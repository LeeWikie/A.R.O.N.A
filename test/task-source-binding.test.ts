import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { z } from 'zod';
import { Core } from '../src/core.js';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { Tasks } from '../src/tasks.js';
import { managementTools } from '../src/management.js';
import {SessionGraph} from '../src/session-graph.js';
import { signalSchema, type SignalRecord } from '../src/domain.js';
import { finished, until, removeTemp } from './helpers.js';

const actualId = '81639939-bfbc-47e6-88b5-99c758523216';
const malformedId = '81639939-bfbc-47e6-88b5-99ef378523216';
const childInput = { title: 'Child', content: 'Synthetic task' };

function fixture(mainWorkspaceId='default') {
  const store = new Store(':memory:'); const runtime = new RuntimeStore(store.db);
  runtime.createContext({ id: 'main', name: 'Main', role: 'main',workspaceId:mainWorkspaceId });
  runtime.createContext({ id: 'shared', name: 'Shared', role: 'work', workspaceId: 'custom' });
  runtime.createContext({ id: 'memory', name: 'Memory', role: 'memory' });
  const tasks = new Tasks(runtime, { manager: () => { throw Error('unexpected admission'); }, createContext: input => runtime.createContext(input), dispatch: async () => ({ runId: 'unused' }), wait: async () => 'complete', abort: () => {}, settle: async () => {}, changed: async () => {} });
  Object.assign(tasks, { start: async (id: string) => runtime.task(id) });
  const core = Object.create(Core.prototype) as Core;
  const activeRuns = new Map([['main', 'main-run'], ['shared', 'shared-run'], ['memory', 'memory-run']]);
  Object.assign(core, { store, runtime, tasks, sessionGraph:new SessionGraph(store.db),branchingContexts: new Set<string>(), activeRuns, stopping: false, capabilities: { mcpKeys: () => [] }, schedules: { isSignal: () => false } });
  const a = runtime.createTask({ title: 'A', content: 'Privileged', contextId: 'shared', returnContextId: 'main', sourceSignalIds: [], status: 'running', grants: { write: true, execute: true, mcp: true }, mcpKeys: ['privileged-server'] });
  const b = runtime.createTask({ title: 'B', content: 'Unprivileged', contextId: 'shared', returnContextId: 'main', sourceSignalIds: [], status: 'running', grants: { write: false, execute: false, mcp: false } });
  tasks.bindRun(a.id, 1, 'shared-run'); tasks.bindRun(b.id, 1, 'shared-run');
  function source(options: { owner?: string; contextId?: string; runId?: string; type?: 'user-message' | 'external-event'; status?: SignalRecord['status']; id?: string; content?: string } = {}) {
    const contextId = options.contextId ?? (options.owner ? 'shared' : 'main');
    const runId = options.runId ?? activeRuns.get(contextId)!;
    const input = signalSchema.parse({ id: options.id ?? randomUUID(), contextId, type: options.type ?? (options.owner ? 'external-event' : 'user-message'), source: 'fixture', content: options.content ?? 'Synthetic input' });
    store.receive(input); store.accept(input.id, randomUUID(), runId, 'deliver', contextId);
    if (options.status && options.status !== 'accepted') store.db.prepare('UPDATE signals SET status=? WHERE id=?').run(options.status, input.id);
    if (options.owner) {
      runtime.setSetting('task-signal-owners', { ...runtime.setting('task-signal-owners', {}), [input.id]: options.owner });
      runtime.setSetting('task-signal-attempts', { ...runtime.setting('task-signal-attempts', {}), [input.id]: 1 });
    }
    return input.id;
  }
  const context = (threadId = 'shared', runId = activeRuns.get(threadId)!, extra = {}) => ({ runId, agent: { threadId, toolCallId: randomUUID() }, ...extra }) as unknown as ToolExecutionContext;
  const tool = managementTools(core, true).task_create;
  const invoke = async (input: Record<string, unknown>, ctx = context()) => {
    const result = await tool.execute!({ task: childInput, ...input } as Parameters<NonNullable<typeof tool.execute>>[0], ctx);
    if (result && typeof result === 'object' && 'error' in result && result.error) throw Error(JSON.stringify(result));
    return result;
  };
  return { core, store, runtime, tasks, a, b, source, context, invoke, activeRuns };
}

