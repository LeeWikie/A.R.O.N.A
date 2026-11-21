import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createWebTools} from '../src/web/index.js';
import {WebResultStore,type WebResultReference} from '../src/web/results.js';

async function fixture(t:test.TestContext){
  const body='HEAD\n'+Array.from({length:6000},(_,index)=>`row_${index}: synthetic public page`).join('\n')+'\nTAIL',db=new DatabaseSync(':memory:'),store=new WebResultStore(db,'synthetic-web-result-tool-storage-key');let requests=0,allowed=true,saves=0,release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  const server=createServer(async(request,response)=>{requests++;if(request.url==='/held'){entered();await gate;}response.writeHead(request.url==='/forbidden'?403:200,{'content-type':'text/plain; charset=utf-8'});response.end(body);});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('invalid fixture address');const base=`http://synthetic.example:${address.port}`,owner={contextId:'work.synthetic',runId:randomUUID(),toolCallId:'synthetic-original-web-fetch',taskId:randomUUID(),attempt:1,workspaceId:'synthetic',proof:createHash('sha256').update('synthetic original source proof').digest('hex')};
  const tools=createWebTools({authorize(){if(!allowed)throw new Error('source revoked');},testing:{resolver:async()=>[{address:'127.0.0.1',family:4}],allowLoopbackForHostname:'synthetic.example'},archive:{save(document,sourceSignalIds,context){saves++;return store.save(document,{...owner,sourceSignalIds},context?.abortSignal);},async read(id,options,sourceSignalIds,context){assert.deepEqual(store.describe(id).binding.sourceSignalIds,sourceSignalIds);return store.read(id,options,context?.abortSignal);}}});
  const fetch=tools.web_fetch.execute,read=tools.read_web_result.execute;assert.ok(fetch);assert.ok(read);
  t.after(async()=>{release();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();});return {tools,fetch,read,store,body,base,ready,release,requests:()=>requests,saves:()=>saves,revoke:()=>{allowed=false;}};
}

test('actual fetch archives the omitted middle, rebinds cache hits to the current source, and authorizes before cache or retained reads',async t=>{
  const f=await fixture(t),firstId=randomUUID(),secondId=randomUUID(),input={signalIds:[firstId],url:f.base+'/page',mode:'text' as const,maxChars:20000},first=await f.fetch(input,{}) as {content:string;resultRef:WebResultReference;continuation:{offset:number};cached:boolean};assert.match(first.content,/HEAD/);assert.match(first.content,/TAIL/);assert.equal(first.cached,false);assert.equal(first.resultRef.sha256,createHash('sha256').update(f.body).digest('hex'));const page=await f.read({id:first.resultRef.id,signalIds:[firstId],offset:3000,limit:1,encoding:'text'},{} ) as Awaited<ReturnType<WebResultStore['read']>>;assert.match(page.content,/row_2998:/);assert.equal(page.source.isTruncated,false);
  first.resultRef.received.bytes=0;const second=await f.fetch({...input,signalIds:[secondId],maxChars:5000},{}) as {resultRef:WebResultReference;cached:boolean};assert.equal(second.cached,true);assert.equal(f.requests(),1);assert.notEqual(first.resultRef.id,second.resultRef.id);assert.deepEqual(f.store.describe(second.resultRef.id).binding.sourceSignalIds,[secondId]);assert.equal(second.resultRef.received.bytes,Buffer.byteLength(f.body));
  f.revoke();await assert.rejects(f.fetch(input,{}),/source revoked/);await assert.rejects(f.read({id:first.resultRef.id,signalIds:[firstId],encoding:'text'},{}),/source revoked/);assert.equal(f.requests(),1);assert.equal(f.saves(),2);
});

test('concurrent identical fetches share one real request while cancellation of one caller preserves the other authorized caller',async t=>{
  const f=await fixture(t),controller=new AbortController(),source=randomUUID(),input={signalIds:[source],url:f.base+'/held',mode:'text' as const,maxChars:20000},cancelled=f.fetch(input,{abortSignal:controller.signal}),cancelledResult=assert.rejects(cancelled,/abort|cancel/i),continuing=f.fetch({...input,signalIds:[randomUUID()]},{});await f.ready;controller.abort();await cancelledResult;assert.equal(f.requests(),1);f.release();const result=await continuing as {content:string;resultRef:WebResultReference};assert.match(result.content,/TAIL/);assert.equal(result.resultRef.received.bytes,Buffer.byteLength(f.body));assert.equal(f.saves(),1);assert.equal(f.requests(),1);
});

test('origin error pages preserve their status and diagnostic head and tail, and are never cached as successes',async t=>{
  const f=await fixture(t),input={signalIds:[randomUUID()],url:f.base+'/forbidden',mode:'text' as const,maxChars:20000};for(let attempt=0;attempt<2;attempt++){const result=await f.fetch(input,{}) as {status:number;isError:boolean;error:string;content:string;cached:boolean;resultRef:WebResultReference};assert.equal(result.status,403);assert.equal(result.isError,true);assert.match(result.error,/403/);assert.match(result.content,/HEAD/);assert.match(result.content,/TAIL/);assert.equal(result.cached,false);assert.equal(result.resultRef.status,403);}assert.equal(f.requests(),2);
});
