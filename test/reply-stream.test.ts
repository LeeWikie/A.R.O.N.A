import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import type {AgentControllerEvent} from '@mastra/core/agent-controller';
import {Core} from '../src/core.js';
import {internalSignalSchema} from '../src/domain.js';
import {Store} from '../src/store.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {ReplyStream, recoverReplies} from '../src/reply-stream.js';
import {finished, removeTemp} from './helpers.js';

const event = (value: unknown) => value as AgentControllerEvent;
test('drafts wait for durable acceptance and exclude reasoning and foreign messages', () => {
  const store = new Store(':memory:'); const runtime = new RuntimeStore(store.db);
  const id = randomUUID(), runId = randomUUID();
  const input = { id, contextId: 'main', type: 'user-message' as const, source: 'tui-message', content: 'hello', output: { kind: 'message' as const, contextId: 'main' } };
  store.receive(input); const stream = new ReplyStream(id, 'main', store, runtime);
  stream.observe(event({type:'message_start',message:{id:'draft',role:'assistant',content:{parts:[]}}}));
  stream.observe(event({type:'message_update',id:'draft',event:{type:'reasoning-delta',delta:'secret',index:0}}));
  stream.observe(event({type:'message_update',id:'foreign',event:{type:'text-delta',delta:'foreign'}}));
  stream.observe(event({type:'message_update',id:'draft',event:{type:'text-delta',delta:'hello'}}));
  assert.equal(runtime.events().length,0);
  assert.throws(()=>stream.accept(runId)); assert.equal(runtime.events().length,0);
  store.accept(id,id,runId,'wake','main'); stream.accept(runId);
  stream.observe(event({type:'message_update',id:'draft',event:{type:'text-delta',delta:' world'}}));
  stream.finish(true); stream.finish(true);
  assert.deepEqual(runtime.events().map(x=>x.kind),['reply.start','reply.delta','reply.delta','delivery','reply.commit']);
  assert.equal(store.outputsForSignal(id)[0]?.content,'hello world');
  assert.ok(!JSON.stringify(runtime.events()).includes('secret'));
  store.close();
});
test('failed admission is discarded and interrupted drafts recover', () => {
  const store = new Store(':memory:'); const runtime = new RuntimeStore(store.db);
  const id=randomUUID(), runId=randomUUID();
  store.receive({id, contextId:'main',type:'user-message',source:'tui-message',content:'x',output:{kind:'message',contextId:'main'}});
  const stream=new ReplyStream(id,'main',store,runtime);
  stream.observe(event({type:'message_start',message:{id:'d',role:'assistant',content:{parts:[{type:'text',text:'private'}]}}}));
  stream.finish(false); assert.equal(runtime.events().length,0);
  const second=new ReplyStream(id,'main',store,runtime);store.accept(id,id,runId,'wake','main');second.accept(runId);
  second.observe(event({type:'message_start',message:{id:'d2',role:'assistant',content:{parts:[{type:'text',text:'partial'}]}}}));
  store.recoverInterrupted();recoverReplies(store,runtime); recoverReplies(store,runtime);
  assert.equal(runtime.events().filter(x=>x.kind==='reply.cancel').length,1); assert.equal(store.outputsForSignal(id).length,0);
  store.close();
});
test('native session streams and commits a scoped reply', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-reply-'));
  const model=new MastraLanguageModelV2Mock({doStream:async()=>({stream:new ReadableStream({start(c){
    c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'Hello native'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
  }})})});
  const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
  try {
    const receipt=await core.submitMessage({content:'hello'}); assert.ok(receipt.runId); await finished(core,receipt.runId!);
    assert.equal(core.store.outputsForSignal(receipt.id)[0]?.content,'Hello native');
    assert.ok(core.runtime.events('main').some(x=>x.kind==='reply.commit'));
  } finally {await core.close();await removeTemp(dir);}
});

test('deliver into a shared run cannot authorize staged text; cancellation never publishes', () => {
  const store=new Store(':memory:'), runtime=new RuntimeStore(store.db);const id=randomUUID(),runId=randomUUID();
  store.receive({id,contextId:'main',type:'user-message',source:'tui-message',content:'x',output:{kind:'message',contextId:'main'}});
  const stream=new ReplyStream(id,'main',store,runtime);
  stream.observe(event({type:'message_start',message:{id:'draft',role:'assistant',content:{parts:[{type:'text',text:'unrelated'}]}}}));
  store.accept(id,id,runId,'deliver','main');assert.throws(()=>stream.accept(runId));stream.finish(false);
  assert.equal(runtime.events().length,0);assert.equal(store.outputsForSignal(id).length,0);
  const id2=randomUUID();store.receive({id:id2,contextId:'main',type:'user-message',source:'tui-message',content:'y',output:{kind:'message',contextId:'main'}});
  store.accept(id2,id2,runId,'wake','main'); const second=new ReplyStream(id2,'main',store,runtime);second.accept(runId);
  second.observe(event({type:'message_start',message:{id:'other',role:'assistant',content:{parts:[{type:'text',text:'partial'}]}}}));second.finish(false);
  assert.equal(runtime.events().at(-1)?.kind,'reply.cancel');assert.equal(store.outputsForSignal(id2).length,0);store.close();
});

