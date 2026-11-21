import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ImmutablePayloadStorage, type ImmutablePayloadReference } from '../src/storage/immutable-payloads.js';
import { payloadBaseOrdinal } from '../src/storage/delta-payloads.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { removeTemp, until } from './helpers.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-immutable-bytes-'));
  const file = path.join(directory, 'records.sqlite'), db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const storage = new ImmutablePayloadStorage(db);
  return { directory, file, db, storage, async close() { db.close(); await removeTemp(directory); } };
}

test('immutable byte versions keep every original prefix edit compact and exact after a cold reopen', async () => {
  const f = fixture();
  try {
    const original = randomBytes(240003), versions: Array<{ reference: ImmutablePayloadReference; bytes: Buffer }> = [];
    for (let index = 0; index < 65; index++) {
      const bytes = Buffer.from(original); bytes.writeUInt32LE(index);
      versions.push({ bytes, reference: f.storage.put('queue-entry-parts', 'entry:content:0', `version:${index}`, bytes) });
    }
    const stored = Number(f.db.prepare('SELECT SUM(length(payload)) AS bytes FROM immutable_payloads').get()!.bytes);
    assert.ok(stored < original.length * 10, `${stored} stored bytes for ${versions.length} almost-identical original versions`);
    const reopened = new DatabaseSync(f.file, { readOnly: true });
    try {
      const storage = new ImmutablePayloadStorage(reopened);
      for (const { reference, bytes } of versions) assert.deepEqual(storage.read(reference), bytes);
    } finally { reopened.close(); }
    for (const ordinal of [1, 2, 3, 4, 7, 8, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      let next = ordinal, depth = 0;
      while (next) { next = payloadBaseOrdinal(next); depth++; }
      assert.ok(depth <= 53);
    }
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='model_snapshots'").get(), undefined);
  } finally { await f.close(); }
});

test('opaque V8 values, empty bytes, isolated identities and duplicate receipts are lossless and immutable', async () => {
  const f = fixture();
  try {
    const shared = { text: '中文\r\n \ud800 x \udc00 ', binary: randomBytes(8192) };
    const value: Record<string, unknown> = { shared, alias: shared, missing: undefined, big: 2n ** 70n, map: new Map([[shared, new Date(0)]]) }; value.self = value;
    const bytes = serialize(value), reference = f.storage.put('draft-private', 'entry', 'original', bytes);
    assert.deepEqual(f.storage.put('draft-private', 'entry', 'original', bytes), reference);
    assert.throws(() => f.storage.put('draft-private', 'entry', 'original', serialize('changed')), /immutable_payload_conflict/);
    assert.throws(() => f.storage.put('draft-private', 'other-entry', 'original', bytes), /immutable_payload_conflict/);
    const other = f.storage.put('shell-private', 'entry', 'original', serialize('independent'));
    assert.equal(deserialize(f.storage.read(other)), 'independent');
    assert.throws(() => f.storage.read({ ...reference, namespace: other.namespace }), /immutable_payload_corrupt/);
    assert.throws(() => f.storage.read({ ...reference, id: 'missing' }), /immutable_payload_corrupt/);
    assert.throws(() => f.storage.read({ ...reference, size: reference.size - 1 }), /immutable_payload_corrupt/);
    const restored = deserialize(f.storage.read(reference));
    assert.equal(restored.self, restored); assert.equal(restored.shared, restored.alias); assert.equal([...restored.map.keys()][0], restored.shared);
    assert.equal(restored.shared.text, shared.text); assert.deepEqual(restored.shared.binary, shared.binary);
    const empty = f.storage.put('empty', 'entry', 'original', Buffer.alloc(0));
    assert.deepEqual(f.storage.read(empty), Buffer.alloc(0));
    const runtime = new RuntimeStore(f.db);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM model_snapshots').get()!.n, 0);
    runtime.snapshot('main', 'actual-model-run', { format: 'v8', data: bytes.toString('base64') });
    assert.deepEqual(runtime.getSnapshot('actual-model-run')!.body, { format: 'v8', data: bytes.toString('base64') });
    assert.deepEqual(f.storage.read(reference), bytes);
  } finally { await f.close(); }
});

test('a rejected enclosing receipt rolls back both payload and references, preserving earlier versions', async () => {
  const f = fixture();
  try {
    const runtime = new RuntimeStore(f.db), first = f.storage.put('queue', 'entry', '1', randomBytes(100000));
    const rows = f.db.prepare('SELECT * FROM immutable_payloads').all(), records = f.db.prepare('SELECT * FROM immutable_payload_records').all();
    f.db.exec("CREATE TRIGGER reject_payload_receipt BEFORE INSERT ON runtime_settings WHEN NEW.id='failed-receipt' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    assert.throws(() => runtime.operation('failed-operation', { entry: '2' }, () => {
      const next = f.storage.put('queue', 'entry', '2', Buffer.concat([f.storage.read(first), Buffer.from('changed')]));
      runtime.setSetting('failed-receipt', next);
    }), /synthetic receipt failure/);
    assert.deepEqual(f.db.prepare('SELECT * FROM immutable_payloads').all(), rows);
    assert.deepEqual(f.db.prepare('SELECT * FROM immutable_payload_records').all(), records);
    assert.equal(f.storage.get('queue', '2'), undefined);
    assert.equal(f.storage.read(first).length, 100000);
  } finally { await f.close(); }
});

