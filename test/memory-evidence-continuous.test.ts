import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {getEncoding} from 'js-tiktoken';
import {APICallError} from '@ai-sdk/provider';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {RuntimeStore} from '../src/runtime-store.js';
import {ProjectMemory,type ContextSnapshot} from '../src/memory/index.js';
import {buildMemoryEvidence} from '../src/memory/evidence.js';
import {MemorySourcePageModel} from './memory-source-page-model.js';
import {removeTemp} from './helpers.js';

for(const mode of ['iteration-boundary','context-boundary','unknown-context']as const)test(`a native memory job can finish a complete large source across the ${mode} without manual retry or changing source bytes`,{timeout:90000},async(t)=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-memory-continuous-')),db=new DatabaseSync(':memory:'),store=new RuntimeStore(db),memory=new ProjectMemory(store,directory),pages=new MemorySourcePageModel(),encoding=getEncoding('o200k_base');
 const source={contextId:'synthetic-continuous',runId:'c2765a4d-78ab-44c4-91e8-a5981fdc8528',sequence:1};
 const original='FIRST_SOURCE_FACT: Original choice was provisional; the user has not confirmed blue.\n'+(mode==='iteration-boundary'?'Original record preserves every condition, correction and source.\n'.repeat(8000):'完整经历及原始条件。修正发生在后续记录，不能作为此前已确认。\n'.repeat(9000))+'\nFINAL_SOURCE_CORRECTION: The confirmed choice is blue.\n';
 const sourceHash=createHash('sha256').update(original).digest('hex'),snapshot:ContextSnapshot={...source,modelProfile:'synthetic',createdAt:'2020-01-01T00:00:00Z',prompt:[],nativeMessages:{},providerOptions:{}},evidence=buildMemoryEvidence({source,gaps:[],entries:[{kind:'user-statement',origin:'signal',provenance:{contextId:source.contextId,runId:source.runId,signalId:'original-user'},content:original}]});
 memory.archive(snapshot);const job=memory.newJob(source.runId),window=mode==='iteration-boundary'?400000:40000;let calls=0,committed=false,written=false,maxInputTokens=0,summaries=0,rejected=0;
 const model=new MastraLanguageModelV2Mock({doGenerate:async request=>{
  calls++;const inputTokens=encoding.encode(JSON.stringify(request.prompt)).length;maxInputTokens=Math.max(maxInputTokens,inputTokens);
  if(inputTokens>window){rejected++;throw new APICallError({message:'maximum context length exceeded',url:'https://fixture.invalid/v1',requestBodyValues:{inputTokens,contextWindow:window},statusCode:400,responseBody:'{"error":{"code":"context_length_exceeded"}}',isRetryable:false});}
  if(!request.tools?.some(tool=>tool.name==='memory_commit')){summaries++;assert.match(JSON.stringify(request.prompt),/FIRST_SOURCE_FACT|The original choice was provisional/);return{content:[{type:'text',text:'The original choice was provisional. Source actor: user; provenance: original-user. Continue reading the complete original source and retain subsequent corrections.'}],finishReason:'stop',usage:{inputTokens,outputTokens:30,totalTokens:inputTokens+30},warnings:[]};}
  const page=pages.next(request);
  if(page)return{content:[page],finishReason:'tool-calls',usage:{inputTokens,outputTokens:1,totalTokens:inputTokens+1},warnings:[]};
  if(!written){const actual=JSON.stringify(request.prompt);assert.match(actual,/FINAL_SOURCE_CORRECTION: The confirmed choice is blue/);assert.match(actual,/FIRST_SOURCE_FACT|The original choice was provisional/);written=true;return{content:[{type:'tool-call',toolName:'memory_write',toolCallId:'write-final-source-correction',input:JSON.stringify({path:'facts.md',content:`The original choice was provisional; later the user confirmed blue. Source: ${source.runId}/original-user. The complete source was read through its final correction.`})}],finishReason:'tool-calls',usage:{inputTokens,outputTokens:1,totalTokens:inputTokens+1},warnings:[]};}
  if(!committed){committed=true;return{content:[{type:'tool-call',toolName:'memory_commit',toolCallId:'commit-entire-source',input:JSON.stringify({sourceRunId:source.runId,note:'Read the entire source through its final correction.'})}],finishReason:'tool-calls',usage:{inputTokens,outputTokens:1,totalTokens:inputTokens+1},warnings:[]};}
  return{content:[{type:'text',text:'Checked the complete source.'}],finishReason:'stop',usage:{inputTokens,outputTokens:1,totalTokens:inputTokens+1},warnings:[]};
 }});
 try{
  await memory.organize(job.id,()=>model,undefined,undefined,()=>evidence,undefined,undefined,{contextWindow:mode==='unknown-context'?null:window});
  assert.equal(memory.jobs().find(row=>row.id===job.id)!.status,'succeeded');assert.equal(committed,true);assert.ok(calls>32,'the scenario must cross the former fixed step boundary');
  if(mode==='unknown-context')assert.ok(rejected>=2,'unknown capacity requires recovery at multiple genuine provider overflow boundaries');else assert.ok(maxInputTokens<=window,'every actual provider request, including summaries, fits the unchanged declared window');if(mode!=='iteration-boundary')assert.ok(summaries>=2,'the source requires continuous compaction');
  assert.equal(createHash('sha256').update(original).digest('hex'),sourceHash);assert.deepEqual(memory.snapshot(source.runId),snapshot);assert.equal(memory.version().generation,1);assert.match(fs.readFileSync(path.join(memory.version().filesDirectory,'facts.md'),'utf8'),/original choice was provisional; later the user confirmed blue.*original-user/s);
 }finally{t.diagnostic(JSON.stringify({calls,summaries,rejected,contextWindow:window,configuredContextWindow:mode==='unknown-context'?null:window,maxInputTokens,written,committed,sourceHash,sourceUnchanged:createHash('sha256').update(original).digest('hex')===sourceHash}));db.close();await removeTemp(directory);}
});
