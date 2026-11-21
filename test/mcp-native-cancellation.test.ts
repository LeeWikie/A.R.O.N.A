import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {MCPClient} from '@mastra/mcp';
import {until} from './helpers.js';

for(const entry of ['esm','cjs']as const)for(const kind of ['read','resources','templates','prompts','prompt']as const)test(`native ${entry} cancellation ends only its ${kind} request and preserves the owner connection`,{timeout:10000},async()=>{
 const method={read:'resources/read',resources:'resources/list',templates:'resources/templates/list',prompts:'prompts/list',prompt:'prompts/get'}[kind];
 let entered!:()=>void,held:{id:string|number;response:ServerResponse}|undefined,cancelled=false,connections=0;const ready=new Promise<void>(resolve=>{entered=resolve;});
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text)as{id?:string|number;method:string;params?:{protocolVersion:string;requestId:string|number}};
  if(rpc.id===undefined){if(rpc.method==='notifications/cancelled'&&held&&rpc.params?.requestId===held.id){cancelled=true;held.response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:held.id,error:{code:-32000,message:'The source read was cancelled.'}}));held=undefined;}response.writeHead(202).end();return;}
  let result:unknown={};if(rpc.method==='initialize'){connections++;result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'synthetic-request-cancel',version:'1'}};}
  if(rpc.method===method&&!cancelled){held={id:rpc.id,response};entered();return;}if(rpc.method===method)result=kind==='read'?{contents:[{uri:'fixture://source',text:'Fresh source'}]}:kind==='resources'?{resources:[{uri:'fixture://source',name:'Fresh source'}]}:kind==='templates'?{resourceTemplates:[{uriTemplate:'fixture://{name}',name:'Fresh source'}]}:kind==='prompts'?{prompts:[{name:'Fresh source'}]}:{messages:[{role:'user',content:{type:'text',text:'Fresh source'}}]};
  if(rpc.method==='tools/list')result={tools:[]};response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const Client:typeof MCPClient=entry==='esm'?MCPClient:createRequire(import.meta.url)('@mastra/mcp').MCPClient,client=new Client({id:'synthetic-request-cancel-'+entry,registerProcessHooks:false,timeout:1000,servers:{source:{url:new URL(`http://127.0.0.1:${address.port}`),protocolVersion:'legacy'}}});
 const invoke=(signal?:AbortSignal)=>{const options={signal};return kind==='read'?Reflect.apply(client.resources.read,client.resources,['source','fixture://source',options]):kind==='resources'?Reflect.apply(client.resources.listWithErrors,client.resources,[options]):kind==='templates'?Reflect.apply(client.resources.templatesWithErrors,client.resources,[options]):kind==='prompts'?Reflect.apply(client.prompts.listWithErrors,client.prompts,[options]):Reflect.apply(client.prompts.get,client.prompts,[{serverName:'source',name:'review'},options]);};
 try{await client.listTools();const controller=new AbortController(),reading=Promise.resolve(invoke(controller.signal));const outcome=reading.then((value:unknown)=>({success:true as const,value}),error=>({success:false as const,error}));await Promise.race([ready,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Synthetic read did not dispatch')),2000).unref())]);const started=performance.now();controller.abort(new DOMException('Synthetic source cancelled','AbortError'));const result=await outcome;
  if(result.success){assert.ok(result.value&&typeof result.value==='object'&&'errors'in result.value);assert.notDeepEqual(result.value.errors,{},'discovery cancellation remains a real diagnostic failure');}
  assert.ok(performance.now()-started<300,'the request uses its own cancellation rather than waiting for the server timeout');await until(()=>cancelled,Boolean);assert.equal(connections,1);const next=await invoke();assert.match(JSON.stringify(next),/Fresh source/);assert.equal(connections,1);
 }
 finally{held?.response.destroy();await client.disconnect();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
