import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fromBuffer } from 'yauzl';
import type { Workspace } from '@mastra/core/workspace';
import { AppError } from '../domain.js';

const formats = new Map([['.docx', 'docx'], ['.xlsx', 'xlsx'], ['.pdf', 'pdf'], ['.ipynb', 'notebook'], ['.db', 'sqlite'], ['.sqlite', 'sqlite'], ['.sqlite3', 'sqlite']]);
const maxBytes = 50 * 1024 * 1024;
const maxText = 4 * 1024 * 1024;
export function documentFormat(file: string) { return formats.get(path.extname(file).toLowerCase()); }
const documentMimes = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.sqlite3', 'sqlite'],
  ['application/x-ipynb+json', 'notebook'],
]);
export function documentFormatForMime(mediaType: string) { return documentMimes.get(mediaType); }
const opaque = new Set(['.docx', '.xlsx', '.doc', '.docm', '.xls', '.xlsm', '.xlsb', '.ppt', '.pptx', '.pptm', '.pps', '.pot', '.ppsx', '.ppsm', '.odt', '.ods', '.odp', '.rtf', '.epub', '.db', '.sqlite', '.sqlite3']);
export function isBinaryDocument(file: string) {
  return opaque.has(path.extname(file).toLowerCase()) || /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/i.test(file);
}

interface Extracted { text: string; warnings: string[]; complete: boolean }
function abort(signal?: AbortSignal) { signal?.throwIfAborted(); }
// Inspect package limits before parsers inflate archive entries in memory. No entry is extracted to disk.
async function checkArchive(bytes: Buffer) {
  await new Promise<void>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
    if (error || !zip) { reject(new AppError('invalid_document_archive')); return; }
    let entries = 0, total = 0, settled = false;
    const fail = () => { if (!settled) { settled = true; zip.close(); reject(new AppError('document_archive_limit')); } };
    zip.on('error', fail);
    zip.on('entry', entry => {
      total += entry.uncompressedSize; entries++;
      if (entries > 20_000 || total > 100 * 1024 * 1024 || entry.uncompressedSize > maxBytes || entry.fileName.includes('\0') || /(^|\/)\.\.(\/|$)/.test(entry.fileName)) { fail(); return; }
      zip.readEntry();
    });
    zip.on('end', () => { if (!settled) { settled = true; resolve(); } }); zip.readEntry();
  }));
}

function sourceText(value: unknown): string { return typeof value === 'string' ? value : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('') : ''; }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function notebook(bytes: Buffer): Extracted {
  const data = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!data) throw new AppError('invalid_notebook');
  const cells = Array.isArray(data.cells) ? data.cells : Array.isArray(data.worksheets) ? data.worksheets.flatMap(sheet => { const value = object(sheet)?.cells; return Array.isArray(value) ? value : []; }) : [];
  if (!cells.length) throw new AppError('notebook_has_no_cells');
  const text: string[] = [], warnings: string[] = [];
  for (let index = 0; index < cells.length; index++) {
    const cell = object(cells[index]); if (!cell || !['code', 'markdown', 'raw', 'heading'].includes(String(cell.cell_type))) continue;
    text.push(`## Cell ${index + 1} (${cell.cell_type})`, sourceText(cell.source ?? cell.input));
    if (!Array.isArray(cell.outputs)) continue;
    for (const raw of cell.outputs) {
      const output = object(raw); if (!output) continue;
      const mime = object(output.data);
      const plain = sourceText(output.text ?? mime?.['text/plain']);
      if (plain) text.push('Output:', plain);
      if (output.output_type === 'error' || output.output_type === 'pyerr') text.push('Error output:', sourceText(output.traceback) || `${output.ename ?? ''}: ${output.evalue ?? ''}`);
      for (const type of Object.keys(mime ?? {})) if (type !== 'text/plain') text.push(`[Additional output: ${type}; inspect the original notebook for its encoded data.]`);
      if (text.join('\n').length > maxText) { warnings.push('Notebook extraction reached the text limit.'); return { text: text.join('\n').slice(0, maxText), warnings, complete: false }; }
    }
  }
  if (!text.length) throw new AppError('notebook_has_no_readable_cells');
  return { text: text.join('\n\n'), warnings, complete: true };
}

