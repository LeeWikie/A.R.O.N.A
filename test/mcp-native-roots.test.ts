import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {MCPClient} from '@mastra/mcp';

for(const entry of ['esm','cjs']as const)test(`native ${entry} roots requests use the configured host callback on the existing transport`,{timeout:10000},async()=>{
 let callbacks=0,rootResult:unknown,reply:((value:unknown)=>void)|undefined,capabilities:unknown;const root={uri:'file:///synthetic/current-project',name:'Current project'};
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text)as{id?:string|number;method?:string;params?:{protocolVersion:string;capabilities:unknown};result?:unknown;error?:unknown};
  if(rpc.method===undefined&&rpc.id==='synthetic-root-request'){rootResult=rpc.result??rpc.error;reply?.(rootResult);response.writeHead(202).end();return;}
  if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize'){capabilities=rpc.params?.capabilities;result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-roots',version:'1'}};}
  if(rpc.method==='tools/list')result={tools:[{name:'inspect_roots',inputSchema:{type:'object',properties:{}}}]};
  if(rpc.method==='tools/call'){
   const responseReady=new Promise<unknown>(resolve=>{reply=resolve;});response.writeHead(200,{'content-type':'text/event-stream'});response.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:'synthetic-root-request',method:'roots/list',params:{}})+'\n\n');
   const timer=setTimeout(()=>{reply?.({error:'roots reply timed out'});},2000);await responseReady;clearTimeout(timer);response.end('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(rootResult)}]}})+'\n\n');return;
  }
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 const configuration={url:new URL(`http://127.0.0.1:${address.port}`),protocolVersion:'legacy'as const,roots:()=>{callbacks++;return [root];}},Client:typeof MCPClient=entry==='esm'?MCPClient:createRequire(import.meta.url)('@mastra/mcp').MCPClient,client=new Client({id:'synthetic-roots-'+entry,registerProcessHooks:false,servers:{source:configuration}});
 try{const tool=(await client.listTools()).source_inspect_roots;assert.ok(tool&&'execute'in tool&&typeof tool.execute==='function');await Reflect.apply(tool.execute,tool,[{},{}]);assert.equal(callbacks,1);assert.deepEqual(rootResult,{roots:[root]});assert.ok(capabilities&&typeof capabilities==='object'&&'roots'in capabilities);}
 finally{await client.disconnect();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
