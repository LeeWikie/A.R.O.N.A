import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWebTools, webConfigurationSchema } from '../src/web/index.js';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { requestWeb, WebBlockedError } from '../src/web/network.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
async function fixture() {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['proxy-authorization'], undefined);
    if (req.url === '/redirect-private') { res.writeHead(302, { location: 'http://localhost:1/private' }); res.end(); return; }
    if (req.url === '/redirect-creds') { res.writeHead(302, { location: 'http://user:pass@example.com/' }); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/article' }); res.end(); return; }
    if (req.url === '/charset') { res.writeHead(200, {'content-type':'text/html'}); res.end(Buffer.from('<html><head><meta charset="iso-8859-1"><title>caf\u00e9</title></head><body><p>caf\u00e9</p></body></html>', 'latin1')); return; }
    if (req.url === '/bom') { res.writeHead(200, {'content-type':'text/plain; charset=iso-8859-1'}); res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('caf\u00e9 \u65e5\u672c', 'utf16le')])); return; }
    if (req.url === '/gzip') { res.writeHead(200, {'content-type': 'text/plain', 'content-encoding': 'gzip'}); res.end(gzipSync('x'.repeat(20000))); return; }
    if (req.url === '/deflate') { res.writeHead(200, {'content-type': 'text/plain', 'content-encoding': 'deflate'}); res.end(deflateSync('fixture body')); return; }
    if (req.url === '/br') { res.writeHead(200, {'content-type': 'text/plain', 'content-encoding': 'br'}); res.end(brotliCompressSync('fixture body')); return; }
    if (req.url === '/badgzip') { res.writeHead(200, {'content-type': 'text/plain', 'content-encoding': 'gzip'}); res.end('not gzip'); return; }
    if (req.url === '/slow') { return; }
    if (req.url === '/markdown') { res.writeHead(200, {'content-type':'text/markdown; charset=utf-8'}); res.end(`# Markdown title

A **bold** paragraph with [link](https://example.com).`); return; }
    if (req.url === '/large') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(1000)); return; }
    if (req.url?.startsWith('/brave-redirect?')) { res.writeHead(302, { location: '/leak' }); res.end(); return; }
    if (req.url?.startsWith('/brave?')) { assert.equal(req.headers['x-subscription-token'], 'synthetic-key'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({web:{results:[{url:'https://example.com/',title:'Brave fixture',description:'Found'}]}})); return; }
    if (req.url?.startsWith('/search?')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [{ url: 'https://example.org/page', title: 'Result', content: 'A result' }, { url: 'http://u:p@example.org', title: 'bad' }] })); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Fixture title</title></head><body><article><h1>Heading</h1><p>A fixture article with enough text to be shown as content. This is untrusted external content.</p><script>evil()</script><p>Another useful paragraph with text and <a href="https://example.org/">a link</a>.</p></article></body></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('bad fixture');
  return { server, base: `http://example.test:${addr.port}`, requests: () => requests };
}
const context = { abortSignal: new AbortController().signal } as never;
test('blocks URL credentials, unsafe schemes, localhost and private DNS before connecting', async () => {
  for (const url of ['file:///etc/passwd', 'http://user:pass@example.org/', 'http://localhost/', 'http://169.254.169.254/', 'http://[::1]/']) await assert.rejects(requestWeb(url), WebBlockedError);
  let calls = 0;
  await assert.rejects(requestWeb('http://rebind.example/', { testing: { resolver: async () => { calls++; return [{address: '127.0.0.1', family: 4}]; } } }), WebBlockedError);
  assert.equal(calls, 1);
  await assert.rejects(requestWeb('http://rebind.example/', { testing: { resolver: async () => [{address: '8.8.8.8', family: 4}, {address: '10.0.0.1', family: 4}] } }), WebBlockedError);
});
test('validates each redirect and bounds bytes with a pinned local fixture', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const testing = { resolver, allowLoopbackForHostname: 'example.test' };
  const r = await requestWeb(f.base + '/large', { testing, maxBytes: 32 });
  assert.equal(r.bytesRead, 32); assert.equal(r.truncated, true);
  await assert.rejects(requestWeb(f.base + '/redirect-private', { testing }), WebBlockedError);
  await assert.rejects(requestWeb(f.base + '/redirect-creds', { testing }), WebBlockedError);
  let lookups = 0;
  const redirected = await requestWeb(f.base + '/redirect', { testing: { ...testing, resolver: async () => { lookups++; return resolver(); } } });
  assert.equal(lookups, 2);
  assert.match(redirected.url, /\/article$/); assert.equal(redirected.status, 200);
});
test('authorization precedes all requests; tools extract and search actual local HTTP responses', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const testing = { resolver, allowLoopbackForHostname: 'example.test' };
  const denied = createWebTools({ authorize() { throw new Error('denied'); }, testing });
  await assert.rejects(denied.web_fetch.execute!({ signalIds: [id], url: f.base, mode: 'text', maxChars: 100 }, context), /denied/);
  assert.equal(f.requests(), 0);
  const tools = createWebTools({ authorize() {}, testing, search: { type: 'searxng', baseUrl: f.base } });
  const fetched = await tools.web_fetch.execute!({ signalIds: [id], url: f.base + '/redirect', mode: 'markdown', maxChars: 500 }, context) as { content: string; url: string };
  assert.ok(fetched && 'content' in fetched); assert.match(fetched.content, /Heading/); assert.doesNotMatch(fetched.content, /evil\(\)/); assert.match(fetched.content, /untrusted external data/); assert.match(fetched.url, /article$/);
  const results = await tools.web_search.execute!({ signalIds: [id], query: 'fixture', count: 5 }, context) as { content: string; count: number };
  assert.ok(results && 'content' in results); assert.match(results.content, /example.org\/page/); assert.equal(results.count, 2);assert.match(results.content,/"title":"bad"/);assert.match(results.content,/"urlAvailable":false/);assert.match(results.content,/did not provide a usable HTTP\(S\) source URL/);
  const unavailable = createWebTools({ authorize() {} });
  assert.deepEqual(await unavailable.web_search.execute!({ signalIds: [id], query: 'x', count: 5 }, context), { status: 'not configured',isError:true });
});


