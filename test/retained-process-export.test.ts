import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {RuntimeStore} from '../src/runtime-store.js';
import {ProcessOutputArchive,writeProcessObservation,type TerminalOwner} from '../src/tools/process-output.js';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function collect(source:AsyncIterable<Uint8Array>){const chunks:Uint8Array[]=[];for await(const chunk of source)chunks.push(chunk);return Buffer.concat(chunks);}
function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-retained-process-')),db=new DatabaseSync(':memory:'),store=new RuntimeStore(db),stat=fs.statSync(directory);
  const owner:TerminalOwner={contextId:'work.synthetic',taskId:null,runId:null,attempt:1,root:{id:'synthetic',path:directory,dev:stat.dev,ino:stat.ino},returnContextId:'main'};
  const archive=new ProcessOutputArchive(store,directory,()=>owner,'synthetic-test-key');
  const binding=archive.create({command:'synthetic private command',cwd:directory,interactive:false,pty:false,notify:false});
  t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
  const set=(stdout:Buffer,status:'running'|'completed'|'unknown'='completed')=>{fs.writeFileSync(path.join(archive.path(binding.id),'stdout'),stdout);writeProcessObservation(archive.path(binding.id),{status,stdoutBytes:stdout.length,stderrBytes:0,...(status==='completed'?{exitCode:0,stdoutSha256:sha(stdout),stderrSha256:sha(Buffer.alloc(0)),stdoutEncoding:'binary' as const,stderrEncoding:'utf8' as const}:{})});};
  return {archive,binding,store,set};
}

test('history export streams exact original binary bytes and empty stderr without live execution authority',async t=>{
  const f=fixture(t),bytes=Buffer.from(Array.from({length:200000},(_,index)=>index%256));f.set(bytes);
  const snapshot=await f.archive.exportRetained(f.binding.id,'work.synthetic');assert.equal(snapshot.metadata.streams.stdout.sha256,sha(bytes));assert.equal(snapshot.metadata.streams.stdout.complete,true);assert.equal(snapshot.metadata.streams.stderr.complete,true);
  assert.deepEqual(await collect(snapshot.read('stdout')),bytes);assert.deepEqual(await collect(snapshot.read('stderr')),Buffer.alloc(0));
  assert.deepEqual(Object.keys(snapshot.metadata).sort(),['capturedAt','id','observation','origin','streams']);assert.deepEqual(snapshot.metadata.origin,{contextId:'work.synthetic',runId:null,taskId:null});assert.doesNotMatch(JSON.stringify(snapshot.metadata),/synthetic private command|synthetic-test-key|binding|sourceProof|root/);
  snapshot.metadata.streams.stdout.bytes=1;assert.deepEqual(await collect(snapshot.read('stdout')),bytes,'public metadata mutation cannot change the sealed stream snapshot');
  await assert.rejects(f.archive.exportRetained(f.binding.id,'work.other'),/process_not_authorized/);
});

test('active and unknown process exports keep the captured prefix explicitly incomplete',async t=>{
  const f=fixture(t);for(const status of ['running','unknown'] as const){f.set(Buffer.from('before'),status);const snapshot=await f.archive.exportRetained(f.binding.id,'work.synthetic');fs.appendFileSync(path.join(f.archive.path(f.binding.id),'stdout'),'after');assert.equal(snapshot.metadata.streams.stdout.complete,false);assert.equal(snapshot.metadata.streams.stderr.complete,false);assert.deepEqual(await collect(snapshot.read('stdout')),Buffer.from('before'));}
});

test('history export rejects changed content, hardlinks and binding substitution before committing a staged result',async t=>{
  const f=fixture(t),bytes=Buffer.from('original output');f.set(bytes);const file=path.join(f.archive.path(f.binding.id),'stdout'),snapshot=await f.archive.exportRetained(f.binding.id,'work.synthetic');fs.writeFileSync(file,'modified output');await assert.rejects(collect(snapshot.read('stdout')),/process_output_changed/);await assert.rejects(f.archive.exportRetained(f.binding.id,'work.synthetic'),/process_output_changed/);f.set(bytes);
  const link=path.join(f.archive.path(f.binding.id),'extra');fs.linkSync(file,link);await assert.rejects(f.archive.exportRetained(f.binding.id,'work.synthetic'),/process_output_changed/);fs.unlinkSync(link);
  f.store.setSetting(`terminal-process:${f.binding.id}`,{...f.binding,command:'changed'});await assert.rejects(collect(snapshot.read('stdout')),/process_source_changed/);
});

