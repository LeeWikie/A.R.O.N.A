import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { AppError } from '../domain.js';

export interface MemoryFileReader {
  list(): { path: string; bytes: number }[];
  read(path: string): string;
  readBytes?(path: string): Uint8Array;
}

export function decodeMemoryText(bytes: Uint8Array): string {
  try {return new TextDecoder('utf8', {fatal: true, ignoreBOM: true}).decode(bytes);}
  catch {throw new AppError('memory_file_not_utf8', 415);}
}

export const memoryPageBytes = (value = 12000) => Number.isFinite(value) ? Math.max(2048, Math.min(12000, Math.floor(value))) : 12000;

/** Offsets remain UTF-16 offsets, including when a byte bound shortens a page. */
export function memoryTextPage(text: string, offset: number, limit: number, bytes: number) {
  let low = 0, high = Math.min(limit, Math.max(0, text.length - offset));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(offset, offset + middle)) <= bytes) low = middle;
    else high = middle - 1;
  }
  let end = offset + low;
  if (end - offset > 1 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return { content: text.slice(offset, end), totalCharacters: text.length, nextOffset: end < text.length ? end : null };
}

export function memoryFileTools(reader: MemoryFileReader, maxBytes = 12000) {
  const bytes = memoryPageBytes(maxBytes), p = z.string().min(1);
  return {
    memory_list: createTool({ id: 'memory_list', description: 'List memory files recursively. Follow nextOffset for every remaining file.',
      inputSchema: z.object({ path: z.string().default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(100) }),
      execute: async ({ path, offset, limit }) => {
        const prefix = path === '' || path === '.' ? '' : `${path.replace(/\/$/, '')}/`;
        const all = reader.list().filter(file => !prefix || file.path.startsWith(prefix));
        const files: typeof all = []; let used = 0;
        for (const file of all.slice(offset, offset + limit)) {
          const size = Buffer.byteLength(JSON.stringify(file));
          if (files.length && used + size > bytes) break;
          files.push(file); used += size;
        }
        const end = offset + files.length;
        return { files, totalFiles: all.length, nextOffset: end < all.length ? end : null };
      } }),
    memory_read: createTool({ id: 'memory_read', description: 'Read an original memory file. Text offsets count UTF-16 characters; follow nextOffset until null. Binary or non-UTF8 files remain readable exactly with encoding=base64, byteOffset and maxBytes; follow nextByteOffset for all bytes.',
      inputSchema: z.object({ path: p, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(48000).default(24000), encoding: z.enum(['text', 'base64']).optional(), byteOffset: z.number().int().min(0).optional(), maxBytes: z.number().int().min(1).max(8192).optional() }),
      execute: async ({ path, offset, limit, encoding = 'text', byteOffset = 0, maxBytes = 6144 }, context) => {
        context?.abortSignal?.throwIfAborted();
        const raw = reader.readBytes ? Buffer.from(reader.readBytes(path)) : undefined;
        if (encoding === 'base64') {
          const original = raw ?? Buffer.from(reader.read(path)), end = Math.min(original.length, byteOffset + Math.min(maxBytes, Math.floor(bytes * .7))), content = original.subarray(byteOffset, end).toString('base64');
          return {path, encoding, byteOffset, content, totalBytes: original.length, nextByteOffset: end < original.length ? end : null};
        }
        try {return { path, encoding, offset, ...memoryTextPage(raw ? decodeMemoryText(raw) : reader.read(path), offset, limit, bytes) };}
        catch (error) {if (!(error instanceof AppError) || error.code !== 'memory_file_not_utf8') throw error;
          return {path, encoding, error: error.code, totalBytes: raw?.length, requiresByteRead: true, message: 'The original bytes are retained. Use encoding=base64 with byteOffset/maxBytes.'};}
      } }),
    memory_search: createTool({ id: 'memory_search', description: 'Find literal text in Markdown memory. Follow nextOffset for all matching lines. Long lines have an explicitly marked excerpt and original file offsets for memory_read.',
      inputSchema: z.object({ query: p, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(100) }),
      execute: async ({ query, offset, limit }) => {
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
        const matches: { path: string; line: number; text: string; offset: number; matchOffset: number; lineCharacters: number; excerpt: boolean }[] = [];
        const unreadable: {path: string; reason: string; encoding: 'base64'}[] = [];
        let ordinal = 0, used = 0, more = false;
        outer: for (const file of reader.list().filter(file => file.path.endsWith('.md'))) {
          let content: string;
          try {content = reader.read(file.path);} catch (error) {
            if (!(error instanceof AppError) || error.code !== 'memory_file_not_utf8') throw error;
            if (ordinal++ < offset) continue;
            const item = {path: file.path, reason: error.code, encoding: 'base64' as const}, size = Buffer.byteLength(JSON.stringify(item));
            if (matches.length + unreadable.length >= limit || used && used + size > bytes) {more = true; break;}
            unreadable.push(item); used += size; continue;
          }
          let position = 0, line = 1;
          for (const segment of content.split(/(?<=\n)/)) {
            const text = segment.replace(/\r?\n$/, ''), found = text.search(pattern);
            if (found >= 0) {
              if (ordinal++ < offset) { position += segment.length; line++; continue; }
              const start = Math.max(0, found - 80);
              const page = memoryTextPage(text, start, text.length, Math.min(1024, Math.floor(bytes / 2)));
              const match = { path: file.path, line, text: page.content, offset: position + start, matchOffset: position + found, lineCharacters: text.length, excerpt: start > 0 || page.nextOffset !== null };
              const size = Buffer.byteLength(JSON.stringify(match));
              if (matches.length + unreadable.length >= limit || used && used + size > bytes) { more = true; break outer; }
              matches.push(match); used += size;
            }
            position += segment.length; line++;
          }
        }
        return { matches, unreadable, omitted: more, nextOffset: more ? offset + matches.length + unreadable.length : null };
      } }),
  };
}

