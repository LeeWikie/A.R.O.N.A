import { createHash } from 'node:crypto';
import { constants, fstatSync, lstatSync, openSync, closeSync } from 'node:fs';
import yauzl from 'yauzl';
import { fileTypeFromBuffer } from 'file-type';
import type { Entry, ZipFile } from 'yauzl';

export class MemoryImportError extends Error {
  constructor(readonly code: 'input' | 'limit' | 'format' | 'graph' | 'identity' | 'archive' | 'unavailable') {
    super(`memory_import_${code}`); this.name = 'MemoryImportError';
  }
}
function openArchive(filename: string) {
  const visible = lstatSync(filename);
  if (!visible.isFile() || visible.isSymbolicLink() || visible.nlink !== 1) throw new MemoryImportError('archive');
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== visible.dev || stat.ino !== visible.ino) throw new MemoryImportError('archive');
    return { fd, stat };
  } catch (error) { closeSync(fd); throw error; }
}
export interface ChatExportZipOptions {
  archivePath: string;
  /** Select one JSON shard by its numeric suffix, or an exact local member. */
  member?: { index: number } | { name: string };
  maxMemberBytes?: number;
  maxEntries?: number;
}
export interface ChatExportArchiveIdentity { device: number; inode: number; size: number; mtimeMs: number; ctimeMs: number }
export interface ChatExportZipMember {
  bytes: Uint8Array;
  sha256: string;
  memberName: string;
  archiveBytes: number;
  archiveIdentity: ChatExportArchiveIdentity;
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(name: string): boolean {
  return !!name && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name)
    && !name.split('/').some(part => part === '.' || part === '..' || part === '');
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new MemoryImportError('limit');
  return result;
}
function openZip(fd: number): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromFd(fd, {
    lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true,
  }, (error, zip) => error || !zip ? reject(new MemoryImportError('archive')) : resolve(zip)));
}
function entries(zip: ZipFile, maximum: number): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const result: Entry[] = [];
    let nameBytes = 0;
    const fail = () => reject(new MemoryImportError('archive'));
    zip.once('error', fail);
    zip.on('entry', (entry: Entry) => {
      nameBytes += Buffer.byteLength(entry.fileName);
      if (nameBytes > 32 * 1024 * 1024 || result.length >= maximum) { reject(new MemoryImportError('limit')); return; }
      result.push(entry); zip.readEntry();
    });
    zip.once('end', () => resolve(result));
    zip.readEntry();
  });
}
function read(zip: ZipFile, entry: Entry, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(new MemoryImportError('archive')); return; }
      const buffers: Buffer[] = []; let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum || size > entry.uncompressedSize) { stream.destroy(new MemoryImportError('limit')); return; }
        buffers.push(chunk);
      });
      stream.once('error', () => reject(new MemoryImportError('archive')));
      stream.once('end', () => {
        const value = Buffer.concat(buffers);
        if (value.length !== entry.uncompressedSize || crc32(value) !== entry.crc32) reject(new MemoryImportError('archive'));
        else resolve(value);
      });
    });
  });
}
/** Reads one bounded member without extraction, URL fetching, or executing archived material. */
export async function readChatExportZipMember(options: ChatExportZipOptions): Promise<ChatExportZipMember> {
  const maximum = bounded(options.maxMemberBytes, 64 * 1024 * 1024, 128 * 1024 * 1024);
  const maxEntries = bounded(options.maxEntries, 60_000, 60_000);
  if (!options.archivePath || options.member && 'index' in options.member && (!Number.isSafeInteger(options.member.index) || options.member.index < 0)) throw new MemoryImportError('input');
  let fd: number | undefined; let zip: ZipFile | undefined;
  try {
    const opened = openArchive(options.archivePath); fd = opened.fd;
    const before = opened.stat;
    if (!before.isFile() || before.nlink !== 1) throw new MemoryImportError('archive');
    zip = await openZip(fd);
    const all = await entries(zip, maxEntries);
    const names = new Set<string>();
    for (const entry of all) {
      if (names.has(entry.fileName)) throw new MemoryImportError('archive');
      names.add(entry.fileName);
    }
    let selected: Entry | undefined;
    if (options.member && 'name' in options.member) selected = all.find(entry => entry.fileName === (options.member as { name: string }).name);
    else {
      const shards = new Map<number, Entry>();
      for (const entry of all) {
        const match = /(?:^|\/)conversations(?:-(\d+))?\.json$/.exec(entry.fileName);
        if (!match) continue;
        const index = Number(match[1] ?? 0);
        if (!Number.isSafeInteger(index) || shards.has(index)) throw new MemoryImportError('archive');
        shards.set(index, entry);
      }
      selected = shards.get(options.member && 'index' in options.member ? options.member.index : 0);
    }
    if (!selected) throw new MemoryImportError('unavailable');
    if (!safeName(selected.fileName) || selected.generalPurposeBitFlag & 1 || ![0, 8].includes(selected.compressionMethod)
      || ((selected.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new MemoryImportError('archive');
    if (selected.uncompressedSize > maximum || selected.compressedSize > maximum
      || selected.uncompressedSize > Math.max(selected.compressedSize, 1) * 200) throw new MemoryImportError('limit');
    const bytes = await read(zip, selected, maximum);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new MemoryImportError('archive');
    return { bytes: new Uint8Array(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), memberName: selected.fileName, archiveBytes: before.size, archiveIdentity: { device: before.dev, inode: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs } };
  } catch (error) {
    if (error instanceof MemoryImportError) throw error;
    throw new MemoryImportError('archive');
  } finally {
    // fromFd(autoClose:false) leaves descriptor ownership with this reader.
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseChatExportJson(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024 * 1024) throw new MemoryImportError('limit');
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text).equals(Buffer.from(bytes))) throw new MemoryImportError('format');
  try { return JSON.parse(text); } catch { throw new MemoryImportError('format'); }
}

export interface ChatExportAssetRequest { locator: string; mediaType: string; expectedBytes?: number }
export interface ChatExportAssets {
  assets: { locator: string; mediaType: string; bytes: Uint8Array }[];
  gaps: { locator: string; reason: 'unsupported-locator' | 'missing' | 'ambiguous' | 'media-mismatch' | 'size-mismatch' | 'capacity' }[];
}
/** Resolves only explicit local export references. Locator equality never substitutes for content hashes. */
export async function readChatExportZipAssets(options: ChatExportZipOptions & { expectedArchiveIdentity?: ChatExportArchiveIdentity }, requests: readonly ChatExportAssetRequest[]): Promise<ChatExportAssets> {
  if (requests.length > 256) throw new MemoryImportError('limit');
  let fd: number | undefined;
  try {
    const opened = openArchive(options.archivePath); fd = opened.fd;
    const before = opened.stat;
    const identity = { device: before.dev, inode: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
    if (!before.isFile() || before.nlink !== 1 || options.expectedArchiveIdentity && JSON.stringify(identity) !== JSON.stringify(options.expectedArchiveIdentity)) throw new MemoryImportError('archive');
    const zip = await openZip(fd); const all = await entries(zip, bounded(options.maxEntries, 60_000, 60_000));
    const names = new Set<string>();
    for (const entry of all) { if (names.has(entry.fileName)) throw new MemoryImportError('archive'); names.add(entry.fileName); }
    const result: ChatExportAssets = { assets: [], gaps: [] }; let total = 0;
    const seen = new Set<string>();
    for (const request of requests) {
      if (typeof request.locator !== 'string' || !request.mediaType || request.locator.length > 4096) throw new MemoryImportError('input');
      if (seen.has(request.locator)) continue; seen.add(request.locator);
      const gap = (reason: ChatExportAssets['gaps'][number]['reason']) => result.gaps.push({ locator: request.locator, reason });
      const pointer = /^(?:sediment|file-service):\/\/([A-Za-z0-9._-]+)$/.exec(request.locator)?.[1];
      const local = pointer ?? (safeName(request.locator) && !request.locator.includes(':') ? request.locator : null);
      if (!local) { gap('unsupported-locator'); continue; }
      const exact = all.filter(entry => entry.fileName === local);
      const matches = exact.length ? exact : local.includes('/') ? [] : all.filter(entry => {
        const name = entry.fileName.split('/').at(-1)!;
        return name === local || name.replace(/\.[^.]+$/, '') === local;
      });
      if (!matches.length) { gap('missing'); continue; }
      if (matches.length !== 1) { gap('ambiguous'); continue; }
      const entry = matches[0]!;
      if (!safeName(entry.fileName) || entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)
        || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new MemoryImportError('archive');
      if (entry.uncompressedSize > 32 * 1024 * 1024 || total + entry.uncompressedSize > 64 * 1024 * 1024
        || entry.uncompressedSize > Math.max(entry.compressedSize, 1) * 200) { gap('capacity'); continue; }
      if (request.expectedBytes !== undefined && request.expectedBytes !== entry.uncompressedSize) { gap('size-mismatch'); continue; }
      const bytes = await read(zip, entry, 32 * 1024 * 1024);
      let actual: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
      try { actual = await fileTypeFromBuffer(bytes); } catch { actual = undefined; }
      if (!actual || actual.mime !== request.mediaType || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(actual.mime)) { gap('media-mismatch'); continue; }
      total += bytes.length; result.assets.push({ locator: request.locator, mediaType: actual.mime, bytes: new Uint8Array(bytes) });
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new MemoryImportError('archive');
    return result;
  } catch (error) { if (error instanceof MemoryImportError) throw error; throw new MemoryImportError('archive'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
