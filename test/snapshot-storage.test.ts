import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';
import { SnapshotStorage, prepareSnapshotStorage } from '../src/storage/snapshots.js';
import { removeTemp, until } from './helpers.js';

const encoded = (value: unknown) => ({ format: 'v8', data: serialize(value).toString('base64') });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-snapshot-storage-'));
  const file = path.join(directory, 'records.sqlite'), db = new DatabaseSync(file), runtime = new RuntimeStore(db);
  db.exec('PRAGMA journal_mode=WAL');
  return { directory, file, db, runtime, async close() { db.close(); await removeTemp(directory); } };
}

test('snapshots retain exact V8 bytes, aliases, cycles, binary views and provenance through writes, branches and a cold reopen', async () => {
  const f = fixture(); const saved = new Map<string, ReturnType<typeof encoded>>();
  try {
    const shared = { text: '中文\n  keep spaces  ', buffer: randomBytes(32768) };
    const circular: Record<string, unknown> = { shared }; circular.self = circular;
    for (let index = 1; index <= 65; index++) {
      const body = encoded({ contextId: 'main', runId: `run-${index}`, sequence: index, prompt: [shared, shared], nativeMessages: { circular, history: Array.from({ length: index }, (_, n) => ({ id: `source-${n}`, content: `${n} ${shared.text}`, bytes: shared.buffer })) }, date: new Date(0), map: new Map([[shared, new Set([shared])]]), missing: undefined, big: 2n ** 65n });
      saved.set(`run-${index}`, body); f.runtime.snapshot('main', `run-${index}`, body);
    }
    const branch = encoded({ contextId: 'branch', sourceRunId: 'run-20', sourceId: 'unchanged', message: 'branch body' });
    f.runtime.snapshot('branch', 'branch-run', branch); saved.set('branch-run', branch);
    const reopened = new DatabaseSync(f.file, { readOnly: true });
    try {
      const storage = new SnapshotStorage(reopened);
      for (const [run, body] of saved) {
        const raw = JSON.parse(String(reopened.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get(run)!.body));
        const actual = storage.materialize(raw) as ReturnType<typeof encoded>;
        assert.deepEqual(actual, body); assert.ok(Buffer.from(actual.data, 'base64').equals(Buffer.from(body.data, 'base64')));
      }
    } finally { reopened.close(); }
    const value = deserialize(Buffer.from((f.runtime.getSnapshot('run-65')!.body as ReturnType<typeof encoded>).data, 'base64'));
    assert.equal(value.prompt[0], value.prompt[1]); assert.equal(value.nativeMessages.circular.self, value.nativeMessages.circular); assert.equal([...value.map.keys()][0], value.prompt[0]);
    assert.throws(() => f.runtime.snapshot('foreign', 'run-65', encoded('wrong owner')), /snapshot_context_conflict/);
  } finally { await f.close(); }
});

test('replacing one run retains referenced bases but releases superseded private versions, and an event failure rolls back the archive', async () => {
  const f = fixture();
  try {
    const first = encoded({ text: 'A'.repeat(100000), source: 'first' });
    f.runtime.snapshot('main', '1', first); f.runtime.snapshot('main', '2', encoded({ text: 'B'.repeat(100000) }));
    const third = encoded({ text: 'B'.repeat(100000), source: 'third' }); f.runtime.snapshot('main', '3', third);
    for (let index = 0; index < 20; index++) f.runtime.snapshot('main', '1', encoded({ text: `replacement-${index}` }));
    assert.deepEqual(f.runtime.getSnapshot('3')!.body, third); assert.ok(Number(f.db.prepare('SELECT COUNT(*) AS count FROM snapshot_payloads').get()!.count) <= 4);
    const before = f.runtime.getSnapshot('1');
    f.db.exec("CREATE TRIGGER reject_snapshot_event BEFORE INSERT ON runtime_events WHEN NEW.kind='context_snapshot' BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END");
    assert.throws(() => f.runtime.archiveSnapshot('main', '1', first, { sequence: 1, sha256: 'synthetic' }), /synthetic event failure/);
    assert.deepEqual(f.runtime.getSnapshot('1'), before);
  } finally { await f.close(); }
});

test('missing, altered or cyclic data is rejected instead of returning a shortened or fabricated historical prompt', async () => {
  const f = fixture();
  try {
    f.runtime.snapshot('main', '1', encoded({ text: randomBytes(50000) }));
    const row = f.db.prepare('SELECT * FROM snapshot_payloads').get()!;
    f.db.prepare('UPDATE snapshot_payloads SET payload=? WHERE sha256=?').run(Buffer.from('corrupt'), String(row.sha256));
    assert.throws(() => f.runtime.getSnapshot('1'), /context_snapshot_corrupt/);
    f.db.prepare("UPDATE snapshot_payloads SET payload=?,codec='fossil-deflate',base_sha256=sha256 WHERE sha256=?").run(row.payload as Uint8Array, String(row.sha256));
    assert.throws(() => f.runtime.getSnapshot('1'), /context_snapshot_corrupt/);
    f.db.exec('DELETE FROM snapshot_payloads'); assert.throws(() => f.runtime.getSnapshot('1'), /context_snapshot_corrupt/);
  } finally { await f.close(); }
});

