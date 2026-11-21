import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {APICallError} from '@ai-sdk/provider';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {RuntimeStore} from '../src/runtime-store.js';
import {ProjectMemory,type ContextSnapshot} from '../src/memory/index.js';
import {buildMemoryEvidence} from '../src/memory/evidence.js';
import {MemorySourcePageModel} from './memory-source-page-model.js';
import {removeTemp} from './helpers.js';

for(const failure of ['length','empty','tool-call','provider-error','abort','stop-generation']as const)test(`a native ${failure} during memory compaction cannot publish a partial candidate or advance the source`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-memory-context-failure-')),db=new DatabaseSync(':memory:'),store=new RuntimeStore(db),memory=new ProjectMemory(store,directory),pages=new MemorySourcePageModel(),abort=new AbortController();
 const source={contextId:'synthetic-summary-failure',runId:'1868614c-7868-46f6-a9a5-71c96862371e',sequence:1},snapshot:ContextSnapshot={...source,modelProfile:'synthetic',createdAt:'2020-01-01T00:00:00Z',prompt:[],nativeMessages:{},providerOptions:{}},evidence=buildMemoryEvidence({source,gaps:[],entries:[{kind:'user-statement',origin:'signal',provenance:{contextId:source.contextId,runId:source.runId,signalId:'original-user'},content:'完整事实、原始条件与尚未确认的提议。\n'.repeat(7000)+'FINAL_ORIGINAL_FACT'}]});
 memory.archive(snapshot);const version=memory.version(),original=path.join(version.filesDirectory,'original.md');fs.writeFileSync(original,'THE ORIGINAL MEMORY REMAINS UNCHANGED');const job=memory.newJob(source.runId);let primary=0,summaries=0,canContinue=true;
 const model=new MastraLanguageModelV2Mock({doGenerate:async request=>{
  if(!request.tools?.some(tool=>tool.name==='memory_commit')){
   summaries++;
   if(failure==='provider-error')throw new APICallError({message:'synthetic summary provider rejected the request',url:'https://fixture.invalid/v1',requestBodyValues:undefined,statusCode:400,isRetryable:false});
   if(failure==='abort')abort.abort(new Error('synthetic cancellation during the original native summary'));
   if(failure==='stop-generation')canContinue=false;
   return{content:failure==='tool-call'?[{type:'tool-call',toolName:'memory_write',toolCallId:'forbidden-summary-tool',input:JSON.stringify({path:'must-not-exist.md',content:'No summary tool authority.'})}]:[{type:'text',text:failure==='empty'?'':'A partial or cancelled summary is not publication.'}],finishReason:failure==='length'?'length':failure==='tool-call'?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2},warnings:[]};
  }
  if(primary++===0)return{content:[{type:'tool-call',toolName:'memory_write',toolCallId:'stage-before-summary',input:JSON.stringify({path:'candidate.md',content:'UNPUBLISHED_STAGING_CANDIDATE'})}],finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2},warnings:[]};
  const next=pages.next(request);assert.ok(next);return{content:[next],finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2},warnings:[]};
 }});
 try{
  await assert.rejects(memory.organize(job.id,()=>model,abort.signal,undefined,()=>evidence,()=>canContinue,undefined,{contextWindow:40000}));assert.ok(summaries>0,'the actual native summary request was reached');
  assert.deepEqual(memory.version(),version);assert.equal(fs.readFileSync(original,'utf8'),'THE ORIGINAL MEMORY REMAINS UNCHANGED');assert.equal(fs.existsSync(path.join(version.filesDirectory,'candidate.md')),false);assert.equal(fs.existsSync(path.join(version.filesDirectory,'must-not-exist.md')),false);assert.equal(store.setting<Record<string,number>>('memory-watermarks',{})[source.contextId],undefined);assert.deepEqual(memory.snapshot(source.runId),snapshot);
  assert.equal(memory.jobs().find(row=>row.id===job.id)!.status,failure==='abort'||failure==='stop-generation'?'interrupted':'failed');assert.equal(store.events(source.contextId,0,1000).filter(row=>row.kind==='memory_compaction'&&(row.data as {state?:string}).state==='finished').length,0);
 }finally{db.close();await removeTemp(directory);}
});
