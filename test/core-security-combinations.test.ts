import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createProvider, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { Core } from '../src/core.js';
import { Credentials } from '../src/credentials.js';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { Tasks } from '../src/tasks.js';
import { managementTools } from '../src/management.js';
import { signalSchema } from '../src/domain.js';
import { contextThinking, publicEventPage } from '../src/event-stream.js';
import { until, removeTemp } from './helpers.js';

function authorizationFixture() {
  const store = new Store(':memory:'); const runtime = new RuntimeStore(store.db);
  runtime.createContext({ id: 'main', name: 'Main', role: 'main' });
  for (const id of ['readonly', 'privileged', 'child']) runtime.createContext({ id, name: id, role: 'work' });
  const tasks = new Tasks(runtime, { manager: () => { throw Error('unexpected admission'); }, createContext: input => runtime.createContext(input), dispatch: async () => ({ runId: 'unused' }), wait: async () => 'complete', abort: () => {}, settle: async () => {}, changed: async () => {} });
  const core = Object.create(Core.prototype) as Core;
  Object.assign(core, { store, runtime, tasks, branchingContexts: new Set<string>(), activeRuns: new Map([['readonly', 'a-run'], ['privileged', 'b-run'], ['main', 'main-run']]), stopping: false, schedules: { isSignal: () => false } });
  const a = runtime.createTask({ title: 'A', content: 'Read only', contextId: 'readonly', returnContextId: 'main', sourceSignalIds: [], status: 'running', grants: { write: false, execute: false, mcp: false } });
  const b = runtime.createTask({ title: 'B', content: 'Privileged', contextId: 'privileged', returnContextId: 'main', sourceSignalIds: [], status: 'running', grants: { write: true, execute: true, mcp: true } });
  tasks.bindRun(a.id, 1, 'a-run'); tasks.bindRun(b.id, 1, 'b-run');
  function source(contextId: string, runId: string, taskId?: string) {
    const input = signalSchema.parse({ id: randomUUID(), contextId, type: taskId ? 'external-event' : 'user-message', source: 'fixture', content: 'fixture' });
    store.receive(input); store.accept(input.id, input.id, runId, 'deliver', contextId);
    if (taskId) runtime.setSetting('task-signal-owners', { ...runtime.setting('task-signal-owners', {}), [input.id]: taskId });
    return input.id;
  }
  const own = source('readonly', 'a-run', a.id); const main = source('main', 'main-run');
  const context = (threadId: string, runId: string) => ({ runId, agent: { threadId, toolCallId: randomUUID() } }) as unknown as ToolExecutionContext;
  let delivered = 0;
  Object.assign(core, { submitSignal: async (input: { id: string }) => { delivered++; return { id: input.id }; } });
  return { store, runtime, tasks, core, a, b, own, main, source, context, delivered: () => delivered };
}

test('worker message and control reject unrelated targets before dispatch or mutation', async () => {
  const f = authorizationFixture();
  try {
    const tools = managementTools(f.core, true); const context = f.context('readonly', 'a-run');
    await assert.rejects(tools.task_message.execute!({ signalIds: [f.own], id: f.b.id, content: 'Create a privileged child' }, context), /task_target_not_authorized/);
    await assert.rejects(tools.task_control.execute!({ signalIds: [f.own], id: f.b.id, revision: f.runtime.task(f.b.id).revision, action: 'cancel' }, context), /task_target_not_authorized/);
    assert.equal(f.delivered(), 0); assert.equal(f.runtime.task(f.b.id).status, 'running');
    assert.equal(Object.values(f.runtime.setting('task-signal-owners', {})).filter(id => id === f.b.id).length, 0);
  } finally { f.store.close(); }
});

test('verified parent supplements its child, while main and administrator controls remain available', async () => {
  const f = authorizationFixture();
  try {
    const child = f.runtime.createTask({ title: 'Child', content: 'Fixture', contextId: 'child', returnContextId: 'readonly', sourceSignalIds: [f.own], parentId: f.a.id, status: 'pending', grants: f.a.grants });
    const tools = managementTools(f.core, true);
    await tools.task_message.execute!({ signalIds: [f.own], id: child.id, content: 'Parent supplement' }, f.context('readonly', 'a-run'));
    await tools.task_control.execute!({ signalIds: [f.own], id: child.id, revision: f.runtime.task(child.id).revision, action: 'cancel' }, f.context('readonly', 'a-run'));
    assert.equal(f.runtime.task(child.id).status, 'cancelled');
    await tools.task_message.execute!({ signalIds: [f.main], id: f.b.id, content: 'Authorized main supplement' }, f.context('main', 'main-run'));
    await f.core.taskMessage(f.b.id, 'Administrator supplement', []);
    assert.equal(f.delivered(), 2);
    await managementTools(f.core, false).task_control.execute!({ signalIds: [f.main], id: f.b.id, revision: f.runtime.task(f.b.id).revision, action: 'cancel' }, f.context('main', 'main-run'));
    assert.equal(f.runtime.task(f.b.id).status, 'cancelled');
    await f.tasks.control(f.a.id, 'cancel', f.runtime.task(f.a.id).revision);
    assert.equal(f.runtime.task(f.a.id).status, 'cancelled');
  } finally { f.store.close(); }
});

