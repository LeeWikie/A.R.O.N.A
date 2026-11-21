import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from './domain.js';

const metadataSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(240), mediaType: z.enum(['text/plain', 'application/octet-stream']), bytes: z.number().int().positive().max(16 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(), purpose: z.literal('client-shell-output'), originalAssetIds:z.array(z.string().uuid()).optional() }).strict();
export type InputAssetMetadata = z.infer<typeof metadataSchema>;
const intentSchema = z.object({ version: z.literal(1), metadata: metadataSchema, temporary: z.string().regex(/^[a-f0-9-]+\.part$/).optional(), identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().optional() }).strict();
type Intent = z.infer<typeof intentSchema>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** An upload receipt publishes immutable user data, never execution or tool permissions. */
export class InputAssetUploads {
  private readonly identity: { dev: bigint; ino: bigint };
  constructor(private readonly db: DatabaseSync, private readonly directory: string) {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('asset_directory_redirected', 403);
    this.identity = { dev: stat.dev, ino: stat.ino };
    db.exec('CREATE TABLE IF NOT EXISTS input_asset_uploads(id TEXT PRIMARY KEY,request TEXT NOT NULL,body TEXT NOT NULL);');
  }
  private boundary() {
    const stat = fs.lstatSync(this.directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw new AppError('asset_directory_redirected', 403);
  }
  private transaction<T>(action: () => T) {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private stat(file: string) { try { return fs.lstatSync(file, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } }
  private matches(stat: fs.BigIntStats, identity: NonNullable<Intent['identity']>) { return stat.isFile() && !stat.isSymbolicLink() && stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino; }
  private verify(file: string, intent: Intent, expectedLinks: bigint) {
    const before = this.stat(file);
    if (!before || !intent.identity || !this.matches(before, intent.identity) || before.nlink !== expectedLinks || before.size !== BigInt(intent.metadata.bytes)) throw new AppError('asset_changed', 409);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!this.matches(opened, intent.identity) || opened.nlink !== expectedLinks || opened.size !== before.size) throw new AppError('asset_changed', 409);
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), visible = this.stat(file);
      if (sha(bytes) !== intent.metadata.sha256 || !visible || !this.matches(visible, intent.identity) || visible.nlink !== expectedLinks || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs) throw new AppError('asset_changed', 409);
      this.boundary();
    } finally { fs.closeSync(fd); }
  }
  publish(input: InputAssetMetadata, bytes: Uint8Array): InputAssetMetadata {
    const metadata = metadataSchema.parse(input);
    if (bytes.byteLength !== metadata.bytes || sha(bytes) !== metadata.sha256) throw new AppError('asset_integrity_mismatch', 409);
    this.boundary();
    const request = JSON.stringify([metadata.id, metadata.name, metadata.mediaType, metadata.bytes, metadata.sha256, metadata.purpose,metadata.originalAssetIds??[]]);
    const prior = this.db.prepare('SELECT request,body FROM input_asset_uploads WHERE id=?').get(metadata.id);
    if (prior && prior.request !== request) throw new AppError('asset_operation_conflict', 409);
    let intent: Intent = prior ? intentSchema.parse(JSON.parse(String(prior.body))) : { version: 1, metadata };
    if (!prior) {
      if (this.db.prepare('SELECT id FROM asset_records WHERE id=?').get(metadata.id) || this.stat(path.join(this.directory, metadata.id))) throw new AppError('asset_operation_conflict', 409);
      this.db.prepare('INSERT INTO input_asset_uploads VALUES(?,?,?)').run(metadata.id, request, JSON.stringify(intent));
    }
    const target = path.join(this.directory, metadata.id), visible = this.stat(target);
    let temporary = intent.temporary ? path.join(this.directory, intent.temporary) : undefined, original = temporary ? this.stat(temporary) : undefined;
    if (visible) {
      const paired = Boolean(original && intent.identity && this.matches(original, intent.identity) && this.matches(visible, intent.identity));
      this.verify(target, intent, paired ? 2n : 1n);
      if (paired && temporary) { this.verify(temporary, intent, 2n); fs.unlinkSync(temporary); }
    } else {
      if (temporary && original) this.verify(temporary, intent, 1n);
      else {
        const name = `${metadata.id}-${randomUUID()}.part`; temporary = path.join(this.directory, name);
        const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); original = fs.fstatSync(fd, { bigint: true }); }
        finally { fs.closeSync(fd); }
        if (!original || !original.isFile() || original.nlink !== 1n) throw new AppError('asset_changed', 409);
        intent = { ...intent, temporary: name, identity: { dev: original.dev.toString(), ino: original.ino.toString() } };
        this.db.prepare('UPDATE input_asset_uploads SET body=? WHERE id=?').run(JSON.stringify(intent), metadata.id);
      }
      this.boundary(); this.verify(temporary, intent, 1n);
      fs.linkSync(temporary, target);
      this.verify(target, intent, 2n); this.verify(temporary, intent, 2n); fs.unlinkSync(temporary);
    }
    this.verify(target, intent, 1n);
    this.transaction(() => {
      const existing = this.db.prepare('SELECT body FROM asset_records WHERE id=?').get(metadata.id);
      if (existing && !isDeepStrictEqual(JSON.parse(String(existing.body)), intent.metadata)) throw new AppError('asset_operation_conflict', 409);
      if (!existing) this.db.prepare('INSERT INTO asset_records VALUES(?,?)').run(metadata.id, JSON.stringify(intent.metadata));
    });
    return intent.metadata;
  }
}
