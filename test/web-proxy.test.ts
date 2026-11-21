import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {WebProviderTransport} from '../src/web/provider-transport.js';
import {validateWebTarget,requestWeb} from '../src/web/network.js';
import {webProxyFixture} from './web-proxy-fixture.js';
import {createWebTools} from '../src/web/index.js';
import {resolveWebRuntime,WebProviderRing} from '../src/web/provider-config.js';
import {randomUUID} from 'node:crypto';

for(const proxy of ['http','https','socks5'] as const)test(`native ${proxy} proxy authenticates only its tunnel, retains exact JSON and closes every owned native socket`,{timeout:15000},async t=>{
  const body=JSON.stringify({value:'原始 API 内容🙂'}),compressed=gzipSync(body),f=await webProxyFixture(t,{proxy,auth:true,handle:async(request,response)=>{assert.equal(request.headers.authorization,'Bearer synthetic-origin-key');const parts:Buffer[]=[];for await(const part of request)parts.push(Buffer.from(part));assert.deepEqual(Buffer.concat(parts),Buffer.from(JSON.stringify({query:'原始请求🙂'})));response.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});response.end(compressed);}}),transport=new WebProviderTransport({testing:{...(proxy==='https'?{proxyTlsCa:f.proxyCa}:{}),resolver:async()=>{throw Error('A trusted API proxy must own target DNS.');}},proxyEnvironment:{HTTP_PROXY:f.proxyURL}}),result=await transport.json(f.target+'/search',{method:'POST',payload:{query:'原始请求🙂'},headers:{authorization:'Bearer synthetic-origin-key'}});assert.deepEqual(result.data,{value:'原始 API 内容🙂'});assert.equal(result.receipt.sha256,createHash('sha256').update(body).digest('hex'));assert.equal(result.receipt.bytes,Buffer.byteLength(body));assert.equal(result.receipt.wireBytes,compressed.length);assert.equal(f.connects.length,1);assert.equal(f.originRequests(),1);assert.ok(f.nativeSockets.size>0);assert.equal(f.closedNative.size,f.nativeSockets.size,'settlement waits for genuine native socket closure');
});

