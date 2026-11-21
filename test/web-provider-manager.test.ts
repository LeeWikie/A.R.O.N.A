import assert from 'node:assert/strict';
import test from 'node:test';
import {WebProviderManager} from '../src/web/provider-manager.js';
import {resolveWebRuntime,WebProviderRing,type WebProviderName,type AutomaticWebConfiguration} from '../src/web/provider-config.js';
import {WebProviderError,providerFailure,type ProviderReceipt,type WebProviderPage} from '../src/web/provider-protocol.js';
import {WebBlockedError} from '../src/web/network.js';

const receipt:ProviderReceipt={kind:'provider-api-response',url:'https://api.synthetic.example/search',status:200,bytes:2,wireBytes:2,sha256:'0'.repeat(64),truncated:false};
const runtime=(configuration:Partial<AutomaticWebConfiguration>={})=>resolveWebRuntime({type:'auto',...configuration},()=>undefined,{},new WebProviderRing(0));
const hit=(provider:string,index=1)=>({url:`https://synthetic.example/${provider}/${index}`,title:provider,description:'Synthetic result',position:index});
const page=(url:string):WebProviderPage=>({url,sourceURL:url,title:'Synthetic page',content:'Complete extracted text',status:null,coverage:'full'});

test('anonymous search rotates between calls and walks refusals, while terminal query errors stop the ring',async()=>{
  const calls:string[]=[],manager=new WebProviderManager({search:async provider=>{calls.push(provider.name);if(provider.name==='exa')throw new WebProviderError('HTTP 403: anonymous access refused');return {hits:[hit(provider.name)],receipt};},extract:async()=>[]},new WebProviderRing(0));
  const one=await manager.search(runtime(), 'first', 5),two=await manager.search(runtime(),'second',5);assert.equal(one.status,'ok');if(one.status==='ok'){assert.equal(one.provider,'parallel');assert.equal(one.servedBy,'parallel');assert.deepEqual(one.attempts.map(row=>row.outcome),['failed','succeeded']);}assert.equal(two.status,'ok');assert.deepEqual(calls,['exa','parallel','parallel']);
  for(const error of ["HTTP 400: invalid query 'http 503'",'request failed: disconnected']){calls.length=0;const stopped=new WebProviderManager({search:async provider=>{calls.push(provider.name);throw new WebProviderError(error);},extract:async()=>[]},new WebProviderRing(0)),result=await stopped.search(runtime(),error,5);assert.equal(result.status,'error');if(result.status==='error')assert.doesNotMatch(result.error,/all anonymous/);assert.deepEqual(calls,['exa']);}
});

test('paid failure rescue is one call only, never memoized, and each later call retries the configured provider',async()=>{
  const calls:string[]=[],manager=new WebProviderManager({search:async provider=>{calls.push(provider.name+':'+provider.mode);if(provider.mode==='keyed')throw new WebProviderError('The selected API key is not configured.');return {hits:[hit(provider.name)],receipt};},extract:async()=>[]},new WebProviderRing(0)),selected=runtime({searchBackend:'tavily',providerTiers:{tavily:'paid'}});
  for(let count=0;count<2;count++){const result=await manager.search(selected,'same query',5);assert.equal(result.status,'ok');if(result.status==='ok'){assert.equal(result.rescuedFrom,'tavily');assert.match(result.backendError??'',/not configured/);assert.equal(result.cached,false);}}
  assert.equal(calls.filter(call=>call==='tavily:keyed').length,2);assert.equal(calls.length,4);
  const disabled=await manager.search(runtime({searchBackend:'tavily',providerTiers:{tavily:'paid'},keylessRescue:false}),'same query',5);assert.equal(disabled.status,'error');assert.equal(calls.at(-1),'tavily:keyed');
});

test('memo facts share the native normalized query/count bucket but never a different credential identity or failed result',async()=>{
  let calls=0;const limits:number[]=[],manager=new WebProviderManager({search:async(provider,_query,count)=>{calls++;limits.push(count);if(calls===1)throw new WebProviderError('HTTP 400: query invalid');return {hits:Array.from({length:count},(_,index)=>hit(provider.name,index+1)),receipt};},extract:async()=>[]},new WebProviderRing(0)),config={type:'auto' as const,searchBackend:'brave' as const,keylessRescue:false},selected=resolveWebRuntime(config,()=> 'synthetic-key-one',{},new WebProviderRing(0));
  assert.equal((await manager.search(selected,' Hello   World ',5)).status,'error');assert.equal((await manager.search(selected,'hello world',5)).cached,false);const cached=await manager.search(selected,'HELLO WORLD',8);assert.equal(cached.cached,true);if(cached.status==='ok')assert.equal(cached.hits.length,8);assert.deepEqual(limits,[10,10]);await manager.search(resolveWebRuntime(config,()=> 'synthetic-key-two',{},new WebProviderRing(0)),'hello world',5);assert.equal(calls,3);
});

test('extract walks only whole-batch provider throttling, preserving partial results and origin errors',async()=>{
  const urls=['https://synthetic.example/one','https://synthetic.example/two'];
  for(const outcome of ['all-rate','partial','origin-429','origin-403'] as const){const calls:WebProviderName[]=[],manager=new WebProviderManager({search:async()=>({hits:[],receipt}),extract:async(provider,requested)=>{calls.push(provider.name);if(provider.name!=='exa')return requested.map(url=>({...page(url),receipt}));return requested.map((url,index)=>outcome==='partial'&&index===0?{...page(url),receipt}:providerFailure(url,outcome==='origin-429'?'HTTP 429 from origin':outcome==='origin-403'?'HTTP 403 from origin':'HTTP 429: provider quota exceeded'));}},new WebProviderRing(0)),result=await manager.extract(runtime({extractBackend:'exa'}),urls,'markdown');assert.deepEqual(calls,outcome==='all-rate'?['exa','parallel']:['exa']);assert.equal(result.pages.length,2);if(outcome==='all-rate'){assert.equal(result.provider,'parallel');assert.equal(result.servedBy,'parallel');}else assert.equal(result.provider,'exa');}
});

test('all-paid tiers make no anonymous requests, a search-only extraction remains explicit, and policy/abort never rescue',async()=>{
  let calls=0;const manager=new WebProviderManager({search:async()=>{calls++;throw new WebBlockedError('Blocked by website policy');},extract:async()=>{calls++;throw new WebBlockedError('Blocked by website policy');}},new WebProviderRing(0)),selected=runtime({searchBackend:'brave',extractBackend:'tavily'});
  await assert.rejects(manager.search(selected,'query',5),WebBlockedError);assert.equal(calls,1);await assert.rejects(manager.extract(selected,['https://synthetic.example'],'text'),WebBlockedError);assert.equal(calls,2);
  await assert.rejects(manager.extract(runtime({extractBackend:'brave'}),['https://synthetic.example'],'text'),/search-only/);assert.equal(calls,2);
  const allPaid=runtime({providerTiers:{exa:'paid',parallel:'paid',firecrawl:'paid',keenable:'paid'}});assert.equal((await manager.search(allPaid,'query',5)).status,'not configured');assert.equal(calls,2);const controller=new AbortController();controller.abort();await assert.rejects(manager.search(selected,'query',5,controller.signal),{name:'AbortError'});assert.equal(calls,2);
});
