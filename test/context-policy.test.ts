import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,type Usage,type Context} from '@earendil-works/pi-ai';
import {estimateMessageTokens} from '@earendil-works/pi-ai/utils/estimate';
import {ContextPolicy} from '../src/context-policy.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {Core} from '../src/core.js';
import {finished,removeTemp} from './helpers.js';

const usage:Usage={input:1000,cacheRead:200,cacheWrite:0,output:10,totalTokens:1210,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
test('capacity uses public Pi estimates and only reuses measured counts for an identical prefix',()=>{
 const db=new DatabaseSync(':memory:');try{
  const store=new RuntimeStore(db);const policy=new ContextPolicy(store);const model=fauxProvider({models:[{id:'fixture',contextWindow:50000,maxTokens:4000,input:['text','image']}]}).getModel();
  const first:Context={messages:[{role:'user',content:'中文原文007',timestamp:1}]};const original=JSON.stringify(first);const observed=policy.observer('main','fixture');
  const completed=observed({context:first,model,options:{}});assert.equal(JSON.stringify(first),original);assert.equal(policy.view('main')?.basis,'heuristic');assert.equal(policy.view('main')?.estimateIsExact,false);assert.equal(policy.view('main')?.imageEstimateIsExact,false);
  assert.equal(typeof completed,'function');completed!(usage);
  const tail={role:'user' as const,content:'new tail',timestamp:3};const next:Context={messages:[{...first.messages[0]!,timestamp:2},tail]};observed({context:next,model,options:{}});
  assert.equal(policy.view('main')?.basis,'reported-prefix-plus-estimate');assert.equal(policy.view('main')?.estimatedInputTokens,1200+estimateMessageTokens(tail));
  observed({context:{messages:[{role:'user',content:'changed prefix',timestamp:4}]},model,options:{}});assert.equal(policy.view('main')?.basis,'heuristic');
  assert.equal(policy.view('main')?.outputReserveIsHardLimit,false);
 }finally{db.close();}
});

test('explicit block policy prevents a native model call without silently trimming original history',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-capacity-block-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  const fake=fauxProvider({provider:'capacity-fixture',models:[{id:'tiny',contextWindow:5000,maxTokens:1000}]});fake.setResponses([fauxAssistantMessage('must not run')]);core.providerRegistry.setProvider(fake.provider);core.models.save({id:'default',name:'Tiny',providerId:'capacity-fixture',modelId:'tiny'});core.configure('runtime',{contextOverflow:'block'});
  const text='完整中文原文007'.repeat(1200);const input=await core.submitMessage({content:text});const run=await finished(core,input.runId!);assert.equal(run?.status,'failed');assert.equal(fake.state.callCount,0);assert.equal(core.contextPolicy.view('main')?.blockedBeforeProvider,true);
  assert.equal(core.store.getSignal(input.id)?.content,text);assert.equal((core.configure('runtime',{}) as {contextOverflow:string}).contextOverflow,'block');
 }finally{await core.close();await removeTemp(directory);}
});
