import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {MCPClient,MCPServer} from '@mastra/mcp';
import {until} from './helpers.js';

for(const entry of ['esm','cjs']as const)test(`native ${entry} current revision keeps resource interests on one listen stream across reconnect`,{timeout:10000},async()=>{
 const common:typeof import('@mastra/mcp')=createRequire(import.meta.url)('@mastra/mcp'),Client=entry==='esm'?MCPClient:common.MCPClient,Server=entry==='esm'?MCPServer:common.MCPServer,updates:string[]=[],methods:string[]=[];
 const remote=new Server({id:'synthetic-current-watch',name:'Synthetic current watch',version:'1',tools:{},resources:{listResources:async()=>[{uri:'fixture://one',name:'One'}],getResourceContent:async()=>({text:'Synthetic watched source.'})}});
 const server=createServer(async(request,response)=>{methods.push(request.method??'');await remote.startHTTP({url:new URL(request.url??'/',`http://${request.headers.host}`),httpPath:'/mcp',req:request,res:response});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const client=new Client({id:'synthetic-current-watch-'+entry,registerProcessHooks:false,servers:{source:{url:new URL(`http://127.0.0.1:${address.port}/mcp`),protocolVersion:'2026-07-28'}}});
 try{await client.resources.onUpdated('source',({uri})=>{updates.push(uri);});await client.resources.subscribe('source','fixture://one');await remote.resources.notifyUpdated({uri:'fixture://one'});await until(()=>updates.length,count=>count===1);await client.reconnectServer('source');await remote.resources.notifyUpdated({uri:'fixture://one'});await until(()=>updates.length,count=>count===2);await client.resources.unsubscribe('source','fixture://one');await remote.resources.notifyUpdated({uri:'fixture://one'});await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(updates,['fixture://one','fixture://one']);assert.ok(methods.length>=3);}
 finally{await client.disconnect();await remote.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