test('origin TLS remains independent from proxy TLS and always validates the requested hostname',{timeout:15000},async t=>{
  const f=await webProxyFixture(t,{proxy:'https',tlsOrigin:true,handle:(_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"secure":true}');}}),environment={HTTPS_PROXY:f.proxyURL};
  await assert.rejects(new WebProviderTransport({testing:{proxyTlsCa:f.proxyCa},proxyEnvironment:environment}).json(f.target+'/api'),/certificate|self.signed/i);assert.equal(f.originRequests(),0);
  const transport=new WebProviderTransport({testing:{proxyTlsCa:f.proxyCa,tlsCa:f.originCa},proxyEnvironment:environment});assert.deepEqual((await transport.json(f.target+'/api')).data,{secure:true});assert.equal(f.originRequests(),1);await assert.rejects(transport.json(f.target.replace('example.test','wrong.test')+'/api'),/hostname|altname|match/i);assert.equal(f.originRequests(),1);assert.equal(f.closedNative.size,f.nativeSockets.size);
});

test('NO_PROXY and lowercase precedence retain strict direct DNS checks and proxy state is frozen per transport',{timeout:15000},async t=>{
  const f=await webProxyFixture(t,{handle:(_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"value":"direct"}');}});let lookups=0;const testing={allowLoopbackForHostname:'example.test',resolver:async()=>{lookups++;return [{address:'127.0.0.1',family:4}];}},environment={HTTP_PROXY:f.proxyURL,NO_PROXY:'example.test'},transport=new WebProviderTransport({testing,proxyEnvironment:environment});environment.NO_PROXY='';await transport.json(f.target+'/api');assert.equal(f.connects.length,0);assert.equal(lookups,1);
  await new WebProviderTransport({testing,proxyEnvironment:{HTTP_PROXY:f.proxyURL,http_proxy:''}}).json(f.target+'/api');assert.equal(f.connects.length,0);assert.equal(lookups,2);
  await new WebProviderTransport({testing,proxyEnvironment:{HTTP_PROXY:f.proxyURL}}).json(f.target+'/api');assert.equal(f.connects.length,1);assert.equal(lookups,2);
  await new WebProviderTransport({testing,proxyEnvironment:{ALL_PROXY:f.proxyURL}}).json(f.target+'/api');assert.equal(f.connects.length,2);assert.equal(lookups,3,'ALL_PROXY retains strict local target validation before its explicit native proxy transport');
  await assert.rejects(validateWebTarget('https://metadata.goog/api',{trustedProviderOrigin:'https://metadata.goog',proxyEnvironment:{HTTPS_PROXY:f.proxyURL}}),/Blocked/);await assert.rejects(requestWeb('http://127.0.0.1/private',{proxyEnvironment:{HTTP_PROXY:f.proxyURL}}),/Blocked/);assert.equal(f.connects.length,2);
});

test('cancelling a native proxied API stream closes its actual sockets before the call rejects',{timeout:15000},async t=>{
  let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),f=await webProxyFixture(t,{handle:(_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.write('{"pending":');entered();}}),controller=new AbortController(),transport=new WebProviderTransport({proxyEnvironment:{HTTP_PROXY:f.proxyURL}}),pending=transport.json(f.target+'/held',{signal:controller.signal}),rejected=assert.rejects(pending,/abort|cancel/i);await ready;assert.ok(f.nativeSockets.size>0);assert.equal(f.closedNative.size,0);controller.abort();await rejected;assert.equal(f.closedNative.size,f.nativeSockets.size);assert.equal(f.connects.length,1);
});

test('proxy refusal and size boundaries preserve errors without credential-bearing redirects',{timeout:15000},async t=>{
  let leaks=0;const f=await webProxyFixture(t,{handle:(request,response)=>{if(request.url==='/redirect'){response.writeHead(307,{location:'/leak'});response.end('Redirect');return;}if(request.url==='/leak')leaks++;response.writeHead(200,{'content-type':'application/json'});response.end('{"value":"'+'x'.repeat(1000)+'"}');}}),transport=new WebProviderTransport({maxBytes:30,proxyEnvironment:{HTTP_PROXY:f.proxyURL}});await assert.rejects(transport.json(f.target+'/large'),/byte limit/);await assert.rejects(transport.json(f.target+'/redirect'),/HTTP 307/);assert.equal(leaks,0);assert.equal(f.connects.length,2);assert.equal(f.closedNative.size,f.nativeSockets.size);
});

test('an explicitly configured private service works without a test bypass, while model URLs and metadata cannot borrow that trust',{timeout:15000},async t=>{
  const f=await webProxyFixture(t,{handle:(_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({results:[{url:'https://synthetic.example/page',title:'Private search service result',content:'Original result'}]}));}}),base=f.target.replace('example.test','127.0.0.1'),runtime=resolveWebRuntime({type:'auto',searchBackend:'searxng',providers:{searxng:{baseURL:base}}},()=>undefined,{},new WebProviderRing(0)),tools=createWebTools({authorize(){},providers:()=>runtime}),source=randomUUID();const result=await tools.web_search.execute!({signalIds:[source],query:'synthetic query',count:5},{}) as {status:string;content:string};assert.equal(result.status,'ok');assert.match(result.content,/Private search service result/);assert.equal(f.originRequests(),1);const refused=await tools.web_fetch.execute!({signalIds:[source],url:base+'/private',mode:'text',maxChars:20000},{}) as {isError:boolean;error:string};assert.equal(refused.isError,true);assert.match(refused.error,/Blocked/);assert.equal(f.originRequests(),1);
  for(const url of ['http://169.254.169.254/','http://169.254.170.2/','http://100.100.100.200/','http://[fd00:ec2::254]/','http://metadata.goog/'])await assert.rejects(validateWebTarget(url,{selfHostedOrigin:new URL(url).origin}),/Blocked/);assert.equal(f.connects.length,0);
});