test('worker source authorization rejects stale attempts and mixed task owners', async () => {
  const f = authorizationFixture();
  try {
    f.runtime.updateTask(f.a.id, { attempt: 2 });
    assert.throws(() => f.core.authorize([f.own], f.context('readonly', 'a-run')), /schedule_authorization_required/);
    f.runtime.updateTask(f.a.id, { attempt: 1 });
    const foreign = f.source('readonly', 'a-run', f.b.id);
    assert.throws(() => f.core.authorize([f.own, foreign], f.context('readonly', 'a-run')), /schedule_authorization_required/);
  } finally { f.store.close(); }
});

test('resolved environment and retired Pi credentials remain private redaction values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-secret-retirement-'));
  const name = 'SHITTIM_SECURITY_COMBINATION_SYNTHETIC_KEY'; const prior = process.env[name];
  try {
    const credentials = new Credentials(dir);
    process.env[name] = 'old synthetic environment key';
    assert.equal(credentials.get(name), 'old synthetic environment key');
    process.env[name] = 'new synthetic environment key';
    assert.ok(credentials.secretValues(1).includes('old synthetic environment key'));
    await credentials.providerStore.modify('fixture', async () => ({ type: 'api_key', key: 'old synthetic Pi key', env: { FIXTURE: 'old synthetic Pi environment' } }));
    await credentials.providerStore.read('fixture');
    await credentials.providerStore.modify('fixture', async () => ({ type: 'api_key', key: 'new synthetic Pi key' }));
    await credentials.providerStore.delete('fixture');
    for (const secret of ['old synthetic Pi key', 'old synthetic Pi environment', 'new synthetic Pi key']) assert.ok(credentials.secretValues(1).includes(secret), secret);
    assert.equal(JSON.stringify(credentials.list()).includes('synthetic'), false);
    assert.equal(fs.readFileSync(path.join(dir, 'provider-credentials.json'), 'utf8'), '{}');
  } finally { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; await removeTemp(dir); }
});

