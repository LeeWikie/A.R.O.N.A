import assert from'node:assert/strict';
import fs from'node:fs';
import os from'node:os';
import path from'node:path';
import{randomUUID}from'node:crypto';
import test from'node:test';
import{MastraLanguageModelV2Mock}from'@mastra/core/test-utils/llm-mock';
import{Core}from'../src/core.js';
import{createApp}from'../src/http.js';
import{AppError}from'../src/domain.js';
import{submitLogicalInput}from'../src/tui/logical-input.js';
import{QueueLocalEdits}from'../src/tui/queue-local-edits.js';
import{finished,until,removeTemp}from'./helpers.js';

for(const scenario of ['ended-before-admission','still-running-refusal']as const)test(`native steer ${scenario} preserves one input and requires terminal-run proof before queue fallback`,{timeout:20000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-steer-life-'));let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),prompts:string[]=[];let refuse=scenario==='still-running-refusal',lose=scenario==='ended-before-admission';
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(prompts.length===1&&scenario==='still-running-refusal')await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false}),http=createApp(core),local=new QueueLocalEdits(path.join(directory,'client'),'control');
 const call=async<T>(route:string,body?:unknown,method='GET',key?:string):Promise<T>=>{const response=await http.request(route,{method,headers:{Authorization:`Bearer ${core.controlToken}`,'X-ShittimChest-Storage-Id':core.storageId,'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new AppError((value as{error:string}).error,response.status);return value as T;};
 const host={local,validate(){},request:<T>(route:string)=>call<T>(route),write:async(route:string,body:unknown,method='POST',key=randomUUID())=>{if(refuse&&route.endsWith('/submit')){refuse=false;throw new AppError('run_changed',409);}const value=await call(route,body,method,key);if(lose&&key.endsWith('.idle-submit')){lose=false;throw new AppError('synthetic_idle_ack_lost',502);}return value;}};
 try{const original=await core.submitMessage({content:'SYNTHETIC_ORIGINAL_RUNNING_INPUT'});await until(()=>prompts.length,count=>count===1);if(scenario==='ended-before-admission')await finished(core,original.runId!);const content='SYNTHETIC_NEW_INPUT_AFTER_OBSERVED_RUN',intent={id:randomUUID(),storageId:core.storageId,contextId:'main',content,attachments:[],mode:'steer' as const,expectedRunId:original.runId!};
  await assert.rejects(submitLogicalInput(host,intent),scenario==='ended-before-admission'?/synthetic_idle_ack_lost/:/run_changed/);
  if(scenario==='still-running-refusal'){assert.equal(prompts.length,1);assert.equal(core.runtime.queueEditDocuments().length,1);assert.equal(core.runtime.queueEditDocuments<{submission?:unknown}>()[0]!.submission,undefined);assert.equal(core.queuedMessages('main').length,0);release();await finished(core,original.runId!);}
  const receipt=await submitLogicalInput(host,intent);await until(()=>core.queueEditor().page('main',receipt.id).draft.status,status=>status==='submitted');const submitted=core.queueEditor().page('main',receipt.id).draft;await finished(core,submitted.submission!.runId!);assert.equal(submitted.submission!.mode,'queue');assert.notEqual(submitted.submission!.runId,original.runId);assert.equal(prompts.length,2);assert.equal(prompts[1]!.split(content).length-1,1);assert.equal(local.captures(core.storageId,'main').length,0);
 }finally{release();await core.close();await removeTemp(directory);}
});
