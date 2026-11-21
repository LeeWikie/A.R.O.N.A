import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import {Store} from '../src/store.js';
import type {SignalRecord} from '../src/domain.js';
import { finished, removeTemp, until } from './helpers.js';

for(const phase of ['capture','first-admission','prepared','legacy-prepared','submitted','v1-prepared','v1-submitted','steer-first-admission'] as const)test(`real SIGKILL at ${phase} preserves and reconciles every queue document source exactly once`,{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-document-crash-'));let core:Core|undefined;
  const child=fork(fileURLToPath(new URL('./queue-editor-crash-fixture.ts',import.meta.url)),[directory,phase],{stdio:['ignore','ignore','ignore','ipc']});
  let calls=0,repeatedAcceptance=0;const prompts:string[]=[],acceptedIds=new Set<string>(),accept=Store.prototype.accept;Store.prototype.accept=function(...args){if(acceptedIds.has(args[0]))repeatedAcceptance++;return accept.apply(this,args);};
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls++;prompts.push(JSON.stringify(request.prompt));return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  try{
    const [code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');
    const boundary=JSON.parse(fs.readFileSync(path.join(directory,'crash-boundary.json'),'utf8')) as {id:string;bindings:Array<{id:string;nativeSignalId:string;runId:string;action:string|null;status:string}>};
    for(const binding of boundary.bindings)if(binding.action!==null&&phase!=='steer-first-admission')acceptedIds.add(binding.id);
    core=await Core.open({dataDir:directory,model,memoryEnabled:false,...(phase.startsWith('v1-')?{memoryContextMode:'v1' as const}:{})});let page=core.queueEditor().page('main',boundary.id,0,50);const next=core.queueEditor().page('main',boundary.id,50,50);const rows=[...page.entries,...next.entries];
    assert.equal(rows.length,65);assert.deepEqual(rows.map(row=>row.content),Array.from({length:65},(_,i)=>`SYNTHETIC_CRASH_SOURCE_${i}`));assert.equal(new Set(rows.flatMap(row=>row.sourceSignalIds)).size,65);
    if(phase==='capture'){
      assert.equal(page.draft.status,'editing');assert.equal(calls,0,'an editing document is never an execution queue');
      await core.queueEditor().submit('main',boundary.id,{expectedRevision:page.draft.revision},'send-after-restart');
    }
    if(phase==='steer-first-admission'){
      assert.equal(page.draft.status,'blocked');assert.equal(page.draft.errorCode,'run_changed');assert.equal(calls,0);
      const reopened=core.queueEditor().reopen('main',boundary.id,{expectedRevision:page.draft.revision},'recover-unsent');assert.equal(reopened.entryCount,64);assert.equal(reopened.previousSubmissions![0]!.entries[0]!.status,'started');
      const currentRows=[...core.queueEditor().page('main',boundary.id,0,50).entries,...core.queueEditor().page('main',boundary.id,50,50).entries];assert.ok(currentRows[0]!.admittedSignalId);assert.equal(currentRows.slice(1).some(row=>row.admittedSignalId),false);
      await core.queueEditor().submit('main',boundary.id,{expectedRevision:reopened.revision},'send-unsent-after-kill');
    }
    page=await until(()=>core!.queueEditor().page('main',boundary.id),row=>row.draft.status==='submitted');
    const expected=phase==='steer-first-admission'?64:65;const receipts=page.draft.submission!.entries;assert.equal(receipts.length,expected);assert.equal(new Set(receipts.map(row=>row.signalId)).size,expected);
    for(const receipt of receipts){const current=core;const record=await until(()=>current.store.getSignal(receipt.signalId)!,row=>row.status==='accepted');await finished(core,record.runId!);}
    assert.equal(calls,1,'all recovered segments enter one native model request');assert.ok(prompts[0]!.includes('SYNTHETIC_CRASH_SOURCE_64'));assert.equal(new Set(receipts.map(row=>core!.store.getSignal(row.signalId)!.runId)).size,1);
    for(let index=0;index<65;index++)assert.equal([...prompts[0]!.matchAll(new RegExp(`SYNTHETIC_CRASH_SOURCE_${index}(?![0-9])`,'g'))].length,1,`source ${index} reaches the actual model exactly once`);
    for(const binding of boundary.bindings){const actual:SignalRecord=core.store.getSignal(binding.id)!;assert.equal(actual.nativeSignalId,binding.nativeSignalId,'a native accepted identity is immutable across restart');assert.equal(actual.runId,binding.runId,'recovery keeps the original reserved native run');if(binding.action!==null)assert.equal(actual.action,binding.action);}
    assert.equal(repeatedAcceptance,0,'an existing acceptance is reattached without observing another Store admission');
    if(phase.startsWith('v1-')){const intake=core.store.db.prepare(`SELECT signal_id,run_id FROM memory_v1_intake WHERE signal_id IN (${receipts.map(()=>'?').join(',')})`).all(...receipts.map(row=>row.signalId));assert.equal(intake.length,65);assert.equal(new Set(intake.map(row=>row.signal_id)).size,65);assert.deepEqual(new Set(intake.map(row=>row.run_id)),new Set([boundary.bindings[0]!.runId]),'every v1 source obligation retains its actual original native run');}
    const before=calls;await core.queueEditor().submit('main',boundary.id,{expectedRevision:page.draft.revision},'same-document-retry');assert.equal(calls,before);
    for(const row of rows)assert.equal(core.store.getSignal(row.sourceSignalIds[0]!)!.status,'cancelled');
  }finally{Store.prototype.accept=accept;if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await core?.close();await removeTemp(directory);}
});
