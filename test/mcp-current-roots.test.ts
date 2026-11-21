import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {MCPClient} from '@mastra/mcp';
const require=createRequire(import.meta.url),mcpRequire=createRequire(require.resolve('@mastra/mcp'));
const {Server,createMcpHandler,inputRequired}=await import(pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/server')).href);
for(const entry of ['esm','cjs']as const)test(`native ${entry} current roots use embedded input requests on the same original call`,async()=>{
 let callbacks=0,rounds=0,rootInput:unknown,notifications=0;
 const expected={uri:'file:///synthetic/only-project',name:'Only project'};
 const handler=createMcpHandler(()=>{
  const server=new Server({name:'synthetic-modern-roots',version:'1'},{capabilities:{tools:{}}});
  server.setNotificationHandler('notifications/roots/list_changed',()=>{notifications++;});
  server.setRequestHandler('tools/list',()=>({tools:[{name:'roots_once',inputSchema:{type:'object',properties:{}}}]}));
  server.setRequestHandler('tools/call',(_request:unknown,context:{mcpReq:{inputResponses?:{root?:unknown}}})=>{
   rounds++;
   const response=context.mcpReq.inputResponses?.root;
   if(!response)return inputRequired({inputRequests:{root:inputRequired.listRoots()},requestState:'synthetic-readonly-root-round'});
   rootInput=response;return {content:[{type:'text',text:JSON.stringify(response)}]};
  });return server;
 },{legacy:'reject'});
 const http=serve({hostname:'127.0.0.1',port:0,fetch:request=>handler.fetch(request)});if(!http.listening)await once(http,'listening');const address=http.address();assert.ok(address&&typeof address!=='string');
 const Client=entry==='esm'?MCPClient:require('@mastra/mcp').MCPClient,client=new Client({id:'synthetic-modern-roots-'+entry,registerProcessHooks:false,servers:{source:{url:new URL(`http://127.0.0.1:${address.port}`),protocolVersion:'2026-07-28',roots:({signal}:{signal:AbortSignal})=>{signal.throwIfAborted();callbacks++;return[expected];}}}});
 try{const tool=(await client.listTools()).source_roots_once;assert.ok(tool&&typeof tool.execute==='function');assert.deepEqual(await client.notifyRootsChanged('source'),{notified:false});assert.equal(notifications,0);const result=await tool.execute({},{});assert.equal(callbacks,1);assert.equal(rounds,2);assert.deepEqual(rootInput,{roots:[expected]});assert.match(JSON.stringify(result),/only-project/);}
 finally{await client.disconnect();await handler.close();if('closeAllConnections'in http&&typeof http.closeAllConnections==='function')http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}
});
