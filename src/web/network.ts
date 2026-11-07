// Hostname and address classification adapted from OpenClaw src/infra/net/ssrf.ts.
// Copyright (c) 2026 OpenClaw Foundation; MIT license in net-policy/LICENSE.
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { extractEmbeddedIpv4FromIpv6, isBlockedSpecialUseIpv4Address, isBlockedSpecialUseIpv6Address, isCanonicalDottedDecimalIPv4, isIpv4Address, isLegacyIpv4Literal, parseCanonicalIpAddress, parseLooseIpAddress } from './net-policy/ip.js';

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
export type NetworkTesting = { resolver?: Resolver; allowPrivate?: boolean; allowLoopbackForHostname?: string; braveUrl?: string; tlsCa?: string };
export class WebBlockedError extends Error {}
const blockedNames = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);
function normalize(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
export function isBlockedHostnameOrIp(hostname: string): boolean {
  const host = normalize(hostname);
  if (!host || blockedNames.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ip = parseCanonicalIpAddress(host);
  if (ip) {
    if (isIpv4Address(ip)) return isBlockedSpecialUseIpv4Address(ip);
    if (isBlockedSpecialUseIpv6Address(ip)) return true;
    const embedded = extractEmbeddedIpv4FromIpv6(ip);
    return embedded ? isBlockedSpecialUseIpv4Address(embedded) : false;
  }
  if (host.includes(':') && !parseLooseIpAddress(host)) return true;
  if (!isCanonicalDottedDecimalIPv4(host) && isLegacyIpv4Literal(host)) return true;
  const parts = host.split('.');
  return parts.length <= 4 && (parts.some(part => part.length === 0) || parts.every(part => /^[0-9]+$/.test(part) || /^0x/i.test(part)));
}
function urlCheck(value: string | URL): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new WebBlockedError('Only HTTP(S) URLs without credentials are permitted');
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
export type WebResponse = { url: string; status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean; bytesRead: number; wireBytes: number };
export async function requestWeb(input: string, options: {
  signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; maxCompressedBytes?: number; maxRedirects?: number;
  testing?: NetworkTesting; headers?: Record<string, string>; allowRedirects?: boolean;
} = {}): Promise<WebResponse> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
  let url = urlCheck(input);
  const maxBytes = options.maxBytes ?? 750_000;
  const redirects = options.maxRedirects ?? 3;
  for (let count = 0; ; count++) {
    signal.throwIfAborted();
    const host = normalize(url.hostname);
    if (!options.testing?.allowPrivate && isBlockedHostnameOrIp(host)) throw new WebBlockedError('Blocked hostname or private/internal/special-use IP address');
    const literalFamily = isIP(host);
    const resolver = options.testing?.resolver ?? (async (name: string) => dnsLookup(name, { all: true }));
    const entries = literalFamily ? [{ address: host, family: literalFamily }] : await withAbort(resolver(host), signal);
    if (entries.length > 8) throw new WebBlockedError('Too many DNS answers');
    if (!entries.length || entries.some(entry => !isIP(entry.address) || isIP(entry.address) !== entry.family || (!options.testing?.allowPrivate && isBlockedHostnameOrIp(entry.address) && !(options.testing?.allowLoopbackForHostname === host && entry.address === '127.0.0.1')))) throw new WebBlockedError('Blocked or invalid DNS resolution');
    // Validate every DNS answer before trying a bounded number of addresses.
    const candidates = [...entries].sort((a, b) => a.family - b.family);
    let response: WebResponse | undefined;
    let lastError: unknown;
    const wireLimit = options.maxCompressedBytes ?? maxBytes;
    for (const address of candidates) {
      signal.throwIfAborted();
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, Math.floor((options.timeoutMs ?? 30_000) / candidates.length)))]);
      try {
        response = await new Promise<WebResponse>((resolve, reject) => {
          const request = (url.protocol === 'https:' ? https : http).request(url, {
            method: 'GET', agent: false, signal: attemptSignal, family: address.family, ...(options.testing?.tlsCa ? { ca: options.testing.tlsCa } : {}),
            headers: { 'user-agent': 'ShittimChest/0.1', accept: '*/*', 'accept-encoding': 'gzip, deflate, br', ...options.headers },
            lookup: ((requested: string, _opts: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
              if (normalize(requested) !== host) return callback(new WebBlockedError('Unexpected DNS lookup'), '', 0);
              callback(null, address.address, address.family);
            }) as typeof import('node:dns').lookup,
          }, res => {
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
          request.on('error', reject); request.end();
        });
        break;
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
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
      url = urlCheck(new URL(response.headers.location, url));
      continue;
    }
    return response;
  }
}
