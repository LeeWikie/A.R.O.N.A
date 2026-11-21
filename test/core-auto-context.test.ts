import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { APICallError } from '@ai-sdk/provider';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { finished, removeTemp } from './helpers.js';

async function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-auto-context-'));const prompts:string[]=[];let overflow=0;let summaries=0;let failSummary=false;
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{
  const prompt=JSON.stringify(request.prompt);prompts.push(prompt);const summary=prompt.includes('context checkpoint summary');
  if(summary){summaries++;if(failSummary)throw Error('synthetic summary failure');}
  else if(overflow>0){overflow--;throw new APICallError({message:'maximum context length exceeded',url:'http://example.invalid/v1',requestBodyValues:{},statusCode:400,responseBody:'{"error":{"code":"context_length_exceeded"}}',isRetryable:false});}
  const text=summary?'## Goal\nKeep EARLY-CONSTRAINT intact.':'complete';
  return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:text});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};
 }});
 const options={dataDir:directory,model,memoryEnabled:false,modelConfig:{protocol:'responses' as const,baseURL:'http://example.invalid/v1',modelId:'synthetic',apiKey:'fixture-only',authHeader:'bearer' as const,contextWindow:8000}};
 let core=await Core.open(options);core.configure('runtime',{autoCompaction:{enabled:false,reserveTokens:1000,keepRecentTokens:500}});
 return {get core(){return core;},prompts,get summaries(){return summaries;},failSummary(){failSummary=true;},overflow(n=1){overflow=n;},async send(content:string,contextId='main'){const r=await core.submitMessage({content,contextId});return finished(core,r.runId!);},async reopen(){await core.close();core=await Core.open(options);},async close(){await core.close();await removeTemp(directory);}};
}
const long='EARLY-CONSTRAINT '+ 'old detail '.repeat(4500);
test('automatic threshold compaction retains the same context, source records and exact active user request across restart',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send(long);await f.send('previous recent turn');const original=(await f.core.memory.recall({threadId:'main',perPage:100,page:0,hideSignals:false,orderBy:{field:'createdAt',direction:'ASC'}})).messages.map(m=>JSON.stringify(m.content));
  f.core.configure('runtime',{autoCompaction:{enabled:true,reserveTokens:1000,keepRecentTokens:500}});
  assert.equal((await f.send('CURRENT-EXACT-REQUEST-777'))!.status,'succeeded');assert.equal(f.summaries,1);
  const actual=f.prompts.at(-1)!;assert.match(actual,/EARLY-CONSTRAINT/);assert.match(actual,/CURRENT-EXACT-REQUEST-777/);assert.doesNotMatch(actual,/old detail old detail/);
  assert.equal(f.core.runtime.contexts().length,1);const after=(await f.core.memory.recall({threadId:'main',perPage:100,page:0,hideSignals:false,orderBy:{field:'createdAt',direction:'ASC'}})).messages;for(let i=0;i<original.length;i++)assert.equal(JSON.stringify(after[i]!.content),original[i]);
  assert.ok(f.core.sessionGraph.records('main').some(row=>row.entry.type==='compaction'));assert.doesNotMatch(JSON.stringify((await f.core.history('main')).messages),/old detail old detail/);
  await f.reopen();assert.equal((await f.send('AFTER-RESTART-REQUEST'))!.status,'succeeded');assert.match(f.prompts.at(-1)!,/EARLY-CONSTRAINT/);assert.equal(f.summaries,1);
  const copy=await f.core.cloneContext('main',{id:'chat.compacted-copy'});
  assert.equal((await f.send('CONTINUE-COPIED-CHECKPOINT',copy.id))!.status,'succeeded');
  assert.match(f.prompts.at(-1)!,/EARLY-CONSTRAINT/);assert.doesNotMatch(f.prompts.at(-1)!,/old detail old detail/);
  assert.equal(f.summaries,1,'a stable native copy reuses the validated checkpoint instead of summarizing again');
 }finally{await f.close();}
});
test('native API overflow recovery compacts and retries the current turn once without replaying user acceptance',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send(long);await f.send('retained recent');f.core.configure('runtime',{autoCompaction:{enabled:true,reserveTokens:1000,keepRecentTokens:500}});
  // An unknown provider window still recovers explicit overflows; it is never guessed from a model name.
  f.core.models.limits=()=>({contextWindow:null,maxTokens:null,source:'unknown'});
  f.overflow();const result=await f.send('RECOVER-THIS-EXACT-REQUEST');assert.equal(result!.status,'succeeded');assert.equal(f.summaries,1);
  assert.match(f.prompts.at(-1)!,/RECOVER-THIS-EXACT-REQUEST/);assert.doesNotMatch(f.prompts.at(-1)!,/old detail old detail/);
  const rows=f.core.store.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE json_extract(body,'$.content')=?").get('RECOVER-THIS-EXACT-REQUEST');assert.equal(rows!.n,1);
  assert.equal(f.core.runtime.events('main',0,1000).filter(event=>event.kind==='compaction_state'&&(event.data as {state:string}).state==='finished').length,1);
 }finally{await f.close();}
});
test('failed automatic summaries leave history and checkpoint publication untouched',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send(long);await f.send('retained recent');f.core.configure('runtime',{autoCompaction:{enabled:true,reserveTokens:1000,keepRecentTokens:500}});f.failSummary();
  assert.equal((await f.send('KEEP-FAILURE-REQUEST'))!.status,'failed');assert.equal(f.core.runtime.setting('auto-context:main',null),null);
  assert.match(JSON.stringify((await f.core.history('main')).messages),/old detail old detail/);assert.equal(f.core.runtime.contexts().length,1);
 }finally{await f.close();}
});

test('a repeated context overflow is terminal after one native recovery and never loops compaction',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send(long);await f.send('retained recent');f.core.configure('runtime',{autoCompaction:{enabled:true,reserveTokens:1000,keepRecentTokens:500}});f.core.models.limits=()=>({contextWindow:null,maxTokens:null,source:'unknown'});f.overflow(2);
  assert.equal((await f.send('DO-NOT-RETRY-INDEFINITELY'))!.status,'failed');assert.equal(f.summaries,1);
  assert.equal(f.core.runtime.events('main',0,1000).filter(event=>event.kind==='compaction_state'&&(event.data as {state:string}).state==='finished').length,1);
 }finally{await f.close();}
});
