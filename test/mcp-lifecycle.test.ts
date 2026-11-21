import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {removeTemp} from './helpers.js';
import {mcpResourcesFixture} from './mcp-resources-fixture.js';

for(const phase of ['initialize','tools/call','resources/read']as const)test(`closing an MCP source cancels its in-flight ${phase} request without reconnecting or replaying it`,{timeout:15000},async()=>{
  let entered!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const server=createServer(async(request,response)=>{if(request.method!=='POST'){response.writeHead(405).end();return;}let text='';for await(const part of request)text+=part;const rpc=JSON.parse(text);if(rpc.id===undefined){response.writeHead(202).end();return;}
    if(rpc.method===phase){calls++;entered();await gate;}
    const result=rpc.method==='initialize'?{protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'synthetic-lifecycle',version:'1'}}:rpc.method==='tools/list'?{tools:[{name:'read',inputSchema:{type:'object',properties:{}}}]}:rpc.method==='resources/read'?{contents:[{uri:'synthetic://held',text:'Synthetic result'}]}:{content:[{type:'text',text:'Synthetic result'}]};
    if(!response.destroyed)response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-mcp-close-')),db=new DatabaseSync(path.join(directory,'records.sqlite')),capabilities=new Capabilities(new RuntimeStore(db),directory,()=>undefined,'synthetic-lifecycle-key');
  let pending:Promise<unknown>|undefined;
  try{
    await capabilities.saveMCP({id:'held',url:`http://127.0.0.1:${address.port}`,protocolVersion:'legacy'});
    if(phase==='initialize')pending=capabilities.connect('held');else{await capabilities.connect('held');pending=phase==='tools/call'?(capabilities.tools(true).ext_held_read as {execute:(input:unknown)=>Promise<unknown>}).execute({}):capabilities.readMcpResource('held','synthetic://held');}
    const settled=Promise.allSettled([pending]);await started;const at=Date.now();await capabilities.close();assert.ok(Date.now()-at<3000,'shutdown must cancel native I/O instead of waiting for its twenty-second request timeout');
    assert.equal((await settled)[0]!.status,'rejected');assert.equal(calls,1);assert.equal(capabilities.mcpStatus()[0]?.connected,false);assert.deepEqual(capabilities.tools(true),{});
  }finally{release();await capabilities.close();await Promise.allSettled(pending?[pending]:[]);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();await removeTemp(directory);}
});

test('closing a second host with the same MCP server name cannot disconnect or replace the first host transport',{timeout:15000},async()=>{
  const remote=await mcpResourcesFixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-mcp-isolation-')),dbs=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const hosts=dbs.map((db,index)=>{const root=path.join(directory,String(index));fs.mkdirSync(root);return new Capabilities(new RuntimeStore(db),root,()=>undefined,`synthetic-host-${index}`);});
  try{
    for(const host of hosts){await host.saveMCP({id:'same',url:remote.url,protocolVersion:'legacy'});await host.connect('same');}
    const first=hosts[0]!,second=hosts[1]!,scope=first.connectionScope('same');assert.match(JSON.stringify(await first.readMcpResource('same','fixture://notes/main')),/Synthetic external notes/);
    await second.close();assert.equal(first.mcpStatus()[0]?.connected,true);assert.equal(first.connectionScope('same'),scope);assert.match(JSON.stringify(await first.readMcpResource('same','fixture://notes/main')),/Synthetic external notes/);
  }finally{for(const host of hosts)await host.close();for(const db of dbs)db.close();await remote.close();await removeTemp(directory);}
});
