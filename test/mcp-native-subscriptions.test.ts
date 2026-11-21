import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {MCPClient} from '@mastra/mcp';

for(const entry of ['esm','cjs']as const)test(`native ${entry} legacy resource watches share the original connection and restore only active interests`,{timeout:10000},async()=>{
 let connections=0;const methods:Array<{method:string;uri?:string}>=[],updates:string[]=[];
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text)as{id?:string|number;method:string;params?:{protocolVersion:string;uri:string}};methods.push({method:rpc.method,uri:rpc.params?.uri});
  if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};if(rpc.method==='initialize'){connections++;result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{},resources:{subscribe:true}},serverInfo:{name:'synthetic-resource-watch',version:'1'}};}
  if(rpc.method==='tools/list')result={tools:[{name:'notify',inputSchema:{type:'object',properties:{}}}]};
  if(rpc.method==='resources/subscribe'||rpc.method==='tools/call'){
   const uri=rpc.params?.uri??'fixture://inactive';response.writeHead(200,{'content-type':'text/event-stream'});response.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/resources/updated',params:{uri}})+'\n\n');response.end('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:rpc.method==='tools/call'?{content:[{type:'text',text:'Notification sent.'}]}:{}})+'\n\n');return;
  }
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const Client:typeof MCPClient=entry==='esm'?MCPClient:createRequire(import.meta.url)('@mastra/mcp').MCPClient,client=new Client({id:'synthetic-legacy-watch-'+entry,registerProcessHooks:false,servers:{source:{url:new URL(`http://127.0.0.1:${address.port}`),protocolVersion:'legacy'}}});
 try{
  await client.resources.onUpdated('source',({uri})=>{updates.push(uri);});await Promise.all([client.resources.subscribe('source','fixture://one'),client.resources.subscribe('source','fixture://two')]);assert.equal(connections,1);assert.deepEqual(updates,['fixture://one','fixture://two']);
  await client.resources.subscribe('source','fixture://one');assert.equal(methods.filter(row=>row.method==='resources/subscribe').length,2,'duplicate subscribe does not send a second request');await client.resources.unsubscribe('source','fixture://one');assert.deepEqual(methods.filter(row=>row.method==='resources/unsubscribe').map(row=>row.uri),['fixture://one']);
  await client.reconnectServer('source');assert.equal(connections,2);assert.deepEqual(methods.filter(row=>row.method==='resources/subscribe').map(row=>row.uri),['fixture://one','fixture://two','fixture://two']);assert.deepEqual(updates,['fixture://one','fixture://two','fixture://two']);
  const tool=(await client.listTools()).source_notify;assert.ok(tool&&'execute'in tool&&typeof tool.execute==='function');await Reflect.apply(tool.execute,tool,[{},{}]);assert.deepEqual(updates,['fixture://one','fixture://two','fixture://two'],'a notification for an unrequested URI is not delivered as a watch event');assert.equal(methods.some(row=>row.method==='subscriptions/listen'),false,'legacy requests use their negotiated protocol on the same native connection');
 }finally{await client.disconnect();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
