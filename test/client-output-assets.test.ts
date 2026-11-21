import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { Assets } from '../src/assets.js';
import { removeTemp } from './helpers.js';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
test('client output data keeps exact binary bytes and retry identity without entering the native prompt as a file or encoded body', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-client-output-')), db = new DatabaseSync(':memory:'), assets = new Assets(db, directory);
  const bytes = Buffer.from(Array.from({ length: 200003 }, (_, i) => i % 256)), id = randomUUID(), options = { purpose: 'client-shell-output' as const, id, bytes: bytes.length, sha256: sha(bytes) };
  try {
    await assert.rejects(assets.put(stream(bytes), 'ordinary.bin'), /asset_type_not_supported/);
    const first = await assets.put(stream(bytes), 'client.bin', undefined, options), retried = await assets.put(stream(bytes), 'client.bin', undefined, options);
    assert.deepEqual(retried, first); assert.equal(first.id, id); assert.equal(first.mediaType, 'application/octet-stream'); assert.equal(first.purpose, 'client-shell-output'); assert.deepEqual((await assets.read(id)).bytes, bytes);
    const prompt = await assets.contents('Original user message', [id]); assert.ok(Array.isArray(prompt)); assert.equal(prompt.some(part => part.type === 'file'), false); assert.match(JSON.stringify(prompt), /user-supplied-data/); assert.equal(JSON.stringify(prompt).includes(bytes.toString('base64')), false);
    const page = await assets.readAttachment(id, { encoding: 'base64', byteOffset: 32000, maxBytes: 32768 }); assert.deepEqual(Buffer.from(page.content, 'base64'), bytes.subarray(32000, 64768)); assert.equal(page.source.purpose, 'client-shell-output');
    await assert.rejects(assets.put(stream(Buffer.from('changed')), 'client.bin', undefined, options), /asset_integrity_mismatch/);
    await assert.rejects(assets.put(stream(bytes), 'renamed.bin', undefined, options), /asset_operation_conflict/);
    assert.equal(Number(db.prepare('SELECT count(*) n FROM asset_records').get()!.n), 1);
  } finally { await assets.close(); db.close(); await removeTemp(directory); }
});
test('historical references resolve only inside the proven current asset set and retain digest ambiguity checks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-client-output-alias-')), db = new DatabaseSync(':memory:'), assets = new Assets(db, directory), original = randomUUID();
  try {
    const first = await assets.put(stream(Buffer.from('first original')), 'first.log', undefined, { purpose: 'client-shell-output', originalAssetIds: [original] });
    const second = await assets.put(stream(Buffer.from('second original')), 'second.log', undefined, { purpose: 'client-shell-output', originalAssetIds: [original] });
    assert.equal(assets.resolveReference(original, [first.id]), first.id); assert.equal(assets.resolveReference(original, [second.id], second.sha256), second.id);
    assert.throws(() => assets.resolveReference(original, []), /attachment_source_not_authorized/); assert.throws(() => assets.resolveReference(original, [first.id, second.id]), /attachment_reference_ambiguous/);
    assert.equal(assets.resolveReference(original, [first.id, second.id], first.sha256), first.id); assert.throws(() => assets.resolveReference(original, [first.id], second.sha256), /attachment_integrity_mismatch/);
    assert.equal(assets.resolveReference(first.id, [first.id]), first.id); assert.throws(() => assets.resolveReference(first.id, [second.id]), /attachment_source_not_authorized/);
  } finally { await assets.close(); db.close(); await removeTemp(directory); }
});
