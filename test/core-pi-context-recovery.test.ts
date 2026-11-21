import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage, Models, Model } from '@earendil-works/pi-ai';
import { createPiLanguageModel, type PiRequestObserver } from '../src/providers/bridge.js';
import { Core } from '../src/core.js';
import {estimateTextTokens} from '@earendil-works/pi-ai/utils/estimate';
import { finished, removeTemp } from './helpers.js';

async function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-pi-context-'));let overflow=false;let summaries=0;let calls=0;let observe:PiRequestObserver|undefined;const prompts:string[]=[];
 const model:Model<'test'>={id:'synthetic-model',name:'Synthetic',api:'test',provider:'test',baseUrl:'http://example.invalid',input:['text'],reasoning:false,contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const registry={streamSimple(_model:unknown,context:unknown){
  const prompt=JSON.stringify(context);prompts.push(prompt);calls++;const summary=prompt.includes('context checkpoint summary');if(summary)summaries++;
  const failed=overflow&&!summary;if(failed)overflow=false;
  const text=summary?'Keep EARLY-PI-CONSTRAINT.':'done';
  const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:failed?[]:[{type:'text',text}],timestamp:Date.now(),stopReason:failed?'error':'stop',...(failed?{errorMessage:'maximum context length exceeded SYNTHETIC-UPSTREAM-SECRET'}:{}),usage:{input:estimateTextTokens(prompt),output:1,cacheRead:0,cacheWrite:0,totalTokens:estimateTextTokens(prompt)+1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{if(failed)stream.push({type:'error',reason:'error',error:message});else {stream.push({type:'start',partial:message});stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_end',contentIndex:0,content:text,partial:message});stream.push({type:'done',reason:'stop',message});}});return stream;
 }} as Pick<Models,'streamSimple'>;
 const languageModel=createPiLanguageModel(registry,model,request=>observe?.(request));
 const core=await Core.open({dataDir:directory,model:languageModel,memoryEnabled:false});
 observe=(core as unknown as {requestObserver(id:string,profile:string):PiRequestObserver}).requestObserver('main','default');
 core.configure('runtime',{autoCompaction:{enabled:false,reserveTokens:1000,keepRecentTokens:500}});
 return {core,model,prompts,get summaries(){return summaries;},get calls(){return calls;},overflow(){overflow=true;},async send(content:string){const receipt=await core.submitMessage({content});return finished(core,receipt.runId!);},async close(){await core.close();await removeTemp(directory);}};
}

test('Pi provider overflow classification reaches native core recovery without repeating input admission',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send('EARLY-PI-CONSTRAINT '+ 'older detail '.repeat(1500));await f.send('recent');f.core.configure('runtime',{autoCompaction:{enabled:true,reserveTokens:1000,keepRecentTokens:500}});f.overflow();
  assert.equal((await f.send('RECOVER-PI-CURRENT-REQUEST'))!.status,'succeeded');assert.equal(f.summaries,1);assert.match(f.prompts.at(-1)!,/RECOVER-PI-CURRENT-REQUEST/);assert.doesNotMatch(f.prompts.at(-1)!,/older detail older detail/);
  assert.equal(f.core.store.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE json_extract(body,'$.content')=?").get('RECOVER-PI-CURRENT-REQUEST')!.n,1);
  assert.doesNotMatch(JSON.stringify(f.core.runtime.events()),/SYNTHETIC-UPSTREAM-SECRET/);
 }finally{await f.close();}
});

test('normalized Pi request budget including tool schemas triggers a native preflight recovery before a provider rejection',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send('EARLY-PI-CONSTRAINT '+ 'old detail '.repeat(800));await f.send('recent');f.model.contextWindow=6000;
  f.core.configure('runtime',{autoCompaction:{enabled:true,reserveTokens:3000,keepRecentTokens:500}});
  assert.equal((await f.send('CURRENT-WITH-TOOLS-BUDGET'))!.status,'succeeded');assert.equal(f.summaries,1);
  const events=f.core.runtime.events('main',0,1000);assert.ok(events.some(e=>e.kind==='compaction_state'&&(e.data as {reason:string}).reason==='threshold'));
  assert.match(f.prompts.at(-1)!,/CURRENT-WITH-TOOLS-BUDGET/);assert.doesNotMatch(f.prompts.at(-1)!,/old detail old detail/);
 }finally{await f.close();}
});
