import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { Tasks, taskInputSchema } from '../src/tasks.js';
import { signalSchema } from '../src/domain.js';
import { until, removeTemp } from './helpers.js';

const report = { outcome: 'succeeded' as const, summary: 'Fixture verified', checks: [{ description: 'Fixture checked', passed: true }], deliveries: [], unresolved: [] };

function fixture() {
  const store = new Store(':memory:'); const runtime = new RuntimeStore(store.db);
  runtime.createContext({ id: 'main', name: 'Main', role: 'main' });
  runtime.createContext({ id: 'shared', name: 'Shared', role: 'work', workspaceId: 'custom' });
  const activeRuns = new Map([['shared', 'shared-run']]);
  const core = Object.create(Core.prototype) as Core;
  const tasks = new Tasks(runtime, { manager: () => { throw Error('no admission expected'); }, createContext: input => runtime.createContext(input), dispatch: async () => ({ runId: 'unused' }), wait: async () => 'complete', abort: () => {}, settle: async () => {}, changed: async () => {} });
  Object.assign(core, { store, runtime, tasks, branchingContexts: new Set<string>(), activeRuns, stopping: true, capabilities: { mcpKeys: () => ['current-server'] }, schedules: { isSignal: () => false } });
  const grant = { toolName: 'ext_fixture_read', args: {}, contextId: 'shared', capabilityKey: 'restricted-server' };
  const first = runtime.createTask({ title: 'A', content: 'A', contextId: 'shared', returnContextId: 'main', sourceSignalIds: [], status: 'running', runIds: ['shared-run'], grants: { write: true, execute: true, mcp: true }, mcpKeys: ['privileged-server'] });
  const second = runtime.createTask({ title: 'B', content: 'B', contextId: 'shared', returnContextId: 'main', sourceSignalIds: [], status: 'running', runIds: ['shared-run'], grants: { write: false, execute: false, mcp: true }, mcpKeys: ['restricted-server'], toolGrants: [grant] });
  function source(taskId: string, runId = 'shared-run') {
    const input = signalSchema.parse({ id: randomUUID(), contextId: 'shared', type: 'external-event', source: `task:${taskId}`, content: 'Fixture' });
    store.receive(input); store.accept(input.id, input.id, runId, 'deliver', 'shared');
    runtime.setSetting('task-signal-owners', { ...runtime.setting('task-signal-owners', {}), [input.id]: taskId });
    return input.id;
  }
  return { core, tasks, runtime, store, first, second, source, activeRuns };
}

test('a shared worker run inherits only its verified source owner, not the first task', async () => {
  const f = fixture();
  try {
    const child = await f.core.createTask(taskInputSchema.parse({ title: 'Child', content: 'Fixture' }), { sourceSignalIds: [f.source(f.second.id)], returnContextId: 'shared' }, 'child');
    assert.equal(child.parentId, f.second.id);
    assert.deepEqual(child.grants, f.second.grants);
    assert.deepEqual(child.mcpKeys, f.second.mcpKeys);
    assert.deepEqual(child.toolGrants, f.second.toolGrants);
    assert.equal(f.runtime.context(child.contextId)?.workspaceId, 'custom');
  } finally { f.store.close(); }
});

test('worker task creation rejects forged, foreign-run, ambiguous and conflicting parent sources', async () => {
  const f = fixture();
  try {
    const own = f.source(f.second.id); const other = f.source(f.first.id); const stale = f.source(f.second.id, 'unrelated-run');
    for (const [index, sources, parentId] of [
      [0, [randomUUID()], undefined], [1, [stale], undefined], [2, [own, other], undefined], [3, [own], f.first.id],
    ] as const) {
      await assert.rejects(f.core.createTask({ title: 'Child', content: 'Fixture', ...(parentId ? { parentId } : {}) }, { sourceSignalIds: [...sources], returnContextId: 'shared', ...(parentId ? { parentId } : {}) }, `denied-${index}`));
    }
    const child = await f.core.createTask({ title: 'Explicit child', content: 'Fixture', parentId: f.second.id }, { sourceSignalIds: [own], returnContextId: 'shared', parentId: f.second.id, grants: f.first.grants, mcpKeys: f.first.mcpKeys, toolGrants: [] }, 'explicit');
    assert.equal(child.parentId, f.second.id); assert.deepEqual(child.grants, f.second.grants); assert.deepEqual(child.mcpKeys, f.second.mcpKeys); assert.deepEqual(child.toolGrants, f.second.toolGrants);
    f.runtime.createContext({ id: 'other', name: 'Other', role: 'work', workspaceId: 'different' });
    await assert.rejects(f.core.createTask({ title: 'Wrong workspace', content: 'Fixture', contextId: 'other' }, { sourceSignalIds: [own], returnContextId: 'shared' }, 'wrong-workspace'), /child_workspace_not_authorized/);
  } finally { f.store.close(); }
});

