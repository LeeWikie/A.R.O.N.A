import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Core} from '../src/core.js';
import {removeTemp,until} from './helpers.js';

type Protocol='responses'|'chat-completions'|'messages';
function answer(response:ServerResponse,protocol:Protocol,step:number,action?:{name:string;input:unknown}){
 const text='Done.',args=JSON.stringify(action?.input??{}),id=`synthetic-codec-${step}`;let frames:unknown[];
 if(protocol==='responses'){
  const item=action?{type:'function_call',id:'fc_'+id,call_id:id,name:action.name,arguments:args,status:'completed'}:{type:'message',id:'msg_'+id,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]},result={id:'resp_'+id,model:'synthetic-model',created_at:1,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  frames=action?[{type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},{type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:args},{type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:args},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result}]:[{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result}];
 }else if(protocol==='chat-completions'){
  const base={id,created:1,model:'synthetic-model',object:'chat.completion.chunk'};
  frames=action?[{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name:action.name,arguments:''}}]},finish_reason:null}]},{...base,choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:args}}]},finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}]:[{...base,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}];
 }else{
  const message={id,type:'message',role:'assistant',model:'synthetic-model',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}},block=action?{type:'tool_use',id,name:action.name,input:{}}:{type:'text',text:''};
  frames=[{type:'message_start',message},{type:'content_block_start',index:0,content_block:block},{type:'content_block_delta',index:0,delta:action?{type:'input_json_delta',partial_json:args}:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:action?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}];
 }
 response.writeHead(200,{'content-type':'text/event-stream'});for(const frame of frames){const type=frame&&typeof frame==='object'&&'type'in frame&&typeof frame.type==='string'?frame.type:'message';response.write(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`);}response.end();
}

for(const protocol of ['responses','chat-completions','messages']as const)for(const configured of ['startup','profile']as const)test(`${configured} ${protocol} V4 HTTP preserves optional nullable MCP input`,{timeout:20000},async()=>{
 let core!:Core,phase=0;const wire:unknown[]=[],requestTools:unknown[]=[];
 const remote=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const body=JSON.parse(text)as Record<string,unknown>;
  if(request.url?.startsWith('/model/')){
   const tools=Array.isArray(body.tools)?body.tools:[],name=(tool:unknown)=>tool&&typeof tool==='object'?('function'in tool&&tool.function&&typeof tool.function==='object'&&'name'in tool.function?tool.function.name:'name'in tool?tool.name:undefined):undefined,worker=tools.some(tool=>name(tool)==='task_report'),task=worker?core.runtime.tasks().find(task=>task.status==='running'):undefined,step=worker?phase++:-1;requestTools.push(tools.find(tool=>name(tool)==='ext_nullable_input'));
   const action=worker&&step<3?{name:'ext_nullable_input',input:[{nullable:null},{},{optional:'ordinary'}][step]}:worker&&step===3?{name:'task_report',input:{id:task!.id,report:{outcome:'succeeded',summary:'The original input was received by the remote tool.',checks:[{description:'The original remote tool replied.',passed:true}],deliveries:[],unresolved:[]}}}:undefined;answer(response,protocol,step,action);return;
  }
  const rpc=body as{id?:string|number;method:string;params?:{protocolVersion:string;arguments:unknown}};if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize')result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-native-nullable',version:'1'}};
  if(rpc.method==='tools/list')result={tools:[{name:'input',inputSchema:{type:'object',properties:{nullable:{anyOf:[{type:'string'},{type:'null'}]},optional:{type:'string'}},additionalProperties:false}}]};if(rpc.method==='tools/call'){wire.push(rpc.params?.arguments);result={content:[{type:'text',text:'Original input received.'}]};}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });remote.listen(0,'127.0.0.1');await once(remote,'listening');const address=remote.address();assert.ok(address&&typeof address!=='string');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-mcp-native-codec-')),baseURL=`http://127.0.0.1:${address.port}/model`,config={protocol,baseURL,modelId:'synthetic-model',apiKey:'synthetic-native-codec-key',authHeader:'bearer'as const,maxTokens:4096,contextWindow:100000};
 core=await Core.open({dataDir:directory,...(configured==='startup'?{modelConfig:config}:{}),memoryEnabled:false});
 try{
  if(configured==='profile'){core.credentials.set('SYNTHETIC_NATIVE_CODEC',config.apiKey);core.models.save({id:'default',name:'Synthetic custom model',protocol,baseURL,modelId:config.modelId,apiKeyEnv:'SYNTHETIC_NATIVE_CODEC',authHeader:'bearer',maxTokens:4096,contextWindow:100000});}
  await core.capabilities.saveMCP({id:'nullable',url:`http://127.0.0.1:${address.port}/mcp`,protocolVersion:'legacy'});await core.capabilities.connect('nullable');const task=await core.submitTask({title:'Preserve nullable input',content:'Submit an explicit null, then omit both fields, then provide the ordinary optional string.',grants:{write:false,execute:false,mcp:true}},`synthetic-native-null-${configured}-${protocol}`);const result=await until(()=>core.runtime.task(task.id),row=>['succeeded','failed','blocked','unreported','interrupted'].includes(row.status));assert.equal(result.status,'succeeded',JSON.stringify({phase,wire,requestTools}));assert.deepEqual(wire,[{nullable:null},{},{optional:'ordinary'}],JSON.stringify({wire,requestTools}));assert.ok(requestTools.some(Boolean));assert.doesNotMatch(JSON.stringify(requestTools),/x-optional/);
  const advertised=requestTools.find(Boolean);assert.ok(advertised&&typeof advertised==='object');const definition='function'in advertised?advertised.function:advertised;assert.ok(definition&&typeof definition==='object');const schema='input_schema'in definition?definition.input_schema:'parameters'in definition?definition.parameters:undefined;assert.ok(schema&&typeof schema==='object'&&'properties'in schema);assert.deepEqual(schema.properties,{nullable:{anyOf:[{type:'string'},{type:'null'}]},optional:{type:'string'}});if('required'in schema)assert.deepEqual(schema.required,[]);if(protocol==='responses'){assert.ok('strict'in definition);assert.equal(definition.strict,false);}
 }finally{await core.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));await removeTemp(directory);}
});
