import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { until, removeTemp } from './helpers.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function response(calls: Array<{ name: string; input: Record<string, unknown> }> = []) {
  return { stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] });
    for (const call of calls) c.enqueue({ type: 'tool-call', toolCallId: 'fixture-side-effect', toolName: call.name, input: JSON.stringify(call.input) });
    c.enqueue({ type: 'finish', finishReason: calls.length ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    c.close();
  } }) };
}
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-admission-'));

test('cancel during native asynchronous stream preparation prevents any later model request', { timeout: 20_000 }, async () => {
  const dir = temporary(); const entered = deferred(); const gate = deferred(); const built = deferred(); let requests = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => { if (JSON.stringify(request.prompt).includes('previousRuns')) requests++; return response(); } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  const context = core.createWorkContext({ name: 'Startup' }); const session = await core.sessions.get(context);
  const original = session.machinery.buildStreamOptions.bind(session.machinery);
  session.machinery.buildStreamOptions = async (...args) => { entered.resolve(); await gate.promise; const options = await original(...args); built.resolve(); return options; };
  try {
    const task = await core.submitTask({ title: 'Cancelled startup', content: 'Synthetic', contextId: context.id }, 'cancel-startup');
    await entered.promise;
    assert.deepEqual(core.runtime.task(task.id).runIds, []);
    assert.equal((await core.tasks.control(task.id, 'cancel', core.runtime.task(task.id).revision)).status, 'cancelled');
    gate.resolve(); await built.promise;
    await until(() => core.store.getSignal(task.signalId), row => row?.status === 'rejected');
    assert.equal(requests, 0);
    assert.deepEqual(core.runtime.task(task.id).runIds, []);
    assert.equal(core.runtime.task(task.id).status, 'cancelled');
    assert.equal(core.runtime.events(context.id, 0, 500).some(row => row.kind === 'model_request'), false);
  } finally { gate.resolve(); session.machinery.buildStreamOptions = original; await core.close(); await removeTemp(dir); }
});

test('native old pause teardown timeout cannot overwrite a resumed attempt', { timeout: 25_000 }, async () => {
  const dir = temporary(); const entered = deferred(); const modelGate = deferred(); const hookEntered = deferred(); const hookGate = deferred(); let requests = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { requests++; entered.resolve(); if (requests === 1) await modelGate.promise; return response(); } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  const context = core.createWorkContext({ name: 'Stale pause' }); const session = await core.sessions.get(context);
  session.onBeforeAgentEnd(async () => { hookEntered.resolve(); await hookGate.promise; });
  const original = session.run.waitForTeardown.bind(session.run); let teardownWaits = 0;
  session.run.waitForTeardown = signal => { teardownWaits++; return original(signal); };
  let pausing: Promise<unknown> | undefined;
  try {
    const task = core.runtime.createTask({ title: 'Resume race', content: 'Synthetic', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'waiting' });
    await core.taskMessage(task.id, 'Synthetic continuation', []); await entered.promise;
    pausing = core.tasks.control(task.id, 'pause', core.runtime.task(task.id).revision); modelGate.resolve();
    await hookEntered.promise;
    await until(() => core.runtime.task(task.id), row => row.status === 'paused');
    await until(() => teardownWaits, count => count > 0);
    await core.tasks.control(task.id, 'resume', core.runtime.task(task.id).revision);
    assert.equal(core.runtime.task(task.id).attempt, 2);
    await pausing;
    assert.notEqual(core.runtime.task(task.id).status, 'interrupted');
    assert.equal(core.runtime.task(task.id).attempt, 2);
    hookGate.resolve();
    await until(() => core.runtime.task(task.id), row => row.status === 'unreported');
    assert.equal(core.runtime.task(task.id).runIds.length, 2);
    assert.equal(core.runtime.events(context.id, 0, 500).filter(row => row.kind === 'model_request').length, 2);
  } finally { modelGate.resolve(); hookGate.resolve(); await pausing?.catch(() => {}); session.run.waitForTeardown = original; await core.close(); await removeTemp(dir); }
});

