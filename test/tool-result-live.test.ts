import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {publicEventPage} from '../src/event-stream.js';
import {toolResultViewSchema} from '../src/protocol.js';
import {until,removeTemp} from './helpers.js';
import {syntheticPng} from './fixtures/png.js';

function output(toolName?:string,input:unknown={},toolCallId='done'){
 return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(toolName)c.enqueue({type:'tool-call',toolName,input:JSON.stringify(input),toolCallId});c.enqueue({type:'finish',finishReason:toolName?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};
}
function imageReference(value:unknown):string|undefined{
 if(typeof value==='string'){const marker='[Additional original business data, readable with read_mcp_result: ';if(value.startsWith(marker)){const rows=JSON.parse(value.slice(marker.length,-1))as Array<{id:string;representation:string}>;return rows.find(row=>row.representation==='mcp-model-image')?.id;}try{return imageReference(JSON.parse(value));}catch{return;}}
 if(value&&typeof value==='object')for(const child of Object.values(value)){const found=imageReference(child);if(found)return found;}
}
for(const mode of ['direct','retained-read']as const)test(`a ${mode} native image is durably readable while the next model step is held, without publishing its bytes in SSE`, {timeout:30000},async()=>{
 const image=syntheticPng(1,1).toString('base64'),secret='SYNTHETIC_PROTOCOL_META_NEVER_VISIBLE';let calls=0,core!:Core,phase=0,held=false,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const remote=createServer(async(req,res)=>{if(req.method!=='POST'){res.writeHead(405).end();return;}let body='';for await(const part of req)body+=part;const rpc=JSON.parse(body);if(rpc.id===undefined){res.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize')result={protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-live-image',version:'1'}};
  if(rpc.method==='tools/list')result={tools:[{name:'picture',inputSchema:{type:'object',properties:{}}}]};
  if(rpc.method==='tools/call'){calls++;result={content:[{type:'text',text:'Original image received.'},{type:'image',mimeType:'image/png',data:image}],_meta:{client:secret}};}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });remote.listen(0,'127.0.0.1');await once(remote,'listening');const address=remote.address();assert.ok(address&&typeof address!=='string');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tool-live-result-'));
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return output();const task=core.runtime.tasks()[0]!;
  const step=phase++;
  if(step===0){const tool=request.tools.find(tool=>tool.name.startsWith('ext_'));assert.ok(tool);return output(tool.name,{},'original-picture-call');}
  if(mode==='retained-read'&&step===1){const id=imageReference(request.prompt);assert.ok(id,'the actual native model received the readable original image reference');return output('read_mcp_result',{id,signalIds:[task.signalId]},'retained-picture-call');}
  if(step===(mode==='direct'?1:2)){assert.ok(!JSON.stringify(request.prompt).includes(secret));held=true;await gate;return output('task_report',{id:task.id,report:{outcome:'succeeded',summary:'Inspected the original image.',checks:[{description:'The model received the original safe result.',passed:true}],deliveries:[],unresolved:[]}},'report-picture');}
  return output();
 }});
 try{
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});await core.capabilities.saveMCP({id:'picture',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy'});await core.capabilities.connect('picture');
  const task=await core.submitTask({title:'Inspect a synthetic image',content:'Read and inspect the original image.',grants:{write:false,execute:false,mcp:true}},'synthetic-live-image');
  await until(()=>held,Boolean);assert.equal(core.runtime.task(task.id).status,'running');assert.equal(calls,1);
  const toolCallId=mode==='direct'?'original-picture-call':'retained-picture-call',page=publicEventPage(core,0,task.contextId),event=page.events.findLast(row=>row.kind==='tool'&&(row.data as any).toolCallId===toolCallId);assert.ok(event);
  const identity=event.data as {nativeMessageId:string;resultEventSeq:number};assert.ok(identity.nativeMessageId);assert.ok(Number.isSafeInteger(identity.resultEventSeq));
  assert.ok(!JSON.stringify(page).includes(image),'SSE carries the real result receipt, not repeated image payloads');assert.ok(!JSON.stringify(page).includes(secret));
  const input={runId:event.runId,toolCallId,nativeMessageId:identity.nativeMessageId};
  const view=toolResultViewSchema.parse(core.contextToolResult(task.contextId,input));
  assert.equal(view.availability,'available');assert.equal(view.tool!.resultEntryId,undefined,'no graph entry is fabricated before the original run commits');assert.equal(view.tool!.resultEventSeq,identity.resultEventSeq);
  assert.deepEqual(view.tool!.resultContent!.filter(part=>part.type==='image'),[{type:'image',mimeType:'image/png',data:image}]);assert.ok(!JSON.stringify(view).includes(secret));
  const app=createApp(core),headers={authorization:`Bearer ${core.controlToken}`,'X-ShittimChest-Storage-Id':core.storageId,'X-ShittimChest-Instance-Id':core.instanceId},response=await app.request(`/contexts/${encodeURIComponent(task.contextId)}/tool-result?runId=${event.runId}&toolCallId=${toolCallId}&nativeMessageId=${identity.nativeMessageId}`,{headers});assert.equal(response.status,200);assert.deepEqual(await response.json(),view);
  const stored=core.store.db.prepare('SELECT seq,data FROM runtime_events WHERE event_key=?').get(`tool.public:${identity.resultEventSeq}`)!;assert.ok(stored);
  const original=String(stored.data),forged=JSON.parse(original);forged.resultContent.find((part:any)=>part.type==='image').data='AAAA';
  core.store.db.prepare('UPDATE runtime_events SET data=? WHERE seq=?').run(JSON.stringify(forged),Number(stored.seq));
  assert.notEqual(core.contextToolResult(task.contextId,input).availability,'available','changed derived image bytes cannot pass the original receipt');
  core.store.db.prepare('UPDATE runtime_events SET data=? WHERE seq=?').run(original,Number(stored.seq));
  assert.equal(core.contextToolResult(task.contextId,input).availability,'available');release();
  const done=await until(()=>core.runtime.task(task.id),row=>['succeeded','failed','unreported','interrupted'].includes(row.status));assert.equal(done.status,'succeeded');assert.equal(calls,1);
  await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  const cold=core.contextToolResult(task.contextId,input);assert.equal(cold.availability,'available');assert.ok(cold.tool!.resultEntryId,'the original committed graph result is retained after a cold restart');assert.deepEqual(cold.tool!.resultContent!.filter(part=>part.type==='image'),[{type:'image',mimeType:'image/png',data:image}]);assert.equal(calls,1);
 }finally{release();await core?.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));await removeTemp(directory);}
});