// Keep ordinary-prose checks independent of randomly generated credential prefixes.
const controlToken = 'Z-synthetic-control-token-0123456789';
type FixtureStreamPart = Awaited<ReturnType<MastraLanguageModelV2Mock['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;

function thinkingFrames(secret: string) {
  return [
    { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `ordinary prose ${secret} safe ending` } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'valid answer' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
  ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}

for (const source of ['environment', 'credential', 'startup', 'pi-environment', 'pi-credential', 'pi-derived', 'pi-auth-header'] as const) test(`native SDK captures ${source} key before rotation preceding the first reasoning delta`, { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-native-secret-'));
  const name = 'SHITTIM_SECURITY_COMBINATION_NATIVE_KEY'; const prior = process.env[name]; const originalFetch = globalThis.fetch;
  const stored = 'fixture-old-native-private-key';
  const old = (source === 'pi-derived' || source === 'pi-auth-header') ? Buffer.from(stored).toString('base64') : stored;
  const replacement = 'fixture-new-native-private-key';
  let entered!: () => void, release!: () => void; const requested = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let header = ''; let core: Core | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
    header = request.headers.get(source === 'pi-auth-header' ? 'x-auth' : 'x-api-key') ?? ''; entered(); await gate;
    return new Response(thinkingFrames(old), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    process.env[name] = old;
    const seed = { protocol: 'messages' as const, baseURL: 'https://fixture.invalid/v1', modelId: 'fixture', apiKey: old, authHeader: 'api-key' as const };
    core = await Core.open({ dataDir: dir, memoryEnabled: false, controlToken, ...(source === 'startup' ? { modelConfig: seed } : {}) });
    if (source.startsWith('pi-')) {
      const model: Model<'anthropic-messages'> = { id: 'fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      core.providerRegistry.setProvider(createProvider({ id: 'fixture', name: 'Fixture', baseUrl: model.baseUrl, models: [model], api: anthropicMessagesApi(), auth: { apiKey: {
        name: 'Fixture', resolve: async ({ ctx, credential }) => {
          const key = credential?.key ?? await ctx.env(name);
          return key ? { auth: source === 'pi-auth-header' ? { apiKey: 'fixture-placeholder', headers: { 'x-auth': Buffer.from(key).toString('base64') } } : { apiKey: source === 'pi-derived' ? Buffer.from(key).toString('base64') : key }, source: 'fixture' } : undefined;
        },
      } } }));
      if (source === 'pi-credential' || source === 'pi-derived' || source === 'pi-auth-header') await core.credentials.providerStore.modify('fixture', async () => ({ type: 'api_key', key: stored }));
      core.models.save({ id: 'default', name: 'Fixture', providerId: 'fixture', modelId: 'fixture' });
    } else if (source !== 'startup') {
      if (source === 'credential') core.credentials.set(name, old);
      core.models.save({ id: 'default', name: 'Fixture', protocol: 'messages', baseURL: 'https://fixture.invalid/v1', modelId: 'fixture', apiKeyEnv: name, thinking: {} });
    }
    const receipt = await core.submitMessage({ content: 'fixture' }); await requested; assert.equal(header, old);
    process.env[name] = replacement;
    if (source === 'startup') seed.apiKey = replacement;
    if (source === 'credential') core.credentials.set(name, replacement);
    if (source === 'pi-credential' || source === 'pi-derived' || source === 'pi-auth-header') await core.credentials.providerStore.modify('fixture', async () => ({ type: 'api_key', key: replacement }));
    release();
    await until(() => core!.store.getRun(receipt.runId!), run => run?.status !== 'running');
    const visible = contextThinking(core, 'main'); assert.equal(visible[0]?.text, 'ordinary prose [hidden] safe ending');
    const events = publicEventPage(core, 0, undefined, 1000); assert.doesNotMatch(JSON.stringify(events), new RegExp(old));
    core.credentials.remove(name); await core.credentials.providerStore.delete('fixture'); delete process.env[name];
    await core.close(); core = await Core.open({ dataDir: dir, memoryEnabled: false, controlToken });
    assert.deepEqual(contextThinking(core, 'main'), visible);
    assert.doesNotMatch(JSON.stringify(publicEventPage(core, 0, undefined, 1000)), new RegExp(old));
  } finally { release(); await core?.close(); globalThis.fetch = originalFetch; if (prior === undefined) delete process.env[name]; else process.env[name] = prior; await removeTemp(dir); }
});

for (const [prefix, tail, expectedTail] of [
  ['Z', 'safe ending', 'safe ending'],
  ['ng', 'safe ending', 'safe endi[hidden]'],
  ['Z', 'safely', 'safely'],
  ['ly', 'safely', 'safe[hidden]'],
] as const) test(`Core synthetic control prefix ${prefix} against ${tail} survives credential rotation and restart`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-control-prefix-'));
  const token = `${prefix}-synthetic-control-token-0123456789`;
  const old = 'fixture credential with spaces'; const replacement = 'replacement-private-credential';
  const streams: ReadableStreamDefaultController<FixtureStreamPart>[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream<FixtureStreamPart>({ start(controller) {
    streams.push(controller); controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'reasoning-start', id: 'reasoning' });
  } }) }) });
  let core = await Core.open({ dataDir: dir, model, memoryEnabled: false, controlToken: token });
  const finish = (controller: ReadableStreamDefaultController<FixtureStreamPart>) => {
    controller.enqueue({ type: 'reasoning-end', id: 'reasoning' });
    controller.enqueue({ type: 'text-start', id: 'answer' }); controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Synthetic completed response' }); controller.enqueue({ type: 'text-end', id: 'answer' });
    controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
  };
  try {
    assert.ok(core.redactionValues(1).includes(token));
    core.credentials.set('FIXTURE_PREFIX_SECRET', old);
    const first = await core.submitMessage({ content: 'Synthetic first reasoning turn' });
    await until(() => streams.length, count => count === 1);
    streams[0]!.enqueue({ type: 'reasoning-delta', id: 'reasoning', delta: 'ordinary prose fixture cred' });
    await until(() => contextThinking(core, 'main')[0]?.text, text => text === 'ordinary prose ');
    assert.equal(contextThinking(core, 'main')[0]?.text, 'ordinary prose ');
    core.credentials.set('FIXTURE_PREFIX_SECRET', replacement); core.credentials.remove('FIXTURE_PREFIX_SECRET');
    assert.ok(core.credentials.secretValues(1).includes(old));
    assert.ok(core.credentials.secretValues(1).includes(replacement));
    streams[0]!.enqueue({ type: 'reasoning-delta', id: 'reasoning', delta: `ential with spaces ${tail}` }); finish(streams[0]!);
    await until(() => core.store.getRun(first.runId!), run => run?.status !== 'running');
    assert.equal(core.store.getRun(first.runId!)?.status, 'succeeded');
    assert.equal(contextThinking(core, 'main')[0]?.text, `ordinary prose [hidden] ${expectedTail}`);
    // Complete control tokens and retired keys remain hidden, not just partial prefixes.
    const second = await core.submitMessage({ content: 'Synthetic second reasoning turn' });
    await until(() => streams.length, count => count === 2);
    streams[1]!.enqueue({ type: 'reasoning-delta', id: 'reasoning', delta: `full ${token} ${old} ${replacement} done!` }); finish(streams[1]!);
    await until(() => core.store.getRun(second.runId!), run => run?.status !== 'running');
    assert.equal(core.store.getRun(second.runId!)?.status, 'succeeded');
    await until(() => core.sessions.peek('main')?.run.isRunning(), running => !running);
    assert.equal(contextThinking(core, 'main')[1]?.text, 'full [hidden] [hidden] [hidden] done!');
    const visible = contextThinking(core, 'main'); const events = publicEventPage(core, 0, undefined, 1000);
    for (const secret of [token, old, replacement]) assert.equal(JSON.stringify(events).includes(secret), false);
    await core.close(); core = await Core.open({ dataDir: dir, model, memoryEnabled: false, controlToken });
    assert.equal(streams.length, 2, 'display recovery does not call the provider');
    assert.deepEqual(contextThinking(core, 'main'), visible);
    const replay = publicEventPage(core, 0, undefined, 1000);
    assert.deepEqual(replay.events, events.events);
    assert.equal(replay.hasMore, events.hasMore);
    // Native terminal bookkeeping may advance the source cursor without new public events.
    assert.ok(replay.nextCursor >= events.nextCursor);
  } finally { for (const controller of streams) { try { controller.close(); } catch {} } await core.close(); await removeTemp(dir); }
});

