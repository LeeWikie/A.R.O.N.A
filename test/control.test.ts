import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { signalSchema } from '../src/domain.js';
import { MemoryFiles } from '../src/memory/files.js';
import { removeTemp, scriptedModel } from './helpers.js';

function request(core: Core, route: string, body?: unknown, method = 'POST') {
  return createApp(core).request(route, { method, headers: { authorization: `Bearer ${core.controlToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('the control plane starts without a model and protects secrets, origins and configuration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-control-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    const app = createApp(core);
    assert.equal((await app.request('/health')).status, 200);
    assert.equal((await app.request('/configuration')).status, 401);
    assert.equal((await app.request('/tasks', { headers: { Authorization: `Bearer ${core.controlToken}`, Origin: 'https://example.invalid' } })).status, 403);
    const secret = 'fixture-private-value-not-for-responses';
    const saved = await request(core, '/credentials/FIXTURE_KEY', { value: secret }, 'PUT');
    assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(secret));
    assert.equal((await request(core, '/configuration/model', { id: 'default', name: 'Fixture', protocol: 'chat-completions', baseURL: 'http://example.invalid/v1', modelId: 'fixture', apiKeyEnv: 'FIXTURE_KEY', thinking: { off: { reasoningEffort: 'none' } } })).status, 200);
    const config = await request(core, '/configuration', undefined, 'GET');
    assert.ok(!(await config.text()).includes(secret));
    assert.equal(core.credentials.get('FIXTURE_KEY'), secret);
    assert.equal((await request(core, '/credentials', undefined, 'GET')).status, 200);
    assert.equal((await request(core, '/configuration/model', { id: 'bad', apiKey: secret })).status, 400);
    assert.equal((await request(core, '/contexts/main/model', { profileId: 'missing' })).status, 404);
    assert.equal((await request(core, '/models', undefined, 'GET')).status, 200);
  } finally { await core.close(); await removeTemp(dir); }
});

test('new event inputs have no mandatory artifact while legacy bodies retain their serialized identity', async () => {
  const legacy = signalSchema.parse({ source: 'fixture', type: 'external-event', content: 'event' });
  const modern = signalSchema.parse({ version: 2, source: 'fixture', type: 'external-event', content: 'event' });
  assert.equal(legacy.output.kind, 'artifact'); assert.equal(modern.output.kind, 'none');
  assert.equal('version' in legacy, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-model-redaction-'));
  const core = await Core.open({ dataDir: dir, model: scriptedModel().model, modelConfig: { protocol: 'responses', baseURL: 'http://example.invalid/v1', modelId: 'fixture', apiKey: 'fixture-seed-secret', authHeader: 'api-key' } });
  try { assert.ok(!JSON.stringify(core.models.list()).includes('fixture-seed-secret')); }
  finally { await core.close(); await removeTemp(dir); }
});

test('memory tools reject path escape, links, ambiguous edits and root replacement', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-files-'));
  const root = path.join(dir, 'memory'); const files = new MemoryFiles(root);
  try {
    files.write('topics/a.md', 'original');
    for (const name of ['../outside', '/absolute', 'x/../../outside', 'a:stream', 'aux.md', 'bad. ', 'x//y']) assert.throws(() => files.resolve(name));
    fs.writeFileSync(path.join(dir, 'outside'), 'outside');
    try {
      fs.linkSync(path.join(dir, 'outside'), path.join(root, 'linked.md'));
      assert.throws(() => files.resolve('linked.md'), /memory_link_refused/);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') t.diagnostic('hard-link creation unavailable'); else throw error; }
    fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
    assert.throws(() => files.write('new.md', 'bad'), /memory_root_changed/);
    assert.equal(fs.readFileSync(path.join(dir, 'outside'), 'utf8'), 'outside');
  } finally { await removeTemp(dir); }
});

test('model options reject unknown levels, options and unsafe response overrides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-model-options-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    const base = { id: 'fixture', name: 'Fixture', protocol: 'responses', baseURL: 'http://example.invalid/v1', modelId: 'fixture', apiKeyEnv: 'FIXTURE_KEY' };
    for (const thinking of [{ turbo: { reasoningEffort: 'high' } }, { high: { reasoningEffort: 'nonsense' } }, { high: { store: true } }, { high: { include: [] } }, { high: { reasoningEffort: 'high', unknown: 'value' } }]) {
      assert.throws(() => core.models.save({ ...base, thinking }), /invalid_model_profile/);
    }
    core.models.save({ ...base, thinking: { high: { reasoningEffort: 'high' } } });
    assert.deepEqual(core.models.options('fixture', 'high').providerOptions, { openai: { store: false, include: ['reasoning.encrypted_content'], reasoningEffort: 'high' } });
    assert.throws(() => core.models.validateThinking('fixture', 'bogus' as never), /thinking_level_not_supported/);
    assert.throws(() => core.models.save({ ...base, protocol: 'messages', thinking: { high: { reasoningEffort: 'high' } } }), /invalid_model_profile/);
    core.models.save({ ...base, protocol: 'messages', thinking: { high: { thinking: { type: 'enabled', budgetTokens: 1024 }, effort: 'high' } } });
    assert.deepEqual(core.models.options('fixture', 'high').providerOptions, { anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 }, effort: 'high' } });
  } finally { await core.close(); await removeTemp(dir); }
});

test('credential names never resolve inherited object properties', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-credentials-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    assert.equal(core.credentials.get('constructor'), undefined);
    core.credentials.set('__proto__', 'fixture-secret');
    assert.equal(core.credentials.get('__proto__'), 'fixture-secret');
    assert.ok(!JSON.stringify(core.credentials.list()).includes('fixture-secret'));
    core.credentials.remove('__proto__');
    assert.equal(core.credentials.get('__proto__'), undefined);
    assert.throws(() => core.credentials.get('bad-name'), /invalid_credential/);
  } finally { await core.close(); await removeTemp(dir); }
});

test('model profiles reject unknown or protocol-incompatible thinking fields and preserve response defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-options-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    const base = { id: 'fixture', name: 'Fixture', protocol: 'responses', baseURL: 'http://example.invalid/v1', modelId: 'synthetic', apiKeyEnv: 'FIXTURE_KEY' };
    for (const thinking of [ { mystery: { reasoningEffort: 'low' } }, { low: { reasoningEffort: 1 } }, { low: { reasoningEffort: 'low', store: true } }, { low: { secret: 'fixture-secret' } }, { low: {} } ]) {
      assert.throws(() => core.models.save({ ...base, thinking }), /invalid_model_profile/);
    }
    core.models.save({ ...base, thinking: { low: { reasoningEffort: 'low' } } });
    assert.deepEqual(core.models.options('fixture', 'low'), { providerOptions: { openai: { store: false, include: ['reasoning.encrypted_content'], reasoningEffort: 'low' } } });
    assert.throws(() => core.models.options('missing'), /model_profile_not_found/);
    assert.throws(() => core.models.save({ ...base, protocol: 'messages', thinking: { low: { reasoningEffort: 'low' } } }), /invalid_model_profile/);
    core.models.save({ ...base, protocol: 'messages', thinking: { low: { thinking: { type: 'enabled', budgetTokens: 1024 }, effort: 'low' } } });
    assert.deepEqual(core.models.options('fixture', 'low'), { providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 }, effort: 'low' } } });
    assert.throws(() => core.models.save({ ...base, thinking: { low: { reasoningEffort: 'low' } }, unknown: true }), /invalid_model_profile/);
  } finally { await core.close(); await removeTemp(dir); }
});

test('credential names cannot resolve prototype properties and reserved names round-trip safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-credentials-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    assert.equal(core.credentials.get('__proto__'), undefined);
    core.credentials.set('__proto__', 'synthetic-value');
    assert.equal(core.credentials.get('__proto__'), 'synthetic-value');
    assert.ok(core.credentials.list().some(x => x.name === '__proto__'));
    core.credentials.remove('__proto__'); assert.equal(core.credentials.get('__proto__'), undefined);
  } finally { await core.close(); await removeTemp(dir); }
});
