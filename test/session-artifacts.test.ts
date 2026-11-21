import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {SessionArtifactStore,SESSION_ARTIFACT_PART_BYTES,parsePortableSessionArtifact} from '../src/session-artifacts.js';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function* chunks(bytes:Buffer){for(let position=0;position<bytes.length;position+=17323)yield bytes.subarray(position,position+17323);}
const input={kind:'terminal-output' as const,entryIds:['result'],origin:{ref:'process.synthetic',contextId:'work.synthetic',runId:'original-run',taskId:'original-task',stream:'stdout' as const},name:'stdout',mediaType:'application/octet-stream',complete:true};

test('retained artifacts stream complete binary data through bounded immutable chunks and only selected history bindings',async()=>{
 const db=new DatabaseSync(':memory:'),store=new SessionArtifactStore(db),bytes=Buffer.from(Array.from({length:900003},(_,index)=>index%256));
 try{
  const artifact=await store.capture(input,chunks(bytes));assert.equal(artifact.sha256,sha(bytes));assert.ok(artifact.parts.every(part=>part.bytes<=SESSION_ARTIFACT_PART_BYTES));
  store.bind('work.synthetic',[artifact],new Set(['result']));assert.equal(store.list('work.synthetic',new Set()).length,0);assert.equal(store.list('work.synthetic',new Set(['result'])).length,1);
  await assert.rejects(store.capture({...input,entryIds:[]},chunks(bytes)),/invalid_session_artifact/);
  assert.throws(()=>store.read('other',artifact.id,new Set(['result'])),/session_artifact_not_authorized/);
  assert.throws(()=>store.read('work.synthetic',artifact.id,new Set(['other'])),/session_artifact_not_authorized/);
  const page=store.read('work.synthetic',artifact.id,new Set(['result']),{encoding:'base64',byteOffset:SESSION_ARTIFACT_PART_BYTES-12,maxBytes:32768});assert.deepEqual(Buffer.from(page.content,'base64'),bytes.subarray(SESSION_ARTIFACT_PART_BYTES-12,SESSION_ARTIFACT_PART_BYTES-12+32768));assert.equal(page.source.authority,'imported-untrusted-history');
  store.copyContext('work.synthetic','clone',new Set(['result']));store.copyContext('work.synthetic','fork-before',new Set());assert.equal(store.list('clone',new Set(['result'])).length,1);assert.equal(store.all('fork-before').length,0);
  const portable=store.portable('clone');assert.equal(parsePortableSessionArtifact(portable[0]).bytes,bytes.length);assert.doesNotMatch(JSON.stringify(portable),/capabilityKey|sourceProof|MAC|command|workspaceId/);
  const targetDb=new DatabaseSync(':memory:');try{const target=new SessionArtifactStore(targetDb),staged=target.stage(portable);targetDb.exec('BEGIN IMMEDIATE');target.bind('imported',staged,new Set(['result']));targetDb.exec('ROLLBACK');assert.equal(target.all('imported').length,0);target.bind('imported',staged,new Set(['result']));assert.deepEqual(target.portable('imported'),portable);assert.equal(Number(targetDb.prepare('SELECT count(*) n FROM session_artifact_chunks').get()!.n),new Set(artifact.parts.map(part=>part.sha256)).size);}finally{targetDb.close();}
 }finally{db.close();}
});

test('modified, missing, malformed and unauthorized artifact parts fail without publishing a binding',async()=>{
 const db=new DatabaseSync(':memory:'),store=new SessionArtifactStore(db);try{
  const artifact=await store.capture(input,chunks(Buffer.from('original')));store.bind('source',[artifact],new Set(['result']));const portable=store.portable('source')[0]!;
  assert.throws(()=>store.stage([{...portable,parts:[{...portable.parts[0],data:Buffer.from('modified').toString('base64')}]}]),/invalid_session_artifact/);
  assert.throws(()=>store.stage([{...portable,parts:[]}]),/invalid_session_artifact/);
  assert.throws(()=>store.stage([{...portable,origin:{...portable.origin,MAC:'not-an-execution-grant'}}]),/invalid_session_artifact/);
  assert.throws(()=>store.bind('target',[artifact],new Set(['other'])),/invalid_session_artifact/);assert.equal(store.all('target').length,0);
  db.prepare('UPDATE session_artifact_chunks SET content=?').run(Buffer.from('modified'));assert.throws(()=>store.read('source',artifact.id,new Set(['result'])),/session_artifact_changed/);
  const controller=new AbortController();async function* aborted(){yield Buffer.alloc(400000);controller.abort();yield Buffer.alloc(1);}await assert.rejects(store.capture(input,aborted(),controller.signal),{name:'AbortError'});assert.equal(store.all('target').length,0);
 }finally{db.close();}
});

test('retained stream growth and later restoration preserve old versions without advertising obsolete missing data', async () => {
 const db=new DatabaseSync(':memory:'),store=new SessionArtifactStore(db),selected=new Set(['result']);
 try{
  const original={...input,complete:false},prefix=await store.capture(original,chunks(Buffer.from('PREFIX')));store.bind('source',[prefix],selected);
  const {complete: _complete,...unavailableInput}=input;const fullBytes=Buffer.from('PREFIX_COMPLETE_ORIGINAL'),missing=store.describeUnavailable({...unavailableInput,expectedSha256:sha(fullBytes),reason:'source-unavailable'});store.bindUnavailable('source',[missing],selected);
  assert.equal(store.currentUnavailable('source',selected).length,1);assert.throws(()=>store.read('source',missing.id,selected),/session_artifact_unavailable/);
  const full=await store.capture(input,chunks(fullBytes));store.bind('source',[full],selected);
  const list=store.list('source',selected);assert.equal(list.length,1);assert.equal(list[0]!.availability,'available');assert.equal(list[0]!.id,full.id);
  assert.equal(store.currentUnavailable('source',selected).length,0);assert.equal(store.all('source').length,2);assert.equal(store.unavailable('source').length,1);
  assert.equal(store.read('source',prefix.id,selected).content,'PREFIX');const recovered=store.read('source',missing.id,selected);assert.equal(recovered.content,fullBytes.toString());assert.equal(recovered.source.requestedId,missing.id);
  assert.throws(()=>store.read('source',missing.id,new Set(['before-source'])),/session_artifact_not_authorized/);
  const incomplete=await store.capture({...input,complete:false},chunks(Buffer.from('LARGER_BUT_INCOMPLETE_PREFIX_AFTER_COMPLETION')));store.bind('source',[incomplete],selected);assert.equal(store.list('source',selected)[0]!.id,full.id,'a later incomplete observation never replaces a complete original');
 }finally{db.close();}
});
