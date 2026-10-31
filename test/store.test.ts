import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { signalSchema } from '../src/domain.js';
import { readConfig } from '../src/config.js';
import { removeTemp } from './helpers.js';

test('receipt idempotency, output boundaries, cursors and interruption survive reopening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-store-'));
  let store = new Store(path.join(dir, 'records.sqlite'));
  try {
    const user = signalSchema.parse({ id: randomUUID(), source: 'test', type: 'user-message', content: 'First input' });
    const event = signalSchema.parse({ id: randomUUID(), source: 'watch', type: 'external-event', content: 'Event input' });
    assert.equal(store.receive(user).fresh, true);
    assert.equal(store.receive(user).fresh, false);
    assert.throws(() => store.receive({ ...user, content: 'Changed' }), /signal_id_conflict/);
    store.receive(event);
    store.accept(user.id, 'native-1', 'run-1', 'wake', 'main');
    store.accept(event.id, 'native-2', 'run-1', 'deliver', 'main');
    assert.throws(() => store.publish({ kind: 'message', runId: 'run-1', signalIds: [event.id], content: 'wrong destination', toolCallId: 'bad' }), /output_kind_not_allowed/);
    assert.throws(() => store.publish({ kind: 'artifact', runId: 'other-run', signalIds: [event.id], content: 'wrong run', toolCallId: 'bad' }), /run_not_active/);
    const message = store.publish({ kind: 'message', runId: 'run-1', signalIds: [user.id], content: 'Hello', toolCallId: 'call-1' });
    const artifact = store.publish({ kind: 'artifact', runId: 'run-1', signalIds: [event.id], content: '# Result', toolCallId: 'call-2' });
    assert.equal(store.publish({ kind: 'message', runId: 'run-1', signalIds: [user.id], content: 'Hello', toolCallId: 'call-1' }).id, message.id);
    assert.deepEqual(store.listOutputs({ after: message.seq }).map(o => o.id), [artifact.id]);
    assert.deepEqual(store.listOutputs({ after: 0, kind: 'message' }).map(o => o.id), [message.id]);
    store.close();
    store = new Store(path.join(dir, 'records.sqlite'));
    store.recoverInterrupted();
    assert.equal(store.getRun('run-1')?.status, 'interrupted');
    assert.equal(store.getSignal(user.id)?.status, 'interrupted');
    assert.equal(store.listOutputs({ after: 0 }).length, 2);
    assert.throws(() => store.publish({ kind: 'message', runId: 'run-1', signalIds: [user.id], content: 'Too late', toolCallId: 'late' }), /run_not_active/);
    const redirected = signalSchema.parse({ source: 'test', type: 'user-message', content: 'Save independently', output: { kind: 'artifact', contextId: 'reports' } });
    store.receive(redirected);
    store.accept(redirected.id, 'native-3', 'run-2', 'wake', 'main');
    const report = store.publish({ kind: 'artifact', runId: 'run-2', signalIds: [redirected.id], content: '# Report', toolCallId: 'call-3' });
    assert.equal(report.contextId, 'reports');
    store.finishRun('run-2', 'succeeded');
  } finally { store.close(); await removeTemp(dir); }
});

test('configuration validates explicit protocols without exposing supplied secrets', () => {
  const env = { ARONA_MODEL_PROTOCOL: 'responses', ARONA_MODEL_BASE_URL: 'http://127.0.0.1:9000/v1', ARONA_MODEL_ID: 'fixture-model', ARONA_MODEL_API_KEY: 'fixture-secret' };
  assert.equal(readConfig(env).model.protocol, 'responses');
  for (const bad of [{ ARONA_MODEL_PROTOCOL: 'automatic' }, { ARONA_PORT: 'abc' }, { ARONA_MODEL_BASE_URL: 'https://name:fixture-secret@example.invalid' }, { ARONA_MODEL_ID: '' }]) {
    assert.throws(() => readConfig({ ...env, ...bad }), (error: Error) => !error.message.includes('fixture-secret'));
  }
});