test('timeout and cancellation stop pending DNS and HTTP operations', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  await assert.rejects(requestWeb('http://example.test/', { timeoutMs: 20, testing: { resolver: () => new Promise(() => {}) } }), /timeout|timed out/i);
  const controller = new AbortController();
  const pending = requestWeb(f.base + '/slow', { signal: controller.signal, testing: { resolver, allowLoopbackForHostname: 'example.test' } });
  setTimeout(() => controller.abort(new Error('cancelled')), 20);
  await assert.rejects(pending, /abort|cancelled/i);
});


test('Brave mode sends its configured token only to the configured provider', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const tools = createWebTools({ authorize() {}, search: {type: 'brave', apiKey: 'synthetic-key'}, testing: { resolver, allowLoopbackForHostname: 'example.test', braveUrl: f.base + '/brave' } });
  const output = await tools.web_search.execute!({ signalIds: [id], query: 'fixture', count: 5 }, context) as {content:string; count:number};
  assert.equal(output.count, 1); assert.match(output.content, /Brave fixture/); assert.doesNotMatch(output.content, /synthetic-key/);
});


test('extracts markdown as text and reports response and output truncation', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const tools = createWebTools({ authorize() {}, testing: { resolver, allowLoopbackForHostname: 'example.test' } });
  const text = await tools.web_fetch.execute!({signalIds:[id],url:f.base+'/markdown',mode:'text',maxChars:1000}, context) as {content:string; contentType:string; bytesRead:number; textTruncated:boolean};
  assert.match(text.content, /Markdown title/); assert.match(text.content, /bold/); assert.doesNotMatch(text.content, /\*\*bold\*\*/); assert.equal(text.contentType, 'text/markdown'); assert.ok(text.bytesRead > 0); assert.equal(text.textTruncated, false);
  const clipped = await tools.web_fetch.execute!({signalIds:[id],url:f.base+'/large',mode:'text',maxChars:10}, context) as {content:string; textTruncated:boolean; responseTruncated:boolean};
  assert.equal(clipped.textTruncated, true); assert.equal(clipped.responseTruncated, false); assert.match(clipped.content, /x{10}/);
});


test('bounds compressed and decompressed bytes and supports gzip, deflate and br', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const testing = {resolver, allowLoopbackForHostname: 'example.test'};
  const bomb = await requestWeb(f.base+'/gzip', {testing, maxBytes: 64, maxCompressedBytes: 1024});
  assert.equal(bomb.body.length, 64); assert.equal(bomb.bytesRead, 64); assert.ok(bomb.wireBytes > 0); assert.equal(bomb.truncated, true);
  await assert.rejects(requestWeb(f.base+'/gzip', {testing, maxBytes: 50000, maxCompressedBytes: 10}), /wire size limit/);
  for (const path of ['/deflate', '/br']) assert.equal((await requestWeb(f.base+path, {testing})).body.toString(), 'fixture body');
  await assert.rejects(requestWeb(f.base+'/badgzip', {testing}));
  const tools = createWebTools({authorize(){}, testing, fetch:{maxBytes: 64, maxCompressedBytes:1024, maxChars: 30}});
  const result = await tools.web_fetch.execute!({signalIds:[id], url:f.base+'/gzip', mode:'text', maxChars:100}, context) as {responseTruncated:boolean; textTruncated:boolean; bytesRead:number};
  assert.equal(result.responseTruncated, true); assert.equal(result.textTruncated, true); assert.equal(result.bytesRead, 64);
});

test('tries other validated DNS addresses after a connection failure', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  let lookups = 0;
  const testing = {allowPrivate: true, resolver: async () => { lookups++; return [{address:'127.0.0.2', family:4}, {address:'127.0.0.1', family:4}]; }};
  const r = await requestWeb(f.base+'/large', {testing});
  assert.equal(r.status, 200); assert.equal(lookups, 1);
});