test('omission binds all accepted main user inputs, never native IDs or IDs quoted in content', async () => {
  const f = fixture('custom');
  try {
    const first = f.source({ id: actualId, content: `quoted source ${malformedId} ${randomUUID()}` });
    const second = f.source(); f.source({ runId: 'old-run' });
    await f.invoke({}, f.context('main'));
    const child = f.runtime.tasks().find(task => task.title === 'Child')!;
    assert.ok(child, 'omitted sources must create a task');
    assert.deepEqual(new Set(child.sourceSignalIds), new Set([first, second]));
    assert.equal(child.parentId, null); assert.deepEqual(child.grants, { write: false, execute: false, mcp: false });
    assert.equal(child.returnContextId, 'main');
    assert.equal(f.runtime.context(child.contextId)?.workspaceId,'custom','delegation keeps the originating conversation workspace');
    for (const id of child.sourceSignalIds) assert.equal(f.store.getSignal(id)?.runId, 'main-run');
    assert.deepEqual(f.runtime.task(child.id).sourceSignalIds, child.sourceSignalIds);
  } finally { f.store.close(); }
});

for (const mode of ['omitted', 'null'] as const) test(`${mode} binds a worker input and same-owner supplement with parent and workspace inheritance`, async () => {
  const f = fixture();
  try {
    const primary = f.source({ owner: f.b.id }); const supplement = f.source({ owner: f.b.id, type: 'user-message' });
    await f.invoke(mode === 'null' ? { signalIds: null } : {});
    const child = f.runtime.tasks().find(task => task.title === 'Child')!;
    assert.ok(child); assert.deepEqual(new Set(child.sourceSignalIds), new Set([primary, supplement]));
    assert.equal(child.parentId, f.b.id); assert.deepEqual(child.grants, f.b.grants);
    assert.deepEqual(child.mcpKeys, []); assert.deepEqual(child.toolGrants, []);
    assert.equal(f.runtime.context(child.contextId)?.workspaceId, 'custom');
    assert.equal(child.returnContextId, 'shared');
  } finally { f.store.close(); }
});

test('shared high and low privilege owners reject omission; explicit subset inherits only its owner', async () => {
  const f = fixture();
  try {
    f.source({ owner: f.a.id }); const low = f.source({ owner: f.b.id });
    await assert.rejects(f.invoke({}), /schedule_authorization_required/);
    await assert.rejects(f.invoke({ signalIds: null }), /schedule_authorization_required/);
    await f.invoke({ signalIds: [low] });
    const child = f.runtime.tasks().find(task => task.title === 'Child')!;
    assert.equal(child.parentId, f.b.id); assert.deepEqual(child.sourceSignalIds, [low]);
    assert.deepEqual(child.grants, f.b.grants); assert.deepEqual(child.mcpKeys, []);
  } finally { f.store.close(); }
});

for (const contamination of ['unowned-worker', 'external-main', 'root-and-owner', 'foreign-context'] as const) test(`automatic binding rejects ${contamination} instead of selecting a trusted first source`, async () => {
  const f = fixture();
  try {
    let ctx = f.context();
    if (contamination === 'unowned-worker') { f.source({ owner: f.b.id }); f.source({ contextId: 'shared' }); }
    if (contamination === 'external-main') { ctx = f.context('main'); f.source(); f.source({ type: 'external-event' }); }
    if (contamination === 'root-and-owner') {
      ctx = f.context('main'); f.source();
      const owner = f.runtime.createTask({ title: 'Main-owned', content: 'Fixture', contextId: 'main', returnContextId: 'main', sourceSignalIds: [], status: 'running' });
      f.tasks.bindRun(owner.id, 1, 'main-run'); f.source({ owner: owner.id, contextId: 'main' });
    }
    if (contamination === 'foreign-context') { f.source({ owner: f.b.id }); f.source({ contextId: 'main', runId: 'shared-run' }); }
    await assert.rejects(f.invoke({}, ctx), /schedule_authorization_required/);
    assert.equal(f.runtime.tasks().filter(task => task.title === 'Child').length, 0);
  } finally { f.store.close(); }
});

