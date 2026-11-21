import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {Client,StreamableHTTPClientTransport,type CallToolResult} from '@modelcontextprotocol/client';

const observing=(onResult:(result:CallToolResult)=>void)=>({signal:undefined,onResult});
for(const entry of ['esm','cjs']as const)test(`native ${entry} result observers retain validation, isolate copies and never replay a received operation`,{timeout:10000},async()=>{
 let connections=0,calls=0,invalid=false,malformed=false;const schema={name:'write_once',inputSchema:{type:'object',properties:{}},outputSchema:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}};
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text)as{id?:string|number;method:string;params?:{protocolVersion:string}};if(rpc.id===undefined){response.writeHead(202).end();return;}let result:unknown={};
  if(rpc.method==='initialize'){connections++;result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-observer',version:'1'}};}if(rpc.method==='tools/list')result={tools:[schema]};if(rpc.method==='tools/call'){calls++;result={content:malformed?[{type:'synthetic-invalid-block'}]:[{type:'text',text:'Original result text'}],structuredContent:{code:invalid?7:'valid'},_meta:{private:'Original protocol metadata'}};}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const sdk=entry==='esm'?{Client,StreamableHTTPClientTransport}:createRequire(import.meta.url)('@modelcontextprotocol/client')as{Client:typeof Client;StreamableHTTPClientTransport:typeof StreamableHTTPClientTransport},client=new sdk.Client({name:'synthetic-observer-'+entry,version:'1'});
 try{await client.connect(new sdk.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}`)));await client.listTools();let observed:CallToolResult|undefined;
  const result=await client.callTool({name:'write_once',arguments:{}},observing((copy)=>{observed=structuredClone(copy);copy.content.length=0;copy.structuredContent={code:7};}));assert.equal(result.content.length,1);assert.deepEqual(result.structuredContent,{code:'valid'});assert.equal(observed?.content.length,1);assert.equal(calls,1);
  await assert.rejects(client.callTool({name:'write_once',arguments:{}},observing(()=>{throw new Error('HTTP 404 not connected fetch failed synthetic observer I/O');})),(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='MCP_RESULT_OBSERVER_FAILED'&&'packetReceived'in error&&error.packetReceived===true&&'validated'in error&&error.validated===true));assert.equal(calls,2);assert.equal(connections,1);
  await client.callTool({name:'write_once',arguments:{}});assert.equal(calls,3,'a later call remains independent of the failed observer');invalid=true;let invalidObserved=false;await assert.rejects(client.callTool({name:'write_once',arguments:{}},observing(()=>{invalidObserved=true;throw new Error('Observer cannot hide original invalid output');})),/output schema/i);assert.equal(invalidObserved,true);assert.equal(calls,4);invalid=false;malformed=true;let malformedObserved=false;await assert.rejects(client.callTool({name:'write_once',arguments:{}},observing(()=>{malformedObserved=true;})));assert.equal(malformedObserved,false,'an invalid protocol packet is not reconstructed as a validated result');assert.equal(calls,5);assert.equal(connections,1);
 }finally{await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
