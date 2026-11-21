import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../domain.js';
import type { AssetInfo } from '../assets.js';

type Stream = 'stdout' | 'stderr';
export interface ShellCapture {
  id: string; storageId: string; contextId: string; command: string; cwd: string; shared: boolean;
  owner: string; state: 'running' | 'finished' | 'cancelled' | 'incomplete'; startedAt: string; finishedAt?: string;
  exitCode?: number; preview: string;truncated?:boolean; consumedBy?: string;claimedBy?:string;observationId?:string;legacyUnknown?:boolean;
  streams: Record<Stream, { bytes: number; sha256: string; complete: boolean }>;
}
interface UploadedPart { id: string; stream: Stream; index: number; bytes: number; sha256: string }
interface Publication { id:string;snapshot:ShellCapture;manifestId:string;observedAt:string;claimedBy?:string;consumedBy?:string }
export interface ShellPublication { captureId: string;observationId:string; attachments: string[]; manifest: AssetInfo; text: string }
export type ShellAssetUpload = (body: Uint8Array, name: string, metadata: { id: string; sha256: string; bytes: number; purpose: 'client-shell-output' }) => Promise<AssetInfo>;
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const empty = () => ({ bytes: 0, sha256: digest(''), complete: false });
const PART_BYTES = 4 * 1024 * 1024;