test('cancelling a paused task never aborts a newer unrelated run sharing its context', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-run-binding-'));
  let entered!: () => void, release!: () => void; const requested = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { entered(); await gate; return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close(); } }) }; } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  try {
    const context = core.createWorkContext({ name: 'Shared' });
    const a = core.runtime.createTask({ title: 'A', content: 'Fixture', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'running' });
    core.tasks.bindRun(a.id, 1, 'finished-a'); core.runtime.updateTask(a.id, { status: 'paused' });
    const b = await core.submitTask({ title: 'B', content: 'Fixture', contextId: context.id }, 'run-binding'); await requested;
    const bRun = core.runtime.task(b.id).runIds.at(-1)!;
    const cancelling = core.tasks.control(a.id, 'cancel', core.runtime.task(a.id).revision); release(); await cancelling;
    const done = await until(() => core.store.getRun(bRun), run => run?.status !== 'running');
    assert.equal(done?.status, 'succeeded'); assert.equal(core.runtime.task(a.id).status, 'cancelled');
  } finally { release(); await core.close(); await removeTemp(dir); }
});

for (const terminalAction of ['decline', 'cancel'] as const) test(`active approval waiting cannot restart, and ${terminalAction} remains usable`, { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-approval-restart-')); let turn = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] });
    if (turn++ === 0) c.enqueue({ type: 'tool-call', toolCallId: 'write-fixture', toolName: 'mastra_workspace_write_file', input: JSON.stringify({ path: 'must-not-exist.txt', content: 'fixture' }) });
    c.enqueue({ type: 'finish', finishReason: turn === 1 ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
  } }) }) });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  try {
    const task = await core.submitTask({ title: 'Waiting', content: 'Fixture' }, `waiting-${terminalAction}`);
    const approval = await until(() => core.runtime.approvals().find(row => row.taskId === task.id && row.status === 'pending'), Boolean);
    const before = core.runtime.task(task.id);
    for (const action of ['resume', 'retry'] as const) await assert.rejects(core.tasks.control(task.id, action, before.revision), /task_run_still_active/);
    assert.equal(core.runtime.task(task.id).attempt, before.attempt); assert.equal(core.runtime.approval(approval!.id).status, 'pending');
    if (terminalAction === 'decline') await core.approve(approval!.id, 'decline');
    else await core.tasks.control(task.id, 'cancel', core.runtime.task(task.id).revision);
    await until(() => core.runtime.approval(approval!.id).status, status => status !== 'pending');
    assert.equal(fs.existsSync(path.join(core.capabilities.root('default').path, 'must-not-exist.txt')), false);
  } finally { await core.close(); await removeTemp(dir); }
});

