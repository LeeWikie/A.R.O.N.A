import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,removeTemp,until} from './helpers.js';

function stream(action?:{name:string;input:unknown},step=0){return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`synthetic-recovery-${step}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

test('an actual worker verifies an ambiguous external effect before reporting delivery without replaying the write',{timeout:20000},async()=>{
 let effects=0,connections=0,step=0,core!:Core;const calls:string[]=[],prompts:string[]=[];
 const remote=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let input='';for await(const chunk of request)input+=chunk;const rpc=JSON.parse(input)as{id?:string|number;method:string;params?:{protocolVersion:string;name:string}};
  if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize'){connections++;result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-effect-verification',version:'1'}};}
  if(rpc.method==='tools/list')result={tools:[{name:'write_once',description:'Apply the requested external operation once.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:false}},{name:'verify_effect',description:'Read the authoritative current operation count without changing it.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]};
  if(rpc.method==='tools/call'){const name=rpc.params?.name??'';calls.push(name);if(name==='write_once'){effects++;response.destroy();return;}result={content:[{type:'text',text:`VERIFIED_EXTERNAL_EFFECT_COUNT=${effects}`}]};}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 remote.listen(0,'127.0.0.1');await once(remote,'listening');const address=remote.address();assert.ok(address&&typeof address!=='string');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-mcp-uncertain-'));
 const model=new MastraLanguageModelV2Mock({provider:'openai.responses',modelId:'gpt-6-luna',doStream:async request=>{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return stream();const task=core.runtime.tasks().find(task=>task.status==='running');assert.ok(task);const prompt=JSON.stringify(request.prompt),phase=step++;prompts.push(prompt);
  if(phase===0)return stream({name:'ext_once_write_once',input:{}},phase);
  if(phase===1){assert.match(prompt,/outcome is uncertain/i);assert.match(prompt,/not replayed/i);assert.equal(effects,1);return stream({name:'ext_once_verify_effect',input:{}},phase);}
  if(phase===2){assert.match(prompt,/VERIFIED_EXTERNAL_EFFECT_COUNT=1/);assert.deepEqual(calls,['write_once','verify_effect']);return stream({name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'The external operation was verified as applied once.',checks:[{description:'Read the external authority after the missing reply and observed exactly one operation.',passed:true}],deliveries:[{kind:'text',title:'Verified operation count',value:'1'}],unresolved:[]}}},phase);}
  return stream();
 }});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{
  await core.capabilities.saveMCP({id:'once',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy'});await core.capabilities.connect('once');
  const response=await authenticatedApp(core).request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Apply and verify operation',content:'Apply the operation exactly once. If its reply is lost, inspect the external authority before declaring delivery. Never repeat an uncertain write.',grants:{write:false,execute:false,mcp:true}})});assert.equal(response.status,202);const admitted=await response.json()as{id:string};
  const result=await until(()=>core.runtime.task(admitted.id),task=>['succeeded','failed','blocked','unreported','interrupted'].includes(task.status));assert.equal(result.status,'succeeded',JSON.stringify(core.runtime.events(result.contextId,0,10000)));assert.equal(effects,1);assert.deepEqual(calls,['write_once','verify_effect']);assert.equal(core.runtime.approvals().filter(row=>row.taskId===result.id&&row.status==='pending').length,0);assert.ok(connections>=3,'rootless and owner connections are separate; the original owner transport heals after the lost reply');assert.equal(result.report?.deliveries[0]?.value,'1');assert.equal(prompts.length,4);
  const events=core.runtime.events(result.contextId,0,10000).filter(event=>event.kind==='tool_end');assert.match(JSON.stringify(events),/outcome is uncertain/i);assert.match(JSON.stringify(events),/VERIFIED_EXTERNAL_EFFECT_COUNT=1/);
 }finally{await core.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));await removeTemp(directory);}
});