test('legacy and reply submissions cannot share an active scoped run', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-reply-busy-'));let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{await gate;return {stream:new ReadableStream({start(c){
    c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'exclusive'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
  }})};}});
  const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
  try {
    const first=await core.submitMessage({content:'first'});
    const queued=await core.submitMessage({content:'second',mode:'queue'});assert.equal(queued.status,'queued');core.cancelQueuedMessage(queued.id,1);
    await assert.rejects(core.submitSignal({type:'user-message',source:'legacy',content:'legacy'}),/context_busy/);
    release(); await finished(core,first.runId!);
    assert.deepEqual(core.store.outputsForSignal(first.id).map(o=>o.content),['exclusive']);
  } finally {release();await core.close();await removeTemp(dir);}
});

test('authoritative indexed text snapshots prevent interleaved span duplication',()=>{
 const store=new Store(':memory:'),runtime=new RuntimeStore(store.db),id=randomUUID(),runId=randomUUID();
 store.receive({id,contextId:'main',type:'user-message',source:'tui-message',content:'fixture',output:{kind:'message',contextId:'main'}});store.accept(id,id,runId,'wake','main');
 const stream=new ReplyStream(id,'main',store,runtime);stream.accept(runId);
 stream.observe(event({type:'message_start',message:{id:'draft-multi',role:'assistant',content:{parts:[]}}}));
 stream.observe(event({type:'message_update',id:'draft-multi',event:{type:'part',index:0,part:{type:'text',text:''}}}));
 stream.observe(event({type:'message_update',id:'draft-multi',event:{type:'part',index:1,part:{type:'text',text:''}}}));
 stream.observe(event({type:'message_update',id:'draft-multi',event:{type:'text-delta',delta:'A'}}));
 stream.observe(event({type:'message_update',id:'draft-multi',event:{type:'part',index:0,part:{type:'text',text:'A'}}}));
 stream.finish(true);assert.equal(store.outputsForSignal(id)[0]?.content,'A');store.close();
});

test('task notification remains retryable while a scoped reply is active', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-reply-outbox-'));let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{if(++calls===1)await gate;return {stream:new ReadableStream({start(c){
    c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'response'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
  }})};}});
  const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
  try {
    const first=await core.submitMessage({content:'first'});
    const notificationId=randomUUID();core.runtime.notify(notificationId,'main',{result:'finished'});
    const pending=await core.retryNotification(notificationId);
    assert.equal(pending.pending,true);
    assert.equal(core.runtime.setting<string|null>(`notification-signal:${notificationId}`,null),null);
    release();await finished(core,first.runId!);
    await core.retryNotification(notificationId);
    const signalId=core.runtime.setting<string|null>(`notification-signal:${notificationId}`,null);
    assert.ok(signalId);assert.equal(core.store.getSignal(signalId)?.status,'accepted');
    const runId=core.store.getSignal(signalId)?.runId;if(runId)await finished(core,runId);
  } finally {release();await core.close();await removeTemp(dir);}
});

test('outbox retries a pre-admission busy rejection but not an uncertain interrupted run', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-outbox-recovery-'));let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return {stream:new ReadableStream({start(c){
    c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
  }})};}});
  const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
  try {
    const uncertainItem=randomUUID(),uncertainSignal=randomUUID(),runId=randomUUID();
    core.runtime.notify(uncertainItem,'main',{fixture:'uncertain'});core.runtime.setSetting(`notification-signal:${uncertainItem}`,uncertainSignal);
    core.store.receive({id:uncertainSignal,contextId:'main',type:'external-event',source:'task-result',content:JSON.stringify({fixture:'uncertain'}),output:{kind:'message',contextId:'main'}});
    core.store.accept(uncertainSignal,uncertainSignal,runId,'wake','main');core.store.recoverInterrupted();
    await (core as unknown as {flushNotifications():Promise<void>}).flushNotifications();
    assert.equal(core.store.getSignal(uncertainSignal)?.status,'interrupted');assert.equal(calls,0);
    core.runtime.notified(uncertainItem);
    const busyItem=randomUUID(),busySignal=randomUUID();core.runtime.notify(busyItem,'main',{fixture:'busy'});core.runtime.setSetting(`notification-signal:${busyItem}`,busySignal);
    core.store.receive(internalSignalSchema.parse({id:busySignal,contextId:'main',type:'external-event',source:'task-result',content:JSON.stringify({fixture:'busy'}),output:{kind:'message',contextId:'main'}}));
    core.store.reject(busySignal,'context_busy');
    await (core as unknown as {flushNotifications():Promise<void>}).flushNotifications();
    assert.equal(core.store.getSignal(busySignal)?.status,'accepted');
    const retryRun=core.store.getSignal(busySignal)?.runId;if(retryRun)await finished(core,retryRun);
  } finally {await core.close();await removeTemp(dir);}
});

test('explicit notification retry starts another native attempt after a failed run', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-outbox-retry-'));let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{if(++calls===1)throw new Error('first attempt failed');return {stream:new ReadableStream({start(c){
    c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();
  }})};}});
  const core=await Core.open({dataDir:dir,model,memoryEnabled:false});
  try {
    const id=randomUUID();core.runtime.notify(id,'main',{fixture:'retry'});await core.retryNotification(id);
    const signalId=core.runtime.setting<string|null>(`notification-signal:${id}`,null)!;const firstRun=core.store.getSignal(signalId)?.runId;assert.ok(firstRun);
    await finished(core,firstRun);assert.equal(core.store.getRun(firstRun)?.status,'failed');
    await core.retryNotification(id);const secondRun=core.store.getSignal(signalId)?.runId;assert.ok(secondRun);assert.notEqual(secondRun,firstRun);
    await finished(core,secondRun);assert.equal(calls,2);
  } finally {await core.close();await removeTemp(dir);}
});