for (const source of ['executor', 'supplement'] as const) test(`cancel aborts the precise native ${source} request before its delayed receipt is bound`, { timeout: 20_000 }, async () => {
  const dir = temporary(); const entered = deferred(); const releaseModel = deferred(); const receiptReady = deferred(); const receiptGate = deferred(); const aborted = deferred();
  let modelSignal: AbortSignal | undefined; let requests = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    if (JSON.stringify(request.prompt).includes(source === 'executor' ? 'previousRuns' : 'admission-supplement-fixture')) {
      requests++; modelSignal = request.abortSignal;
      const abort = () => { aborted.resolve(); releaseModel.resolve(); };
      modelSignal?.addEventListener('abort', abort, { once: true });
      if (modelSignal?.aborted) abort();
      entered.resolve(); await releaseModel.promise;
      return response([{ name: 'mastra_workspace_write_file', input: { path: 'late-side-effect.txt', content: 'Synthetic' } }]);
    }
    return response();
  } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  const context = core.createWorkContext({ name: 'Late receipt' }); const session = await core.sessions.get(context);
  const send = session.sendSignal.bind(session);
  session.sendSignal = (...args) => {
    const sent = send(...args);
    return { ...sent, accepted: sent.accepted.then(async value => { receiptReady.resolve(); await receiptGate.promise; return value; }) };
  };
  let supplement: Promise<unknown> | undefined;
  try {
    const task = source === 'executor' ? await core.submitTask({ title: 'Owned admission', content: 'Synthetic', contextId: context.id }, 'late-receipt')
      : core.runtime.createTask({ title: 'Owned admission', content: 'Synthetic', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'waiting' });
    if (source === 'supplement') { supplement = core.taskMessage(task.id, 'admission-supplement-fixture', []); void supplement.catch(() => {}); }
    await entered.promise; await receiptReady.promise;
    assert.deepEqual(core.runtime.task(task.id).runIds, []);
    assert.equal((await core.tasks.control(task.id, 'cancel', core.runtime.task(task.id).revision)).status, 'cancelled');
    assert.equal(modelSignal?.aborted, true); await aborted.promise;
    receiptGate.resolve();
    if (supplement) await assert.rejects(supplement, /task_attempt_changed/);
    else await until(() => core.store.getSignal(task.signalId), row => row?.status === 'rejected');
    await until(() => session.run.getRunId(), id => !id);
    assert.equal(requests, 1);
    assert.deepEqual(core.runtime.task(task.id).runIds, []);
    assert.equal(core.runtime.task(task.id).status, 'cancelled');
    assert.equal(core.runtime.tasks().length, 1);
    assert.equal(core.runtime.approvals().filter(row => row.contextId === context.id && row.status === 'pending').length, 0);
    assert.equal(core.runtime.events(context.id, 0, 500).some(row => row.kind === 'tool_start' || row.kind === 'delivery'), false);
    assert.equal(fs.existsSync(path.join(core.capabilities.root('default').path, 'late-side-effect.txt')), false);
  } finally { releaseModel.resolve(); receiptGate.resolve(); await supplement?.catch(() => {}); session.sendSignal = send; await core.close(); await removeTemp(dir); }
});

test('cancel of unbound delivery admission preserves another live task in the same native context', { timeout: 20_000 }, async () => {
  const dir = temporary(); const entered = deferred(); const modelGate = deferred(); const receiptReady = deferred(); const receiptGate = deferred();
  let peerSignal: AbortSignal | undefined;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    if (JSON.stringify(request.prompt).includes('Live peer')) { peerSignal = request.abortSignal; entered.resolve(); await modelGate.promise; }
    return response();
  } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  const context = core.createWorkContext({ name: 'Shared admission' }); const session = await core.sessions.get(context);
  const send = session.sendSignal.bind(session);
  try {
    const peer = await core.submitTask({ title: 'Live peer', content: 'Synthetic', contextId: context.id }, 'peer');
    await entered.promise;
    const runId = core.runtime.task(peer.id).runIds.at(-1)!;
    session.sendSignal = (...args) => {
      const sent = send(...args);
      return { ...sent, accepted: sent.accepted.then(async value => { receiptReady.resolve(); await receiptGate.promise; return value; }) };
    };
    const task = await core.submitTask({ title: 'Unbound delivery', content: 'Synthetic', contextId: context.id }, 'unbound-delivery');
    await receiptReady.promise;
    assert.deepEqual(core.runtime.task(task.id).runIds, []);
    await core.tasks.control(task.id, 'cancel', core.runtime.task(task.id).revision);
    assert.equal(peerSignal?.aborted, false);
    assert.equal(session.run.getRunId(), runId);
    receiptGate.resolve();
    await until(() => core.store.getSignal(task.signalId), row => row?.status === 'rejected');
    assert.equal(peerSignal?.aborted, false);
    assert.equal(core.runtime.task(peer.id).runIds.at(-1), runId);
    modelGate.resolve();
    await until(() => core.runtime.task(peer.id), row => row.status === 'unreported');
    assert.equal(core.store.getRun(runId)?.status, 'succeeded');
    assert.equal(core.runtime.task(task.id).status, 'cancelled');
    assert.deepEqual(core.runtime.task(task.id).runIds, []);
  } finally { receiptGate.resolve(); modelGate.resolve(); session.sendSignal = send; await core.close(); await removeTemp(dir); }
});

