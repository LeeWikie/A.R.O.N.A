import assert from 'node:assert/strict';
import {createServer as httpServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {createServer as tcpServer,createConnection,Socket} from 'node:net';
import {once} from 'node:events';
import {channel} from 'node:diagnostics_channel';
import type {TestContext} from 'node:test';
import {key,cert,proxyCert} from './web-tls-fixture.js';

export async function webProxyFixture(t:TestContext,input:{proxy?:'http'|'https'|'socks5';tlsOrigin?:boolean;handle:(request:IncomingMessage,response:ServerResponse)=>void|Promise<void>;auth?:boolean}){
  const sockets=new Set<Socket>(),nativeSockets=new Set<Socket>(),closedNative=new Set<Socket>(),connects:Array<{target:string;auth?:string;originAuth?:string}>=[];let originRequests=0;
  const track=(socket:Socket)=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));};
  const handler=(request:IncomingMessage,response:ServerResponse)=>{originRequests++;assert.equal(request.headers['proxy-authorization'],undefined);void input.handle(request,response);},origin=input.tlsOrigin?httpsServer({key,cert},handler):httpServer(handler);origin.on('connection',track);origin.listen(0,'127.0.0.1');await once(origin,'listening');const originAddress=origin.address();if(!originAddress||typeof originAddress==='string')throw Error('bad origin address');
  const tunnel=(target:string,client:Socket,head:Buffer,ready:()=>void)=>{assert.match(target,new RegExp(`^[^:]+:${originAddress.port}$`));const upstream=createConnection({host:'127.0.0.1',port:originAddress.port});track(upstream);upstream.once('connect',()=>{ready();if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());};
  const kind=input.proxy??'http';let proxy;
  if(kind==='socks5')proxy=tcpServer(client=>{
    let pending=Buffer.alloc(0),stage='greeting';const data=(chunk:Buffer)=>{pending=Buffer.concat([pending,chunk]);for(;;){
      if(stage==='greeting'){if(pending.length<2||pending.length<2+pending[1]!)return;assert.equal(pending[0],5);const methods=pending.subarray(2,2+pending[1]!);assert.ok(methods.includes(input.auth?2:0));pending=pending.subarray(2+pending[1]!);client.write(Buffer.from([5,input.auth?2:0]));stage=input.auth?'auth':'target';}
      else if(stage==='auth'){if(pending.length<2)return;const userLength=pending[1]!;if(pending.length<3+userLength)return;const passLength=pending[2+userLength]!;if(pending.length<3+userLength+passLength)return;assert.equal(pending.subarray(2,2+userLength).toString(),'proxy-user');assert.equal(pending.subarray(3+userLength,3+userLength+passLength).toString(),'proxy-pass');pending=pending.subarray(3+userLength+passLength);client.write(Buffer.from([1,0]));stage='target';}
      else{if(pending.length<5)return;assert.equal(pending[0],5);assert.equal(pending[1],1);assert.equal(pending[3],3);const length=pending[4]!;if(pending.length<7+length)return;const host=pending.subarray(5,5+length).toString(),port=pending.readUInt16BE(5+length);connects.push({target:host+':'+port,auth:input.auth?'socks5-auth':undefined});const head=pending.subarray(7+length);client.removeListener('data',data);tunnel(host+':'+port,client,head,()=>client.write(Buffer.from([5,0,0,1,127,0,0,1,0,0])));return;}
      if(!pending.length)return;
    }};client.on('data',data);
  });
  else{const unexpected=(_request:IncomingMessage,response:ServerResponse)=>{response.writeHead(500);response.end('An unexpected non-tunneled request reached the test proxy.');};proxy=kind==='https'?httpsServer({key,cert:proxyCert},unexpected):httpServer(unexpected);proxy.on('connect',(request,client,head)=>{const socket=client as Socket;assert.ok(socket instanceof Socket);const entry={target:request.url??'',auth:typeof request.headers['proxy-authorization']==='string'?request.headers['proxy-authorization']:undefined,originAuth:typeof request.headers.authorization==='string'?request.headers.authorization:undefined};assert.equal(entry.originAuth,undefined);if(input.auth)assert.equal(entry.auth,'Basic '+Buffer.from('proxy-user:proxy-pass').toString('base64'));connects.push(entry);tunnel(entry.target,socket,head,()=>socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));});}
  proxy.on('connection',track);proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const proxyAddress=proxy.address();if(!proxyAddress||typeof proxyAddress==='string')throw Error('bad proxy address');const proxyURL=`${kind}://${input.auth?'proxy-user:proxy-pass@':''}127.0.0.1:${proxyAddress.port}`,target=`${input.tlsOrigin?'https':'http'}://example.test:${originAddress.port}`;
  const observer=channel('undici:client:connected'),observed=(message:unknown)=>{if(!message||typeof message!=='object'||!('socket'in message)||!(message.socket instanceof Socket)||!('connectParams'in message)||!message.connectParams||typeof message.connectParams!=='object'||!('port'in message.connectParams))return;if(![String(proxyAddress.port),String(originAddress.port)].includes(String(message.connectParams.port)))return;nativeSockets.add(message.socket);message.socket.once('close',()=>closedNative.add(message.socket as Socket));};observer.subscribe(observed);
  t.after(async()=>{observer.unsubscribe(observed);for(const socket of sockets)socket.destroy();await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>origin.close(()=>resolve()))]);});
  return {target,proxyURL,connects,nativeSockets,closedNative,originRequests:()=>originRequests,originCa:cert,proxyCa:proxyCert};
}
