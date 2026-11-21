import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {getEncoding} from 'js-tiktoken';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,type TranscriptContext} from '@earendil-works/pi-ai';
import {getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {Core} from '../src/core.js';
import {finished,until,removeTemp} from './helpers.js';

function page(value:unknown):{next:{index:number;offset:number}|null}|undefined{
 if(typeof value==='string'){try{return page(JSON.parse(value));}catch{return;}}
 if(!value||typeof value!=='object')return;if('source'in value&&'parts'in value&&'next'in value)return value as {next:{index:number;offset:number}|null};
 for(const child of Object.values(value)){const result=page(child);if(result)return result;}
}
test('the actual native background memory task completes large retained history with its separately selected small model and continuous compaction',{timeout:60000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-memory-continuous-')),core=await Core.open({dataDir:directory,memoryEnabled:false}),encoding=getEncoding('o200k_base'),provider=fauxProvider({provider:'synthetic-core-memory-continuous',models:[{id:'source',input:['text'],contextWindow:1000000,maxTokens:8192},{id:'organizer',input:['text'],contextWindow:40000,maxTokens:8192}]});
 let sourceRunId='',modelCalls=0,summaries=0,maxInput=0,written=false;const observed=new Set<string>();
 provider.setResponses(Array.from({length:200},()=>async(context:TranscriptContext,_options:unknown,_state:unknown,model:{id:string})=>{
  if(model.id==='source')return fauxAssistantMessage('The original experience remains recorded.');
  modelCalls++;const actual=JSON.stringify(context.messages),tokens=encoding.encode(actual).length;maxInput=Math.max(maxInput,tokens);assert.ok(tokens<40000,'the actual selected small provider rejects oversized input');
  if(!getCurrentTools(context.messages).some(tool=>tool.name==='memory_commit')){summaries++;assert.match(actual,/FIRST_SOURCE_FACT|The original choice was provisional/);return fauxAssistantMessage('The original choice was provisional. Actor user; retain original provenance and later corrections. Continue reading the entire source.');}
  const latest=[...context.messages].reverse().flatMap(row=>row.role==='toolResult'&&row.toolName==='memory_source_page'?[page(row.content)]:[]).find(Boolean);
  if(!latest||latest.next!==null)return fauxAssistantMessage(fauxToolCall('memory_source_page',latest?.next??{index:0,offset:0},{id:`source-page-${modelCalls}`}),{stopReason:'toolUse'});
  if(!written){assert.match(actual,/FINAL_SOURCE_CORRECTION: The confirmed choice is blue/);assert.match(actual,/FIRST_SOURCE_FACT|The original choice was provisional/);written=true;return fauxAssistantMessage(fauxToolCall('memory_write',{path:'facts.md',content:`The original choice was provisional; later the user confirmed blue. Source ${sourceRunId}.`},{id:'write-complete-history'}),{stopReason:'toolUse'});}
  observed.add(sourceRunId);return fauxAssistantMessage(fauxToolCall('memory_commit',{sourceRunId,note:'Checked all original source pages and retained the earlier condition and final correction.'},{id:'commit-complete-history'}),{stopReason:'toolUse'});
 }));
 core.providerRegistry.setProvider(provider.provider);core.models.save({id:'default',name:'Source',providerId:provider.provider.id,modelId:'source'});core.models.save({id:'memory-small',name:'Organizer',providerId:provider.provider.id,modelId:'organizer'});core.configure('runtime',{memoryModel:'memory-small'});
 try{
  const body='完整的共同经历与原始条件。\n'.repeat(3200);
  for(let index=0;index<3;index++){const receipt=await core.submitMessage({content:(index===0?'FIRST_SOURCE_FACT: Original choice was provisional.\n':'')+body+(index===2?'\nFINAL_SOURCE_CORRECTION: The confirmed choice is blue.':'')});assert.equal((await finished(core,receipt.runId!))!.status,'succeeded');sourceRunId=receipt.runId!;}
  const snapshotHash=createHash('sha256').update(JSON.stringify(core.projectMemory.snapshot(sourceRunId))).digest('hex'),job=await core.queueMemory(sourceRunId);
  const done=await until(()=>core.projectMemory.jobs().find(row=>row.id===job.id)!,row=>!['pending','running'].includes(row.status));assert.equal(done.status,'succeeded',done.error??undefined);assert.ok(job.nativeTaskId);const manager=core.sessions.controller.getMastra()!.backgroundTaskManager!,native=await until(()=>manager.getTask(job.nativeTaskId!),row=>row!==null&&['completed','failed','cancelled','timed_out'].includes(row.status));assert.equal(native!.status,'completed');
  assert.ok(modelCalls>32);assert.ok(summaries>=2);assert.equal(observed.size,1);assert.ok(maxInput<40000);assert.match(fs.readFileSync(path.join(core.projectMemory.version().filesDirectory,'facts.md'),'utf8'),/original choice was provisional; later the user confirmed blue/);
  const checkpoints=core.runtime.events('main',0,10000).filter(row=>row.kind==='memory_compaction'&&(row.data as {state?:string}).state==='finished');assert.ok(checkpoints.length>=2);assert.equal(createHash('sha256').update(JSON.stringify(core.projectMemory.snapshot(sourceRunId))).digest('hex'),snapshotHash);
 }finally{await core.close();await removeTemp(directory);}
});
