import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client, type ClientRequestInit } from '../src/client.js';
import { AppError } from '../src/domain.js';

const client = () => new Client('http://127.0.0.1:1', 'deadline-test-token');
const connectionFailed = (error: unknown) => error instanceof AppError && error.code === 'connection_failed' && error.status === 502;

test('request uses one 30s default deadline or the caller override, without forwarding timeoutMs', async t => {
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); return timeout(ms); });
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    assert.equal('timeoutMs' in init, false);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer deadline-test-token');
    assert.equal(init.redirect, 'error');
    return Response.json({ ok: true });
  });
  assert.deepEqual(await client().request('/ordinary'), { ok: true });
  const options: ClientRequestInit = { timeoutMs: 600_000 };
  assert.deepEqual(await client().request('/ordinary', options), { ok: true });
  assert.deepEqual(deadlines, [30_000, 600_000]);
});

test('invalid timeout values reject before issuing a request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648, '30', null]) {
    await assert.rejects(client().request('/ordinary', { timeoutMs } as ClientRequestInit),
      error => error instanceof AppError && error.code === 'invalid_request_timeout' && error.status === 400);
  }
  assert.equal(calls, 0);
});

test('body consumption remains inside the deadline', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => timeout(20));
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    const signal = init.signal!;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); }, { once: true });
      },
    }));
  });
  // AbortSignal.timeout does not itself keep Node alive when fetch is in memory.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(client().request('/ordinary', { timeoutMs: 20 }), connectionFailed);
  assert.equal(aborted, true);
});

test('caller abort remains effective before headers and while reading the body', async t => {
  let fetchResponse: (init: RequestInit) => Promise<Response>;
  t.mock.method(globalThis, 'fetch', (_input: unknown, init: RequestInit) => fetchResponse(init));
  for (const phase of ['headers', 'body'] as const) {
    const caller = new AbortController();
    const reason = new Error('caller stopped');
    let received: AbortSignal | null | undefined;
    fetchResponse = async (init: RequestInit) => {
      received = init.signal;
      if (phase === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          received!.addEventListener('abort', () => reject(received!.reason), { once: true });
          caller.abort(reason);
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          received!.addEventListener('abort', () => controller.error(received!.reason), { once: true });
          caller.abort(reason);
        },
      }));
    };
    await assert.rejects(client().request('/ordinary', { signal: caller.signal, timeoutMs: 600_000 }), connectionFailed);
    assert.equal(received!.aborted, true);
    assert.equal(received!.reason, reason);
  }
});

test('pre-aborted caller prevents fetch even if a fetch implementation ignores its signal', async t => {
  const caller = new AbortController();
  caller.abort();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  await assert.rejects(client().request('/ordinary', { signal: caller.signal, timeoutMs: 600_000 }), connectionFailed);
  assert.equal(calls, 0);
});

test('ordinary network, malformed JSON, HTTP and origin errors retain their public codes', async t => {
  let fetchResponse: () => Promise<Response> = async () => { throw new TypeError('offline'); };
  t.mock.method(globalThis, 'fetch', () => fetchResponse());
  await assert.rejects(client().request('/ordinary'), connectionFailed);
  fetchResponse = async () => new Response('not JSON');
  await assert.rejects(client().request('/ordinary'), error => error instanceof AppError && error.code === 'invalid_core_response' && error.status === 502);
  fetchResponse = async () => Response.json({ error: 'forbidden' }, { status: 403 });
  await assert.rejects(client().request('/ordinary'), error => error instanceof AppError && error.code === 'forbidden' && error.status === 403);
  await assert.rejects(client().request('http://example.invalid/ordinary'), error => error instanceof AppError && error.code === 'cross_origin_request_refused');
});

test('local HTTP: shortened default, longer override and caller abort cover headers and body', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  // Exercise the real default-selection path without waiting 30 seconds.
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); return timeout(ms === 30_000 ? 30 : ms); });
  const server = createServer((request, response) => {
    if (request.url === '/body') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"ok":');
    }
    const timer = setTimeout(() => {
      if (request.url === '/body') response.end('true}');
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); }
    }, 100);
    response.once('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const local = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'deadline-test-token');
  for (const route of ['/headers', '/body']) {
    await t.test(route, async () => {
      await assert.rejects(local.request(route), connectionFailed);
      assert.deepEqual(await local.request(route, { timeoutMs: 1_000 }), { ok: true });
      const caller = new AbortController();
      const timer = setTimeout(() => caller.abort(), 30);
      try { await assert.rejects(local.request(route, { timeoutMs: 1_000, signal: caller.signal }), connectionFailed); }
      finally { clearTimeout(timer); }
    });
  }
  assert.deepEqual(deadlines, [30_000, 1_000, 1_000, 30_000, 1_000, 1_000]);
});
