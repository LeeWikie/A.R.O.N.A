import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Core } from '../src/core.js';
import { authenticatedApp as createApp } from './helpers.js';
import { finished, scriptedModel, until, removeTemp } from './helpers.js';

test('native Signals merge active inputs and publish separate destinations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prompts: string[] = [];
  const providerOptions: unknown[] = [];
  const fixture = scriptedModel({ gate, onCall: prompt => prompts.push(prompt), onOptions: options => providerOptions.push(options) });
  const core = await Core.open({ dataDir: dir, model: fixture.model,
    modelConfig: { protocol: 'responses', modelId: 'fixture', baseURL: 'http://example.invalid/v1', apiKey: 'fixture-only-key', authHeader: 'api-key' } });
  try {
    const user = { id: randomUUID(), source: 'terminal', type: 'user-message', content: 'Synthetic request' };
    const first = await core.submitSignal(user);
    await until(() => prompts.length, n => n > 0);
    const event = await core.submitSignal({ id: randomUUID(), source: 'fixture', type: 'external-event', content: 'Synthetic background event' });
    assert.equal(event.runId, first.runId);
    assert.equal(event.action, 'deliver');
    const duplicate = await core.submitSignal(user);
    assert.equal(duplicate.nativeSignalId, first.nativeSignalId);
    const duplicateBatch = await Promise.all(Array.from({ length: 6 }, () => core.submitSignal(user)));
    assert.ok(duplicateBatch.every(record => record.runId === first.runId && record.nativeSignalId === first.nativeSignalId));
    release();
    const run = await finished(core, first.runId!);
    assert.equal(run?.status, 'succeeded');
    assert.ok(prompts.slice(1).some(p => p.includes(event.id)), 'the later signal must reach a later model step');
    assert.ok(providerOptions.every(options => (options as { openai?: { store?: boolean } })?.openai?.store === false));
    const outputs = core.store.listOutputs({ after: 0 });
    assert.deepEqual(outputs.map(o => o.kind), ['message', 'artifact']);
    assert.deepEqual(outputs.map(o => o.signalIds), [[first.id], [event.id]]);
    assert.ok(outputs.every(o => !o.content.includes('Internal completion')));
    const history = await core.history('main', 0, 100);
    assert.ok(history.messages.length > 0);
    const app = createApp(core);
    assert.equal((await app.request('/signals', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await app.request('/outputs?after=-1')).status, 400);
    assert.equal((await app.request('/outputs?kind=other')).status, 400);
    assert.equal((await app.request('/runs/missing')).status, 404);
    assert.equal((await app.request('/signals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...user, content: 'different' }) })).status, 409);
  } finally { release(); await core.close(); }
  const reopened = await Core.open({ dataDir: dir, model: scriptedModel().model });
  try {
    assert.equal(reopened.store.listOutputs({ after: 0 }).length, 2);
    assert.ok((await reopened.history('main')).messages.length > 0);
  } finally { await reopened.close(); await removeTemp(dir); }
});

test('concurrent first arrivals share native ownership and a data directory has one owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-concurrent-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = scriptedModel({ gate });
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    await assert.rejects(Core.open({ dataDir: dir, model: fixture.model }), /data_directory_locked/);
    const records = await Promise.all(Array.from({ length: 4 }, (_, index) => core.submitSignal({
      source: 'fixture', type: 'user-message', content: `Concurrent input ${index}`,
    })));
    assert.equal(new Set(records.map(record => record.runId)).size, 1);
    release();
    assert.equal((await finished(core, records[0]!.runId!))?.status, 'succeeded');
    assert.equal(core.store.listOutputs({ after: 0 }).length, 4);
  } finally { release(); await core.close(); await removeTemp(dir); }
});

test('generation errors are failed runs, not successful receipts, and do not expose upstream details', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-error-'));
  const fixture = scriptedModel({ fail: true });
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    const receipt = await core.submitSignal({ source: 'test', type: 'user-message', content: 'Failure case' });
    assert.equal(receipt.status, 'accepted');
    const run = await finished(core, receipt.runId!);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.errorCode, 'model_execution_failed');
    assert.equal(core.store.listOutputs({ after: 0 }).length, 0);
    assert.equal(JSON.stringify(run).includes('fixture-secret'), false);
    assert.equal(JSON.stringify(await core.history('main')).includes('fixture-secret'), false);
  } finally { await core.close(); await removeTemp(dir); }
});