test('cache requires authorization, honours cancellation and host limits', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  let authorised = true; const testing = {resolver, allowLoopbackForHostname: 'example.test'};
  const tools = createWebTools({authorize(){ if (!authorised) throw Error('denied'); }, testing, fetch:{maxChars:7, cacheTtlMs:60000}});
  const input = {signalIds:[id],url:f.base+'/large',mode:'text' as const,maxChars:100};
  const a = await tools.web_fetch.execute!(input, context) as {cached:boolean; textTruncated:boolean};
  const b = await tools.web_fetch.execute!(input, context) as {cached:boolean};
  assert.equal(a.cached, false); assert.equal(a.textTruncated, true); assert.equal(b.cached, true); assert.equal(f.requests(),1);
  authorised = false; await assert.rejects(tools.web_fetch.execute!(input, context), /denied/); assert.equal(f.requests(),1);
  authorised = true; const aborter = new AbortController(); aborter.abort();
  await assert.rejects(tools.web_fetch.execute!(input, {abortSignal:aborter.signal} as never)); assert.equal(f.requests(),1);
  const uncached = createWebTools({authorize(){},testing,fetch:{cacheTtlMs:0}});
  await uncached.web_fetch.execute!(input, context); await uncached.web_fetch.execute!(input, context); assert.equal(f.requests(),3);
});

test('configuration schema accepts only safe provider choices and environment references', () => {
  assert.equal(webConfigurationSchema.safeParse({type:'none'}).success,true);
  assert.equal(webConfigurationSchema.safeParse({type:'brave', apiKeyEnv:'BRAVE_API_KEY'}).success,true);
  assert.equal(webConfigurationSchema.safeParse({type:'brave', apiKeyEnv:'literal-key'}).success,false);
  assert.equal(webConfigurationSchema.safeParse({type:'searxng', baseURL:'https://example.org/'}).success,true);
  assert.equal(webConfigurationSchema.safeParse({type:'searxng', baseURL:'http://user:secret@example.org/'}).success,false);
  assert.equal(webConfigurationSchema.safeParse({type:'none', allowPrivate:true}).success,false);
  assert.throws(() => createWebTools({authorize(){}, fetch:{maxBytes:10000001}}));
});


test('honours BOM, document charset and exact response byte limits', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const testing = {resolver,allowLoopbackForHostname:'example.test'};
  const tools = createWebTools({authorize(){}, testing});
  for (const route of ['/bom','/charset']) {
    const result = await tools.web_fetch.execute!({signalIds:[id],url:f.base+route,mode:'text',maxChars:1000}, context) as {content:string};
    assert.match(result.content, /caf\u00e9/);
  }
  const exact = await requestWeb(f.base+'/large', {testing,maxBytes:1000,maxCompressedBytes:1000});
  assert.equal(exact.bytesRead,1000); assert.equal(exact.truncated,false);
  await assert.rejects(requestWeb(f.base, {testing:{resolver: async () => Array.from({length:9}, () => ({address:'8.8.8.8',family:4}))}}), /Too many DNS/);
});

test('cache expires and keeps case-sensitive URL paths distinct', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const tools = createWebTools({authorize(){},testing:{resolver,allowLoopbackForHostname:'example.test'},fetch:{cacheTtlMs:20}});
  const input = {signalIds:[id],url:f.base+'/Article',mode:'text' as const,maxChars:100};
  await tools.web_fetch.execute!(input,context);
  await tools.web_fetch.execute!({...input,url:f.base+'/article'},context);
  assert.equal(f.requests(),2);
  await new Promise(resolve => setTimeout(resolve,30));
  const result = await tools.web_fetch.execute!(input,context) as {cached:boolean};
  assert.equal(result.cached,false); assert.equal(f.requests(),3);
});


test('never forwards provider credentials through redirects', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const tools = createWebTools({authorize(){},search:{type:'brave',apiKey:'synthetic-key'},testing:{resolver,allowLoopbackForHostname:'example.test',braveUrl:f.base+'/brave-redirect'}});
  await assert.rejects(tools.web_search.execute!({signalIds:[id],query:'fixture',count:5},context),/HTTP 302/);
  assert.equal(f.requests(),1);
});

test('fetch cache has a bounded least-recently-used size', async t => {
  const f = await fixture(); t.after(() => f.server.close());
  const tools = createWebTools({authorize(){},testing:{resolver,allowLoopbackForHostname:'example.test'}});
  const base = {signalIds:[id],mode:'text' as const,maxChars:10};
  for (let i=0;i<101;i++) await tools.web_fetch.execute!({...base,url:f.base+'/large?item='+i},context);
  const first = await tools.web_fetch.execute!({...base,url:f.base+'/large?item=0'},context) as {cached:boolean};
  assert.equal(first.cached,false); assert.equal(f.requests(),102);
});
