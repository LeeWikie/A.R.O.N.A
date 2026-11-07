// File scoping and operations are adapted from MIT-licensed code; see LICENSE.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { AppError } from '../domain.js';

export class MemoryFiles {
  private readonly realRoot: string;
  private readonly identity: fs.BigIntStats;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
    if (fs.lstatSync(root).isSymbolicLink()) throw new AppError('memory_root_redirected');
    this.realRoot = fs.realpathSync(root); this.identity = fs.lstatSync(root, { bigint: true });
  }
  resolve(relative: string, allowRoot = false) {
    const current = fs.lstatSync(this.root, { bigint: true });
    if (current.isSymbolicLink() || fs.realpathSync(this.root) !== this.realRoot || current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw new AppError('memory_root_changed');
    if (allowRoot && (relative === '' || relative === '.')) return this.root;
    const parts = relative.replaceAll('\\', '/').split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || [...p].some(c => c.charCodeAt(0) < 32) || /[:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new AppError('invalid_memory_path');
    let target = this.root;
    for (const part of parts) {
      target = path.join(target, part);
      try { const stat = fs.lstatSync(target); if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new AppError('memory_link_refused'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const rel = path.relative(this.root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new AppError('memory_path_outside_scope');
    return target;
  }
  list(relative = ''): { path: string; bytes: number }[] {
    const output: { path: string; bytes: number }[] = [];
    for (const entry of fs.readdirSync(this.resolve(relative, true), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new AppError('memory_link_refused');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) output.push(...this.list(name));
      else if (entry.isFile()) output.push({ path: name, bytes: fs.statSync(this.resolve(name)).size });
      else throw new AppError('memory_file_type_refused');
    }
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }
  write(relative: string, content: string) {
    const target = this.resolve(relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, content, { mode: 0o600 }); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  resident() {
    return this.list().filter(x => x.path.endsWith('.md')).map(file => `<file path=${JSON.stringify(file.path)}>\n${fs.readFileSync(this.resolve(file.path), 'utf8')}\n</file>`).join('\n');
  }
  tools() {
    const p = z.string().min(1);
    return {
      memory_list: createTool({ id: 'memory_list', description: 'List memory files recursively.', inputSchema: z.object({ path: z.string().default('') }), execute: async ({ path }) => this.list(path) }),
      memory_read: createTool({ id: 'memory_read', description: 'Read memory; follow nextOffset to read remaining text.', inputSchema: z.object({ path: p, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(48000).default(24000) }), execute: async ({ path, offset, limit }) => {
        const content = fs.readFileSync(this.resolve(path), 'utf8'); return { path, content: content.slice(offset, offset + limit), totalCharacters: content.length, nextOffset: offset + limit < content.length ? offset + limit : null };
      } }),
      memory_search: createTool({ id: 'memory_search', description: 'Find literal text in Markdown. Reports whether further matches were omitted.', inputSchema: z.object({ query: p }), execute: async ({ query }) => {
        const matches: { path: string; line: number; text: string }[] = []; let omitted = false;
        for (const file of this.list().filter(x => x.path.endsWith('.md'))) for (const [i, text] of fs.readFileSync(this.resolve(file.path), 'utf8').split(/\r?\n/).entries()) {
          if (!text.toLowerCase().includes(query.toLowerCase())) continue;
          if (matches.length < 100) matches.push({ path: file.path, line: i + 1, text }); else omitted = true;
        }
        return { matches, omitted };
      } }),
      memory_write: createTool({ id: 'memory_write', description: 'Create or replace a memory file.', inputSchema: z.object({ path: p, content: z.string() }), execute: async ({ path, content }) => { this.write(path, content); return { written: true }; } }),
      memory_edit: createTool({ id: 'memory_edit', description: 'Replace one exact unique substring. Read before editing.', inputSchema: z.object({ path: p, oldText: p, newText: z.string() }), execute: async ({ path, oldText, newText }) => {
        const content = fs.readFileSync(this.resolve(path), 'utf8'); const index = content.indexOf(oldText);
        if (index < 0 || content.lastIndexOf(oldText) !== index) throw new AppError('memory_edit_not_unique');
        this.write(path, content.slice(0, index) + newText + content.slice(index + oldText.length)); return { edited: true };
      } }),
      memory_mkdir: createTool({ id: 'memory_mkdir', description: 'Create a memory directory.', inputSchema: z.object({ path: p }), execute: async ({ path }) => { fs.mkdirSync(this.resolve(path), { recursive: true }); return { created: true }; } }),
      memory_move: createTool({ id: 'memory_move', description: 'Move a memory file or directory without overwriting.', inputSchema: z.object({ from: p, to: p }), execute: async ({ from, to }) => {
        const source = this.resolve(from), destination = this.resolve(to); if (fs.existsSync(destination)) throw new AppError('memory_destination_exists');
        fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(source, destination); return { moved: true };
      } }),
      memory_remove: createTool({ id: 'memory_remove', description: 'Remove a memory file or empty directory.', inputSchema: z.object({ path: p }), execute: async ({ path }) => {
        const target = this.resolve(path); if (fs.statSync(target).isDirectory()) fs.rmdirSync(target); else fs.unlinkSync(target); return { removed: true };
      } }),
    };
  }
}
