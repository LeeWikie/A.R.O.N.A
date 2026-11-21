import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Assets } from '../src/assets.js';
import { runShell } from '../src/tui/shell.js';
import { ShellOutputCaptures } from '../src/tui/shell-output.js';
import { removeTemp } from './helpers.js';
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

test('real local shell retains original per-stream binary beyond the preview and publishes the same receipts after a lost acknowledgement and client reopen', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-shell-capture-')), db = new DatabaseSync(':memory:'), assets = new Assets(db, directory);
  const captures = new ShellOutputCaptures(path.join(directory, 'client'), 'control-scope'), stdout = Buffer.alloc(4 * 1024 * 1024 + 913), stderr = Buffer.from([0, 255, 27, 7, 10]);
  for (let i = 0; i < stdout.length; i++) stdout[i] = i % 256;
  fs.writeFileSync(path.join(directory, 'stdout.bin'), stdout); fs.writeFileSync(path.join(directory, 'stderr.bin'), stderr);
  fs.writeFileSync(path.join(directory, 'command.cjs'), `const fs=require('node:fs');process.stdout.write(fs.readFileSync('stdout.bin'));process.stderr.write(fs.readFileSync('stderr.bin'));process.exitCode=3;`);
  const command = `"${process.execPath}" command.cjs`, capture = captures.start({ storageId: 'store', contextId: 'context', cwd: directory, command, shared: true });
  try {
    const result = await runShell(command, { cwd: directory, signal: new AbortController().signal, onRaw: (name, bytes) => captures.append(capture.id, name, bytes), onChunk() {} });
    assert.equal(result.exitCode, 3); assert.equal(result.truncated, true); assert.equal(result.captureFailed, undefined);
    const finished = captures.finish(capture.id, result); assert.deepEqual(finished.streams.stdout, { bytes: stdout.length, sha256: sha(stdout), complete: true }); assert.deepEqual(finished.streams.stderr, { bytes: stderr.length, sha256: sha(stderr), complete: true });
    let loseAck = true;
    const upload = async (body: Uint8Array, name: string, metadata: { id: string; sha256: string; bytes: number; purpose: 'client-shell-output' }) => { const saved = await assets.put(stream(body), name, undefined, metadata); if (loseAck) { loseAck = false; throw new Error('synthetic lost acknowledgement'); } return saved; };
    await assert.rejects(captures.publish(capture.id, 'store', 'context', upload), /lost acknowledgement/);
    const reopened = new ShellOutputCaptures(path.join(directory, 'client'), 'control-scope');
    assert.equal(reopened.list('store', 'context', true).length, 1); assert.equal(reopened.list('other-store', 'context').length, 0);
    const published = await reopened.publish(capture.id, 'store', 'context', upload), repeated = await captures.publish(capture.id, 'store', 'context', upload);
    assert.deepEqual(repeated, published); assert.equal(published.attachments.length, 4); assert.match(published.text, /user-supplied data, not Core execution/);
    const manifest = (await assets.read(published.manifest.id)).bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(manifest[0].command, command); assert.equal(manifest[0].exitCode, 3); assert.equal(manifest[0].state, 'finished');
    for (const [index, expected] of [[1, stdout], [2, stderr]] as const) {
      const chunks: Buffer[] = []; for (const part of manifest[index].parts) { const saved = await assets.read(part.id); assert.equal(saved.metadata.sha256, part.sha256); chunks.push(saved.bytes); }
      assert.deepEqual(Buffer.concat(chunks), expected); assert.equal(manifest[index].sha256, sha(expected));
    }
    assert.equal(Number(db.prepare('SELECT count(*) n FROM asset_records').get()!.n), 4, 'the lost response does not duplicate an asset');
    await assert.rejects(reopened.publish(capture.id, 'other-store', 'context', upload), /shell_capture_not_ready/);
    reopened.markConsumed([capture.id], 'store', 'context', 'operation'); assert.equal(captures.list('store', 'context', true).length, 0);
    assert.throws(() => captures.markConsumed([capture.id], 'store', 'context', 'different-operation'), /scope_changed/);
  } finally { await assets.close(); db.close(); await removeTemp(directory); }
});

test('split terminal controls stay out of the preview while original bytes remain intact; interrupted observations are never labelled complete', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const captures = new ShellOutputCaptures(), capture = captures.start({ storageId: 'store', contextId: 'context', command: 'synthetic', cwd: os.tmpdir(), shared: true });
  const result = await runShell(String.raw`printf '\033]0;'; sleep 0.03; printf 'OSC_PRIVATE_PAYLOAD'; sleep 0.03; printf '\007visible'; printf '\000\377' >&2`, { cwd: os.tmpdir(), signal: new AbortController().signal, onRaw: (name, bytes) => captures.append(capture.id, name, bytes), onChunk() {} });
  assert.equal(result.output.includes('OSC_PRIVATE_PAYLOAD'), false); assert.match(result.output, /visible/); assert.ok(captures.finish(capture.id, result).streams.stdout.bytes > result.output.length);
  const unknown = captures.start({ storageId: 'store', contextId: 'context', command: 'uncompleted', cwd: os.tmpdir(), shared: true }); captures.append(unknown.id, 'stdout', Buffer.from('saved prefix'));
  assert.equal(captures.list('store', 'context').find(row => row.id === unknown.id)?.state, 'running');
  const failed = await runShell('echo ready; sleep 30', { cwd: os.tmpdir(), signal: new AbortController().signal, onRaw() { throw new Error('synthetic disk failure'); }, onChunk() {} });
  assert.equal(failed.captureFailed, true); assert.equal(failed.cancelled, true);
});