test('authenticated task submission remains top-level during unrelated active work and supports explicit scoped parents', async () => {
  const f = fixture();
  try {
    Object.assign(f.core, { stopping: false });
    Object.assign(f.tasks, { start: async (id: string) => f.runtime.task(id) });
    const root = await f.core.submitTask({ title: 'Manual', content: 'Fixture', returnContextId: 'shared', grants: { write: false, execute: false, mcp: false } }, 'manual');
    assert.equal(root.parentId, null); assert.equal(f.runtime.context(root.contextId)?.workspaceId, 'default');
    const child = await f.core.submitTask({ title: 'Manual child', content: 'Fixture', parentId: f.second.id }, 'manual-child');
    assert.equal(child.parentId, f.second.id); assert.equal(f.runtime.context(child.contextId)?.workspaceId, 'custom'); assert.deepEqual(child.grants, f.second.grants);
  } finally { f.store.close(); }
});

test('schema preserves omitted workspace until parent resolution', () => {
  assert.equal(taskInputSchema.parse({ title: 'Fixture', content: 'Fixture' }).workspaceId, undefined);
});

test('reports from previous attempts cannot settle a retried task', async () => {
  const f = fixture();
  try {
    const task = f.runtime.updateTask(f.second.id, { status: 'waiting' });
    Object.assign(f.tasks, { start: async (id: string) => f.runtime.updateTask(id, { status: 'running' }) });
    await f.tasks.control(task.id, 'retry', task.revision);
    await assert.rejects(f.tasks.report(task.id, report, 'shared-run', async (_task, body) => body), /task_report_not_in_run/);
    assert.equal(f.runtime.task(task.id).report, null);
  } finally { f.store.close(); }
});

for (const childFinishesWhileBusy of [false, true]) {
  test(`supplement runs settle waiting tasks and compensate busy child completion (${childFinishesWhileBusy})`, { timeout: 30_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-supplement-lifecycle-'));
    let release!: () => void; let entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    let core!: Core; let taskId = ''; let firstCall = true; const reported = new Set<number>();
    const model = new MastraLanguageModelV2Mock({ doStream: async request => {
      const task = core.runtime.task(taskId);
      if (firstCall) { firstCall = false; entered(); if (childFinishesWhileBusy) await gate; }
      const shouldReport = request.tools?.some(tool => tool.name === 'task_report') && (!childFinishesWhileBusy || task.attempt > 1) && !reported.has(task.attempt);
      if (shouldReport) reported.add(task.attempt);
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        if (shouldReport) controller.enqueue({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'task_report', input: JSON.stringify({ id: taskId, report }) });
        controller.enqueue({ type: 'finish', finishReason: shouldReport ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
      } }) };
    } });
    core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
    try {
      const context = core.createWorkContext({ name: 'Waiting parent' });
      const task = core.runtime.createTask({ title: 'Parent', content: 'Fixture', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'waiting' }); taskId = task.id;
      let child;
      if (childFinishesWhileBusy) {
        const childContext = core.createWorkContext({ name: 'Child' });
        child = core.runtime.createTask({ title: 'Child', content: 'Fixture', contextId: childContext.id, returnContextId: context.id, sourceSignalIds: [], status: 'running', parentId: task.id });
      }
      const receipt = await core.taskMessage(task.id, 'Supplement', []); await started;
      assert.ok('runId' in receipt && receipt.runId);
      if (child) {
        const done = core.runtime.updateTask(child.id, { status: 'succeeded', report });
        await (core as unknown as { taskChanged: (task: typeof done) => Promise<void> }).taskChanged(done);
      }
      release();
      const done = await until(() => core.runtime.task(task.id), value => value.status === 'succeeded', 7000);
      assert.equal(done.attempt, childFinishesWhileBusy ? 2 : 1);
      assert.equal(done.report?.summary, report.summary);
      assert.equal(done.runIds.length, childFinishesWhileBusy ? 2 : 1);
    } finally { release(); await core.close(); await removeTemp(dir); }
  });
}

test('aborting native execution releases the executor even before a run-end notification', async () => {
  const store=new Store(':memory:');const runtime=new RuntimeStore(store.db);const controller=new AbortController();
  let release!:()=>void;const ended=new Promise<'complete'>(resolve=>{release=()=>resolve('complete');});
  let execute!:()=>Promise<unknown>;
  const manager={enqueue:async (_payload:unknown,options:{executor:{execute:(args:unknown,options:{abortSignal:AbortSignal})=>Promise<unknown>}})=>{execute=()=>options.executor.execute({}, {abortSignal:controller.signal});return {task:{id:'native'},fallbackToSync:false};},cancel:async()=>{controller.abort();}} as unknown as BackgroundTaskManager;
  const tasks=new Tasks(runtime,{manager:()=>manager,createContext:input=>runtime.createContext(input),dispatch:async()=>({runId:'fixture-run'}),wait:async (_runId,signal)=>signal?Promise.race([ended,new Promise<never>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('fixture_abort')),{once:true});})]):ended,abort:()=>{},settle:async()=>{},changed:async()=>{}});
  let execution:Promise<unknown>|undefined;
  try{
    const task=tasks.create({title:'Fixture',content:'Fixture'},{sourceSignalIds:[],returnContextId:'main'},'abort');await tasks.start(task.id);execution=execute();
    await until(()=>runtime.task(task.id),task=>task.runIds.length===1);
    await tasks.control(task.id,'pause',runtime.task(task.id).revision);
    const result=await Promise.race([execution.then(()=>true),new Promise<false>(resolve=>setTimeout(()=>resolve(false),100))]);
    assert.equal(result,true,'the executor must retain its abortable wait');assert.equal(runtime.task(task.id).status,'paused');
  }finally{release();await execution;store.close();}
});

