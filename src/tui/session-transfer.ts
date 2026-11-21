import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../domain.js';
import { sensitiveFile } from '../file-policy.js';
import type { SessionArchive } from '../protocol.js';
import {sessionDataRequirements} from '../session-assets.js';

export type SessionTransferArchive = SessionArchive;
export const MAX_SESSION_TRANSFER_BYTES = 32 * 1024 * 1024;

export function encodeSessionArchive(archive: SessionTransferArchive): string {
  const { messages, ...header } = archive;
  return [JSON.stringify({ type: 'session', ...header }), ...messages.map(message => JSON.stringify({ type: 'message', message }))].join('\n') + '\n';
}

/** Decode the transfer envelope only; source identity and message authority are validated by the core. */
export function decodeSessionArchive(text: string): SessionTransferArchive {
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSION_TRANSFER_BYTES) throw new AppError('session_archive_too_large');
  try {
    const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    const header = rows[0];
    if (!header || header.type !== 'session' || header.format !== 'shittimchest-session' || header.version !== 1 || !header.context || rows.slice(1).some(row => !row || row.type !== 'message' || !row.message)) throw new AppError('invalid_session_archive');
    const { type: _type, ...archive } = header;
    return { ...archive, messages: rows.slice(1).map(row => row.message) } as SessionTransferArchive;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('invalid_session_archive');
  }
}

export async function readSessionText(file: string): Promise<string> {
  if (sensitiveFile(file)) throw new AppError('import_private_path');
  const actual = await fs.promises.realpath(file);
  if (sensitiveFile(actual)) throw new AppError('import_private_path');
  const visible=await fs.promises.lstat(file);if(!visible.isFile()||visible.isSymbolicLink()||visible.nlink!==1)throw new AppError('session_archive_redirected',403);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1||before.dev!==visible.dev||before.ino!==visible.ino) throw new AppError('session_archive_changed',409);
    if (before.size > MAX_SESSION_TRANSFER_BYTES) throw new AppError('session_archive_too_large');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current=await fs.promises.lstat(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size||after.nlink!==1||current.isSymbolicLink()||current.nlink!==1||current.dev!==before.dev||current.ino!==before.ino||sensitiveFile(await fs.promises.realpath(file))) throw new AppError('session_archive_changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

export async function readSessionArchive(file: string): Promise<SessionTransferArchive> {
  return decodeSessionArchive(await readSessionText(file));
}

export type SessionImport = { format: 'archive'; archive: SessionTransferArchive } | { format: 'pi'; jsonl: string;requiredCapabilities?:string[] };
export function decodeSessionImport(text: string): SessionImport {
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSION_TRANSFER_BYTES) throw new AppError('session_archive_too_large');
  let header: { type?: string; format?: string; id?: string; cwd?: string };
  try { header = JSON.parse(text.replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim()) ?? 'null'); }
  catch { throw new AppError('invalid_session_archive'); }
  if (!header || header.type !== 'session') throw new AppError('invalid_session_archive');
  if (header.format === 'shittimchest-session') return { format: 'archive', archive: decodeSessionArchive(text) };
  if (header.format !== undefined || typeof header.id !== 'string' || typeof header.cwd !== 'string') throw new AppError('invalid_session_archive');
  const requiredCapabilities=sessionDataRequirements(header);return { format: 'pi', jsonl: text,...(requiredCapabilities.length?{requiredCapabilities}:{}) };
}

export async function writeSessionExport(file: string, body: string): Promise<void> {
  if (sensitiveFile(file)) throw new AppError('export_private_path');
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (sensitiveFile(await fs.promises.realpath(path.dirname(file)))) throw new AppError('export_private_path');
  await fs.promises.writeFile(file, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
