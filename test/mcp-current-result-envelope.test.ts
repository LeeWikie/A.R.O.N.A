import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {MCPClient} from '@mastra/mcp';

const require=createRequire(import.meta.url),nativeRequire=createRequire(require.resolve('@mastra/mcp'));
const {Server,createMcpHandler}=await import(pathToFileURL(nativeRequire.resolve('@modelcontextprotocol/server')).href);
for(const entry of ['esm','cjs']as const)test(`native ${entry} current result envelopes preserve scalar, null and array structured content`,{timeout:10000},async()=>{
 const results:Record<string,unknown>={nil:{content:[],structuredContent:null,_meta:{original:'Private original metadata'}},array:{content:[{type:'text',text:'Array content channel'}],structuredContent:[1,2],_meta:{original:'Private original metadata'}},scalar:{content:[],structuredContent:'Original scalar'},invalid:{content:[{type:'text',text:'Original invalid content'}],structuredContent:7}},schemas:Record<string,unknown>={nil:{type:'null'},array:{type:'array',items:{type:'number'}},scalar:{type:'string'},invalid:{type:'string'}},calls:string[]=[];
 const handler=createMcpHandler(()=>{const server=new Server({name:'synthetic-modern-full-result',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler('tools/list',()=>({tools:Object.keys(results).map(name=>({name,inputSchema:{type:'object',properties:{}},outputSchema:schemas[name]}))}));server.setRequestHandler('tools/call',(request:{params:{name:string}})=>{calls.push(request.params.name);return results[request.params.name];});return server;},{legacy:'reject'});
 const http=serve({hostname:'127.0.0.1',port:0,fetch:request=>handler.fetch(request)});if(!http.listening)await once(http,'listening');const address=http.address();assert.ok(address&&typeof address!=='string');const Client:typeof MCPClient=entry==='esm'?MCPClient:require('@mastra/mcp').MCPClient,configuration={url:new URL(`http://127.0.0.1:${address.port}`),protocolVersion:'2026-07-28'as const,preserveResultEnvelope:true,onToolError:'return'as const},client=new Client({id:'synthetic-current-envelopes-'+entry,registerProcessHooks:false,servers:{source:configuration}});
 try{const tools=await client.listTools();for(const name of Object.keys(results)){const tool=tools[`source_${name}`];assert.ok(tool&&'execute'in tool&&typeof tool.execute==='function');const output:unknown=await Reflect.apply(tool.execute,tool,[{},{}]);assert.ok(output&&typeof output==='object'&&'result'in output);const expected=results[name]as{_meta?:Record<string,unknown>};assert.deepEqual(output.result,{...expected,_meta:{...expected._meta,'io.modelcontextprotocol/serverInfo':{name:'synthetic-modern-full-result',version:'1'}}});assert.equal('version'in output&&output.version,1);assert.equal('packetReceived'in output&&output.packetReceived,true);assert.equal('validated'in output&&output.validated,name!=='invalid');}assert.deepEqual(calls,Object.keys(results));}
 finally{await client.disconnect();await handler.close();if('closeAllConnections'in http&&typeof http.closeAllConnections==='function')http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}
});
