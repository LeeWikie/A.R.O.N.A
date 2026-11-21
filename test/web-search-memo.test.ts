import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createWebTools,type SearchProvider} from '../src/web/index.js';
import {WebMemo,searchBucket,searchQueryKey} from '../src/web/memo.js';

test('actual paid search shares normalized bucketed requests but rechecks sources, credentials, DNS and requested result counts',async t=>{
  const calls:Array<{count:number;key:string|undefined}>=[];let held=true,release!:()=>void,entered!:()=>void,allowed=true,privateDns=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  const server=createServer(async(request,response)=>{const url=new URL(request.url!,'http://synthetic.example');calls.push({count:Number(url.searchParams.get('count')),key:typeof request.headers['x-subscription-token']==='string'?request.headers['x-subscription-token']:undefined});if(held){entered();await gate;}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({web:{results:Array.from({length:Number(url.searchParams.get('count'))},(_,index)=>({url:`https://synthetic.example/${index}`,title:`result_${index}`,description:'synthetic'}))}}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{release();server.closeAllConnections();server.close();});const address=server.address();if(!address||typeof address==='string')throw Error('invalid address');
  const provider:SearchProvider={type:'brave',apiKey:'synthetic-key-1'},tools=createWebTools({authorize(){if(!allowed)throw Error('source revoked');},search:provider,testing:{braveUrl:`http://synthetic.example:${address.port}/search`,allowLoopbackForHostname:'synthetic.example',resolver:async()=>[{address:privateDns?'10.0.0.1':'127.0.0.1',family:4}]}}),input={signalIds:[randomUUID()],query:'A   Synthetic Query',count:5},controller=new AbortController();
  const first=tools.web_search.execute!(input,{abortSignal:controller.signal}),cancelled=assert.rejects(first,{name:'AbortError'}),second=tools.web_search.execute!({...input,signalIds:[randomUUID()],query:' a synthetic query ',count:8},{});await ready;controller.abort();await cancelled;held=false;release();
  const result=await second as {content:string;count:number;cached:boolean};assert.equal(result.count,8);assert.equal(result.cached,false);assert.equal(calls.length,1);assert.equal(calls[0]!.count,10);assert.doesNotMatch(result.content,/synthetic-key/);
  const hit=await tools.web_search.execute!({...input,count:9},{}) as typeof result;assert.equal(hit.cached,true);assert.equal(hit.count,9);assert.equal(calls.length,1);
  await tools.web_search.execute!({...input,count:11},{});assert.equal(calls[1]!.count,20);provider.apiKey='synthetic-key-2';await tools.web_search.execute!(input,{});assert.equal(calls[2]!.key,'synthetic-key-2');
  allowed=false;await assert.rejects(tools.web_search.execute!(input,{}),/source revoked/);allowed=true;privateDns=true;await assert.rejects(tools.web_search.execute!(input,{}),/Blocked or invalid DNS/);assert.equal(calls.length,3);
});

test('SearXNG uses native score order and supports the whole requested search range',async t=>{
  let calls=0;const server=createServer((_request,response)=>{calls++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({results:Array.from({length:100},(_,index)=>({url:`https://synthetic.example/${index}`,title:String(index),score:index,content:'synthetic'}))}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();if(!address||typeof address==='string')throw Error('invalid address');
  const tools=createWebTools({authorize(){},search:{type:'searxng',baseUrl:`http://synthetic.example:${address.port}`},testing:{allowLoopbackForHostname:'synthetic.example',resolver:async()=>[{address:'127.0.0.1',family:4}]}});const schema=tools.web_search.inputSchema;assert.ok(schema);assert.equal((await schema['~standard'].validate({signalIds:[randomUUID()],query:'synthetic',count:100})).issues,undefined);
  const result=await tools.web_search.execute!({signalIds:[randomUUID()],query:'synthetic',count:100},{}) as {content:string;count:number};assert.equal(result.count,100);assert.ok(result.content.indexOf('"title":"99"')<result.content.indexOf('"title":"98"'));assert.equal(calls,1);
});

test('memo failures are not cached, disabled caching does not reuse facts, and small bounded LRU entries return independent copies',async()=>{
  const memo=new WebMemo<{content:string}>(60000,40,2);let calls=0;await assert.rejects(memo.get('failed',async()=>{calls++;throw Error('synthetic failure');}),/synthetic failure/);await assert.rejects(memo.get('failed',async()=>{calls++;throw Error('synthetic failure');}),/synthetic failure/);assert.equal(calls,2);
  const load=async()=>({content:String(++calls)}),first=await memo.get('one',load);first.value.content='modified';assert.notEqual((await memo.get('one',load)).value.content,'modified');await memo.get('two',load);await memo.get('three',load);assert.equal((await memo.get('one',load)).cached,false);
  const disabled=new WebMemo(0);await disabled.get('same',load);assert.equal((await disabled.get('same',load)).cached,false);assert.deepEqual([1,10,11,20,21,50,51,100].map(searchBucket),[10,10,20,20,50,50,100,100]);assert.equal(searchQueryKey(' A\t甲\nB '),'a 甲 b');
});

test('a successful extracted-page cache never bypasses a current blocked DNS answer',async t=>{
  let calls=0,privateDns=false;const server=createServer((_request,response)=>{calls++;response.writeHead(200,{'content-type':'text/plain'});response.end('synthetic cached page');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();if(!address||typeof address==='string')throw Error('invalid address');
  const tools=createWebTools({authorize(){},testing:{allowLoopbackForHostname:'synthetic.example',resolver:async()=>[{address:privateDns?'10.0.0.1':'127.0.0.1',family:4}]}}),input={signalIds:[randomUUID()],url:`http://synthetic.example:${address.port}/page`,mode:'text' as const,maxChars:20000};await tools.web_fetch.execute!(input,{});privateDns=true;await assert.rejects(tools.web_fetch.execute!(input,{}),/Blocked or invalid DNS/);assert.equal(calls,1);
});
