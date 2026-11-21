// Hostname and address classification adapted from OpenClaw src/infra/net/ssrf.ts.
// Copyright (c) 2026 OpenClaw Foundation; MIT license in net-policy/LICENSE.
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { extractEmbeddedIpv4FromIpv6, isBlockedSpecialUseIpv4Address, isBlockedSpecialUseIpv6Address, isCanonicalDottedDecimalIPv4, isIpv4Address, isLegacyIpv4Literal, parseCanonicalIpAddress, parseLooseIpAddress,isCloudMetadataIpAddress } from './net-policy/ip.js';
import {urlContainsCredential} from './url-credentials.js';
import {resolveEnvHttpProxyUrl,shouldUseEnvHttpProxyForUrl,resolveEnvHttpProxyAgentOptions,matchesNoProxy} from './net-policy/proxy-env.js';
import {requestViaWebProxy,validateWebProxyURL} from './proxy-request.js';

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
export type NetworkTesting = { resolver?: Resolver; allowPrivate?: boolean; allowLoopbackForHostname?: string; braveUrl?: string; tlsCa?: string;proxyTlsCa?:string;providerEndpoints?:Partial<Record<'exa'|'parallel'|'firecrawl'|'keenable',string>> };
export class WebBlockedError extends Error {}
const blockedNames = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal','metadata.goog']);
function normalize(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
export function isBlockedHostnameOrIp(hostname: string,policy?:{allowRfc2544BenchmarkRange?:boolean;allowIpv6UniqueLocalRange?:boolean}): boolean {
  const host = normalize(hostname);
  if (!host || blockedNames.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ip = parseCanonicalIpAddress(host);
  if (ip) {
    if (isIpv4Address(ip)) return isBlockedSpecialUseIpv4Address(ip,{allowRfc2544BenchmarkRange:policy?.allowRfc2544BenchmarkRange});
    if (isBlockedSpecialUseIpv6Address(ip,{allowUniqueLocalRange:policy?.allowIpv6UniqueLocalRange})) return true;
    const embedded = extractEmbeddedIpv4FromIpv6(ip);
    return embedded ? isBlockedSpecialUseIpv4Address(embedded,{allowRfc2544BenchmarkRange:policy?.allowRfc2544BenchmarkRange}) : false;
  }
  if (host.includes(':') && !parseLooseIpAddress(host)) return true;
  if (!isCanonicalDottedDecimalIPv4(host) && isLegacyIpv4Literal(host)) return true;
  const parts = host.split('.');
  return parts.length <= 4 && (parts.some(part => part.length === 0) || parts.every(part => /^[0-9]+$/.test(part) || /^0x/i.test(part)));
}
function urlCheck(value: string | URL,secretValues?:()=>readonly string[]): URL {
  const raw=String(value).trim().replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)\s+/u,'$1'),url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new WebBlockedError('Only HTTP(S) URLs without credentials are permitted');
  const secrets=secretValues?.()??[];if(urlContainsCredential(String(value),secrets)||urlContainsCredential(url.href,secrets))throw new WebBlockedError('Blocked: URL contains what appears to be an API key or token. Secrets must not be sent in URLs.');
  return url;
}
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function isAlwaysBlockedWebTarget(hostname:string){const host=normalize(hostname);if(host==='metadata.google.internal'||host==='metadata.goog')return true;const ip=parseLooseIpAddress(host);if(!ip)return false;const value=isIpv4Address(ip)?ip:extractEmbeddedIpv4FromIpv6(ip)??ip;return isCloudMetadataIpAddress(host)||['linkLocal','unspecified','multicast','broadcast'].includes(value.range());}
async function resolveTarget(url:URL,testing:NetworkTesting|undefined,signal:AbortSignal,trustedProviderOrigin?:string,selfHostedOrigin?:string,proxyEnvironment:Readonly<Record<string,string|undefined>>=process.env){
  signal.throwIfAborted();const host=normalize(url.hostname);
  const selfHosted=selfHostedOrigin===url.origin;
  if(isAlwaysBlockedWebTarget(host)||!selfHosted&&!testing?.allowPrivate&&isBlockedHostnameOrIp(host))throw new WebBlockedError('Blocked hostname or private/internal/special-use IP address');
  // OpenClaw 2026.11.2 withTrustedWebToolsEndpoint uses the exact provider host,
  // retaining other private/metadata classes and strict user-controlled URLs.
  const policy=trustedProviderOrigin===url.origin&&!isIP(host)?{allowRfc2544BenchmarkRange:true,allowIpv6UniqueLocalRange:true}:undefined;
  const proxy=(trustedProviderOrigin===url.origin||selfHosted)&&shouldUseEnvHttpProxyForUrl(url.href,proxyEnvironment)?resolveEnvHttpProxyUrl(url.protocol==='https:'?'https':'http',proxyEnvironment):undefined;
  if(proxy){validateWebProxyURL(proxy);return {host,entries:[] as LookupAddress[],proxy};}
  const explicitOptions=resolveEnvHttpProxyAgentOptions(proxyEnvironment),explicitProxy=(trustedProviderOrigin===url.origin||selfHosted)&&!matchesNoProxy(url,proxyEnvironment)?url.protocol==='https:'?explicitOptions?.httpsProxy:explicitOptions?.httpProxy:undefined;
  if(explicitProxy)validateWebProxyURL(explicitProxy);
  const literalFamily=isIP(host),resolver=testing?.resolver??(async(name:string)=>dnsLookup(name,{all:true}));
  const entries=literalFamily?[{address:host,family:literalFamily}]:await withAbort(resolver(host),signal);
  if(entries.length>8)throw new WebBlockedError('Too many DNS answers');
  if(!entries.length||entries.some(entry=>!isIP(entry.address)||isIP(entry.address)!==entry.family||isAlwaysBlockedWebTarget(entry.address)||(!selfHosted&&!testing?.allowPrivate&&isBlockedHostnameOrIp(entry.address,policy)&&!(testing?.allowLoopbackForHostname===host&&entry.address==='127.0.0.1'))))throw new WebBlockedError('Blocked or invalid DNS resolution');
  return {host,entries,proxy:explicitProxy};
}
/** Cache reuse passes the same current target checks as a new request. */
export async function validateWebTarget(input:string,options:{signal?:AbortSignal;testing?:NetworkTesting;timeoutMs?:number;secretValues?:()=>readonly string[];trustedProviderOrigin?:string;selfHostedOrigin?:string;proxyEnvironment?:Readonly<Record<string,string|undefined>>}={}){
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(options.timeoutMs??30000)]),url=urlCheck(input,options.secretValues);await resolveTarget(url,options.testing,signal,options.trustedProviderOrigin,options.selfHostedOrigin,options.proxyEnvironment);return url.href;
}
export type WebResponse = { url: string; status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean; bytesRead: number; wireBytes: number };
export async function requestWeb(input: string, options: {
  signal?: AbortSignal; timeoutMs?: number; connectTimeoutMs?:number; maxBytes?: number; maxCompressedBytes?: number; maxRedirects?: number;
  testing?: NetworkTesting; headers?: Record<string, string>; allowRedirects?: boolean;
  secretValues?:()=>readonly string[];
  method?:'GET'|'POST';body?:string;
  /** Trusted service origin only; never supplied from a model-controlled page URL. */
  trustedProviderOrigin?:string;
  selfHostedOrigin?:string;
  proxyEnvironment?:Readonly<Record<string,string|undefined>>;
} = {}): Promise<WebResponse> {
  if(options.method==='POST'&&options.allowRedirects!==false)throw new WebBlockedError('Provider API requests must not follow redirects');
  if(options.body!==undefined&&(options.method!=='POST'||Buffer.byteLength(options.body)>1000000))throw new WebBlockedError('Invalid provider request body');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
  let url = urlCheck(input,options.secretValues);
  const maxBytes = options.maxBytes ?? 750_000;
  const redirects = options.maxRedirects ?? 3;
  for (let count = 0; ; count++) {
    signal.throwIfAborted();
    const {host,entries,proxy}=await resolveTarget(url,options.testing,options.connectTimeoutMs?AbortSignal.any([signal,AbortSignal.timeout(options.connectTimeoutMs)]):signal,options.trustedProviderOrigin,options.selfHostedOrigin,options.proxyEnvironment);
    // Validate every DNS answer before trying a bounded number of addresses.
    const candidates = [...entries].sort((a, b) => a.family - b.family);
    let response: WebResponse | undefined;
    let lastError: unknown;
    const wireLimit = options.maxCompressedBytes ?? maxBytes;
    if(proxy)response=await requestViaWebProxy(url,proxy,{signal,method:options.method??'GET',body:options.body,maxWireBytes:wireLimit,timeoutMs:options.timeoutMs??30000,connectTimeoutMs:options.connectTimeoutMs,originCa:options.testing?.tlsCa,proxyCa:options.testing?.proxyTlsCa,headers:{'user-agent':'ShittimChest/0.1',accept:'*/*','accept-encoding':'gzip, deflate, br',...(options.body!==undefined?{'content-length':String(Buffer.byteLength(options.body))}:{}),...options.headers}});
    else for (const address of candidates) {
      signal.throwIfAborted();
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, Math.floor((options.timeoutMs ?? 30_000) / candidates.length)))]);
      let request:http.ClientRequest|undefined;let closed:Promise<void>=Promise.resolve(),connected=false,connectTimer:ReturnType<typeof setTimeout>|undefined;
      try {
        response = await new Promise<WebResponse>((resolve, reject) => {
          request = (url.protocol === 'https:' ? https : http).request(url, {
            method: options.method??'GET', agent: false, signal: attemptSignal, family: address.family, ...(options.testing?.tlsCa ? { ca: options.testing.tlsCa } : {}),
            headers: { 'user-agent': 'ShittimChest/0.1', accept: '*/*', 'accept-encoding': 'gzip, deflate, br',...(options.body!==undefined?{'content-length':String(Buffer.byteLength(options.body))}:{}), ...options.headers },
            lookup: ((requested: string, _opts: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
              if (normalize(requested) !== host) return callback(new WebBlockedError('Unexpected DNS lookup'), '', 0);
              callback(null, address.address, address.family);
            }) as typeof import('node:dns').lookup,
          }, res => {
            if(connectTimer)clearTimeout(connectTimer);
            const chunks: Buffer[] = []; let bytes = 0; let done = false;
            const finish = (truncated: boolean) => { if (done) return; done = true; resolve({ url: url.href, status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated, bytesRead: bytes, wireBytes: bytes }); };
            res.on('data', (chunk: Buffer) => {
              const part = chunk.subarray(0, Math.max(0, wireLimit - bytes));
              chunks.push(part); bytes += part.length;
              if (part.length < chunk.length) { finish(true); res.destroy(); }
            });
            res.on('end', () => finish(false));
            res.on('error', error => { if (!done) reject(error); });
            res.on('aborted', () => { if (!done) reject(new Error('Response aborted')); });
          });
          closed=new Promise<void>(resolve=>request!.once('close',resolve));
          request.on('socket',socket=>{socket.once('connect',()=>{connected=true;});socket.once(url.protocol==='https:'?'secureConnect':'connect',()=>{if(connectTimer)clearTimeout(connectTimer);});});if(options.connectTimeoutMs)connectTimer=setTimeout(()=>request?.destroy(new Error('Provider connection timed out')),options.connectTimeoutMs);request.on('error', reject); request.end(options.body);
        });
        await closed;
        break;
      } catch (error) {
        if(request&&!request.destroyed)request.destroy();await closed;
        signal.throwIfAborted();
        if(options.method==='POST'&&connected)throw error;
        lastError = error;
      }finally{if(connectTimer)clearTimeout(connectTimer);
      }
    }
    if (!response) throw lastError ?? new Error('No usable DNS addresses');
    const encoding = (response.headers['content-encoding'] || 'identity').trim().toLowerCase();
    if (encoding !== 'identity') {
      if (response.truncated) throw new Error('Compressed response exceeded wire size limit');
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      if (!decoder) throw new Error('Unsupported content encoding');
      const source = Readable.from([response.body]);
      const abort = () => { source.destroy(); decoder.destroy(signal.reason instanceof Error ? signal.reason : new Error('Aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      const chunks: Buffer[] = []; let bytes = 0; let truncated = false;
      try {
        for await (const value of source.pipe(decoder)) {
          signal.throwIfAborted();
          const chunk = Buffer.from(value as Uint8Array);
          const part = chunk.subarray(0, Math.max(0, maxBytes - bytes));
          chunks.push(part); bytes += part.length;
          if (part.length < chunk.length) { truncated = true; source.destroy(); decoder.destroy(); break; }
        }
      } finally { signal.removeEventListener('abort', abort); source.destroy(); decoder.destroy(); }
      response = { ...response, body: Buffer.concat(chunks), bytesRead: bytes, truncated };
    } else if (response.body.length > maxBytes) {
      response = { ...response, body: response.body.subarray(0, maxBytes), bytesRead: maxBytes, truncated: true };
    }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location && options.allowRedirects !== false) {
      if (count >= redirects) throw new Error('Too many redirects');
      url = urlCheck(new URL(response.headers.location, url),options.secretValues);
      continue;
    }
    return response;
  }
}
