import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '../src/client.js';

test('ordinary snapshots retain the original route while structured tool content requires an explicit option and advertised capability', async () => {
  const original = globalThis.fetch, routes: string[] = []; let supportsContent = true;
  globalThis.fetch = async input => {
    const url = new URL(String(input)); routes.push(url.pathname + url.search);
    return new Response(JSON.stringify(url.pathname === '/protocol' ? { capabilities: supportsContent ? ['tool-result-content'] : ['snapshot'] } : { toolActivity: url.searchParams.has('toolResultContent') ? [{ resultContent: [{ type: 'image', mimeType: 'image/png', data: 'synthetic-image' }] }] : [{ output: { text: 'summary' } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = new Client('http://127.0.0.1:4111', 'synthetic-token');
    await client.snapshot('main'); assert.deepEqual(routes, ['/protocol','/snapshot?contextId=main']); routes.length = 0;
    const full = await client.snapshot('main', undefined, { toolResultContent: true }); assert.deepEqual(routes, ['/protocol', '/snapshot?contextId=main&toolResultContent=1']); assert.equal((full.toolActivity?.[0] as { resultContent: Array<{ data: string }> }).resultContent[0]!.data, 'synthetic-image'); routes.length = 0;
    supportsContent = false; const legacy = await client.snapshot('main', undefined, { toolResultContent: true }); assert.deepEqual(routes, ['/protocol', '/snapshot?contextId=main']); assert.equal('resultContent' in (legacy.toolActivity?.[0] as object), false);
  } finally { globalThis.fetch = original; }
});

test('snapshot tool capability discovery observes cancellation before either request can be sent', async () => {
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('unexpected request'); };
  try { const controller = new AbortController(); controller.abort(); await assert.rejects(new Client('http://127.0.0.1:4111', 'synthetic-token').snapshot('main', controller.signal, { toolResultContent: true })); assert.equal(requests, 0); }
  finally { globalThis.fetch = original; }
});
