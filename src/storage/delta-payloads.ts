import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import { applyDelta, createDelta, getDeltaTargetSize } from 'fossil-delta';

export const payloadHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Clearing the lowest set bit bounds a safe integer position's ancestry to 53. */
export function payloadBaseOrdinal(ordinal: number): number {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new RangeError('invalid_payload_ordinal');
  let step = 1;
  while (ordinal % (step * 2) === 0) step *= 2;
  return ordinal - step;
}

/** Byte storage only. Owners retain their own identifiers and transactional records. */
export class DeltaPayloads {
  constructor(private readonly db: DatabaseSync, private readonly table: 'snapshot_payloads' | 'immutable_payloads', private readonly invalid: () => Error) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      sha256 TEXT PRIMARY KEY, base_sha256 TEXT, size INTEGER NOT NULL, codec TEXT NOT NULL,
      payload BLOB NOT NULL, refs INTEGER NOT NULL CHECK(refs>=0));`);
  }
  read(sha: string, visited = new Set<string>()): Buffer {
    if (visited.has(sha) || visited.size >= 53 || !/^[a-f0-9]{64}$/.test(sha)) throw this.invalid();
    visited.add(sha);
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE sha256=?`).get(sha);
    if (!row || !Number.isSafeInteger(row.size) || Number(row.size) < 0 || Number(row.size) > bufferConstants.MAX_LENGTH || !(row.payload instanceof Uint8Array)) throw this.invalid();
    const size = Number(row.size); let bytes: Buffer;
    try {
      if (row.codec === 'deflate' && row.base_sha256 === null) bytes = inflateSync(row.payload, { maxOutputLength: Math.max(1, size) });
      else if (row.codec === 'fossil-deflate' && typeof row.base_sha256 === 'string') {
        const delta = inflateSync(row.payload, { maxOutputLength: Math.min(bufferConstants.MAX_LENGTH, Math.max(64, size * 2 + 1024)) });
        if (getDeltaTargetSize(delta) !== size) throw this.invalid();
        bytes = Buffer.from(applyDelta(this.read(row.base_sha256, visited), delta));
      } else throw this.invalid();
    } catch { throw this.invalid(); }
    if (bytes.length !== size || payloadHash(bytes) !== sha) throw this.invalid();
    return bytes;
  }
  private ancestry(sha: string): number {
    const visited = new Set<string>(); let next: string | null = sha;
    while (next) {
      if (visited.has(next) || visited.size >= 53) return 53;
      visited.add(next);
      const row = this.db.prepare(`SELECT base_sha256 FROM ${this.table} WHERE sha256=?`).get(next);
      if (!row || (row.base_sha256 !== null && typeof row.base_sha256 !== 'string')) throw this.invalid();
      next = row.base_sha256 as string | null;
    }
    return visited.size;
  }
  ensure(bytes: Uint8Array, base?: string): string {
    const sha = payloadHash(bytes);
    if (this.db.prepare(`SELECT 1 FROM ${this.table} WHERE sha256=?`).get(sha)) {
      if (!this.read(sha).equals(bytes)) throw this.invalid();
      return sha;
    }
    let payload = deflateSync(bytes), codec = 'deflate', baseSha: string | null = null;
    // Fossil's counters are unsigned 32-bit. Larger records use full frames.
    if (base && this.ancestry(base) < 53 && bytes.length < 0x80000000) {
      const baseBytes = this.read(base);
      if (baseBytes.length < 0x80000000) {
        const delta = createDelta(baseBytes, bytes);
        if (!Buffer.from(applyDelta(baseBytes, delta)).equals(bytes)) throw this.invalid();
        const candidate = deflateSync(delta);
        if (candidate.length < payload.length) { payload = candidate; codec = 'fossil-deflate'; baseSha = base; }
      }
    }
    this.db.prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?,?,0)`).run(sha, baseSha, bytes.length, codec, payload);
    if (baseSha) this.retain(baseSha);
    return sha;
  }
  retain(sha: string) {
    if (!this.db.prepare(`UPDATE ${this.table} SET refs=refs+1 WHERE sha256=?`).run(sha).changes) throw this.invalid();
  }
  release(sha: string) {
    let next: string | undefined = sha; const visited = new Set<string>();
    while (next) {
      if (visited.has(next) || visited.size >= 53) throw this.invalid();
      visited.add(next);
      const changed = this.db.prepare(`UPDATE ${this.table} SET refs=refs-1 WHERE sha256=? AND refs>0`).run(next);
      if (!changed.changes) throw this.invalid();
      const row: Record<string, unknown> = this.db.prepare(`SELECT refs,base_sha256 FROM ${this.table} WHERE sha256=?`).get(next)!;
      if (row.refs !== 0) return;
      this.db.prepare(`DELETE FROM ${this.table} WHERE sha256=?`).run(next);
      next = typeof row.base_sha256 === 'string' ? row.base_sha256 : undefined;
    }
  }
}