for (const state of ['empty', 'old-run', 'rejected', 'cancelled', 'interrupted', 'stale-attempt', 'stale-source-attempt', 'cancelled-owner', 'foreign-tool-run', 'memory-role', 'aborted'] as const) test(`automatic binding cannot authorize ${state}`, async () => {
  const f = fixture();
  try {
    let ctx = f.context();
    if (state === 'old-run') f.source({ owner: f.b.id, runId: 'old-run' });
    else if (['rejected', 'cancelled', 'interrupted'].includes(state)) f.source({ owner: f.b.id, status: state as SignalRecord['status'] });
    else if (state === 'memory-role') { f.source({ contextId: 'memory' }); ctx = f.context('memory'); }
    else if (state !== 'empty') {
      const id = f.source({ owner: f.b.id });
      if (state === 'stale-attempt') f.runtime.updateTask(f.b.id, { attempt: 2 });
      if (state === 'stale-source-attempt') f.runtime.setSetting('task-signal-attempts', { [id]: 2 });
      if (state === 'cancelled-owner') f.runtime.updateTask(f.b.id, { status: 'cancelled' });
      if (state === 'foreign-tool-run') ctx = f.context('shared', 'old-run');
      if (state === 'aborted') ctx = f.context('shared', 'shared-run', { abortSignal: AbortSignal.abort() });
    }
    await assert.rejects(f.invoke({}, ctx));
    assert.equal(f.runtime.tasks().filter(task => task.title === 'Child').length, 0);
  } finally { f.store.close(); }
});

test('automatic source selection never resolves a conflicting parent or workspace', async () => {
  const f = fixture();
  try {
    f.source({ owner: f.b.id });
    await assert.rejects(f.invoke({ task: { ...childInput, parentId: f.a.id } }), /task_parent_not_authorized/);
    f.runtime.createContext({ id: 'foreign', name: 'Foreign', role: 'work', workspaceId: 'other' });
    await assert.rejects(f.invoke({ task: { ...childInput, contextId: 'foreign' } }), /child_workspace_not_authorized/);
  } finally { f.store.close(); }
});

test('other management tools still require explicit sources and manual submission stays independent', async () => {
  const f = fixture();
  try {
    for (const name of ['context_create', 'context_archive', 'task_message', 'task_control', 'memory_request', 'model_switch'] as const) {
      const schema = managementTools(f.core, true)[name].inputSchema! as z.ZodObject<{ signalIds: z.ZodType }>;
      assert.equal(schema.shape.signalIds.safeParse(undefined).success, false, name);
      assert.equal(schema.shape.signalIds.safeParse(null).success, false, name);
    }
    f.source({ owner: f.a.id }); f.source({ owner: f.b.id });
    const manual = await f.core.submitTask({ title: 'Manual', content: 'Fixture', returnContextId: 'shared' }, 'manual');
    assert.equal(manual.parentId, null); assert.deepEqual(manual.grants, f.b.grants);
    assert.equal(f.store.getSignal(manual.sourceSignalIds[0]!)?.source, 'authenticated-control');
  } finally { f.store.close(); }
});