test('busy parent continuations are reconciled once per child result', async () => {
  const f=fixture();let resumed=0;
  const internal=f.core as unknown as {continueParent:(id:string)=>Promise<void>;flushNotifications:()=>Promise<void>};
  try{
    Object.assign(f.core,{stopping:false,notifying:new Set()});
    f.runtime.updateTask(f.second.id,{status:'waiting'});
    const child=f.runtime.createTask({title:'Child',content:'Fixture',contextId:'child',returnContextId:'shared',sourceSignalIds:[],parentId:f.second.id,status:'succeeded',report});
    Object.assign(f.tasks,{control:async()=>{resumed++;return f.runtime.updateTask(f.second.id,{attempt:resumed+1});}});
    await internal.continueParent(f.second.id);assert.equal(resumed,0);
    f.activeRuns.delete('shared');await internal.flushNotifications();await internal.flushNotifications();assert.equal(resumed,1);
    f.runtime.updateTask(child.id,{attempt:2,status:'cancelling'});await internal.flushNotifications();assert.equal(resumed,1);
    f.runtime.updateTask(child.id,{status:'cancelled'});await internal.flushNotifications();assert.equal(resumed,2);
  }finally{f.store.close();}
});

test('an earlier run in the same attempt cannot settle over its newer supplement run',async()=>{
  const store=new Store(':memory:');const runtime=new RuntimeStore(store.db);const releases=new Map<string,(reason:'complete')=>void>();let changed=0;
  const tasks=new Tasks(runtime,{manager:()=>({} as BackgroundTaskManager),createContext:input=>runtime.createContext(input),dispatch:async()=>({runId:'unused'}),wait:runId=>new Promise(resolve=>releases.set(runId,resolve)),abort:()=>{},settle:async()=>{},changed:async()=>{changed++;}});
  try{
    const task=runtime.createTask({title:'Fixture',content:'Fixture',contextId:'worker',returnContextId:'main',sourceSignalIds:[],status:'running'});
    tasks.bindRun(task.id,1,'earlier');const earlier=tasks.observeRun(task.id,1,'earlier');
    tasks.bindRun(task.id,1,'supplement');const supplement=tasks.observeRun(task.id,1,'supplement');
    releases.get('earlier')!('complete');await earlier;assert.equal(runtime.task(task.id).status,'running');assert.equal(changed,0);
    await tasks.report(task.id,report,'supplement',async(_task,body)=>body);
    releases.get('supplement')!('complete');await supplement;assert.equal(runtime.task(task.id).status,'succeeded');assert.equal(changed,1);
  }finally{store.close();}
});

test('run settlement is idempotent and ignores a previous attempt completion', async () => {
  const store = new Store(':memory:'); const runtime = new RuntimeStore(store.db); let changed = 0;
  const tasks = new Tasks(runtime, { manager: () => ({} as BackgroundTaskManager), createContext: input => runtime.createContext(input), dispatch: async () => ({ runId: 'unused' }), wait: async () => 'complete', abort: () => {}, settle: async () => {}, changed: async () => { changed++; } });
  try {
    const task = runtime.createTask({ title: 'Fixture', content: 'Fixture', contextId: 'worker', returnContextId: 'main', sourceSignalIds: [], status: 'running' });
    tasks.bindRun(task.id, 1, 'first');
    await tasks.observeRun(task.id, 1, 'first'); await tasks.observeRun(task.id, 1, 'first');
    assert.equal(runtime.task(task.id).status, 'unreported'); assert.equal(changed, 1);
    runtime.updateTask(task.id, { status: 'running', attempt: 2 }); tasks.bindRun(task.id, 2, 'second');
    await tasks.observeRun(task.id, 1, 'first');
    assert.equal(runtime.task(task.id).status, 'running'); assert.equal(changed, 1);
    await assert.rejects(tasks.report(task.id, report, 'first', async (_task, body) => body), /task_report_not_in_run/);
    await tasks.report(task.id, report, 'second', async (_task, body) => body);
    await tasks.observeRun(task.id, 2, 'second'); assert.equal(runtime.task(task.id).status, 'succeeded'); assert.equal(changed, 2);
  } finally { store.close(); }
});
