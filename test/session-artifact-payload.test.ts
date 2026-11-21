import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {SessionArtifactStore,SESSION_ARTIFACT_PART_BYTES} from '../src/session-artifacts.js';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function* source(bytes:Uint8Array){for(let position=0;position<bytes.length;position+=19007)yield bytes.subarray(position,position+19007);}
async function collect(values:AsyncIterable<Uint8Array>){const bytes:Uint8Array[]=[];for await(const value of values)bytes.push(value);return Buffer.concat(bytes);}

test('the shared payload byte layer pages and streams exact immutable bytes without creating a history or granting a binding',async()=>{
 const db=new DatabaseSync(':memory:'),store=new SessionArtifactStore(db),bytes=Buffer.from(Array.from({length:SESSION_ARTIFACT_PART_BYTES*2+1723},(_,index)=>index%251));
 try{
  const payload=await store.captureData(source(bytes));assert.equal(payload.sha256,digest(bytes));assert.equal(Number(db.prepare('SELECT count(*) n FROM session_artifact_bindings').get()!.n),0);
  const page=store.readPayload(payload,{byteOffset:SESSION_ARTIFACT_PART_BYTES-9,maxBytes:32768,encoding:'base64'});assert.deepEqual(Buffer.from(page.content,'base64'),bytes.subarray(SESSION_ARTIFACT_PART_BYTES-9,SESSION_ARTIFACT_PART_BYTES-9+32768));assert.equal(page.nextByteOffset,SESSION_ARTIFACT_PART_BYTES-9+32768);assert.equal(page.complete,false);assert.deepEqual(await collect(store.payloadChunks(payload)),bytes);
  assert.throws(()=>store.readPayload({...payload,bytes:payload.bytes+1}),/invalid_session_artifact/);assert.throws(()=>store.readPayload({...payload,parts:[{...payload.parts[0]!,bytes:7},...payload.parts.slice(1)]}),/invalid_session_artifact/);
  await assert.rejects(collect(store.payloadChunks({...payload,sha256:'0'.repeat(64)})),/session_artifact_changed/);
  const small=await store.captureData(source(Buffer.from('中文原文')));assert.throws(()=>store.readPayload(small,{maxBytes:1}),/session_artifact_requires_base64/);assert.equal(store.readPayload(small,{encoding:'base64',maxBytes:1}).content,Buffer.from('中').subarray(0,1).toString('base64'));assert.equal(store.readPayload(small).complete,true);assert.equal(store.readPayload(small).content,'中文原文');
  assert.throws(()=>store.readPayload({...small,sha256:'0'.repeat(64)}),/session_artifact_changed/);assert.throws(()=>store.readPayload(small,{maxBytes:32769}),/invalid_session_artifact_page/);
  db.prepare('UPDATE session_artifact_chunks SET content=? WHERE sha256=?').run(Buffer.alloc(small.bytes),small.parts[0]!.sha256);assert.throws(()=>store.readPayload(small),/session_artifact_changed/);
 }finally{db.close();}
});

test('payload streaming aborts without claiming that an incomplete aggregate was verified',async()=>{
 const db=new DatabaseSync(':memory:'),store=new SessionArtifactStore(db),bytes=Buffer.alloc(SESSION_ARTIFACT_PART_BYTES*2+1,3),controller=new AbortController();
 try{const payload=await store.captureData(source(bytes)),iterator=store.payloadChunks(payload,controller.signal);assert.equal((await iterator.next()).value?.byteLength,SESSION_ARTIFACT_PART_BYTES);controller.abort();await assert.rejects(iterator.next(),/abort/i);assert.throws(()=>store.readPayload(payload,{},controller.signal),/abort/i);}
 finally{db.close();}
});
