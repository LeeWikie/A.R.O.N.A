import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {WebResultStore,type WebResultReference} from '../src/web/results.js';
import {authenticatedApp,until,removeTemp} from './helpers.js';

const marker='SYNTHETIC_RETAINED_MIDDLE_CANARY';
function reply(action?:{name:string;input:unknown},callId='synthetic-web-proof'){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:callId,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}
const cases=['same-source','supplement','source-rewrite','permission-revoked','other-context','other-workspace','before-result','unknown-reference','record-changed'] as const;
for(const mode of cases)test(`retained web data checks its actual source and selected tool origin: ${mode}`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-web-source-proof-')),rows=Array.from({length:4000},(_,index)=>index===2000?marker:`synthetic public row ${index} `.repeat(3)),body=rows.join('\n'),server=createServer((_request,response)=>response.writeHead(200,{'content-type':'text/plain'}).end(body));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 let core!:Core,phase:'fetch'|'after-fetch'|'read'|'after-read'='fetch',reference:WebResultReference|undefined,modelError:unknown,mutated=false,readCallId='';const prompts:string[]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>['running','waiting'].includes(row.status))!;prompts.push(JSON.stringify(request.prompt));
  if(phase==='fetch'){phase='after-fetch';return reply({name:'web_fetch',input:{signalIds:[task.signalId],url:`http://synthetic.example:${address.port}/page`,mode:'text',maxChars:20000}},'source-web-fetch');}
  if(phase==='after-fetch'){const event=core.runtime.events(task.contextId,0,1000).find(event=>event.kind==='tool_end'&&(event.data as {toolCallId?:string}).toolCallId==='source-web-fetch')!;assert.equal((event.data as {isError?:boolean}).isError,false,JSON.stringify(event.data));reference=(event.data as {result:{resultRef:WebResultReference}}).result.resultRef;assert.ok(reference);return reply();}
  if(phase==='read'){
   if(!mutated){mutated=true;
    if(mode==='source-rewrite'){const binding=new WebResultStore(core.store.db,core.controlToken).describe(reference!.id).binding,id=binding.sourceSignalIds.find(id=>!task.sourceSignalIds.includes(id))!;assert.ok(id);const row=core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(id)!,input=JSON.parse(String(row.body));input.content+=' SYNTHETIC_CHANGED_SOURCE';core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(input),id);}
    if(mode==='permission-revoked')core.runtime.updateTask(task.id,{grants:{...task.grants,write:false}});
    if(mode==='record-changed'){const row=core.store.db.prepare('SELECT body FROM web_result_records WHERE id=?').get(reference!.id)!,value=JSON.parse(String(row.body));value.binding.proof='0'.repeat(64);core.store.db.prepare('UPDATE web_result_records SET body=? WHERE id=?').run(JSON.stringify(value),reference!.id);}
    if(mode==='supplement'){await core.taskMessage(task.id,'A genuine later supplement.',task.sourceSignalIds);return reply();}
   }
   if(mode==='supplement')assert.ok(JSON.stringify(request.prompt).includes('A genuine later supplement.'),'the resumed native request must observe the actual accepted supplement');
   phase='after-read';readCallId='source-web-read';return reply({name:'read_web_result',input:{id:mode==='unknown-reference'?randomUUID():reference!.id,signalIds:[task.signalId],offset:2001,limit:1,encoding:'text'}},readCallId);
  }
  return reply();
 }catch(error){modelError=error;throw error;}}});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false,webTesting:{resolver:async()=>[{address:'127.0.0.1',family:4}],allowLoopbackForHostname:'synthetic.example'}});
 try{
  core.configure('web',{type:'none'});
  const app=authenticatedApp(core),source=await core.submitTask({title:'Synthetic source page',content:'Fetch the synthetic public page.',grants:{write:true,execute:false,mcp:false}},'web-proof-original');
  await until(async()=>{if(modelError)throw modelError;for(const row of core.runtime.approvals().filter(row=>row.status==='pending')){assert.equal(row.toolName,'web_fetch');assert.equal((await app.request(`/approvals/${row.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"decision":"approve"}'})).status,200);}return core.runtime.task(source.id);},row=>row.status==='unreported');assert.ok(reference);assert.ok(prompts.every(prompt=>!prompt.includes(marker)));
  const original=core.runtime.task(source.id),oldRun=original.runIds.at(-1)!;await core.sessions.waitForNativePersistence(oldRun,AbortSignal.timeout(1000));
  if(mode==='before-result'){const entry=core.sessionGraph.records(original.contextId).find(row=>row.source?.runId===oldRun&&row.entry.type==='message'&&row.entry.message.role==='assistant'&&row.entry.message.content.some(part=>part.type==='toolCall'&&part.id==='source-web-fetch'))!;assert.ok(entry);core.sessionGraph.select(original.contextId,entry.entry.id);assert.ok(core.sessionRunIds(original.contextId)?.has(oldRun),'the original run alone does not prove the selected result exists');}
  phase='read';let targetId=source.id;
  if(mode==='other-context'||mode==='other-workspace'){
   let workspaceId:string|undefined;if(mode==='other-workspace'){const workspace=path.join(directory,'other');fs.mkdirSync(workspace);core.configure('workspace',{id:'other',name:'Other synthetic workspace',path:workspace});workspaceId='other';}
   targetId=(await core.submitTask({title:'Another source',content:'Read a reference without borrowing the original task.',...(workspaceId?{workspaceId}:{})},'web-proof-other')).id;
  }else await core.tasks.control(original.id,'retry',original.revision);
  await until(()=>{if(modelError)throw modelError;return core.runtime.task(targetId);},row=>['unreported','failed','interrupted','blocked'].includes(row.status));
  const target=core.runtime.task(targetId),runId=target.runIds.at(-1)!;const event=core.runtime.events(target.contextId,0,1000).find(event=>event.runId===runId&&event.kind==='tool_end'&&(event.data as {toolCallId?:string}).toolCallId===readCallId);assert.ok(event,'the attempted native read must reach its real tool boundary');
  const success=mode==='same-source'||mode==='supplement';assert.equal((event.data as {isError?:boolean}).isError,!success,JSON.stringify(event.data));
  if(success){assert.ok(JSON.stringify((event.data as {result:unknown}).result).includes(marker));assert.ok(prompts.some(prompt=>prompt.includes(marker)));}
  else{assert.equal(prompts.some(prompt=>prompt.includes(marker)),false);assert.match(JSON.stringify((event.data as {result:unknown}).result),/web_result_(?:not_authorized|source_changed|origin_unavailable|not_found|changed)/);}
 }finally{await core.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await removeTemp(directory);}
});
