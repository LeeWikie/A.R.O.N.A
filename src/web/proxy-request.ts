// Proxy construction adapted from OpenClaw 2026.11.2 src/infra/net/undici-runtime.ts
// and undici-dispatcher-options.ts. Copyright (c) 2026 OpenClaw Foundation.
// MIT license in net-policy/LICENSE.
import {isIP,Socket} from 'node:net';
import {EventEmitter} from 'node:events';
import {AsyncLocalStorage} from 'node:async_hooks';
import {channel} from 'node:diagnostics_channel';
import {Agent,Client,Pool,ProxyAgent,Socks5ProxyAgent,buildConnector,errors,type Dispatcher} from 'undici';
import {WebBlockedError,isAlwaysBlockedWebTarget,type WebResponse} from './network.js';

const ignoreDispatcherError=()=>{};
// A failed TLS handshake can outlive dispatcher destruction. Retain the actual
// sockets within this request's async scope until their close events arrive.
const socketOwners=new AsyncLocalStorage<Map<Socket,Promise<void>>>();
function retainOwnedSocket(message:unknown){const owner=socketOwners.getStore();if(!owner||!message||typeof message!=='object'||!('socket'in message)||!(message.socket instanceof Socket)||owner.has(message.socket))return;const socket=message.socket;owner.set(socket,socket.closed?Promise.resolve():new Promise<void>(resolve=>socket.once('close',()=>resolve())));}
channel('net.client.socket').subscribe(retainOwnedSocket);
channel('undici:client:connected').subscribe(retainOwnedSocket);
function observed<T extends Dispatcher>(dispatcher:T):T{EventEmitter.prototype.on.call(dispatcher,'error',ignoreDispatcherError);return dispatcher;}
function originFactory(origin:string|URL,options:Agent.Options):Dispatcher{return options.connections===1?observed(new Client(origin,options)):observed(new Pool(origin,{...options,factory:(origin,options)=>observed(new Client(origin,options))}));}
export function validateWebProxyURL(uri:string){let proxy:URL;try{proxy=new URL(uri);}catch{throw new WebBlockedError('Invalid configured web proxy URL');}if(!['http:','https:','socks:','socks5:'].includes(proxy.protocol))throw new WebBlockedError('Unsupported configured web proxy protocol');if(isAlwaysBlockedWebTarget(proxy.hostname))throw new WebBlockedError('Blocked metadata or special-use proxy address');return proxy;}
export function createWebProxyAgent(uri:string,options:{timeoutMs:number;connectTimeoutMs?:number;originCa?:string;proxyCa?:string}):Dispatcher{
  const proxy=validateWebProxyURL(uri);
  const connectTimeout=options.connectTimeoutMs??options.timeoutMs,requestTls={allowH2:false,timeout:connectTimeout,...(options.originCa?{ca:options.originCa}:{})},proxyTls=options.proxyCa?{ca:options.proxyCa}:undefined,defaults={allowH2:false,connections:1,pipelining:1,bodyTimeout:options.timeoutMs,headersTimeout:options.timeoutMs};
  if(proxy.protocol==='socks:'||proxy.protocol==='socks5:'){
    const connect=buildConnector({autoSelectFamily:true,autoSelectFamilyAttemptTimeout:2000,timeout:connectTimeout,...proxyTls});
    // Native Agent owns admission and every SOCKS pool.
    return observed(new Agent({...defaults,factory:()=>observed(new Socks5ProxyAgent(uri,{...defaults,connect,connectTimeout,requestTls,...(proxyTls?{proxyTls}:{})}))})).compose(dispatch=>(request,handler)=>{const headers=request.headers,names=Array.isArray(headers)?headers.filter((_,index)=>index%2===0):Object.keys(headers??{});if(names.some(name=>typeof name==='string'&&name.toLowerCase()==='proxy-authorization'))throw new errors.InvalidArgumentError('Proxy-Authorization should be sent in ProxyAgent constructor');return dispatch({...defaults,...request},handler);});
  }
  return observed(new ProxyAgent({...defaults,uri,proxyTunnel:true,requestTls,connectTimeout,...(proxyTls?{proxyTls}:{}),factory:originFactory,clientFactory:(origin,poolOptions)=>{
    const connect=Reflect.get(poolOptions,'connect');
    const safeConnect:typeof connect=typeof connect==='function'?(input:Parameters<ReturnType<typeof buildConnector>>[0],callback:Parameters<ReturnType<typeof buildConnector>>[1])=>{const {servername,...without}=input;return connect(servername&&isIP(servername.replace(/^\[|\]$/g,''))?without:input,callback);}:connect;
    return observed(new Pool(origin,{...poolOptions,connect:safeConnect,factory:(origin,options)=>observed(new Client(origin,options))}));
  }}));
}

/** Returns only after this request's native proxy dispatcher and all of its sockets have closed. */
export async function requestViaWebProxy(url:URL,proxy:string,input:{signal:AbortSignal;method:'GET'|'POST';body?:string;headers:Record<string,string>;maxWireBytes:number;timeoutMs:number;connectTimeoutMs?:number;originCa?:string;proxyCa?:string}):Promise<WebResponse>{
  if(Object.keys(input.headers).some(name=>name.toLowerCase()==='proxy-authorization'))throw new WebBlockedError('Proxy authentication must not be sent as an origin header');
  const owner=new Map<Socket,Promise<void>>();return socketOwners.run(owner,async()=>{const agent=createWebProxyAgent(proxy,input);let body:Dispatcher.ResponseData['body']|undefined;
  try{
    input.signal.throwIfAborted();const response=await agent.request({origin:url.origin,path:url.pathname+url.search,method:input.method,headers:input.headers,body:input.body,signal:input.signal,bodyTimeout:input.timeoutMs,headersTimeout:input.timeoutMs});body=response.body;
    const chunks:Buffer[]=[];let bytes=0,truncated=false;for await(const value of response.body){input.signal.throwIfAborted();const chunk=Buffer.from(value),part=chunk.subarray(0,Math.max(0,input.maxWireBytes-bytes));chunks.push(part);bytes+=part.length;if(part.length<chunk.length){truncated=true;break;}}
    input.signal.throwIfAborted();return {url:url.href,status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks),truncated,bytesRead:bytes,wireBytes:bytes};
  }finally{body?.on('error',()=>{});body?.destroy();try{await agent.destroy();}finally{for(;;){const pending=[...owner.values()];await Promise.all(pending);if(pending.length===owner.size)break;}}}
  });
}
