import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {urlContainsCredential} from '../src/web/url-credentials.js';
import {requestWeb,validateWebTarget} from '../src/web/network.js';
import {createWebTools} from '../src/web/index.js';

test('native credential-prefix boundaries, dotted keys, Unicode digits and tolerant percent decoding retain their complete URL semantics',()=>{
  for(const token of ['sk-sp-abcdefghijk.1234567890','ctx7sk-abcdefghijkl','github_pat_abcdefghijkl','glrt-abcdef.1234567890','xapp-١-abcdefghijk','pk-lf-abcdefghijk']){assert.equal(urlContainsCredential('https://synthetic.example/?q='+token),true);assert.equal(urlContainsCredential('https://synthetic.example/?q='+Array.from(Buffer.from(token)).map(byte=>'%'+byte.toString(16).padStart(2,'0')).join('')),true);}
  for(const url of ['https://synthetic.example/scikit-learn','https://synthetic.example/task-history','https://synthetic.example/?q=wordghp_abcdefghijk'])assert.equal(urlContainsCredential(url),false,url);
  assert.equal(urlContainsCredential('https://synthetic.example/%ZZ?q=%E7%94%B2opaque',['甲opaque']),true);
});

test('input, redirect, cache and whole-batch URL gates reject known or prefixed secrets before any prohibited request',async t=>{
  const token='ghp_abcdefghijklmnopqrst',opaque='synthetic-opaque-credential';let calls=0,leaks=0,dns=0,secrets:readonly string[]=[];
  const server=createServer((request,response)=>{calls++;if(request.url?.startsWith('/redirect')){response.writeHead(302,{location:'/leak?q='+token});response.end();return;}if(request.url?.startsWith('/leak'))leaks++;response.writeHead(200,{'content-type':'text/plain'});response.end('synthetic original page');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();if(!address||typeof address==='string')throw Error('invalid address');const base=`http://synthetic.example:${address.port}`,testing={allowPrivate:true,allowLoopbackForHostname:'synthetic.example',resolver:async()=>{dns++;return [{address:'127.0.0.1',family:4}];}},secretValues=()=>secrets;
  await assert.rejects(validateWebTarget(base+'/?q='+token,{testing}),error=>error instanceof Error&&!error.message.includes(token));assert.equal(calls,0);assert.equal(dns,0,'testing overrides never bypass credential refusal');
  await assert.rejects(requestWeb(base+'/redirect',{testing}),/Secrets must not be sent/);assert.equal(calls,1);assert.equal(leaks,0);
  const tools=createWebTools({authorize(){},secretValues,testing}),input={signalIds:[randomUUID()],url:base+'/?q='+opaque,mode:'text' as const,maxChars:20000};await tools.web_fetch.execute!(input,{});assert.equal(calls,2);secrets=[opaque];await assert.rejects(tools.web_fetch.execute!(input,{}),/Secrets must not be sent/);assert.equal(calls,2,'an old cache cannot skip current credential checks');
  await assert.rejects(tools.web_fetch.execute!({signalIds:[randomUUID()],urls:[base+'/public',base+'/?q='+token],mode:'text',maxChars:20000},{}),/web_secret_url_blocked/);assert.equal(calls,2,'the full batch is preflighted before any URL can connect');
  await requestWeb(base.replace('://',':// ')+'/public',{testing});assert.equal(calls,3,'native URL whitespace repair does not require manual editing');
});
