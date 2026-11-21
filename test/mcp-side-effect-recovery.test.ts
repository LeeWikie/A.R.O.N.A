import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {MCPClient} from '@mastra/mcp';

for(const entry of ['esm','cjs'] as const)test(`native ${entry} MCP recovery never replays an already dispatched side effect`,{timeout:15000},async()=>{
 let effects=0,connections=0;
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}
  let input='';for await(const chunk of request)input+=chunk;
  const rpc=JSON.parse(input) as {id?:string|number;method:string;params?:{protocolVersion:string}};
  if(rpc.id===undefined){response.writeHead(202).end();return;}
  let result:unknown={};
  if(rpc.method==='initialize'){connections++;result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-write-recovery',version:'1'}};}
  if(rpc.method==='tools/list')result={tools:[{name:'write_once',inputSchema:{type:'object',properties:{}}}]};
  if(rpc.method==='tools/call'){effects++;if(effects===1){response.destroy();return;}result={content:[{type:'text',text:'Actual side effect '+effects}]};}
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 const configuration={url:new URL(`http://127.0.0.1:${address.port}`),protocolVersion:'legacy' as const,toolCallRetry:'never' as const},Client:typeof MCPClient=entry==='esm'?MCPClient:createRequire(import.meta.url)('@mastra/mcp').MCPClient,client=new Client({id:'synthetic-once-'+entry,registerProcessHooks:false,servers:{write:configuration}});
 try{
  const tools=await client.listTools(),tool=tools.write_write_once;assert.ok(tool&&'execute'in tool&&typeof tool.execute==='function');
  const first=await Promise.resolve(Reflect.apply(tool.execute,tool,[{},{}])).then(value=>({status:'fulfilled' as const,value}),error=>({status:'rejected' as const,error}));
  assert.equal(first.status,'rejected',JSON.stringify({effects,connections,first}));assert.equal(effects,1,'the original call may already have changed external state');
  if(first.status==='rejected')assert.match(String(first.error),/outcome.*uncertain|already.*dispatched|not.*replay/i);
  assert.ok(connections>=2,'the original native recovery heals the connection for subsequent calls');
  assert.match(JSON.stringify(await Reflect.apply(tool.execute,tool,[{},{}])),/Actual side effect 2/);assert.equal(effects,2);
 }finally{await client.disconnect();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