test('altered payload bytes and broken delta ancestry fail without returning partial historical content', async () => {
  const f = fixture();
  try {
    const bytes = randomBytes(100000); f.storage.put('queue', 'entry', '1', bytes);
    const first = f.storage.put('queue', 'entry', '2', bytes);
    const next = Buffer.from(bytes); next.write('changed');
    const second = f.storage.put('queue', 'entry', '3', next);
    const row = f.db.prepare('SELECT * FROM immutable_payloads WHERE sha256=?').get(second.sha256)!;
    assert.equal(row.codec, 'fossil-deflate');
    f.db.prepare('UPDATE immutable_payloads SET base_sha256=sha256 WHERE sha256=?').run(second.sha256);
    assert.throws(() => f.storage.read(second), /immutable_payload_corrupt/);
    f.db.prepare('UPDATE immutable_payloads SET base_sha256=? WHERE sha256=?').run(first.sha256, second.sha256);
    f.db.prepare('UPDATE immutable_payloads SET payload=? WHERE sha256=?').run(Buffer.from('broken'), first.sha256);
    assert.throws(() => f.storage.read(second), /immutable_payload_corrupt/);
    assert.throws(() => f.storage.read(first), /immutable_payload_corrupt/);
    assert.equal(f.storage.get('queue', '3')!.sha256, second.sha256);
  } finally { await f.close(); }
});

test('an owned process killed before commit cannot acknowledge or damage an immutable version', { timeout: 30000 }, async () => {
  const f = fixture(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const bytes = serialize({ text: 'original\ud800\n中文', binary: randomBytes(100000) });
    const first = f.storage.put('queue', 'entry', 'original', bytes);
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./immutable-payloads-process.ts', import.meta.url)), f.file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; });
    await until(() => { assert.equal(child!.exitCode, null, errors); return output; }, value => value.includes('IMMUTABLE_TRANSACTION_OPEN'));
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(f.storage.get('queue', 'uncommitted'), undefined);
    assert.deepEqual(f.storage.read(first), bytes);
    const reopened = new DatabaseSync(f.file);
    try {
      assert.equal(reopened.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
      const storage = new ImmutablePayloadStorage(reopened);
      assert.deepEqual(storage.read(first), bytes);
      const next = storage.put('queue', 'entry', 'uncommitted', serialize('new committed value'));
      assert.equal(deserialize(storage.read(next)), 'new committed value');
    } finally { reopened.close(); }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
    await f.close();
  }
});