for (const mode of ['omitted', 'null', 'explicit', 'malformed', 'unmatched'] as const) test(`real Core SDK task_create ${mode} preserves strict source validation and persisted provenance`, { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-source-'));
  let mainIssued = false; let workerIssued = false;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const worker = request.tools?.some(tool => tool.type === 'function' && tool.name === 'task_report');
    let toolName: string | undefined; let input: unknown;
    if (!worker && !mainIssued) {
      mainIssued = true; toolName = 'task_create';
      input = { task: childInput, ...(mode === 'omitted' ? {} : { signalIds: mode === 'null' ? null : [mode === 'malformed' ? malformedId : mode === 'unmatched' ? randomUUID() : actualId] }) };
    } else if (worker && !workerIssued) {
      workerIssued = true; toolName = 'mastra_workspace_write_file'; input = { path: 'must-not-exist.txt', content: 'Synthetic' };
    }
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (toolName) controller.enqueue({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
      controller.enqueue({ type: 'finish', finishReason: toolName ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  let core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  try {
    const receipt = await core.submitSignal({ id: actualId, type: 'user-message', source: 'fixture', content: 'Create a synthetic task' });
    await finished(core, receipt.runId!);
    const succeeds = ['omitted', 'null', 'explicit'].includes(mode);
    const created = core.runtime.tasks();
    assert.equal(created.length, succeeds ? 1 : 0, `${mode} must ${succeeds ? 'create' : 'reject'} the task through SDK execution`);
    if (succeeds) {
      const child = created[0]!;
      assert.deepEqual(child.sourceSignalIds, [actualId]); assert.equal(child.parentId, null);
      assert.deepEqual(child.grants, { write: false, execute: false, mcp: false });
      const approval = await until(() => core.runtime.approvals().find(row => row.taskId === child.id && row.status === 'pending'), Boolean);
      assert.equal(approval!.toolName, 'mastra_workspace_write_file');
      const file = path.join(core.capabilities.root('default').path, 'must-not-exist.txt');
      assert.equal(fs.existsSync(file), false); await core.approve(approval!.id, 'decline');
      await core.close(); core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
      assert.deepEqual(core.runtime.task(child.id).sourceSignalIds, [actualId]);
      assert.equal(core.store.getSignal(actualId)?.runId, receipt.runId);
      assert.equal(fs.existsSync(file), false);
    } else {
      const activity = core.runtime.events('main', 0, 1000).filter(event => event.kind === 'tool_end');
      assert.ok(activity.length, 'SDK must record rejected execution');
      assert.match(JSON.stringify(activity), mode === 'malformed' ? /Invalid UUID|invalid.*uuid/i : /schedule_authorization_required/);
    }
  } finally { await core.close(); await removeTemp(dir); }
});

for (const state of ['missing-run-attempt', 'missing-source-attempt', 'archived-context', 'finished-run', 'missing-tool-context'] as const) test(`automatic binding refuses incomplete or inactive authority: ${state}`, async () => {
  const f = fixture();
  try {
    const source = f.source({ owner: f.b.id });
    if (state === 'missing-run-attempt') f.runtime.setSetting(`task-run-attempts:${f.b.id}`, {});
    if (state === 'missing-source-attempt') f.runtime.setSetting('task-signal-attempts', {});
    if (state === 'archived-context') f.runtime.updateContext('shared', { archived: true });
    if (state === 'finished-run') f.store.finishRun('shared-run', 'succeeded');
    if (state === 'missing-tool-context') assert.throws(() => f.core.authorizeTaskCreation(undefined, undefined));
    else await assert.rejects(f.invoke({}), /schedule_authorization_required/);
    assert.equal(f.runtime.tasks().some(task => task.title === 'Child'), false);
    assert.equal(f.store.getSignal(source)?.status, 'accepted');
  } finally { f.store.close(); }
});

test('automatic binding retains every accepted source beyond the old single-message count', async () => {
  const f = fixture();
  try {
    const ids=Array.from({length:65},()=>f.source());
    await f.invoke({}, f.context('main'));
    assert.deepEqual(f.runtime.tasks().find(task => task.title === 'Child')!.sourceSignalIds,ids);
  } finally { f.store.close(); }
});

test('automatic binding checks a contaminated source after a large valid prefix instead of truncating it',async()=>{
 const f=fixture();try{for(let index=0;index<65;index++)f.source();f.source({type:'external-event'});await assert.rejects(f.invoke({},f.context('main')),/schedule_authorization_required/);assert.equal(f.runtime.tasks().some(task=>task.title==='Child'),false);}finally{f.store.close();}
});

test('explicit task_create sources never fall back to current inputs after a source error', async () => {
  const f = fixture();
  try {
    const source = f.source({ owner: f.b.id });
    const old = f.source({ owner: f.b.id, runId: 'old-run' });
    const rejected = f.source({ owner: f.b.id, status: 'rejected' });
    const cancelled = f.source({ owner: f.b.id, status: 'cancelled' });
    for (const signalIds of [[malformedId], [randomUUID()], [old], [rejected], [cancelled], [], [source, randomUUID()]]) {
      await assert.rejects(f.invoke({ signalIds }));
      assert.equal(f.runtime.tasks().some(task => task.title === 'Child'), false);
    }
    assert.throws(() => f.core.authorizeTaskCreation([source], f.context('shared', 'old-run')), /output_requires_active_run/);
    const memorySource = f.source({ contextId: 'memory' });
    await assert.rejects(f.invoke({ signalIds: [memorySource] }, f.context('memory')), /schedule_authorization_required/);
  } finally { f.store.close(); }
});

test('real shared SDK run rejects automatic cross-owner binding; explicit B child still requests write approval', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-source-shared-'));
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let core!: Core; let lowSignal = ''; let parentTurns = 0; let childIssued = false;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const text = request.prompt.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
    const ids = [...text.matchAll(/<(?:user|external-event|scheduled-task)\b[^>]*signal_id="([^"]+)"/g)].map(match => match[1]);
    const child = core.runtime.tasks().find(task => task.title === 'Child');
    const worker = request.tools?.some(tool => tool.type === 'function' && tool.name === 'task_report');
    let toolName: string | undefined; let input: unknown;
    if (child && ids.includes(child.signalId)) {
      if (!childIssued) { childIssued = true; toolName = 'mastra_workspace_write_file'; input = { path: 'shared-must-not-exist.txt', content: 'Synthetic' }; }
    } else if (worker && parentTurns < 3) {
      const turn = parentTurns++;
      if (turn === 0) { entered(); await gate; toolName = 'context_list'; input = { query: '' }; }
      else {
        if (turn === 2) assert.equal(core.runtime.tasks().some(task => task.title === 'Child'), false, 'ambiguous omission must not create a child');
        toolName = 'task_create'; input = { task: childInput, ...(turn === 1 ? {} : { signalIds: [lowSignal] }) };
      }
    }
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (toolName) controller.enqueue({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
      controller.enqueue({ type: 'finish', finishReason: toolName ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  try {
    const context = core.createWorkContext({ name: 'Shared parent' });
    const high = await core.submitTask({ title: 'A', content: 'Shared parent A', contextId: context.id, grants: { write: true, execute: true, mcp: true } }, 'high');
    await started;
    const low = await core.submitTask({ title: 'B', content: 'Shared parent B', contextId: context.id }, 'low'); lowSignal = low.signalId;
    const accepted = await until(() => core.store.getSignal(lowSignal), signal => signal?.status === 'accepted');
    assert.equal(accepted?.runId, core.store.getSignal(high.signalId)?.runId);
    release();
    const child = await until(() => core.runtime.tasks().find(task => task.title === 'Child'), Boolean);
    assert.equal(child!.parentId, low.id); assert.deepEqual(child!.sourceSignalIds, [lowSignal]);
    assert.deepEqual(child!.grants, { write: false, execute: false, mcp: false }); assert.deepEqual(child!.mcpKeys, []);
    const approval = await until(() => core.runtime.approvals().find(row => row.taskId === child!.id && row.status === 'pending'), Boolean);
    assert.equal(approval!.toolName, 'mastra_workspace_write_file');
    assert.equal(fs.existsSync(path.join(core.capabilities.root('default').path, 'shared-must-not-exist.txt')), false);
    const results = core.runtime.events(context.id, 0, 1000).filter(event => event.kind === 'tool_end');
    assert.match(JSON.stringify(results), /schedule_authorization_required/);
    assert.equal(core.runtime.tasks().filter(task => task.title === 'Child').length, 1);
    await core.approve(approval!.id, 'decline');
  } finally { release(); await core.close(); await removeTemp(dir); }
});