test('a consistent old-data backup precedes migration; failed migration rolls back, and legacy restoration preserves original bodies and ledger hashes', async () => {
  const f = fixture(); const originals: Array<{ run: string; body: ReturnType<typeof encoded> }> = [];
  try {
    for (let index = 0; index < 25; index++) {
      const row = { run: `legacy-${index}`, body: encoded({ runId: `legacy-${index}`, prompt: Array.from({ length: index + 1 }, (_, n) => `original source ${n}`), nativeMessages: { opaque: randomBytes(500) } }) };
      originals.push(row); f.db.prepare('INSERT INTO model_snapshots VALUES(?,?,?)').run(row.run, 'main', JSON.stringify(row.body));
      f.runtime.event({ contextId: 'main', runId: row.run, kind: 'context_snapshot', data: { sha256: createHash('sha256').update(row.body.data).digest('hex') } });
    }
    const events = f.db.prepare('SELECT * FROM runtime_events').all();
    f.db.exec("CREATE TRIGGER reject_snapshot_migration BEFORE UPDATE ON model_snapshots WHEN NEW.run_id='legacy-12' BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END");
    await assert.rejects(prepareSnapshotStorage(f.directory), /synthetic migration failure/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM model_snapshots WHERE json_extract(body,'$.format')='v8'").get()!.count, 25);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM snapshot_payloads').get()!.count, 0);
    f.db.exec('DROP TRIGGER reject_snapshot_migration');
    await prepareSnapshotStorage(f.directory);
    const backupDirectory = path.join(f.directory, 'migration-backups'); const backups = fs.readdirSync(backupDirectory);
    assert.equal(backups.length, 2);
    for (const name of backups) {
      const backupDir = path.join(backupDirectory, name), manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
      const records = manifest.files.find((file: { name: string }) => file.name === 'records.sqlite');
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(backupDir, records.name))).digest('hex'), records.sha256);
      const legacy = new DatabaseSync(path.join(backupDir, records.name), { readOnly: true });
      try { for (const row of originals) assert.deepEqual(JSON.parse(String(legacy.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get(row.run)!.body)), row.body); } finally { legacy.close(); }
    }
    for (const row of originals) assert.deepEqual(f.runtime.getSnapshot(row.run)!.body, row.body);
    assert.deepEqual(f.db.prepare('SELECT * FROM runtime_events').all(), events);
    await prepareSnapshotStorage(f.directory); assert.equal(fs.readdirSync(backupDirectory).length, 2, 'a completed migration does not make another backup');
    new SnapshotStorage(f.db).restoreLegacy();
    for (const row of originals) assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get(row.run)!.body)), row.body);
    assert.deepEqual(f.db.prepare('SELECT * FROM runtime_events').all(), events);
  } finally { await f.close(); }
});

test('a real process death during migration leaves every old snapshot readable; reopening completes migration without changing source evidence', { timeout: 30000 }, async () => {
  const f = fixture(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const bodies = Array.from({ length: 25 }, (_, index) => encoded({ sequence: index, source: `original-${index}`, bytes: randomBytes(1000) }));
    for (const [index, body] of bodies.entries()) f.db.prepare('INSERT INTO model_snapshots VALUES(?,?,?)').run(`original-${index}`, 'main', JSON.stringify(body));
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./snapshot-migration-process.ts', import.meta.url)), f.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; });
    await until(() => { assert.equal(child!.exitCode, null, errors); return output; }, value => value.includes('MIGRATION_TRANSACTION_OPEN'));
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    for (const [index, body] of bodies.entries()) assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get(`original-${index}`)!.body)), body);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM snapshot_payloads').get()!.count, 0);
    await prepareSnapshotStorage(f.directory);
    for (const [index, body] of bodies.entries()) assert.deepEqual(f.runtime.getSnapshot(`original-${index}`)!.body, body);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
    await f.close();
  }
});

test('unreadable legacy records stay untouched and inspectable while healthy records migrate once without repeated backups', async () => {
  const f = fixture();
  try {
    const broken = '{broken JSON', noncanonical = JSON.stringify({ format: 'v8', data: '*** invalid base64 ***' });
    f.db.prepare('INSERT INTO model_snapshots VALUES(?,?,?)').run('broken', 'main', broken);
    f.db.prepare('INSERT INTO model_snapshots VALUES(?,?,?)').run('noncanonical', 'main', noncanonical);
    const healthy = encoded({ text: 'Original healthy context' }); f.db.prepare('INSERT INTO model_snapshots VALUES(?,?,?)').run('healthy', 'other', JSON.stringify(healthy));
    await prepareSnapshotStorage(f.directory); await prepareSnapshotStorage(f.directory);
    assert.equal(fs.readdirSync(path.join(f.directory, 'migration-backups')).length, 1);
    assert.equal(f.db.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get('broken')!.body, broken);
    assert.equal(f.db.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get('noncanonical')!.body, noncanonical);
    assert.throws(() => f.runtime.getSnapshot('broken'), /context_snapshot_corrupt/); assert.throws(() => f.runtime.getSnapshot('noncanonical'), /context_snapshot_corrupt/);
    assert.deepEqual(f.runtime.getSnapshot('healthy')!.body, healthy);
  } finally { await f.close(); }
});

test('a redirected backup directory cannot receive private snapshots or change the original database', async () => {
  const f = fixture();
  try {
    const original = JSON.stringify(encoded({ text: 'Private synthetic original record' }));
    f.db.prepare('INSERT INTO model_snapshots VALUES(?,?,?)').run('original', 'main', original);
    const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'Original outside bytes');
    fs.symlinkSync(outside, path.join(f.directory, 'migration-backups'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareSnapshotStorage(f.directory), /core_directory_redirected/);
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt']); assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'Original outside bytes');
    assert.equal(f.db.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get('original')!.body, original);
  } finally { await f.close(); }
});