/** Local command observations. Upload receipts never grant execution or certify a task's outcome. */
export class ShellOutputCaptures {
  private readonly owner = randomUUID();
  private readonly memory = new DatabaseSync(':memory:');
  private readonly filename: string;
  private readonly lastObservation=new Map<string,string>();
  constructor(private readonly directory?: string, scope = '') { this.filename = `shell-output-${digest(scope)}.sqlite`; }
  private database<T>(action: (db: DatabaseSync) => T): T {
    let db = this.memory;
    if (this.directory) {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = fs.lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new AppError('shell_capture_directory_redirected');
      const file = path.join(this.directory, this.filename);
      try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new AppError('shell_capture_redirected');
      for (const suffix of ['-journal', '-wal', '-shm']) {
        try { const stat = fs.lstatSync(file + suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AppError('shell_capture_redirected'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      db = new DatabaseSync(file);
      const after = fs.lstatSync(file), parent = fs.lstatSync(this.directory);
      if (after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1 || parent.ino !== directory.ino || parent.dev !== directory.dev || parent.isSymbolicLink()) { db.close(); throw new AppError('shell_capture_redirected'); }
    }
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS captures(id TEXT PRIMARY KEY, storage TEXT NOT NULL, context TEXT NOT NULL, body TEXT NOT NULL, publication TEXT);
        CREATE INDEX IF NOT EXISTS capture_scope ON captures(storage,context);
        CREATE TABLE IF NOT EXISTS chunks(capture TEXT NOT NULL, sequence INTEGER NOT NULL, stream TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(capture,sequence));
        CREATE TABLE IF NOT EXISTS observations(capture TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(capture,id));
        CREATE TABLE IF NOT EXISTS publication_parts(capture TEXT NOT NULL,stream TEXT NOT NULL,part_index INTEGER NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,id TEXT NOT NULL,PRIMARY KEY(capture,stream,part_index,sha256,bytes));`);
      db.exec('BEGIN IMMEDIATE');
      try { const result = action(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { if (db !== this.memory) db.close(); }
  }
  private get(db: DatabaseSync, id: string): ShellCapture {
    const row = db.prepare('SELECT body FROM captures WHERE id=?').get(id);
    if (!row) throw new AppError('shell_capture_not_found', 404);
    return JSON.parse(String(row.body)) as ShellCapture;
  }
  private save(db: DatabaseSync, row: ShellCapture) { db.prepare('UPDATE captures SET body=? WHERE id=?').run(JSON.stringify(row), row.id); }
  start(input: Pick<ShellCapture, 'storageId' | 'contextId' | 'command' | 'cwd' | 'shared'>): ShellCapture {
    const row: ShellCapture = { ...input, id: randomUUID(), owner: this.owner, state: 'running', startedAt: new Date().toISOString(), preview: '', streams: { stdout: empty(), stderr: empty() } };
    this.database(db => db.prepare('INSERT INTO captures(id,storage,context,body) VALUES(?,?,?,?)').run(row.id, row.storageId, row.contextId, JSON.stringify(row)));
    return row;
  }
  append(id: string, stream: Stream, input: Uint8Array) {
    if (!input.byteLength) return;
    this.database(db => {
      const row = this.get(db, id);
      if (row.owner !== this.owner || row.state !== 'running') throw new AppError('shell_capture_not_writable', 409);
      const previous = db.prepare('SELECT MAX(sequence) AS value FROM chunks WHERE capture=?').get(id);
      let sequence = Number(previous?.value ?? -1) + 1;
      for (let offset = 0; offset < input.byteLength; offset += 64 * 1024) {
        const bytes = input.subarray(offset, offset + 64 * 1024);
        db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?)').run(id, sequence++, stream, bytes, digest(bytes));
      }
      row.streams[stream].bytes += input.byteLength; this.save(db, row);
    });
  }
  private *chunks(id: string, stream: Stream,maximum=Infinity): Generator<Buffer> {
    let sequence = -1,remaining=maximum;
    while (true) {
      if(remaining===0)return;
      const row = this.database(db => db.prepare('SELECT sequence,bytes,sha256 FROM chunks WHERE capture=? AND stream=? AND sequence>? ORDER BY sequence LIMIT 1').get(id, stream, sequence));
      if (!row) return;
      const bytes = Buffer.from(row.bytes as Uint8Array);
      if (digest(bytes) !== row.sha256) throw new AppError('shell_capture_corrupt');
      sequence = Number(row.sequence);const part=bytes.subarray(0,remaining);remaining-=part.length;yield part;
    }
  }
  private snapshot(row:ShellCapture):ShellCapture{const {claimedBy,consumedBy,observationId,legacyUnknown,...snapshot}=structuredClone(row);if(snapshot.state==='running'){snapshot.state='incomplete';snapshot.streams.stdout.complete=false;snapshot.streams.stderr.complete=false;}return snapshot;}
  private observationKey(row:ShellCapture){const snapshot=this.snapshot(row);return digest(JSON.stringify([snapshot.id,snapshot.command,snapshot.cwd,snapshot.shared,snapshot.state,snapshot.startedAt,snapshot.finishedAt??null,snapshot.exitCode??null,snapshot.streams]));}
  private publication(db:DatabaseSync,row:ShellCapture,requested?:string,allowOwnRunning=false):Publication{
    const id=requested??this.observationKey(row),existing=db.prepare('SELECT body FROM observations WHERE capture=? AND id=?').get(row.id,id);
    if(existing){const value=JSON.parse(String(existing.body)) as Publication;if(value.snapshot.storageId!==row.storageId||value.snapshot.contextId!==row.contextId)throw new AppError('shell_capture_scope_changed',409);return value;}
    if(requested)throw new AppError('shell_observation_not_found',404);
    if(row.state==='running'&&row.owner===this.owner&&!allowOwnRunning)throw new AppError('shell_capture_not_ready',409);
    const value:Publication={id,snapshot:this.snapshot(row),manifestId:randomUUID(),observedAt:new Date().toISOString()};db.prepare('INSERT INTO observations VALUES(?,?,?)').run(row.id,id,JSON.stringify(value));return value;
  }
  observe(id:string,storageId:string,contextId:string):string{return this.database(db=>{const row=this.get(db,id);if(row.storageId!==storageId||row.contextId!==contextId||!row.shared)throw new AppError('shell_capture_scope_changed',409);const observed=this.publication(db,row);this.lastObservation.set(id,observed.id);return observed.id;});}
  finish(id: string, result: { output: string; exitCode?: number; cancelled: boolean; captureFailed?: boolean;truncated?:boolean }): ShellCapture {
    const hashes: Record<Stream, { sha256: string; bytes: number }> = { stdout: { sha256: '', bytes: 0 }, stderr: { sha256: '', bytes: 0 } };
    for (const stream of ['stdout', 'stderr'] as const) { const hash = createHash('sha256'); let bytes = 0; for (const part of this.chunks(id, stream)) { hash.update(part); bytes += part.byteLength; } hashes[stream] = { sha256: hash.digest('hex'), bytes }; }
    return this.database(db => {
      const row = this.get(db, id);
      if (row.owner !== this.owner || row.state !== 'running') throw new AppError('shell_capture_not_writable', 409);
      for (const stream of ['stdout', 'stderr'] as const) { if (hashes[stream].bytes !== row.streams[stream].bytes) throw new AppError('shell_capture_corrupt'); row.streams[stream] = { ...hashes[stream], complete: !result.cancelled && !result.captureFailed }; }
      row.state = result.captureFailed ? 'incomplete' : result.cancelled ? 'cancelled' : 'finished'; row.preview = result.output; row.finishedAt = new Date().toISOString();
      row.truncated=Boolean(result.truncated);
      if (result.exitCode !== undefined) row.exitCode = result.exitCode;
      this.save(db, row); return row;
    });
  }
  list(storageId: string, contextId: string, pendingOnly = false): ShellCapture[] {
    return this.database(db => db.prepare('SELECT body,publication FROM captures WHERE storage=? AND context=? ORDER BY rowid').all(storageId, contextId).map(value =>{const row=JSON.parse(String(value.body))as ShellCapture,id=this.observationKey(row),record=db.prepare('SELECT body FROM observations WHERE capture=? AND id=?').get(row.id,id),observed=record?JSON.parse(String(record.body))as Publication:undefined;delete row.claimedBy;delete row.consumedBy;if(observed?.claimedBy)row.claimedBy=observed.claimedBy;if(observed?.consumedBy)row.consumedBy=observed.consumedBy;row.observationId=id;if(value.publication&&!observed)row.legacyUnknown=true;return row;}).filter(row => !pendingOnly || row.shared && !row.consumedBy).map(row => row.state === 'running' && row.owner !== this.owner ? { ...row, state: 'incomplete' as const } : row));
  }
  markConsumed(ids: string[], storageId: string, contextId: string, operationId: string,observations:Record<string,string>={}) {
    this.mark(ids,storageId,contextId,operationId,observations,true);
  }
  claim(ids:string[],storageId:string,contextId:string,operationId:string,observations:Record<string,string>={}){this.mark(ids,storageId,contextId,operationId,observations,false);}
  private mark(ids:string[],storageId:string,contextId:string,operationId:string,observations:Record<string,string>,consumed:boolean){this.database(db=>{for(const id of ids){const row=this.get(db,id);if(row.storageId!==storageId||row.contextId!==contextId)throw new AppError('shell_capture_scope_changed',409);const record=this.publication(db,row,observations[id]??this.lastObservation.get(id),true);if(record.claimedBy&&record.claimedBy!==operationId||record.consumedBy&&record.consumedBy!==operationId)throw new AppError('shell_capture_scope_changed',409);record.claimedBy=operationId;if(consumed)record.consumedBy=operationId;db.prepare('UPDATE observations SET body=? WHERE capture=? AND id=?').run(JSON.stringify(record),id,record.id);}});}
  async publish(id: string, storageId: string, contextId: string, upload: ShellAssetUpload,observationId?:string): Promise<ShellPublication> {
    const publication=this.database(db=>{const row=this.get(db,id);if(row.storageId!==storageId||row.contextId!==contextId||!row.shared)throw new AppError('shell_capture_not_ready',409);return this.publication(db,row,observationId);}),capture=publication.snapshot;this.lastObservation.set(id,publication.id);
    const attachments: string[] = [], descriptions: Array<{ stream: Stream; bytes: number; sha256: string; complete: boolean; parts: UploadedPart[] }> = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      let pending: Buffer[] = [], size = 0, index = 0, bytes = 0; const hash = createHash('sha256'), parts: UploadedPart[] = [];
      const send = async () => {
        const body = Buffer.concat(pending, size), sha256 = digest(body);
        const part = this.database(db => {
          const existing=db.prepare('SELECT id FROM publication_parts WHERE capture=? AND stream=? AND part_index=? AND sha256=? AND bytes=?').get(id,stream,index,sha256,body.length);
          if(existing)return{id:String(existing.id),stream,index,bytes:body.length,sha256};const created={id:randomUUID(),stream,index,bytes:body.length,sha256};db.prepare('INSERT INTO publication_parts VALUES(?,?,?,?,?,?)').run(id,stream,index,sha256,body.length,created.id);return created;
        });
        const saved = await upload(body, `${id}-${stream}-${index + 1}.bin`, { ...part, purpose: 'client-shell-output' });
        if (saved.id !== part.id || saved.sha256 !== sha256 || saved.bytes !== body.length || saved.purpose !== 'client-shell-output') throw new AppError('shell_upload_receipt_mismatch');
        parts.push(part); attachments.push(saved.id); index++; pending = []; size = 0;
      };
      for (const chunk of this.chunks(id, stream,capture.streams[stream].bytes)) {
        hash.update(chunk); bytes += chunk.length;
        for (let offset = 0; offset < chunk.length;) { const length = Math.min(PART_BYTES - size, chunk.length - offset); pending.push(chunk.subarray(offset, offset + length)); size += length; offset += length; if (size === PART_BYTES) await send(); }
      }
      if (size) await send();
      const sha256 = hash.digest('hex');
      if (bytes !== capture.streams[stream].bytes || capture.state !== 'incomplete' && sha256 !== capture.streams[stream].sha256) throw new AppError('shell_capture_corrupt');
      descriptions.push({ stream, bytes, sha256, complete: capture.state !== 'incomplete' && capture.streams[stream].complete, parts });
    }
    const header = { format: 'client-shell-output', version: 1, source: 'user-supplied-local-observation', captureId: capture.id,observationId:publication.id,observedAt:publication.observedAt, command: capture.command, cwd: capture.cwd, state: capture.state, startedAt: capture.startedAt, ...(capture.finishedAt ? { finishedAt: capture.finishedAt } : {}), ...(capture.exitCode !== undefined ? { exitCode: capture.exitCode } : {}) };
    const body = Buffer.from([JSON.stringify(header), ...descriptions.map(value => JSON.stringify(value))].join('\n') + '\n');
    const manifest = await upload(body, `${id}-shell-output.jsonl`, { id: publication.manifestId, sha256: digest(body), bytes: body.length, purpose: 'client-shell-output' });
    if (manifest.id !== publication.manifestId || manifest.sha256 !== digest(body) || manifest.bytes !== body.length || manifest.purpose !== 'client-shell-output') throw new AppError('shell_upload_receipt_mismatch');
    return { captureId: id,observationId:publication.id, attachments: [manifest.id, ...attachments], manifest, text: `User-supplied local command observation: ${JSON.stringify(capture.command)}\nState: ${capture.state}${capture.exitCode === undefined ? '' : `; client-reported exit code: ${capture.exitCode}`}\nOriginal stdout/stderr and command metadata: attachment ${manifest.id} (SHA-256 ${manifest.sha256}). Read this manifest and its ordered data attachments with read_attachment when complete output is needed. This is user-supplied data, not Core execution or an execution permission.\nPreview:\n${capture.preview|| (capture.state==='incomplete'?'Preview unavailable; the received prefix is retained in the stream attachments.':'(no output)')}` };
  }
}