function sqliteCell(value: unknown): string {
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`;
  return String(value).replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t').slice(0, 256);
}
function sqlite(bytes: Buffer): Extracted {
  if (!bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new AppError('invalid_sqlite_document');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-document-')); const file = path.join(directory, 'snapshot.sqlite');
  let database: DatabaseSync | undefined;
  try {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    database = new DatabaseSync(file, { readOnly: true, allowExtension: false, defensive: true, readBigInts: true });
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const entries = database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type DESC,name").all();
    const tables = entries.filter(entry => entry.type === 'table'), others = entries.filter(entry => entry.type !== 'table');
    const text = [`# SQLite snapshot`, `${tables.length} tables, ${others.length} indexes/views/triggers`];
    for (const entry of tables.slice(0, 200)) {
      const name = String(entry.name), quoted = '"' + name.replaceAll('"', '""') + '"';
      const count = database.prepare(`SELECT COUNT(*) AS total FROM ${quoted}`).get()?.total;
      text.push(`## ${name} (${count} rows)`, String(entry.sql));
      const rows = database.prepare(`SELECT * FROM ${quoted} LIMIT 5`).all();
      if (rows.length) text.push(Object.keys(rows[0]!).join('\t'), ...rows.map(row => Object.values(row).map(sqliteCell).join('\t')));
    }
    if (tables.length > 200) text.push(`${tables.length - 200} additional tables omitted.`);
    if (others.length) text.push('## Indexes/views/triggers', ...others.map(entry => `${entry.type}: ${entry.name}\n${entry.sql}`));
    return { text: text.join('\n\n'), complete: tables.length <= 200, warnings: ['Schema and five-row previews only. This file snapshot does not include live WAL/journal sidecars.'] };
  } finally { database?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

async function extract(bytes: Buffer, format: string, signal?: AbortSignal): Promise<Extracted> {
  abort(signal);
  if (format === 'notebook') return notebook(bytes);
  if (format === 'sqlite') return sqlite(bytes);
  if (format === 'docx') {
    await checkArchive(bytes); abort(signal);
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { text: result.value, warnings: result.messages.map(message => message.message), complete: true };
  }
  if (format === 'xlsx') {
    await checkArchive(bytes); abort(signal);
    const { default: ExcelJS } = await import('exceljs'); const workbook = new ExcelJS.Workbook();
    // ExcelJS consumes binary input without evaluating formulas, macros or external links.
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
    const text: string[] = [], warnings: string[] = []; let complete = true;
    for (const sheet of workbook.worksheets) {
      abort(signal); if (sheet.state === 'hidden' || sheet.state === 'veryHidden') continue;
      text.push(`## Sheet: ${sheet.name}`);
      if (sheet.rowCount > 5000 || sheet.columnCount > 256) { warnings.push(`Sheet ${sheet.name} preview is limited to 5000 rows and 256 columns.`); complete = false; }
      for (let row = 1; row <= Math.min(sheet.rowCount, 5000); row++) {
        const values: string[] = [];
        for (let column = 1; column <= Math.min(sheet.columnCount, 256); column++) {
          const cell = sheet.getRow(row).getCell(column), value = cell.value;
          if (value && typeof value === 'object' && 'formula' in value) values.push(`${cell.text || '(no cached result)'} [formula: ${value.formula}]`);
          else values.push(cell.text);
        }
        text.push(values.join('\t'));
      }
      if (text.join('\n').length > maxText) { complete = false; warnings.push('Workbook extraction reached the text limit.'); break; }
    }
    return { text: text.join('\n'), warnings, complete };
  }
  if (format === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    try {
      const result = await parser.getText({ first: 1000, pageJoiner: '\n-- page_number of total_number --' });
      return { text: result.text, complete: result.total <= 1000, warnings: [
        ...(result.total > 1000 ? ['PDF extraction is limited to the first 1000 pages.'] : []),
        ...(!result.pages.some(page => page.text.trim()) ? ['No text layer was found. Image-only pages require visual inspection or OCR.'] : []),
      ] };
    } finally { await parser.destroy(); }
  }
  throw new AppError('unsupported_document_format');
}

export interface DocumentReadInput { path: string; offset?: number; limit?: number; showLineNumbers?: boolean }
/** Reads through the already authorized native workspace; extracted text never becomes binary source bytes. */
export async function readWorkspaceDocument(workspace: Workspace, input: DocumentReadInput, signal?: AbortSignal) {
  const format = documentFormat(input.path); if (!format) throw new AppError('unsupported_document_format');
  const filesystem = workspace.filesystem; if (!filesystem) throw new AppError('workspace_filesystem_unavailable');
  abort(signal); const stat = await filesystem.stat(input.path);
  if (stat.type !== 'file') throw new AppError('document_not_file');
  if (stat.size > maxBytes) throw new AppError('document_too_large');
  const original = await filesystem.readFile(input.path); abort(signal);
  if (!Buffer.isBuffer(original)) throw new AppError('document_bytes_unavailable');
  return extractDocumentBytes(original, input, signal, format);
}

/** Complete retained extraction from already authorized bytes, shared by file and URL readers. */
export async function extractDocumentText(original:Buffer,format:string,signal?:AbortSignal):Promise<Extracted>{
  abort(signal);if(original.length>maxBytes)throw new AppError('document_too_large');let result:Extracted;
  try{result=await extract(original,format,signal);}catch(error){abort(signal);if(error instanceof AppError)throw error;throw new AppError('document_extraction_failed');}
  abort(signal);return {text:result.text.slice(0,maxText),complete:result.complete&&result.text.length<=maxText,warnings:[...result.warnings,...(result.text.length>maxText?['Extraction reached the text limit.']:[])]};
}

/** Extracts already-authorized bytes without requiring or manufacturing a filesystem path. */
export async function extractDocumentBytes(original: Buffer, input: DocumentReadInput, signal?: AbortSignal, format = documentFormat(input.path)) {
  if (!format) throw new AppError('unsupported_document_format');
  abort(signal);
  if (original.length > maxBytes) throw new AppError('document_too_large');
  const sha256 = createHash('sha256').update(original).digest('hex');
  const result=await extractDocumentText(original,format,signal);
  abort(signal);
  const warnings = [...result.warnings]; if (result.text.length > maxText) warnings.push('Extraction reached the text limit.');
  const text = result.text.slice(0, maxText), lines = text.split('\n'), start = Math.max(0, (input.offset ?? 1) - 1), end = Math.min(lines.length, start + (input.limit ?? 2000));
  const shown = lines.slice(start, end), complete = result.complete && result.text.length <= maxText && start === 0 && end === lines.length;
  return { source: { kind: 'workspace-document', path: input.path, bytes: original.length, sha256 }, authority: 'external-document-data', format,
    representation: 'extracted-text', complete, totalLines: lines.length, startLine: shown.length ? start + 1 : null, endLine: shown.length ? end : null,
    content: shown.map((line, index) => input.showLineNumbers === false ? line : `${start + index + 1}\t${line}`).join('\n'),
    warnings: [...warnings, ...(end < lines.length ? [`Continue from offset ${end + 1} to read the remaining extracted lines.`] : [])] };
}
