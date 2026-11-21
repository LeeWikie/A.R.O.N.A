import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {serialize} from 'node:v8';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {finished,removeTemp,until} from './helpers.js';

for(const recovery of ['automatic','explicit','explicit-off','reenable','disable'] as const)test(`default memory organization resumes after service shutdown through ${recovery} recovery`,{timeout:25000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-legacy-memory-restart-'));
 let held=true,memoryCalls=0,release:(()=>void)|undefined;
 const model=new MastraLanguageModelV2Mock({
  doStream:async()=>({stream:new ReadableStream({start(controller){
   controller.enqueue({type:'stream-start',warnings:[]});controller.enqueue({type:'text-start',id:'reply'});controller.enqueue({type:'text-delta',id:'reply',delta:'Synthetic acknowledgement.'});controller.enqueue({type:'text-end',id:'reply'});controller.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();
  }})}),
  doGenerate:async request=>{
   assert.ok(request.tools?.some(tool=>tool.name==='memory_commit'));
   memoryCalls++;
   if(held){
    assert.ok(request.abortSignal);request.abortSignal.throwIfAborted();
    await new Promise<void>((resolve,reject)=>{release=resolve;request.abortSignal!.addEventListener('abort',()=>reject(request.abortSignal!.reason),{once:true});});
   }
   const runId=/来源运行是 ([0-9a-f-]{36})/.exec(JSON.stringify(request.prompt))?.[1];assert.ok(runId);
   const commit=!request.prompt.some(message=>message.role==='tool'&&message.content.some(part=>part.type==='tool-result'&&part.toolName==='memory_commit'));
   return{content:commit?[{type:'tool-call' as const,toolName:'memory_commit',toolCallId:'commit-recovered-memory',input:JSON.stringify({sourceRunId:runId,note:'No change needed after checking the retained source.'})}]:[{type:'text' as const,text:'Checked.'}],finishReason:commit?'tool-calls' as const:'stop' as const,usage:{inputTokens:1,outputTokens:1,totalTokens:2},warnings:[]};
  },
 });
 let core:Core|undefined;
 try{
  core=await Core.open({dataDir:directory,model,memoryEnabled:recovery!=='explicit-off'});assert.equal(core.memoryContextMode(),'legacy');
  const receipt=await core.submitMessage({content:'A synthetic preference for recovery testing.'});await finished(core,receipt.runId!);
  if(recovery==='explicit-off')await core.queueMemory(receipt.runId!);
  await until(()=>core!.projectMemory.jobs(),jobs=>jobs.some(job=>job.runId===receipt.runId&&job.status==='running')&&memoryCalls===1);
  const originalSnapshot=core.projectMemory.snapshot(receipt.runId!),originalSignal=String(core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(receipt.id)?.body),callsBefore=memoryCalls;
  if(recovery==='disable'){
   const disabling=core.configure('runtime',{memoryEnabled:false});held=false;release?.();await disabling;
   const jobs=await until(()=>core!.projectMemory.jobs(),rows=>rows.some(job=>job.runId===receipt.runId&&['succeeded','failed','interrupted'].includes(job.status)));
   assert.equal(jobs.find(job=>job.runId===receipt.runId)?.status,'interrupted','disabled memory must not publish after a late provider response');
   assert.equal(core.runtime.setting<Record<string,number>>('memory-watermarks',{})['main'],undefined);
  }
  const reopenCalls=memoryCalls;await core.close();core=undefined;held=false;
  core=await Core.open({dataDir:directory,model,memoryEnabled:recovery!=='reenable'&&recovery!=='explicit-off'});
  if(recovery==='reenable'||recovery==='disable'){
   assert.equal(memoryCalls,reopenCalls,'disabled startup does not issue a memory request');
   await core.configure('runtime',{memoryEnabled:true});
  }
  if(recovery==='explicit')await core.queueMemory(receipt.runId!,true);
  await until(()=>core!.projectMemory.jobs(),jobs=>jobs.some(job=>job.runId===receipt.runId&&job.status==='succeeded'),5000);
  assert.ok(memoryCalls>callsBefore);assert.equal(core.projectMemory.version().generation,0,'an unchanged result is not a second publication');
  assert.deepEqual(core.projectMemory.snapshot(receipt.runId!),originalSnapshot);
  assert.equal(String(core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(receipt.id)?.body),originalSignal);
 }finally{await core?.close();await removeTemp(directory);}
});