test('native async startup cancelled before admission issues no provider HTTP request', { timeout: 20_000 }, async () => {
  const dir = temporary(); const entered = deferred(); const gate = deferred(); const built = deferred(); const fetch = globalThis.fetch;
  let requests = 0;
  const frames = [
    { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Synthetic answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
    if ((await request.text()).includes('previousRuns')) requests++;
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
  };
  let core: Core | undefined;
  try {
    core = await Core.open({ dataDir: dir, memoryEnabled: false, modelConfig: { protocol: 'messages', baseURL: 'https://fixture.invalid/v1', modelId: 'fixture', apiKey: 'synthetic-offline-only-key', authHeader: 'api-key' } });
    const context = core.createWorkContext({ name: 'HTTP startup' }); const session = await core.sessions.get(context);
    const build = session.machinery.buildStreamOptions.bind(session.machinery);
    session.machinery.buildStreamOptions = async (...args) => { entered.resolve(); await gate.promise; const options = await build(...args); built.resolve(); return options; };
    try {
      const task = await core.submitTask({ title: 'HTTP cancellation', content: 'Synthetic', contextId: context.id }, 'http-cancel');
      await entered.promise;
      assert.deepEqual(core.runtime.task(task.id).runIds, []);
      await core.tasks.control(task.id, 'cancel', core.runtime.task(task.id).revision);
      gate.resolve(); await built.promise;
      await until(() => core!.store.getSignal(task.signalId), row => row?.status === 'rejected');
      assert.equal(core.runtime.events(context.id, 0, 500).some(row => row.kind === 'model_request'), false);
      await core.close(); assert.equal(requests, 0);
    } finally { gate.resolve(); session.machinery.buildStreamOptions = build; }
  } finally { gate.resolve(); await core?.close(); globalThis.fetch = fetch; await removeTemp(dir); }
});

test('late old teardown failure cannot abort the already running resumed native attempt', { timeout: 20_000 }, async () => {
  const dir = temporary(); const firstEntered = deferred(); const secondEntered = deferred(); const firstGate = deferred(); const secondGate = deferred();
  const hookEntered = deferred(); const hookGate = deferred(); const cleanupEntered = deferred(); const cleanupGate = deferred();
  let requests = 0; let nextSignal: AbortSignal | undefined;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt);
    if (prompt.includes('cleanup-race-first') || prompt.includes('previousRuns')) {
      requests++;
      if (requests === 1) { firstEntered.resolve(); await firstGate.promise; }
      else { nextSignal = request.abortSignal; secondEntered.resolve(); await secondGate.promise; }
    }
    return response();
  } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  const context = core.createWorkContext({ name: 'Cleanup ownership' }); const session = await core.sessions.get(context);
  let firstHook = true;
  session.onBeforeAgentEnd(async () => { if (firstHook) { firstHook = false; hookEntered.resolve(); await hookGate.promise; } });
  const internal = core as unknown as { settleTaskRun: (contextId: string, runId?: string) => Promise<void> };
  const settle = internal.settleTaskRun.bind(core); let firstWait = true;
  internal.settleTaskRun = async (...args) => {
    if (!firstWait) return settle(...args);
    firstWait = false; cleanupEntered.resolve();
    await settle(...args); await cleanupGate.promise; throw Error('fixture_old_teardown_timeout');
  };
  let pausing: Promise<unknown> | undefined;
  try {
    const task = core.runtime.createTask({ title: 'Cleanup race', content: 'Synthetic', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'waiting' });
    await core.taskMessage(task.id, 'cleanup-race-first', []); await firstEntered.promise;
    pausing = core.tasks.control(task.id, 'pause', core.runtime.task(task.id).revision); firstGate.resolve();
    await hookEntered.promise; await cleanupEntered.promise;
    await until(() => core.runtime.task(task.id), row => row.status === 'paused');
    hookGate.resolve(); await until(() => session.run.getRunId(), id => !id);
    await core.tasks.control(task.id, 'resume', core.runtime.task(task.id).revision); await secondEntered.promise;
    const runId = core.runtime.task(task.id).runIds.at(-1)!;
    assert.equal(core.runtime.task(task.id).attempt, 2);
    cleanupGate.resolve(); await pausing;
    assert.equal(core.runtime.task(task.id).status, 'running');
    assert.equal(nextSignal?.aborted, false);
    assert.equal(session.run.getRunId(), runId);
    secondGate.resolve(); await until(() => core.runtime.task(task.id), row => row.status === 'unreported');
    assert.equal(core.store.getRun(runId)?.status, 'succeeded');
  } finally { firstGate.resolve(); secondGate.resolve(); hookGate.resolve(); cleanupGate.resolve(); await pausing?.catch(() => {}); internal.settleTaskRun = settle; await core.close(); await removeTemp(dir); }
});
