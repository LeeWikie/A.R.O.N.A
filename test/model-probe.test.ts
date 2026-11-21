import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Credentials } from '../src/credentials.js';
import { modelCatalog, testModel } from '../src/model-probe.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';

const temporaryKey = 'synthetic-probe-temporary-key';
const storedKey = 'synthetic-probe-stored-key';
const noCredentials = { get: () => undefined };
const protocols = ['chat-completions', 'responses', 'messages'] as const;
type Protocol = typeof protocols[number];

async function mockServer(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => { res.destroy(error); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function requestBody(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}

function generated(protocol: Protocol, text = 'OK') {
  if (protocol === 'chat-completions') return { id: 'fixture-chat', model: 'manual-model', created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
  if (protocol === 'responses') return { id: 'fixture-response', model: 'manual-model', created_at: 1, status: 'completed',
    output: [{ type: 'message', id: 'fixture-message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } };
  return { id: 'fixture-message', type: 'message', model: 'manual-model', role: 'assistant',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 } };
}

for (const protocol of protocols) {
  test(`${protocol}: real catalog and SDK generation use the draft, not a saved profile`, async t => {
    const requests: { method?: string; url?: string; auth?: string; key?: string; version?: string; body?: Record<string, unknown> }[] = [];
    const baseURL = await mockServer(t, async (req, res) => {
      const record = { method: req.method, url: req.url, auth: req.headers.authorization,
        key: req.headers['x-api-key'] as string | undefined, version: req.headers['anthropic-version'] as string | undefined,
        ...(req.method === 'POST' ? { body: await requestBody(req) } : {}) };
      requests.push(record);
      if (req.method === 'GET') json(res, { data: [{ id: 'manual-model', display_name: 'Remote model', context_window: 8192, input_images: true, ignored_secret: temporaryKey }] });
      else json(res, generated(protocol));
    });
    const draft = { protocol, baseURL: `${baseURL}/`, apiKey: temporaryKey, modelId: 'manual-model' };
    assert.deepEqual(await modelCatalog(draft, noCredentials), { models: [{ id: 'manual-model', name: 'Remote model', contextWindow: 8192, inputImages: true }] });
    const before = Date.now();
    const result = await testModel(draft, noCredentials);
    assert.equal(result.ok, true, result.detail);
    assert.match(result.detail, /最小文本生成/);
    assert.match(result.detail, /16.*费用/);
    assert.ok(result.checkedAt >= before && result.checkedAt <= Date.now());
    assert.deepEqual(Object.keys(result).sort(), ['checkedAt', 'detail', 'ok']);
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.url!, /^\/v1\/models(?:\?|$)/);
    assert.equal(requests[1]!.url, `/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`);
    assert.equal(requests[1]!.body!.model, 'manual-model');
    assert.equal(requests[1]!.body!.stream, undefined);
    assert.equal(requests[1]!.body![protocol === 'responses' ? 'max_output_tokens' : 'max_tokens'], 16);
    if (protocol === 'responses') assert.equal(requests[1]!.body!.store, false);
    for (const request of requests) {
      if (protocol === 'messages') {
        assert.equal(request.key, temporaryKey); assert.equal(request.auth, undefined); assert.equal(request.version, '2023-06-01');
      } else { assert.equal(request.auth, `Bearer ${temporaryKey}`); assert.equal(request.key, undefined); }
    }
    assert.ok(!JSON.stringify(result).includes(temporaryKey));
  });

  test(`${protocol}: generation rejects remote errors, malformed bodies and empty output without leaking keys`, async t => {
    let mode = 'http-error';
    let count = 0;
    const baseURL = await mockServer(t, (_req, res) => {
      count++;
      if (mode === 'http-error') json(res, { error: { message: `do not echo ${temporaryKey}`, type: temporaryKey } }, 401);
      else if (mode === 'malformed') json(res, { key: temporaryKey });
      else if (mode === 'invalid-json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`not json ${temporaryKey}`); }
      else json(res, generated(protocol, ''));
    });
    for (mode of ['http-error', 'malformed', 'invalid-json', 'empty']) {
      const result = await testModel({ protocol, baseURL, apiKey: temporaryKey, modelId: 'manual-model' }, noCredentials);
      assert.equal(result.ok, false);
      assert.match(result.detail, /最小文本生成/);
      assert.ok(!JSON.stringify(result).includes(temporaryKey));
      assert.ok(!result.detail.includes('do not echo'));
    }
    assert.equal(count, 4);
  });
}

test('messages bearer authentication applies to catalog and generation', async t => {
  const baseURL = await mockServer(t, async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${temporaryKey}`);
    assert.equal(req.headers['x-api-key'], undefined);
    if (req.method === 'GET') json(res, { data: [{ id: 'manual-model' }] });
    else { await requestBody(req); json(res, generated('messages')); }
  });
  const draft = { protocol: 'messages', baseURL, apiKey: temporaryKey, modelId: 'manual-model', authHeader: 'bearer' };
  assert.equal((await modelCatalog(draft, noCredentials)).models.length, 1);
  assert.equal((await testModel(draft, noCredentials)).ok, true);
});

test('named credentials resolve from the existing vault and environment; temporary key takes precedence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-probe-credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentials = new Credentials(dir);
  credentials.set('PROBE_KEY', storedKey);
  const before = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
  let expected = storedKey;
  const baseURL = await mockServer(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${expected}`);
    json(res, req.method === 'GET' ? { data: [{ id: 'manual-model' }] } : generated('responses'));
  });
  const draft = { protocol: 'responses', baseURL, modelId: 'manual-model', apiKeyEnv: 'PROBE_KEY' };
  assert.equal((await modelCatalog(draft, credentials)).models.length, 1);
  assert.equal((await testModel(draft, credentials)).ok, true);
  expected = temporaryKey;
  assert.equal((await testModel({ ...draft, apiKey: temporaryKey }, credentials)).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), before);
  assert.equal(credentials.get('PROBE_KEY'), storedKey);
  const envName = 'SHITTIMCHEST_TEST_PROBE_NAMED_KEY';
  const previous = process.env[envName];
  process.env[envName] = storedKey;
  try {
    expected = storedKey;
    assert.equal((await testModel({ ...draft, apiKeyEnv: envName }, credentials)).ok, true);
  } finally { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; }
  await assert.rejects(testModel({ ...draft, apiKeyEnv: 'MISSING_PROBE_KEY' }, noCredentials), /model_credentials_unavailable/);
});

test('redirects never forward credentials for catalog or any generation protocol', async t => {
  let targetHits = 0;
  const target = await mockServer(t, (_req, res) => { targetHits++; json(res, {}); });
  let sourceHits = 0;
  const baseURL = await mockServer(t, (req, res) => {
    sourceHits++;
    assert.ok(req.headers.authorization || req.headers['x-api-key']);
    res.writeHead(307, { location: `${target}/collect`, 'content-type': 'text/plain' });
    res.end(temporaryKey);
  });
  for (const protocol of protocols) {
    const draft = { protocol, baseURL, modelId: 'manual-model', apiKey: temporaryKey };
    await assert.rejects(modelCatalog(draft, noCredentials), /model_probe_redirect_rejected/);
    const result = await testModel(draft, noCredentials);
    assert.equal(result.ok, false); assert.match(result.detail, /model_probe_redirect_rejected/);
    assert.ok(!result.detail.includes(temporaryKey));
  }
  assert.equal(sourceHits, 6);
  assert.equal(targetHits, 0);
});

test('unsafe addresses and invalid drafts fail before sending requests', async t => {
  let hits = 0;
  const baseURL = await mockServer(t, (_req, res) => { hits++; json(res, {}); });
  const draft = { protocol: 'responses', baseURL, modelId: 'manual-model', apiKey: temporaryKey };
  for (const badURL of [baseURL.replace('http://', 'http://user:password@'), `${baseURL}?key=${temporaryKey}`, `${baseURL}#secret`, `${baseURL}?`, `${baseURL}#`, 'file:///tmp/models', 'ftp://example.invalid/v1', 'not-a-url', `${baseURL}\\models`]) {
    await assert.rejects(modelCatalog({ ...draft, baseURL: badURL }, noCredentials), /invalid_model_probe/);
    await assert.rejects(testModel({ ...draft, baseURL: badURL }, noCredentials), /invalid_model_probe/);
  }
  for (const body of [{ ...draft, protocol: 'other' }, { ...draft, apiKey: 'bad\r\nkey' }, { ...draft, apiKeyEnv: '../secret' }, { ...draft, unexpected: true }]) {
    await assert.rejects(testModel(body, noCredentials), /invalid_model_probe/);
  }
  await assert.rejects(testModel({ ...draft, modelId: undefined }, noCredentials), /model_probe_model_required/);
  assert.equal(hits, 0);
});

test('empty or unsupported remote catalogs fail independently of manually entered model generation', async t => {
  let mode = 'empty';
  let generatedCount = 0;
  const baseURL = await mockServer(t, async (req, res) => {
    if (req.method === 'POST') { generatedCount++; await requestBody(req); json(res, generated('responses')); }
    else if (mode === 'empty') json(res, { data: [] });
    else if (mode === 'unsupported') json(res, { error: temporaryKey }, 404);
    else if (mode === 'missing-data') json(res, {});
    else json(res, { data: [{ id: temporaryKey }, { id: '' }, null] });
  });
  const draft = { protocol: 'responses', baseURL, apiKey: temporaryKey };
  for (mode of ['empty', 'unsupported', 'missing-data', 'invalid-models']) {
    await assert.rejects(modelCatalog(draft, noCredentials), error => {
      assert.ok(!String(error).includes(temporaryKey));
      return /model_catalog_empty|model_probe_http_404|model_catalog_invalid_response/.test(String(error));
    });
    assert.equal((await testModel({ ...draft, modelId: 'manual-model' }, noCredentials)).ok, true);
  }
  assert.equal(generatedCount, 4);
});

test('catalog filters unrecognized fields and echoed secrets, and follows bounded messages cursors', async t => {
  const cursors: (string | null)[] = [];
  const baseURL = await mockServer(t, (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    cursors.push(url.searchParams.get('after_id'));
    assert.equal(url.searchParams.get('limit'), '100');
    json(res, cursors.length === 1
      ? { data: [{ id: 'one', name: `echo ${temporaryKey}`, contextWindow: -1 }, { id: temporaryKey }], has_more: true, last_id: 'one' }
      : { data: [{ id: 'two', name: 'Two', input: ['text', 'image'], arbitrary: temporaryKey }], has_more: false });
  });
  assert.deepEqual(await modelCatalog({ protocol: 'messages', baseURL, apiKey: temporaryKey }, noCredentials), { models: [{ id: 'one' }, { id: 'two', name: 'Two', inputImages: true }] });
  assert.deepEqual(cursors, [null, 'one']);
});

test('response size limits cover declared and chunked bodies for catalogs and SDK generation', async t => {
  let mode = 'declared';
  const baseURL = await mockServer(t, (_req, res) => {
    if (mode === 'declared') {
      res.writeHead(200, { 'content-length': 1024 * 1024 + 1, 'content-type': 'application/json' });
      res.end('x');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('x'.repeat(600_000)); res.end('x'.repeat(600_000));
    }
  });
  for (mode of ['declared', 'chunked']) {
    const draft = { protocol: 'responses', baseURL, apiKey: temporaryKey, modelId: 'manual-model' };
    await assert.rejects(modelCatalog(draft, noCredentials), /model_probe_response_too_large/);
    const result = await testModel(draft, noCredentials);
    assert.equal(result.ok, false); assert.match(result.detail, /model_probe_response_too_large/);
  }
});

test('caller cancellation interrupts stalled response bodies', async t => {
  const baseURL = await mockServer(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  const draft = { protocol: 'responses', baseURL, apiKey: temporaryKey, modelId: 'manual-model' };
  for (const kind of ['catalog', 'test']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      if (kind === 'catalog') await assert.rejects(modelCatalog(draft, noCredentials, controller.signal), /model_probe_cancelled/);
      else { const result = await testModel(draft, noCredentials, controller.signal); assert.equal(result.ok, false); assert.match(result.detail, /model_probe_cancelled/); }
    } finally { clearTimeout(timer); }
  }
});

test('probe deadline stops a stalled upstream without a caller signal', async t => {
  const baseURL = await mockServer(t, () => {});
  const before = Date.now();
  await assert.rejects(modelCatalog({ protocol: 'responses', baseURL, apiKey: temporaryKey }, noCredentials), /model_probe_timeout/);
  assert.ok(Date.now() - before < 15_000);
});

test('HTTP middleware remains in force and probes never persist, activate, or replace existing state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-probe-http-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  t.after(async () => { await core.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let mode = 'ok';
  let hits = 0;
  const baseURL = await mockServer(t, async (req, res) => {
    hits++;
    if (mode === 'error') { json(res, { error: `private ${temporaryKey}` }, 401); return; }
    if (req.method === 'GET') json(res, { data: [{ id: 'manual-model' }] });
    else { await requestBody(req); json(res, generated('responses')); }
  });
  core.credentials.set('PROBE_KEY', storedKey);
  core.models.save({ id: 'existing', name: 'Existing', protocol: 'responses', baseURL, modelId: 'existing-model', apiKeyEnv: 'PROBE_KEY' });
  const app = createApp(core);
  const request = (route: string, body?: unknown, headers: Record<string, string> = {}) => app.request(route, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${core.controlToken}`, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const configurationBefore = await (await request('/configuration')).json();
  const activeBefore = await (await request('/contexts/main/model')).json();
  const credentialsBefore = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
  const draft = { protocol: 'responses', baseURL, apiKey: temporaryKey, modelId: 'manual-model' };
  for (const route of ['/models/catalog', '/models/test']) {
    assert.equal((await app.request(route, { method: 'POST', body: JSON.stringify(draft) })).status, 401);
    assert.equal((await request(route, draft, { Origin: 'https://example.invalid' })).status, 403);
  }
  assert.equal(hits, 0);
  for (mode of ['ok', 'error']) {
    const catalog = await request('/models/catalog', draft);
    assert.equal(catalog.status, mode === 'ok' ? 200 : 502);
    assert.ok(!(await catalog.text()).includes(temporaryKey));
    const tested = await request('/models/test', draft);
    assert.equal(tested.status, 200);
    const result = await tested.json() as { ok: boolean };
    assert.equal(result.ok, mode === 'ok');
    assert.ok(!JSON.stringify(result).includes(temporaryKey));
  }
  const malformed = await app.request('/models/test', { method: 'POST', headers: { authorization: `Bearer ${core.controlToken}`, 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_json' });
  assert.deepEqual(await (await request('/configuration')).json(), configurationBefore);
  assert.deepEqual(await (await request('/contexts/main/model')).json(), activeBefore);
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), credentialsBefore);
  for (const item of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (item.isFile()) assert.ok(!fs.readFileSync(path.join(item.parentPath, item.name)).includes(Buffer.from(temporaryKey)), `temporary key persisted in ${item.name}`);
  }
});