test('a killed default memory worker is recovered once from unchanged accepted source',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-legacy-memory-crash-'));
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./legacy-memory-recovery-process.ts',import.meta.url)),directory],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc']});
 const closed=once(child,'close');const diagnostics:Buffer[]=[];assert.ok(child.stderr);assert.ok(child.stdout);child.stderr.on('data',bytes=>diagnostics.push(Buffer.from(bytes)));child.stdout.resume();
 type Ready={ready:true;runId:string;signalId:string;jobId:string;nativeTaskId:string;snapshotSha256:string;signalSha256:string};
 let core:Core|undefined;
 try{
  const ready=await new Promise<Ready>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error('memory fixture did not reach its durable running state')),10000);
   child.once('message',value=>{clearTimeout(timeout);resolve(value as Ready);});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('memory fixture exited before kill: '+Buffer.concat(diagnostics).toString()));});
  });
  assert.equal(ready.ready,true);assert.ok(ready.nativeTaskId);assert.equal(child.kill('SIGKILL'),true);
  const [code,signal]=await closed;assert.ok(signal==='SIGKILL'||process.platform==='win32'&&code!==0);
  let calls=0;
  const model=new MastraLanguageModelV2Mock({
   doStream:async()=>{throw new Error('Main must not be replayed to recover memory');},
   doGenerate:async request=>{
    assert.ok(request.tools?.some(tool=>tool.name==='memory_commit'));assert.match(JSON.stringify(request.prompt),/synthetic recovery preference: blue/);
    const phase=calls++,call=phase===0?{toolName:'memory_write',toolCallId:'recover-preference',input:JSON.stringify({path:'shared/preference.md',content:'# Synthetic preference\nThe accepted preference is blue.'})}:phase===1?{toolName:'memory_commit',toolCallId:'recover-commit',input:JSON.stringify({sourceRunId:ready.runId,note:'Recovered original accepted source.'})}:undefined;
    return{content:call?[{type:'tool-call' as const,...call}]:[{type:'text' as const,text:'Checked.'}],finishReason:call?'tool-calls' as const:'stop' as const,usage:{inputTokens:1,outputTokens:1,totalTokens:2},warnings:[]};
   },
  });
  core=await Core.open({dataDir:directory,model,memoryEnabled:true});
  await until(()=>core!.projectMemory.jobs(),jobs=>jobs.some(job=>job.runId===ready.runId&&job.status==='succeeded'),8000);
  assert.match(core.projectMemory.resident().text,/accepted preference is blue/);assert.equal(core.projectMemory.version().generation,1);
  const old=core.projectMemory.jobs().find(job=>job.id===ready.jobId)!;assert.equal(old.status,'interrupted');assert.equal(old.nativeTaskId,ready.nativeTaskId);assert.ok(old.resolvedBy);assert.equal(core.projectMemory.unresolvedJobs().length,0);
  const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(serialize(core.projectMemory.snapshot(ready.runId))),ready.snapshotSha256);assert.equal(hash(String(core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(ready.signalId)?.body)),ready.signalSha256);
  await core.close();core=undefined;const completeCalls=calls;
  core=await Core.open({dataDir:directory,model,memoryEnabled:true});await new Promise(resolve=>setTimeout(resolve,100));assert.equal(calls,completeCalls);assert.equal(core.projectMemory.version().generation,1);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}await core?.close();await removeTemp(directory);}
});
