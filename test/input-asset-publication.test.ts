import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { InputAssetUploads, type InputAssetMetadata } from '../src/asset-uploads.js';
import { removeTemp } from './helpers.js';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const metadata = (bytes: Uint8Array): InputAssetMetadata => ({ id: randomUUID(), name: 'client-output.bin', mediaType: 'application/octet-stream', purpose: 'client-shell-output', bytes: bytes.length, sha256: hash(bytes), createdAt: new Date().toISOString() });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-input-asset-publication-')), assets = path.join(directory, 'assets'); fs.mkdirSync(assets, { mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'records.sqlite')); db.exec('CREATE TABLE asset_records(id TEXT PRIMARY KEY,body TEXT NOT NULL);');
  return { directory, assets, db, store: new InputAssetUploads(db, assets), async close() { db.close(); await removeTemp(directory); } };
}
test('an input data publication is idempotent, byte-exact and rejects changed requests or foreign files and links', async () => {
  const f = fixture(), bytes = Buffer.from(Array.from({ length: 320003 }, (_, i) => i % 256)), original = metadata(bytes);
  try {
    assert.deepEqual(f.store.publish(original, bytes), original); assert.deepEqual(f.store.publish({ ...original, createdAt: new Date(Date.now() + 10000).toISOString() }, bytes), original);
    assert.deepEqual(fs.readFileSync(path.join(f.assets, original.id)), bytes); assert.equal(fs.statSync(path.join(f.assets, original.id)).nlink, 1); assert.equal(Number(f.db.prepare('SELECT count(*) n FROM asset_records').get()!.n), 1);
    assert.throws(() => f.store.publish({ ...original, name: 'changed.bin' }, bytes), /asset_operation_conflict/);
    assert.throws(() => f.store.publish(original, Buffer.from('changed')), /asset_integrity_mismatch/);
    const other = metadata(bytes), foreign = path.join(f.assets, other.id); fs.writeFileSync(foreign, 'FOREIGN_ORIGINAL'); assert.throws(() => f.store.publish(other, bytes), /asset_operation_conflict/); assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN_ORIGINAL');
    const linked = path.join(f.directory, 'foreign-link'); fs.linkSync(path.join(f.assets, original.id), linked); assert.throws(() => f.store.publish(original, bytes), /asset_changed/); fs.unlinkSync(linked);
    fs.writeFileSync(path.join(f.assets, original.id), Buffer.alloc(bytes.length, 1)); assert.throws(() => f.store.publish(original, bytes), /asset_changed/); assert.equal(Number(f.db.prepare('SELECT count(*) n FROM asset_records').get()!.n), 1);
  } finally { await f.close(); }
});
test('a real SIGKILL in the link publication gap recovers only the exact owned pair and preserves the original receipt', { timeout: 15000 }, async () => {
  const f = fixture(), bytes = Buffer.from(Array.from({ length: 200003 }, (_, i) => i % 256)), original = metadata(bytes); f.db.close();
  fs.writeFileSync(path.join(f.directory, 'metadata.json'), JSON.stringify(original)); fs.writeFileSync(path.join(f.directory, 'original.bin'), bytes);
  const child = fork(fileURLToPath(new URL('./input-asset-publication-fixture.ts', import.meta.url)), { execArgv: ['--import', 'tsx'], env: { ...process.env, ASSET_PUBLICATION_DIRECTORY: f.directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let reopened: DatabaseSync | undefined, timer: ReturnType<typeof setTimeout> | undefined, errors = '';
  child.stderr?.on('data', chunk => { errors += String(chunk).slice(-2000); });
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(`publication fixture exited: ${errors}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`publication fixture timeout: ${errors}`)), 8000); })]); clearTimeout(timer);
    assert.equal(fs.statSync(path.join(f.assets, original.id)).nlink, 2); const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    reopened = new DatabaseSync(path.join(f.directory, 'records.sqlite')); assert.equal(Number(reopened.prepare('SELECT count(*) n FROM asset_records').get()!.n), 0);
    const store = new InputAssetUploads(reopened, f.assets), receipt = store.publish({ ...original, createdAt: new Date(Date.now() + 10000).toISOString() }, bytes);
    assert.deepEqual(receipt, original); assert.deepEqual(fs.readFileSync(path.join(f.assets, original.id)), bytes); assert.equal(fs.statSync(path.join(f.assets, original.id)).nlink, 1); assert.equal(Number(reopened.prepare('SELECT count(*) n FROM asset_records').get()!.n), 1); assert.deepEqual(store.publish(original, bytes), original);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; } reopened?.close(); await removeTemp(f.directory); }
});
