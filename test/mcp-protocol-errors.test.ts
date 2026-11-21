import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {MCPClient} from '@mastra/mcp';

for(const entry of ['esm','cjs'] as const)for(const message of ['upstream returned HTTP 404 for this document','service not connected to the selected account','fetch failed for a rejected business argument'])test(`native ${entry} MCP protocol failure is not a transport failure: ${message}`,{timeout:10000},async()=>{
  let calls=0,connections=0;
  const server=createServer(async(request,response)=>{
    if(request.method!=='POST'){response.writeHead(405).end();return;}
    let input='';for await(const chunk of request)input+=chunk;const rpc=JSON.parse(input) as {id?:string|number;method:string;params?:{protocolVersion:string}};
    if(rpc.id===undefined){response.writeHead(202).end();return;}
    let result:unknown={};
    if(rpc.method==='initialize'){connections++;result={protocolVersion:rpc.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-protocol-error',version:'1'}};}
    if(rpc.method==='tools/list')result={tools:[{name:'checked',inputSchema:{type:'object',properties:{}}}]};
    if(rpc.method==='tools/call'){calls++;response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32602,message}}));return;}
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const Client:typeof MCPClient=entry==='esm'?MCPClient:createRequire(import.meta.url)('@mastra/mcp').MCPClient,client=new Client({id:'synthetic-protocol-error-'+entry,registerProcessHooks:false,servers:{source:{url:new URL(`http://127.0.0.1:${address.port}`),protocolVersion:'legacy',toolCallRetry:'never' as const}}});
  try{
    const tool=(await client.listTools()).source_checked;assert.ok(tool&&'execute'in tool&&typeof tool.execute==='function');
    await assert.rejects(()=>Promise.resolve(Reflect.apply(tool.execute!,tool,[{},{}])),error=>{assert.ok(error&&typeof error==='object'&&'code'in error);assert.equal(error.code,-32602);assert.match(String(error),new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));return true;});
    assert.equal(calls,1,'a protocol error does not dispatch another tool call');assert.equal(connections,1,'a protocol error does not discard a healthy native connection');
  }finally{await client.disconnect();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
