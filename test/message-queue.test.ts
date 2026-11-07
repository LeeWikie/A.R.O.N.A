import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {finished, removeTemp, until} from './helpers.js';

test('native queue receipt identifies a future run and cancellation removes it before start', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-queue-'));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  let started!:()=>void;const modelStarted=new Promise<void>(resolve=>{started=resolve;});
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;started();await gate;return {stream:new ReadableStream({start(c){
    c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
  }})};}});
  const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
  try {
    const first=await core.submitMessage({content:'first'});await modelStarted;const session=core.sessions.peek('main')!;
    const id=randomUUID();
    const queued=await core.sessions.queueSignal(session,{id,type:'user',contents:'next'});
    const receipt=await queued.accepted;assert.equal(receipt.action,'deliver');
    assert.ok('runId' in receipt);assert.notEqual(receipt.runId,first.runId);
    assert.notEqual(session.getCurrentRunId(),receipt.runId);assert.equal(calls,1);
    assert.deepEqual(core.agent.cancelQueuedMessages({resourceId:'local',threadId:'main',signalIds:[id]}).cancelledSignalIds,[id]);
    release();await finished(core,first.runId!);assert.equal(calls,1);
  } finally {release();await core.close();await removeTemp(dir);}
});

test('busy host input stays queued without a running row, then starts a fresh scoped native run', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-host-queue-'));let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async()=>{const n=++calls;if(n===1)await gate;return {stream:new ReadableStream({start(c){
  c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:`reply ${n}`});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
 }})};}});
 const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
 try{
  const first=await core.submitMessage({content:'first'});await until(()=>calls,n=>n===1);const second=await core.submitMessage({content:'second',mode:'queue'});
  assert.equal(second.status,'queued');assert.notEqual(second.runId,first.runId);assert.equal(core.store.getRun(second.runId!),undefined);assert.equal(calls,1);
  assert.equal(core.queuedMessages('main')[0]?.id,second.id);
  assert.deepEqual(await core.submitMessage({id:second.id,content:'second',mode:'queue'}),second);
  release();await finished(core,first.runId!);await finished(core,second.runId!);
  assert.equal(core.store.getSignal(second.id)?.status,'accepted');assert.equal(calls,2);assert.equal(core.queuedMessages('main').length,0);
  assert.equal(core.store.outputsForSignal(second.id)[0]?.content,'reply 2');
  assert.equal(core.store.outputsForSignal(first.id)[0]?.content,'reply 1');
 }finally{release();await core.close();await removeTemp(dir);}
});

test('queued edit preserves the original and withdraws native input with revision checks', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-host-queue-edit-'));let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let calls=0;
 const prompts:string[]=[];const model=new MastraLanguageModelV2Mock({doStream:async(request)=>{prompts.push(JSON.stringify(request.prompt));if(++calls===1)await gate;return {stream:new ReadableStream({start(c){
 c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'done'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
 }})};}});
 const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
 try{
  const first=await core.submitMessage({content:'first'});const queued=await core.submitMessage({content:'original queue input',mode:'queue'});
  assert.throws(()=>core.cancelQueuedMessage(queued.id,2),/revision_conflict/);
  const replacement=await core.replaceQueuedMessage(queued.id,1,'replacement queue input',randomUUID());
  assert.equal(core.store.getSignal(queued.id)?.status,'cancelled');assert.equal(core.store.getSignal(queued.id)?.content,'original queue input');
  assert.equal(replacement.status,'queued');assert.throws(()=>core.cancelQueuedMessage(queued.id,1),/revision_conflict/);
  const withdrawn=await core.submitMessage({content:'must not execute',mode:'queue'});core.cancelQueuedMessage(withdrawn.id,1);
  release();await finished(core,first.runId!);await finished(core,replacement.runId!);assert.equal(calls,2);
  assert.ok(prompts[1]?.includes('replacement queue input'));assert.ok(!prompts[1]?.includes('original queue input'));assert.ok(!prompts[1]?.includes('must not execute'));
 }finally{release();await core.close();await removeTemp(dir);}
});

test('steer binds to the expected active reply and never wakes a successor on a stale click', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-host-steer-'));let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let calls=0;const prompts:string[]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async(request)=>{prompts.push(JSON.stringify(request.prompt));if(++calls===1)await gate;return {stream:new ReadableStream({start(c){
 c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'scoped reply'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
 }})};}});
 const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
 try{
  const first=await core.submitMessage({content:'first'});await until(()=>calls,n=>n===1);
  await assert.rejects(core.submitMessage({content:'late',mode:'steer',expectedRunId:randomUUID()}),/run_changed/);
  const steered=await core.submitMessage({content:'supplement-current-scope',mode:'steer',expectedRunId:first.runId});
  assert.equal(steered.action,'deliver');assert.equal(steered.runId,first.runId);
  release();await finished(core,first.runId!);
  assert.ok(prompts.some(p=>p.includes('supplement-current-scope')));assert.ok(core.store.outputsForSignal(steered.id).length>0);
  await assert.rejects(core.submitMessage({content:'late after end',mode:'steer',expectedRunId:first.runId}),/run_changed/);
 }finally{release();await core.close();await removeTemp(dir);}
});

test('concurrent first submissions serialize admission but execute in independent native runs',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-host-first-queue-'));let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async()=>{const n=++calls;if(n===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:`reply ${n}`});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
 const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
 try{
  const pendingFirst=core.submitMessage({content:'first'});const pendingSecond=core.submitMessage({content:'second',mode:'queue'});
  const [first,second]=await Promise.all([pendingFirst,pendingSecond]);assert.equal(second.status,'queued');assert.notEqual(first.runId,second.runId);
  release();await finished(core,first.runId!);await finished(core,second.runId!);
  assert.equal(core.store.outputsForSignal(first.id)[0]?.content,'reply 1');assert.equal(core.store.outputsForSignal(second.id)[0]?.content,'reply 2');
 }finally{release();await core.close();await removeTemp(dir);}
});