test('a child-result continuation without a report terminates unreported instead of waiting forever', async () => {
  const store = new Store(':memory:'); const runtime = new RuntimeStore(store.db); let changed = 0;
  const tasks = new Tasks(runtime, { manager: () => ({} as BackgroundTaskManager), createContext: input => runtime.createContext(input), dispatch: async () => ({ runId: 'unused' }), wait: async () => 'complete', abort: () => {}, settle: async () => {}, changed: async () => { changed++; } });
  try {
    const parent = runtime.createTask({ title: 'Parent', content: 'Fixture', contextId: 'parent', returnContextId: 'main', sourceSignalIds: [], status: 'running', attempt: 2 });
    const child = runtime.createTask({ title: 'Child', content: 'Fixture', contextId: 'child', returnContextId: 'parent', sourceSignalIds: [], parentId: parent.id, status: 'unreported' });
    runtime.setSetting(`task-child-continuation:${parent.id}`, JSON.stringify([{ id: child.id, attempt: child.attempt, status: child.status, report: child.report, runIds: child.runIds }]));
    tasks.bindRun(parent.id, 2, 'continuation'); await tasks.observeRun(parent.id, 2, 'continuation');
    assert.equal(runtime.task(parent.id).status, 'unreported');
    await tasks.observeRun(parent.id, 2, 'continuation'); assert.equal(changed, 1);
  } finally { store.close(); }
});

test('finished children trigger one continuation and an unreported parent cannot auto-run again', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-parent-continuation-'));
  let entered!: () => void, release!: () => void; const requested = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => {
    if (first) { first = false; entered(); await gate; }
    return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close(); } }) };
  } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  try {
    const context = core.createWorkContext({ name: 'Parent' }); const childContext = core.createWorkContext({ name: 'Child' });
    const parent = core.runtime.createTask({ title: 'Parent', content: 'Fixture', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'waiting' });
    const child = core.runtime.createTask({ title: 'Child', content: 'Fixture', contextId: childContext.id, returnContextId: context.id, sourceSignalIds: [], parentId: parent.id, status: 'running' });
    await core.taskMessage(parent.id, 'Continue fixture', []); await requested;
    const done = core.runtime.updateTask(child.id, { status: 'unreported' });
    const internal = core as unknown as { taskChanged: (task: typeof done) => Promise<void>; flushNotifications: () => Promise<void> };
    await internal.taskChanged(done); release();
    const settled = await until(() => core.runtime.task(parent.id), task => task.status === 'unreported', 7000);
    assert.equal(settled.attempt, 2); assert.equal(settled.runIds.length, 2);
    await internal.flushNotifications(); await internal.flushNotifications();
    assert.equal(core.runtime.task(parent.id).runIds.length, 2); assert.equal(core.runtime.task(parent.id).attempt, 2);
    await core.tasks.observeRun(parent.id, 1, settled.runIds[0]!);
    assert.equal(core.runtime.task(parent.id).status, 'unreported');
  } finally { release(); await core.close(); await removeTemp(dir); }
});

for (const representation of ['record', 'Headers', 'tuples'] as const) test(`provider auth captures all designated header values from ${representation} without enumerating ordinary headers or env`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-auth-headers-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  const secret = 'synthetic-derived-header-value'; const plain = 'synthetic-public-configuration';
  const envName = 'SHITTIM_AUTH_HEADERS_PUBLIC_FIXTURE'; const previous = process.env[envName]; process.env[envName] = plain;
  try {
    const headers = representation === 'record' ? { 'x-auth': secret, 'another-auth-field': `Basic ${secret}`, 'removed': null }
      : representation === 'Headers' ? new Headers({ 'x-auth': secret, 'another-auth-field': `Basic ${secret}` })
      : [['x-auth', secret], ['another-auth-field', `Basic ${secret}`]];
    core.providerRegistry.setProvider(createProvider({ id: 'header-fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid', models: [], api: anthropicMessagesApi(),
      headers: { 'x-public-config': plain }, auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { headers: headers as unknown as Record<string, string | null> }, source: 'fixture' }) } } }));
    await core.providerRegistry.getAuth('header-fixture');
    assert.ok(core.redactionValues(1).includes(secret));
    assert.ok(core.redactionValues(1).includes(`Basic ${secret}`));
    assert.equal(core.redactionValues(1).includes(plain), false);
    assert.equal(fs.existsSync(path.join(dir, 'provider-credentials.json')), false);
  } finally { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; await core.close(); await removeTemp(dir); }
});
