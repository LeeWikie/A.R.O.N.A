import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createWebTools} from '../src/web/index.js';
import {WebExtractionCache} from '../src/web/cache.js';
import {WebResultStore,MAX_WEB_RESULT_CHARACTERS,type WebResultDocument,type WebResultReference} from '../src/web/results.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const document=(content:string):WebResultDocument=>({url:'https://synthetic.example/page',status:200,contentType:'text/plain',extractor:'raw',content,received:{bytes:Buffer.byteLength(content),wireBytes:Buffer.byteLength(content),sha256:sha(content),truncated:false}});

test('fresh tools and reopened SQLite reuse complete extraction facts and seal a new source-bound result without copying old authority',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-web-persistent-cache-')),file=path.join(directory,'records.sqlite'),body='HEAD\n'+Array.from({length:2000},(_,i)=>`row_${i}:甲🙂`).join('\n')+'\nTAIL';let requests=0,allowed=true,privateDns=false,db=new DatabaseSync(file),closed=false;
  const server=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'text/plain; charset=utf-8'});response.end(body);});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('bad address');const url=`http://synthetic.example:${address.port}/page`,testing={allowLoopbackForHostname:'synthetic.example',resolver:async()=>[{address:privateDns?'10.0.0.1':'127.0.0.1',family:4}]};
  t.after(()=>{if(!closed)db.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const open=()=>{const cache=new WebExtractionCache(db,'synthetic-cache-key'),archive=new WebResultStore(db,'synthetic-cache-key'),runId=randomUUID(),taskId=randomUUID();return {archive,tools:createWebTools({authorize(){if(!allowed)throw Error('source revoked');},testing,cache:{get:(key,ttl,_ids,_ctx,signal)=>cache.get(key,ttl,signal),put:(key,doc,_ids,_ctx,signal)=>cache.put(key,doc,signal)},archive:{save:(doc,ids,_ctx,signal)=>archive.save(doc,{contextId:'work.synthetic',runId,taskId,toolCallId:'synthetic-fetch-'+runId,attempt:1,workspaceId:'synthetic',sourceSignalIds:ids,proof:sha('synthetic source '+runId)},signal),read:async(id,options,_ids,_ctx,signal)=>archive.read(id,options,signal)}})};};
  const first=open(),firstSource=randomUUID(),input={signalIds:[firstSource],url,mode:'text' as const,maxChars:20000},initial=await first.tools.web_fetch.execute!(input,{}) as {resultRef:WebResultReference;cached:boolean};assert.equal(initial.cached,false);assert.equal(requests,1);db.close();db=new DatabaseSync(file);
  const second=open(),secondSource=randomUUID(),resumed=await second.tools.web_fetch.execute!({...input,signalIds:[secondSource]},{} ) as typeof initial;assert.equal(resumed.cached,true);assert.equal(requests,1);assert.notEqual(initial.resultRef.id,resumed.resultRef.id);assert.deepEqual(second.archive.describe(resumed.resultRef.id).binding.sourceSignalIds,[secondSource]);assert.deepEqual(second.archive.exportRetained(resumed.resultRef.id).bytes,Buffer.from(body));assert.equal(resumed.resultRef.sha256,initial.resultRef.sha256);
  allowed=false;await assert.rejects(second.tools.web_fetch.execute!(input,{}),/source revoked/);allowed=true;privateDns=true;await assert.rejects(second.tools.web_fetch.execute!(input,{}),/Blocked or invalid DNS/);privateDns=false;
  const fresh=open();await fresh.tools.web_fetch.execute!({...input,mode:'markdown'},{});assert.equal(requests,2,'native extraction modes never reuse each other');db.prepare('UPDATE web_extraction_cache SET body=?').run('tampered');const afterCorruption=open();const result=await afterCorruption.tools.web_fetch.execute!(input,{}) as typeof initial;assert.equal(result.cached,false);assert.equal(requests,3,'a damaged cache misses and naturally retrieves the authorized source again');assert.deepEqual(afterCorruption.archive.exportRetained(initial.resultRef.id).bytes,Buffer.from(body),'cache repair never changes old canonical retained data');db.close();closed=true;
});

test('cache respects TTL and disable, rejects incomplete or oversized source facts, and verifies metadata before reuse',async()=>{
  const db=new DatabaseSync(':memory:'),cache=new WebExtractionCache(db,'synthetic-cache-key'),key=sha('synthetic-cache-key');try{
    cache.put(key,document('original'));assert.equal(cache.get(key,60000)?.content,'original');assert.equal(cache.get(key,0),undefined);await new Promise(resolve=>setTimeout(resolve,5));assert.equal(cache.get(key,1),undefined);
    for(const doc of [{...document('partial'),received:{...document('partial').received,truncated:true}},{...document('bad origin'),status:403},document('🙂'.repeat(MAX_WEB_RESULT_CHARACTERS+1))]){cache.put(key,doc);assert.equal(cache.get(key,60000),undefined);}
    cache.put(key,document('again'));const body=String(db.prepare('SELECT body FROM web_extraction_cache WHERE key=?').get(key)!.body),value=JSON.parse(body);value.document.url='http://127.0.0.1/secret';db.prepare('UPDATE web_extraction_cache SET body=? WHERE key=?').run(JSON.stringify(value),key);assert.equal(cache.get(key,60000),undefined);const controller=new AbortController();controller.abort();assert.throws(()=>cache.put(key,document('abort'),controller.signal),{name:'AbortError'});assert.throws(()=>cache.get(key,60000,controller.signal),{name:'AbortError'});
  }finally{db.close();}
});

test('cached final URLs are checked against current DNS independently of the requested URL',async()=>{
  const db=new DatabaseSync(':memory:'),cache=new WebExtractionCache(db,'synthetic-cache-key'),doc={...document('cached result'),url:'http://blocked.example/page'},input={signalIds:[randomUUID()],url:'http://synthetic.example/page',mode:'text' as const,maxChars:20000};let getKey:string|undefined;
  const tools=createWebTools({authorize(){},testing:{resolver:async host=>[{address:host==='blocked.example'?'10.0.0.1':'8.8.8.8',family:4}]},cache:{get:key=>{getKey=key;cache.put(key,doc);return cache.get(key,60000);},put(){throw Error('must not write refused source');}}});try{await assert.rejects(tools.web_fetch.execute!(input,{}),/Blocked or invalid DNS/);assert.ok(getKey);}finally{db.close();}
});