/** Keep complete small memories inline; larger memories remain discoverable and readable. */
export function memoryFileResident(reader: MemoryFileReader, maxBytes = 12000) {
  const bytes = memoryPageBytes(maxBytes), files = reader.list().filter(file => file.path.endsWith('.md'));
  const parts = files.map(file => ({ ...file, opening: `<file path=${JSON.stringify(file.path)}>\n`, closing: '\n</file>' }));
  if (parts.reduce((sum, file) => sum + Buffer.byteLength(file.opening + file.closing) + file.bytes + 1, 0) <= bytes) {
    try {
      const complete = parts.map(file => `${file.opening}${reader.read(file.path)}${file.closing}`).join('\n');
      if (Buffer.byteLength(complete) <= bytes) return complete;
    } catch (error) {if (!(error instanceof AppError) || error.code !== 'memory_file_not_utf8') throw error;}
  }
  let text = `记忆包含 ${files.length} 个 Markdown 文件。以下只列出部分目录及能完整放入的 UTF-8 正文；未展示内容仍保留。使用 memory_list 分页发现全部文件，用 memory_search 检索，用 memory_read 的 nextOffset 读取完整原文；非 UTF-8 文件可用 encoding=base64 逐字节读取。\n`;
  let directoryBytes = 0;
  for (const file of files) {
    const line = `${JSON.stringify({ path: file.path, bytes: file.bytes })}\n`, size = Buffer.byteLength(line);
    if (directoryBytes + size > Math.floor(bytes / 3)) break;
    text += line; directoryBytes += size;
  }
  for (const file of parts) {
    if (Buffer.byteLength(text) + Buffer.byteLength(file.opening + file.closing) + file.bytes + 1 > bytes) continue;
    try {
      const complete = `${file.opening}${reader.read(file.path)}${file.closing}\n`;
      if (Buffer.byteLength(text) + Buffer.byteLength(complete) <= bytes) text += complete;
    } catch (error) {if (!(error instanceof AppError) || error.code !== 'memory_file_not_utf8') throw error;}
  }
  return text;
}