test('history export cancellation closes an in-progress byte reader and leaves the original data readable',async t=>{
  const f=fixture(t),bytes=Buffer.alloc(200000,255);f.set(bytes);const aborted=new AbortController();aborted.abort();await assert.rejects(f.archive.exportRetained(f.binding.id,'work.synthetic',aborted.signal),{name:'AbortError'});
  const snapshot=await f.archive.exportRetained(f.binding.id,'work.synthetic'),controller=new AbortController(),iterator=snapshot.read('stdout',controller.signal);assert.equal((await iterator.next()).value?.length,65536);controller.abort();await assert.rejects(iterator.next(),{name:'AbortError'});assert.deepEqual(await collect(snapshot.read('stdout')),bytes);
});

test('a missing or altered stderr spool cannot discard the independently verified stdout, while metadata keeps the original expected bytes',async t=>{
  const f=fixture(t),stdout=Buffer.from('original complete stdout'),stderr=Buffer.from([0,255,128,10]);f.set(stdout);fs.writeFileSync(path.join(f.archive.path(f.binding.id),'stderr'),stderr);writeProcessObservation(f.archive.path(f.binding.id),{status:'completed',exitCode:0,stdoutBytes:stdout.length,stderrBytes:stderr.length,stdoutSha256:sha(stdout),stderrSha256:sha(stderr),stdoutEncoding:'utf8',stderrEncoding:'binary'});fs.unlinkSync(path.join(f.archive.path(f.binding.id),'stderr'));const description=f.archive.describeRetained(f.binding.id,'work.synthetic');assert.equal(description.observation?.stdoutSha256,sha(stdout));assert.equal(description.observation?.stderrSha256,sha(stderr));assert.equal(description.observation?.stderrBytes,stderr.length);
  const snapshot=await f.archive.exportStream(f.binding.id,'work.synthetic','stdout');assert.equal(snapshot.metadata.stream,'stdout');assert.equal(snapshot.metadata.source.sha256,sha(stdout));assert.deepEqual(await collect(snapshot.read()),stdout);await assert.rejects(f.archive.exportStream(f.binding.id,'work.synthetic','stderr'));
  fs.writeFileSync(path.join(f.archive.path(f.binding.id),'stderr'),'altered');const linked=path.join(f.archive.path(f.binding.id),'stderr-link');fs.linkSync(path.join(f.archive.path(f.binding.id),'stderr'),linked);await assert.rejects(f.archive.exportStream(f.binding.id,'work.synthetic','stderr'),/process_output_changed/);assert.deepEqual(await collect((await f.archive.exportStream(f.binding.id,'work.synthetic','stdout')).read()),stdout);
  fs.unlinkSync(path.join(f.archive.path(f.binding.id),'state.json'));const unavailable=f.archive.describeRetained(f.binding.id,'work.synthetic');assert.equal(unavailable.observation,null);assert.equal(unavailable.issue,'process_state_unavailable');assert.deepEqual(unavailable.origin,{contextId:'work.synthetic',runId:null,taskId:null});f.store.setSetting(`terminal-process:${f.binding.id}`,{...f.binding,runId:'changed'});assert.throws(()=>f.archive.describeRetained(f.binding.id,'work.synthetic'),/process_source_changed/);
});

test('state metadata cannot inject undeclared authority or arbitrary nested values through a retained-data export',async t=>{
  const f=fixture(t),bytes=Buffer.from('original');f.set(bytes);const file=path.join(f.archive.path(f.binding.id),'state.json'),original=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...original,command:'must not leave',grants:{execute:true},secret:'must not leave'}));const exported=await f.archive.exportStream(f.binding.id,'work.synthetic','stdout');assert.doesNotMatch(JSON.stringify(exported.metadata),/must not leave|grants|command|secret/);assert.deepEqual(await collect(exported.read()),bytes);
  fs.writeFileSync(file,JSON.stringify({...original,reason:{secret:'invalid nested metadata'}}));await assert.rejects(f.archive.exportStream(f.binding.id,'work.synthetic','stdout'),/process_state_invalid/);assert.equal(f.archive.describeRetained(f.binding.id,'work.synthetic').issue,'process_state_invalid');
  fs.writeFileSync(file,'invalid syntax: private state fragment');await assert.rejects(f.archive.exportStream(f.binding.id,'work.synthetic','stdout'),error=>error instanceof Error&&error.message==='process_state_invalid');
});
