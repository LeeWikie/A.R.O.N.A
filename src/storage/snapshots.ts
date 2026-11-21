import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { AppError } from '../domain.js';
import { privateCoreDirectory, privateCoreFile } from '../lock.js';
import { DeltaPayloads, payloadBaseOrdinal } from './delta-payloads.js';

const FORMAT = 'v8-delta-v1';
function fileHash(file: string): string {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { for (;;) { const count = fs.readSync(fd, buffer); if (!count) break; digest.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
type Manifest = { format: typeof FORMAT; sha256: string; template: Record<string, unknown> };
const invalid = () => new AppError('context_snapshot_corrupt', 409);

function original(body: unknown): { bytes: Buffer; template: Record<string, unknown> } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const row = body as Record<string, unknown>;
  if (row.format !== 'v8' || typeof row.data !== 'string') return;
  const bytes = Buffer.from(row.data, 'base64');
  if (bytes.toString('base64') !== row.data) return;
  return { bytes, template: { ...row, data: null } };
}
function manifest(body: unknown): Manifest | undefined {
  if (!body || typeof body !== 'object' || (body as { format?: unknown }).format !== FORMAT) return;
  const row = body as Manifest;
  if (!/^[a-f0-9]{64}$/.test(row.sha256) || !row.template || typeof row.template !== 'object' || Array.isArray(row.template) || row.template.format !== 'v8' || row.template.data !== null) throw invalid();
  return row;
}

/** Exact V8 bytes; the ordinal base clears one set bit, bounding ancestry to 53. */
export class SnapshotStorage {
  private readonly payloads: DeltaPayloads;
  constructor(readonly db: DatabaseSync) {
    this.payloads = new DeltaPayloads(db, 'snapshot_payloads', invalid);
    db.exec(`CREATE TABLE IF NOT EXISTS snapshot_positions (
        run_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        UNIQUE(context_id,ordinal));`);
  }
  private atomic<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  materialize(body: unknown): unknown {
    const stored = manifest(body);
    if (!stored && body && typeof body === 'object' && (body as { format?: unknown }).format === 'v8' && !original(body)) throw invalid();
    return stored ? { ...stored.template, data: this.payloads.read(stored.sha256).toString('base64') } : body;
  }
  put(contextId: string, runId: string, body: unknown) {
    return this.atomic(() => {
      const prior = this.db.prepare('SELECT context_id,body FROM model_snapshots WHERE run_id=?').get(runId);
      if (prior && prior.context_id !== contextId) throw new AppError('snapshot_context_conflict', 409);
      const previous = prior ? manifest(JSON.parse(String(prior.body))) : undefined;
      const source = original(body);
      let stored: unknown = body;
      if (source) {
        let position = this.db.prepare('SELECT * FROM snapshot_positions WHERE run_id=?').get(runId);
        if (!position) {
          const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM snapshot_positions WHERE context_id=?').get(contextId)!.ordinal);
          if (!Number.isSafeInteger(ordinal)) throw invalid();
          this.db.prepare('INSERT INTO snapshot_positions VALUES(?,?,?)').run(runId, contextId, ordinal);
          position = { ordinal };
        }
        const ordinal = Number(position.ordinal);
        if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw invalid();
        const baseRow = this.db.prepare('SELECT s.body FROM snapshot_positions p JOIN model_snapshots s ON s.run_id=p.run_id WHERE p.context_id=? AND p.ordinal=?').get(contextId, payloadBaseOrdinal(ordinal));
        const base = baseRow ? manifest(JSON.parse(String(baseRow.body))) : undefined;
        const sha = this.payloads.ensure(source.bytes, base?.sha256);
        stored = { format: FORMAT, sha256: sha, template: source.template } satisfies Manifest;
        if (previous?.sha256 !== sha) this.payloads.retain(sha);
      }
      this.db.prepare('INSERT INTO model_snapshots VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(runId, contextId, JSON.stringify(stored));
      if (previous && previous.sha256 !== (stored as Partial<Manifest> | null)?.sha256) this.payloads.release(previous.sha256);
    });
  }
  migrate() {
    this.atomic(() => {
      let cursor = 0;
      for (;;) {
        const row = this.db.prepare('SELECT rowid,run_id,context_id,body FROM model_snapshots WHERE rowid>? ORDER BY rowid LIMIT 1').get(cursor);
        if (!row) break; cursor = Number(row.rowid);
        let body: unknown; try { body = JSON.parse(String(row.body)); } catch { continue; }
        if (original(body)) {
          this.put(String(row.context_id), String(row.run_id), body);
          const saved = JSON.parse(String(this.db.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get(row.run_id as string)!.body));
          if (JSON.stringify(this.materialize(saved)) !== JSON.stringify(body)) throw invalid();
        }
      }
    });
  }
  /** Materialize before using a binary which predates this storage format. */
  restoreLegacy() {
    this.atomic(() => {
      for (const row of this.db.prepare('SELECT run_id,body FROM model_snapshots').iterate()) {
        const body = JSON.parse(String(row.body));
        if (manifest(body)) this.db.prepare('UPDATE model_snapshots SET body=? WHERE run_id=?').run(JSON.stringify(this.materialize(body)), String(row.run_id));
      }
      this.db.exec('DELETE FROM snapshot_positions; DELETE FROM snapshot_payloads;');
    });
  }
}

/** Called with the Core ownership lock held, before changing any legacy snapshot. */
export async function prepareSnapshotStorage(directory: string) {
  const file = path.join(directory, 'records.sqlite');
  if (!fs.existsSync(file)) return;
  privateCoreFile(file, false);
  const probe = new DatabaseSync(file, { readOnly: true }); let required: boolean;
  try {
    required = false;
    if (probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_snapshots'").get()) {
      for (const row of probe.prepare('SELECT body FROM model_snapshots').iterate()) {
        let body: unknown; try { body = JSON.parse(String(row.body)); } catch { continue; }
        if (original(body)) { required = true; break; }
      }
    }
  }
  finally { probe.close(); }
  if (!required) return;
  const destination = path.join(privateCoreDirectory(directory, 'migration-backups'), `snapshots-${randomUUID()}`);
  fs.mkdirSync(destination, { mode: 0o700 });
  const files: Array<{ name: string; sha256: string }> = [];
  for (const name of ['records.sqlite', 'history.sqlite']) {
    const source = path.join(directory, name); if (!fs.existsSync(source)) continue;
    privateCoreFile(source, false);
    const db = new DatabaseSync(source, { readOnly: true }); const target = path.join(destination, name);
    try { await backup(db, target); } finally { db.close(); }
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    const verify = new DatabaseSync(target, { readOnly: true });
    try { if (verify.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw invalid(); } finally { verify.close(); }
    const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    files.push({ name, sha256: fileHash(target) });
  }
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ format: 'snapshot-storage-backup', version: 1, files }) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  if (process.platform !== 'win32') for (const parent of [destination, path.dirname(destination)]) {
    const fd = fs.openSync(parent, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;'); new SnapshotStorage(db).migrate(); }
  finally { db.close(); }
}
