import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../domain.js';
import { DeltaPayloads, payloadBaseOrdinal, payloadHash } from './delta-payloads.js';

export interface ImmutablePayloadReference {
  format: 'immutable-bytes-v1'; namespace: string; id: string; sha256: string; size: number;
}

const invalid = () => new AppError('immutable_payload_corrupt', 409);
const identifier = (value: string) => { if (typeof value !== 'string' || !value.length) throw new AppError('invalid_payload_identifier'); };

/** Immutable byte records, independent of model snapshots and their run identities. */
export class ImmutablePayloadStorage {
  private readonly payloads: DeltaPayloads;
  constructor(readonly db: DatabaseSync) {
    this.payloads = new DeltaPayloads(db, 'immutable_payloads', invalid);
    db.exec(`CREATE TABLE IF NOT EXISTS immutable_payload_records (
      namespace TEXT NOT NULL, id TEXT NOT NULL, series_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
      PRIMARY KEY(namespace,id), UNIQUE(namespace,series_id,ordinal));`);
  }
  private atomic<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(namespace: string, id: string): ImmutablePayloadReference | undefined {
    identifier(namespace); identifier(id);
    const row = this.db.prepare('SELECT sha256,size FROM immutable_payload_records WHERE namespace=? AND id=?').get(namespace, id);
    if (!row) return;
    if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || Number(row.size) < 0) throw invalid();
    return { format: 'immutable-bytes-v1', namespace, id, sha256: row.sha256, size: Number(row.size) };
  }
  read(reference: ImmutablePayloadReference): Buffer {
    if (!reference || reference.format !== 'immutable-bytes-v1' || typeof reference.namespace !== 'string' || !reference.namespace.length || typeof reference.id !== 'string' || !reference.id.length) throw invalid();
    const stored = this.get(reference.namespace, reference.id);
    if (!stored || reference.sha256 !== stored.sha256 || reference.size !== stored.size) throw invalid();
    const bytes = this.payloads.read(stored.sha256);
    if (bytes.length !== stored.size) throw invalid();
    return bytes;
  }
  put(namespace: string, seriesId: string, id: string, bytes: Uint8Array): ImmutablePayloadReference {
    identifier(namespace); identifier(seriesId); identifier(id);
    return this.atomic(() => {
      const prior = this.get(namespace, id);
      if (prior) {
        const row = this.db.prepare('SELECT series_id FROM immutable_payload_records WHERE namespace=? AND id=?').get(namespace, id)!;
        if (row.series_id !== seriesId || prior.sha256 !== payloadHash(bytes) || !this.read(prior).equals(bytes)) throw new AppError('immutable_payload_conflict', 409);
        return prior;
      }
      const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM immutable_payload_records WHERE namespace=? AND series_id=?').get(namespace, seriesId)!.ordinal);
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw invalid();
      const base = this.db.prepare('SELECT sha256 FROM immutable_payload_records WHERE namespace=? AND series_id=? AND ordinal=?').get(namespace, seriesId, payloadBaseOrdinal(ordinal));
      const sha = this.payloads.ensure(bytes, base ? String(base.sha256) : undefined);
      this.payloads.retain(sha);
      this.db.prepare('INSERT INTO immutable_payload_records VALUES(?,?,?,?,?,?)').run(namespace, id, seriesId, ordinal, sha, bytes.length);
      return { format: 'immutable-bytes-v1', namespace, id, sha256: sha, size: bytes.length };
    });
  }
}
