import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createAssistantMessageEventStream,type AssistantMessage,type Context,type Model,type Models,type JsonObject} from '@earendil-works/pi-ai';
import {createPiLanguageModel} from '../src/providers/bridge.js';
import {Core} from '../src/core.js';
import {removeTemp,until} from './helpers.js';

test('the native Pi provider path preserves optional fields and an explicit business null through MCP execution',{timeout:20000},async()=>{
 let core!:Core,phase=0,wire:unknown;const schemas:unknown[]=[];
 const original={type:'object',properties:{nullable:{anyOf:[{type:'string'},{type:'null'}]},optional:{type:'string'}},additionalProperties:false};
 const remote=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text)as{id?:string|number;method:string;params?:{protocolVersion:string;arguments:unknown}};if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize')result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-nullable',version:'1'}};
  if(rpc.method==='tools/list')result={tools:[{name:'input',inputSchema:original}]};if(rpc.method==='tools/call'){wire=rpc.params?.arguments;result={content:[{type:'text',text:'The original input was received.'}]};}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });remote.listen(0,'127.0.0.1');await once(remote,'listening');const address=remote.address();assert.ok(address&&typeof address!=='string');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-mcp-nullable-'));
 const selected:Model<'openai-codex-responses'>={id:'gpt-6-luna',name:'Synthetic Codex',provider:'openai-codex',api:'openai-codex-responses',baseUrl:'http://synthetic.invalid',input:['text','image'],reasoning:true,contextWindow:100000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const models:Pick<Models,'streamSimple'>={streamSimple(_model,context:Context){
  const worker=context.tools?.some(tool=>tool.name==='task_report'),task=worker?core.runtime.tasks().find(task=>task.status==='running'):undefined,step=worker?phase++:-1;if(worker)schemas.push(context.tools?.find(tool=>tool.name==='ext_nullable_input')?.parameters);
  const action:{name:string;arguments:JsonObject}|undefined=worker&&step===0?{name:'ext_nullable_input',arguments:{nullable:null}}:worker&&step===1?{name:'task_report',arguments:{id:task!.id,report:{outcome:'succeeded',summary:'The remote input was submitted.',checks:[{description:'The remote endpoint returned its original response.',passed:true}],deliveries:[],unresolved:[]}}}:undefined;
  const content:AssistantMessage['content']=action?[{type:'toolCall',id:`synthetic-pi-null-${step}`,name:action.name,arguments:action.arguments}]:[{type:'text',text:'Done.'}],message:AssistantMessage={role:'assistant',content,api:selected.api,provider:selected.provider,model:selected.id,timestamp:1,stopReason:action?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}},stream=createAssistantMessageEventStream();
  queueMicrotask(()=>{stream.push({type:'start',partial:message});if(action){const call=content[0];assert.equal(call?.type,'toolCall');if(call?.type==='toolCall'){stream.push({type:'toolcall_start',contentIndex:0,partial:message});stream.push({type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(action.arguments),partial:message});stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:message});}}else{stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_delta',contentIndex:0,delta:'Done.',partial:message});stream.push({type:'text_end',contentIndex:0,content:'Done.',partial:message});}stream.push({type:'done',reason:action?'toolUse':'stop',message});});return stream;
 }};
 core=await Core.open({dataDir:directory,model:createPiLanguageModel(models,selected),memoryEnabled:false});
 try{await core.capabilities.saveMCP({id:'nullable',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy'});await core.capabilities.connect('nullable');const task=await core.submitTask({title:'Preserve remote input',content:'Submit an explicit null to the remote nullable field; leave the optional string absent.',grants:{write:false,execute:false,mcp:true}},'synthetic-native-nullable');const result=await until(()=>core.runtime.task(task.id),row=>['succeeded','failed','blocked','unreported','interrupted'].includes(row.status));assert.equal(result.status,'succeeded');assert.deepEqual(wire,{nullable:null},JSON.stringify({wire,schemas}));const schema=schemas[0];assert.ok(schema&&typeof schema==='object');assert.doesNotMatch(JSON.stringify(schema),/x-optional/);}
 finally{await core.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));await removeTemp(directory);}
});
