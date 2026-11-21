import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {requestWeb,validateWebTarget} from '../src/web/network.js';

test('provider POST requests retain exact JSON and byte limits without following credential-bearing redirects',async t=>{
  let leaks=0;const bodies:Buffer[]=[],server=createServer(async(request,response)=>{if(request.url==='/leak')leaks++;const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));bodies.push(Buffer.concat(chunks));if(request.url==='/redirect'){response.writeHead(307,{location:'/leak'});response.end('redirect');return;}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({result:{content:[{type:'text',text:'甲🙂'}]}}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();if(!address||typeof address==='string')throw Error('invalid address');const base=`http://synthetic.example:${address.port}`,testing={allowLoopbackForHostname:'synthetic.example',resolver:async()=>[{address:'127.0.0.1',family:4}]},body=JSON.stringify({query:'甲🙂',urls:['https://synthetic.example/page']});
  const response=await requestWeb(base+'/api',{method:'POST',body,allowRedirects:false,testing,headers:{authorization:'Bearer synthetic-secret-key','content-type':'application/json'}});assert.equal(response.status,200);assert.deepEqual(bodies,[Buffer.from(body)]);assert.match(response.body.toString(),/甲🙂/);assert.equal(response.bytesRead,response.body.length);
  const redirect=await requestWeb(base+'/redirect',{method:'POST',body,allowRedirects:false,testing,headers:{authorization:'Bearer synthetic-secret-key'}});assert.equal(redirect.status,307);assert.equal(leaks,0);await assert.rejects(requestWeb(base+'/redirect',{method:'POST',body,testing}),/must not follow redirects/);assert.equal(bodies.length,2);
  await assert.rejects(requestWeb(base+'/api',{method:'POST',body:'x'.repeat(1000001),allowRedirects:false,testing}),/Invalid provider request body/);assert.equal(bodies.length,2);
});

test('a submitted provider request is not replayed against another DNS address after a partial response fails',async t=>{
  let requests=0;const server=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'application/json','content-length':'1000'});response.write('{"partial":');setImmediate(()=>response.destroy());});server.listen(0,'0.0.0.0');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();if(!address||typeof address==='string')throw Error('invalid address');
  await assert.rejects(requestWeb(`http://synthetic.example:${address.port}/api`,{method:'POST',body:'{}',allowRedirects:false,testing:{allowPrivate:true,resolver:async()=>[{address:'127.0.0.1',family:4},{address:'127.0.0.2',family:4}]}}));assert.equal(requests,1,'an acknowledged API request cannot be replayed merely because another address is available');
});

test('trusted provider fake-IP policy is scoped to the exact origin while arbitrary pages, other hosts and metadata stay blocked',async()=>{
  const url='https://api.synthetic.example/search',origin=new URL(url).origin;
  for(const [address,family]of [['198.18.0.33',4],['fd12::33',6],['::ffff:198.18.0.33',6]] as const){const testing={resolver:async()=>[{address,family}]};await assert.rejects(validateWebTarget(url,{testing}),/Blocked/);assert.equal(await validateWebTarget(url,{testing,trustedProviderOrigin:origin}),url);await assert.rejects(validateWebTarget('https://other.synthetic.example/search',{testing,trustedProviderOrigin:origin}),/Blocked/);await assert.rejects(validateWebTarget('http://api.synthetic.example/search',{testing,trustedProviderOrigin:origin}),/Blocked/);}
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.100.100.200','192.168.0.1','fd00:ec2::254','::ffff:127.0.0.1'])await assert.rejects(validateWebTarget(url,{testing:{resolver:async()=>[{address,family:address.includes(':')?6:4}]},trustedProviderOrigin:origin}),/Blocked/);
  for(const target of ['https://198.18.0.33/','https://[fd12::33]/','https://localhost/','https://metadata.google.internal/'])await assert.rejects(validateWebTarget(target,{trustedProviderOrigin:new URL(target).origin}),/Blocked/);
  await assert.rejects(validateWebTarget(url,{testing:{resolver:async()=>[{address:'198.18.0.33',family:4},{address:'10.0.0.1',family:4}]},trustedProviderOrigin:origin}),/Blocked/);
  await assert.rejects(validateWebTarget(url+'?key=sk-ant-api03-'+'a'.repeat(80),{testing:{resolver:async()=>[{address:'198.18.0.33',family:4}]},trustedProviderOrigin:origin}),/Secrets must not be sent/);
});
