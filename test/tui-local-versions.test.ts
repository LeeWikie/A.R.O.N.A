import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QueueLocalEdits, type QueueLocalEdit } from '../src/tui/queue-local-edits.js';
import { removeTemp } from './helpers.js';

function record(): QueueLocalEdit {
  const entryId = randomUUID();
  return { storageId: 'synthetic-store', contextId: 'main', draftId: randomUUID(), entryId, baseRevision: 1,
    base: { id: entryId, content: 'original', attachments: [], sourceSignalIds: [randomUUID()], removed: false, captureDraftId: randomUUID(), captureInputDetached: false, captureInputUnconfirmed: true },
    content: 'edited', attachments: [], pending: { operationId: randomUUID(), baseRevision: 1, content: 'edited', attachments: [], localContext: 'observed shell output' }, updatedAt: new Date().toISOString() };
}

test('two local terminal instances preserve independent offline versions of the same queue entry and acknowledge only their own confirmed input', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-local-versions-'));
  try {
    const first = new QueueLocalEdits(directory, 'authenticated-core'), second = new QueueLocalEdits(directory, 'authenticated-core'), input = record();
    const a = first.save({ ...input, content: 'first offline answer', pending: { ...input.pending!, content: 'first offline answer' } }), b = second.save({ ...input, content: 'second offline answer', pending: { ...input.pending!, content: 'second offline answer' } });
    assert.notEqual(a.localId, b.localId); assert.equal(first.current(input, input.entryId)?.content, a.content); assert.equal(second.current(input, input.entryId)?.content, b.content);
    assert.deepEqual(new Set(first.list(input).map(row => row.content)), new Set([a.content, b.content]));
    assert.equal(first.acknowledge(input, input.entryId, a), true);
    assert.equal(second.current(input, input.entryId)?.content, b.content); assert.deepEqual(first.list(input).map(row => row.content), [b.content]);
    assert.throws(() => first.save(b), /queue_local_version_not_owned/);
  } finally { await removeTemp(directory); }
});

test('an old HTTP acknowledgement cannot erase a newer edit or operation, and adoption preserves the source version', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-local-versions-'));
  try {
    const first = new QueueLocalEdits(directory, 'authenticated-core'), input = record(), pending = first.save(input);
    const newer = first.save({ ...pending, content: 'newer unsent text', pending: { ...pending.pending!, operationId: randomUUID() } });
    assert.equal(first.acknowledge(input, input.entryId, pending), false); assert.equal(first.current(input, input.entryId)?.content, newer.content);
    const reopened = new QueueLocalEdits(directory, 'authenticated-core'); assert.equal(reopened.current(input, input.entryId), undefined);
    const adopted = reopened.adopt(newer); assert.notEqual(adopted.localId, newer.localId); assert.equal(reopened.current(input, input.entryId)?.localId, adopted.localId);
    reopened.remove(input, input.entryId); assert.deepEqual(first.list(input).map(row => row.localId), [newer.localId]);
  } finally { await removeTemp(directory); }
});

test('large version blobs preserve Unicode and host material independently across reopen and deletion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-local-versions-'));
  try {
    const input = record(), a = new QueueLocalEdits(directory, 'authenticated-core'), b = new QueueLocalEdits(directory, 'authenticated-core');
    const text = '分片😀'.repeat(40000);
    const first = a.save({ ...input, content: text }), second = b.save({ ...input, content: text + '另一版本', pending: { ...input.pending!, localContext: 'different host observations' } });
    const recovered = new QueueLocalEdits(directory, 'authenticated-core').list(input); assert.equal(recovered.length, 2); assert.equal(recovered.find(row => row.localId === first.localId)?.content, text);
    a.remove(input, input.entryId); assert.equal(b.current(input, input.entryId)?.content, second.content); assert.equal(b.list(input)[0]!.pending?.localContext, 'different host observations');
    assert.deepEqual(b.list({ ...input, storageId: 'another-store' }), []);
  } finally { await removeTemp(directory); }
});

test('an unavailable private directory keeps the newest input and operation in memory until Core confirmation',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-local-write-failure-'));
  try{
    const redirected=path.join(directory,'client'),outside=path.join(directory,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,redirected);
    const cache=new QueueLocalEdits(redirected,'authenticated-core'),input=record();assert.throws(()=>cache.save(input),/queue_local_directory_redirected/);
    const first=cache.current(input,input.entryId)!;assert.equal(first.content,input.content);assert.equal(first.pending?.operationId,input.pending?.operationId);assert.equal(cache.hasUnpersisted(input.storageId),true);
    const newer={...first,content:'newer 中文😀',pending:{...first.pending!,operationId:randomUUID(),content:'newer 中文😀'}};assert.throws(()=>cache.save(newer),/queue_local_directory_redirected/);
    assert.equal(cache.acknowledge(input,input.entryId,first),false,'a late acknowledgement cannot erase later memory input');assert.equal(cache.current(input,input.entryId)?.content,newer.content);assert.equal(cache.storageProblem(),true);assert.deepEqual(fs.readdirSync(outside),[],'a redirected directory receives no private input');
    fs.unlinkSync(redirected);fs.mkdirSync(redirected);const saved=cache.save(cache.current(input,input.entryId)!);assert.equal(cache.hasUnpersisted(input.storageId),false);assert.equal(new QueueLocalEdits(redirected,'authenticated-core').list(input)[0]!.content,newer.content);assert.equal(cache.acknowledge(input,input.entryId,saved),true);assert.equal(cache.current(input,input.entryId),undefined);
  }finally{await removeTemp(directory);}
});

test('known endpoint queue files remain discoverable after stable identity migration without changing their original bytes',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-local-legacy-address-'));try{
  const endpoint='http://127.0.0.1:4111',legacy=new QueueLocalEdits(directory,endpoint),input=record(),original=legacy.save(input),files=new Map(fs.readdirSync(directory).map(name=>[name,fs.readFileSync(path.join(directory,name))]));
  const current=new QueueLocalEdits(directory,'authenticated-core',[endpoint]);assert.deepEqual(current.list(input),[original]);assert.deepEqual(new QueueLocalEdits(directory,'another-core',['http://127.0.0.1:4222']).list(input),[]);assert.deepEqual(current.list({...input,storageId:'another-storage'}),[]);
  const adopted=current.adopt(original);assert.notEqual(adopted.localId,original.localId);assert.equal(current.acknowledge(input,input.entryId,adopted),true);for(const[name,bytes]of files)assert.deepEqual(fs.readFileSync(path.join(directory,name)),bytes);assert.deepEqual(new QueueLocalEdits(directory,'authenticated-core',[endpoint]).list(input),[original]);
 }finally{await removeTemp(directory);}
});
