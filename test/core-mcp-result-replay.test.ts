import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {removeTemp,until} from './helpers.js';

function stream(action?:{name:string;input:unknown},phase=0){return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`synthetic-result-replay-${phase}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

test('structured MCP result content remains available to the same worker after a complete core restart without another remote call',{timeout:20000},async()=>{
 let calls=0,phase=0,core!:Core,continuing=false;const checks:Array<{continuing:boolean;present:boolean}>=[],turns=new Map<string,number>();const marker='SYNTHETIC_CONTENT_CHANNEL_ONLY_VIOLET_29';
 const remote=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text)as{id?:string|number;method:string;params?:{protocolVersion:string}};if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize')result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-result-replay',version:'1'}};
  if(rpc.method==='tools/list')result={tools:[{name:'source',inputSchema:{type:'object',properties:{}},outputSchema:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}}]};
  if(rpc.method==='tools/call'){calls++;result={content:[{type:'text',text:marker}],structuredContent:{code:'structured-code'},_meta:{synthetic:'original-result-meta'}};}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 remote.listen(0,'127.0.0.1');await once(remote,'listening');const address=remote.address();assert.ok(address&&typeof address!=='string');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-mcp-replay-'));
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return stream();const task=core.runtime.tasks().find(task=>task.status==='running');assert.ok(task);const step=phase++,turn=turns.get(task.id)??0;turns.set(task.id,turn+1);
  if(!continuing&&turn===0)return stream({name:'ext_replay_source',input:{}},step);
  checks.push({continuing,present:JSON.stringify(request.prompt).includes(marker)});assert.match(JSON.stringify(request.prompt),new RegExp(marker),'the original MCP content channel is model-readable');
  return stream((!continuing&&turn===1)||(continuing&&turn===0)?{name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:continuing?'Reviewed the original remote source after restart.':'Read the remote source.',checks:[{description:'The original remote content is present.',passed:true}],deliveries:[],unresolved:[]}}}:undefined,step);
 }});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{
  await core.capabilities.saveMCP({id:'replay',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy'});await core.capabilities.connect('replay');const first=await core.submitTask({title:'Read remote source',content:'Read the original remote source.',grants:{write:false,execute:false,mcp:true}},'synthetic-mcp-replay-first');const done=await until(()=>core.runtime.task(first.id),row=>['succeeded','failed','blocked','unreported','interrupted'].includes(row.status));assert.equal(done.status,'succeeded');assert.equal(calls,1);
  await core.close();continuing=true;core=await Core.open({dataDir:directory,model,memoryEnabled:false});const next=await core.submitTask({contextId:first.contextId,title:'Continue from original source',content:'Review the source already obtained in this conversation. Use the original result without another remote operation.'},'synthetic-mcp-replay-second');const restored=await until(()=>core.runtime.task(next.id),row=>['succeeded','failed','blocked','unreported','interrupted'].includes(row.status));assert.equal(restored.status,'succeeded',JSON.stringify({checks,phase,errors:core.runtime.events(next.contextId,0,10000).filter(event=>/error|failed/.test(event.kind))}));assert.equal(calls,1,'history replay does not fetch the source again');
 }finally{await core.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));await removeTemp(directory);}
});

test('an MCP image beside structured content reaches the vision model as its original bytes',{timeout:20000},async()=>{
 let core!:Core,phase=0,calls=0,observed=false;const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
 const contains=(value:unknown):boolean=>value instanceof Uint8Array?Buffer.from(value).equals(Buffer.from(png,'base64')):typeof value==='string'?value===png||value===`data:image/png;base64,${png}`:Array.isArray(value)?value.some(contains):Boolean(value&&typeof value==='object'&&Object.values(value).some(contains));
 const remote=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text)as{id?:string|number;method:string;params?:{protocolVersion:string}};if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize')result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-result-image',version:'1'}};
  if(rpc.method==='tools/list')result={tools:[{name:'image',inputSchema:{type:'object',properties:{}},outputSchema:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}}]};
  if(rpc.method==='tools/call'){calls++;result={content:[{type:'text',text:'A synthetic image follows.'},{type:'image',mimeType:'image/png',data:png}],structuredContent:{code:'image-source'}};}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 remote.listen(0,'127.0.0.1');await once(remote,'listening');const address=remote.address();assert.ok(address&&typeof address!=='string');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-mcp-image-'));
 const model=new MastraLanguageModelV2Mock({provider:'openai.responses',modelId:'gpt-6-luna',doStream:async request=>{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return stream();const task=core.runtime.tasks().find(task=>task.status==='running');assert.ok(task);const step=phase++;
  if(step===0)return stream({name:'ext_vision_image',input:{}},step);
  observed=contains(request.prompt);assert.equal(observed,true,'the provider receives the original image content rather than a text-only structured-result projection');
  return stream(step===1?{name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Inspected the original synthetic image.',checks:[{description:'The original image bytes reached the model input.',passed:true}],deliveries:[],unresolved:[]}}}:undefined,step);
 }});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{await core.capabilities.saveMCP({id:'vision',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy'});await core.capabilities.connect('vision');const task=await core.submitTask({title:'Inspect remote image',content:'Inspect the supplied remote image.',grants:{write:false,execute:false,mcp:true}},'synthetic-mcp-vision');const done=await until(()=>core.runtime.task(task.id),row=>['succeeded','failed','blocked','unreported','interrupted'].includes(row.status));assert.equal(done.status,'succeeded',JSON.stringify({phase,calls,observed}));assert.equal(calls,1);}
 finally{await core.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));await removeTemp(directory);}
});
