import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { BackgroundTask } from '@mastra/core/background-tasks';
import { RuntimeStore } from '../src/runtime-store.js';
import type { ProjectMemory, MemoryJob, MemoryV1OrganizeOptions } from '../src/memory/index.js';
import { NativeMemoryV1Runtime, type NativeMemoryV1Host } from '../src/memory/v1/runtime.js';
import { resolveMemoryContextPolicy } from '../src/memory/v1/binding.js';
import type { PreparedMemorySource } from '../src/memory/v1/source.js';
import type { MemoryV1OrganizeResult } from '../src/memory/v1/organizer.js';
import type { MemoryV1RecoveryPlan } from '../src/memory/v1/version-index.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const outcome = (fields: Partial<MemoryV1OrganizeResult> = {}): MemoryV1OrganizeResult => ({
  version: 'initial', generation: 0, complete: true, processedRecords: 1, deferredRecords: 0, changed: false, corrections: 0, ...fields,
});

test('cold reconciliation closes an exact abandoned resource without changing its business outcome or a new generation', async t => {
  const f = fixture(t), old = await f.runtime.queue('run:one');
  f.jobs[0]!.status = 'interrupted'; f.jobs[0]!.error = 'process_interrupted';
  Object.assign(f.tasks.get(old.nativeTaskId!)!, { status: 'running', ownerId: 'previous-owner' });
  f.restart(); await f.runtime.reconcile();
  assert.deepEqual(f.cancelled, [old.nativeTaskId]); assert.equal(f.jobs[0]!.status, 'interrupted'); assert.equal(f.calls, 0);
  const next = await f.runtime.queue('run:one'); assert.notEqual(next.id, old.id); assert.notEqual(next.nativeTaskId, old.nativeTaskId);
  await f.runtime.reconcile(); assert.deepEqual(f.cancelled, [old.nativeTaskId]); assert.equal(f.tasks.get(next.nativeTaskId!)!.status, 'pending');
});

const foreignResources: Record<string, (task: BackgroundTask) => void> = {
  'current live owner': task => { task.ownerId = 'synthetic-owner'; },
  'different native ID': task => { task.id = 'other-native'; },
  'different business job': task => { task.args = { jobId: 'other-job' }; },
  'different source run': task => { task.runId = 'other-run'; },
  'different agent': task => { task.agentId = 'other-core-agent'; },
  'different tool': task => { task.toolName = 'other-tool'; },
  'different tool receipt': task => { task.toolCallId = 'other-receipt'; },
};
for (const [name, mutate] of Object.entries(foreignResources)) test(`cold cleanup refuses a ${name}`, async t => {
  const f = fixture(t), job = await f.runtime.queue('run:one'); f.jobs[0]!.status = 'interrupted';
  const native = f.tasks.get(job.nativeTaskId!)!; Object.assign(native, { status: 'running', ownerId: 'previous-owner' }); mutate(native);
  f.restart(); await f.runtime.reconcile(); assert.deepEqual(f.cancelled, []); assert.equal(native.status, 'running'); assert.equal(f.jobs[0]!.status, 'interrupted');
});

test('cold cleanup rechecks owner changes and ignores terminal jobs created by the current runtime', async t => {
  const f = fixture(t), job = await f.runtime.queue('run:one'); f.jobs[0]!.status = 'interrupted';
  const native = f.tasks.get(job.nativeTaskId!)!; Object.assign(native, { status: 'running', ownerId: 'previous-owner' }); f.restart(); let reads = 0;
  f.taskRead(() => { if (++reads === 2) native.ownerId = 'another-active-owner'; });
  await f.runtime.reconcile(); assert.deepEqual(f.cancelled, []); assert.equal(native.ownerId, 'another-active-owner');
  f.taskRead(undefined); const next = await f.runtime.queue('run:two'); f.jobs.find(row => row.id === next.id)!.status = 'interrupted';
  await f.runtime.reconcile(); assert.ok(!f.cancelled.some(id => id === next.nativeTaskId)); assert.equal(native.status, 'running'); assert.equal(native.ownerId, 'another-active-owner');
});

test('cold cleanup finds an enqueue receipt whose business binding was not yet acknowledged', async t => {
  const f = fixture(t), old = await f.runtime.queue('run:one'); f.jobs[0]!.status = 'interrupted'; f.jobs[0]!.nativeTaskId = null;
  const native = f.tasks.get(old.nativeTaskId!)!; native.ownerId = 'previous-owner'; f.restart(); await f.runtime.reconcile();
  assert.deepEqual(f.cancelled, [native.id]); assert.equal(f.jobs[0]!.nativeTaskId, null); assert.equal(f.jobs[0]!.status, 'interrupted');
  const next = await f.runtime.queue('run:one'); assert.notEqual(next.id, old.id); assert.notEqual(next.nativeTaskId, native.id); assert.equal(f.calls, 0);
});

for (const [name, mutate] of Object.entries(foreignResources)) test(`unbound cold cleanup refuses a ${name}`, async t => {
  const f = fixture(t), old = await f.runtime.queue('run:one'); f.jobs[0]!.status = 'interrupted'; f.jobs[0]!.nativeTaskId = null;
  const native = f.tasks.get(old.nativeTaskId!)!; Object.assign(native, { status: 'running', ownerId: 'previous-owner' }); mutate(native);
  f.restart(); await f.runtime.reconcile(); assert.deepEqual(f.cancelled, []); assert.equal(native.status, 'running');
});

// 手动驱动现有 host 合同，原生 task、job 状态和发布结果彼此独立。
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'), store = new RuntimeStore(db);
  t.after(() => db.close());
  const jobs: MemoryJob[] = [], tasks = new Map<string, BackgroundTask>();
  const executions: { id: string; run: (signal?: AbortSignal) => Promise<unknown> }[] = [];
  const cancelled: string[] = [];
  let taskRead: ((id: string) => void) | undefined;
  const receipts = new Map<string, { source: PreparedMemorySource['source']; result: MemoryV1OrganizeResult; cutoff: string }>();
  let enabled = true, identity = 'model:one', processing = 'processing:initial', refreshed = 0, calls = 0, active = 0, maxActive = 0;
  let source: PreparedMemorySource = { source: { contextId: 'main', runId: 'run:one', sequence: 1 }, records: [], observations: [], contents: new Map(), gaps: [], canonicalRefs: new Map(), attachmentRefs: new Map() };
  let organize: () => Promise<MemoryV1OrganizeResult> = async () => outcome();
  let prepare: () => Promise<void> = async () => {};
  let enqueueHook: ((task: BackgroundTask) => Promise<void>) | undefined;
  const memory = {
    jobs: () => jobs.map(row => ({ ...row })), version: () => ({ id: 'initial' }), processingV1Head: () => processing,
    committedV1Publication: (id: string, source: PreparedMemorySource['source']) => { const receipt = receipts.get(id); return receipt?.result.complete && isDeepStrictEqual(receipt.source, source) ? { key: `memory-publication:${id}`, result: receipt.result, cutoff: receipt.cutoff } : null; },
    newV1Job: (runId: string) => {
      const existing = jobs.find(row => row.runId === runId && ['pending', 'running'].includes(row.status));
      if (existing) return { ...existing };
      const row: MemoryJob = { id: `job:${jobs.length + 1}`, runId, contextId: 'main', nativeTaskId: null, status: 'pending', error: null, createdAt: new Date().toISOString() };
      jobs.push(row); return { ...row };
    },
    bind: (id: string, nativeTaskId: string) => { jobs.find(row => row.id === id)!.nativeTaskId = nativeTaskId; },
    interruptNativeJob: (binding: MemoryJob, error: string) => {
      const row = jobs.find(row => row.id === binding.id);
      if (row && row.runId === binding.runId && row.nativeTaskId === binding.nativeTaskId && ['pending', 'running'].includes(row.status)) Object.assign(row, { status: 'interrupted', error });
    },
    rejectAdmission: (id: string, error: string, status = 'failed') => {
      const row = jobs.find(row => row.id === id)!;
      if (['pending', 'running'].includes(row.status)) Object.assign(row, { status, error });
    },
    organizeV1: async (id: string, options: Pick<MemoryV1OrganizeOptions, 'signal' | 'preparedSource' | 'cutoff'>) => {
      const row = jobs.find(row => row.id === id)!; row.status = 'running'; calls++; active++; maxActive = Math.max(maxActive, active);
      try {
        const result = await organize(); options.signal?.throwIfAborted();
        if (row.status !== 'running') throw new Error('synthetic-interrupted');
        // no-op 正文也前进 processing head，不能据此产生无限自动整理。
        processing = `processing:${calls}`; row.status = 'succeeded'; receipts.set(id, { source: structuredClone(options.preparedSource.source), result, cutoff: options.cutoff }); return result;
      } catch (error) {
        if (row.status === 'running') Object.assign(row, { status: options.signal?.aborted ? 'interrupted' : 'failed', error: 'synthetic-failure' });
        throw error;
      } finally { active--; }
    },
  } as unknown as ProjectMemory;
  const host: NativeMemoryV1Host = {
    scopeId: 'synthetic-scope', enabled: () => enabled, policy: () => resolveMemoryContextPolicy(),
    prepare: async runId => { await prepare(); const prepared = structuredClone(source); prepared.source = { ...prepared.source, runId }; return prepared; },
    model: () => ({ identity, model: {} as ReturnType<NativeMemoryV1Host['model']>['model'], options: {}, supportedImageMediaTypes: [] }),
    task: async id => { taskRead?.(id); return tasks.has(id) ? structuredClone(tasks.get(id)!) : null; },
    tasks: async runId => [...tasks.values()].filter(task => task.runId === runId).map(task => structuredClone(task)),
    ownerId: 'synthetic-owner', cancel: async id => { cancelled.push(id); const task = tasks.get(id); if (task) task.status = 'cancelled'; },
    processed: runId => { refreshed++; void runtime.queue(runId).catch(() => {}); },
    enqueue: async (runId, key, jobId, run) => {
      const task: BackgroundTask = { id: `native:${tasks.size + 1}`, runId, toolName: 'organize-memory-v1', agentId: 'memory-organizer', toolCallId: key,
        args: { jobId }, status: 'pending', createdAt: new Date(), retryCount: 0, maxRetries: 0, timeoutMs: 60_000 };
      tasks.set(task.id, task); executions.push({ id: task.id, run }); await enqueueHook?.(task); return task.id;
    },
  };
  let runtime = new NativeMemoryV1Runtime(store, memory, host);
  const step = async (signal?: AbortSignal) => {
    const next = executions.shift(); assert.ok(next, '预期一个已入原生队列的执行');
    const task = tasks.get(next.id)!;
    if (task.status !== 'pending') { await tick(); return; }
    task.status = 'running';
    try { await next.run(signal); task.status = 'completed'; }
    catch { task.status = signal?.aborted ? 'cancelled' : 'failed'; }
    runtime.settleNativeTask(task); await tick();
  };
  const drain = async (limit = 20) => {
    for (let i = 0; executions.length; i++) { assert.ok(i < limit, '自动续进必须有界'); await step(); }
  };
  return {
    get runtime() { return runtime; }, store, memory, tasks, jobs, executions, step, drain, cancelled,
    get calls() { return calls; }, get refreshed() { return refreshed; }, get maxActive() { return maxActive; },
    result: (value: MemoryV1OrganizeResult) => { organize = async () => value; },
    organize: (fn: typeof organize) => { organize = fn; }, prepare: (fn: typeof prepare) => { prepare = fn; },
    enable: (value: boolean) => { enabled = value; }, model: (value: string) => { identity = value; },
    supplement: () => { source.source = { ...source.source, sequence: source.source.sequence + 1 }; }, enqueueHook: (fn: typeof enqueueHook) => { enqueueHook = fn; },
    restart: () => { runtime = new NativeMemoryV1Runtime(store, memory, host); },
    taskRead: (hook: typeof taskRead) => { taskRead = hook; },
  };
}

test('partial 成功不等于 complete，零进度后普通 queue 仍可重试剩余来源', async t => {
  const f = fixture(t); f.result(outcome({ complete: false, processedRecords: 0, deferredRecords: 1 }));
  const first = await f.runtime.queue('run:one'); await f.drain();
  assert.equal(f.jobs[0]!.status, 'succeeded'); assert.equal(f.calls, 1);
  f.result(outcome()); const second = await f.runtime.queue('run:one');
  assert.notEqual(second.id, first.id); await f.drain(); assert.equal(f.calls, 2);
});

test('明确 complete 才跨重启稳定去重，自己的 no-op processing head 不续入队', async t => {
  const f = fixture(t), first = await f.runtime.queue('run:one'); await f.drain();
  assert.equal(f.calls, 1); assert.equal(f.refreshed, 1); f.restart();
  for (let n = 0; n < 3; n++) assert.equal((await f.runtime.queue('run:one')).id, first.id);
  assert.equal(f.executions.length, 0); assert.equal(f.calls, 1);
});

test('旧 succeeded 没有 complete 回执不能永久挡住整理，failed 普通 queue 可重试', async t => {
  const f = fixture(t); const first = await f.runtime.queue('run:one');
  f.jobs[0]!.status = 'succeeded'; f.tasks.get(first.nativeTaskId!)!.status = 'completed'; f.executions.length = 0;
  f.restart(); const second = await f.runtime.queue('run:one'); assert.notEqual(second.id, first.id);
  f.organize(async () => { throw new Error('synthetic-failure'); }); await f.drain();
  assert.equal(f.jobs.at(-1)!.status, 'failed');
  f.result(outcome()); const retry = await f.runtime.queue('run:one'); assert.notEqual(retry.id, second.id); await f.drain();
  assert.equal(f.jobs.at(-1)!.status, 'succeeded');
});

test('真实本轮进度才自动续进，完整结果及时停止且共用 writer', async t => {
  const f = fixture(t); let batches = 0;
  f.organize(async () => ++batches < 3 ? outcome({ complete: false, processedRecords: 1, deferredRecords: 3 - batches }) : outcome());
  await f.runtime.queue('run:one'); await f.drain();
  assert.equal(f.calls, 3); assert.equal(f.jobs.length, 3); assert.equal(f.maxActive, 1);
  assert.equal(f.refreshed, 1); assert.ok(f.jobs.every(row => row.status === 'succeeded'));
});

test('不同 run 的原生 executor 同时启动仍由原 writer 串行发布', async t => {
  const f = fixture(t); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.organize(async () => { entered(); await gate; return outcome(); });
  await f.runtime.queue('run:one'); await f.runtime.queue('run:two');
  const first = f.step(); await started; const second = f.step(); await tick();
  assert.equal(f.calls, 1); release(); await Promise.all([first, second]); await f.drain();
  assert.equal(f.calls, 2); assert.equal(f.maxActive, 1); assert.equal(f.jobs.length, 2);
});

test('持续 partial 有界停止，普通 queue 允许下一批，零进度不自动重试', async t => {
  const f = fixture(t); f.result(outcome({ complete: false, processedRecords: 1, deferredRecords: 100 }));
  await f.runtime.queue('run:one'); await f.drain();
  assert.ok(f.calls > 1 && f.calls <= 8); const calls = f.calls;
  f.result(outcome({ complete: false, processedRecords: 0, deferredRecords: 100 }));
  await f.runtime.queue('run:one'); await f.drain(); assert.equal(f.calls, calls + 1);
  assert.equal(f.refreshed, 0); assert.equal(f.executions.length, 0);
});

test('complete 后切模型和补源创建新尝试，admission 同 run 并发合并', async t => {
  const f = fixture(t); const first = await f.runtime.queue('run:one'); await f.drain();
  f.model('model:two'); const changed = await f.runtime.queue('run:one'); assert.notEqual(changed.id, first.id); await f.drain();
  f.supplement(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); f.prepare(() => gate);
  const one = f.runtime.queue('run:one'), two = f.runtime.queue('run:one'); release();
  assert.equal((await one).id, (await two).id); await f.drain(); assert.equal(f.calls, 3);
});

test('partial 后停用不自动重试，取消/旧终态不覆盖新尝试，重新开启普通 queue 可继续', async t => {
  const f = fixture(t);
  f.organize(async () => { f.enable(false); return outcome({ complete: false, processedRecords: 1, deferredRecords: 1 }); });
  await f.runtime.queue('run:one'); await f.drain(); assert.equal(f.calls, 1);
  await assert.rejects(f.runtime.queue('run:one'), /memory_disabled/);
  f.enable(true); const queued = await f.runtime.queue('run:one'); const old = f.tasks.get(queued.nativeTaskId!)!;
  old.status = 'cancelled'; f.runtime.settleNativeTask(old); assert.equal(f.jobs.at(-1)!.status, 'interrupted');
  f.result(outcome()); const replacement = await f.runtime.queue('run:one'); assert.notEqual(replacement.id, queued.id);
  for (const status of ['completed', 'failed', 'cancelled', 'timed_out'] as const) f.runtime.settleNativeTask({ ...old, status });
  assert.equal(f.jobs.at(-1)!.status, 'pending'); await f.drain(); assert.equal(f.jobs.at(-1)!.status, 'succeeded');
});

test('queued 绑定前取消补读收尾，owner/tool/id 校验仍然精确', async t => {
  const f = fixture(t); f.enqueueHook(async task => { task.status = 'cancelled'; f.runtime.settleNativeTask(task); });
  const first = await f.runtime.queue('run:one'); await tick(); assert.equal(f.jobs[0]!.status, 'interrupted');
  f.enqueueHook(undefined); const replacement = await f.runtime.queue('run:one');
  const current = f.tasks.get(replacement.nativeTaskId!)!, old = f.tasks.get(first.nativeTaskId!)!;
  for (const wrong of [{ ...current, agentId: 'other' }, { ...current, toolName: 'other' }, { ...current, toolCallId: 'other' }, { ...current, runId: 'other' }, { ...current, id: old.id }, { ...current, args: { jobId: first.id } }]) f.runtime.settleNativeTask({ ...wrong, status: 'cancelled' });
  assert.equal(f.jobs.at(-1)!.status, 'pending'); await f.drain();
});

test('自动续进遇失败立即停止，普通 queue 可重新开始且运行中 abort 不发布 complete 回执', async t => {
  const f = fixture(t); let batch = 0;
  f.organize(async () => {
    if (++batch === 2) throw new Error('synthetic-next-batch-failure');
    return outcome({ complete: false, processedRecords: 1, deferredRecords: 2 });
  });
  await f.runtime.queue('run:one'); await f.drain();
  assert.equal(f.calls, 2); assert.equal(f.jobs.at(-1)!.status, 'failed'); assert.equal(f.refreshed, 0);
  const controller = new AbortController(); let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  f.organize(async () => { started(); await gate; return outcome(); });
  const interrupted = await f.runtime.queue('run:one'), execution = f.step(controller.signal);
  await entered; controller.abort(); release(); await execution;
  assert.equal(f.jobs.at(-1)!.status, 'interrupted'); assert.equal(f.executions.length, 0); assert.equal(f.refreshed, 0);
  f.result(outcome()); const retry = await f.runtime.queue('run:one'); assert.notEqual(retry.id, interrupted.id); await f.drain();
  assert.equal(f.jobs.at(-1)!.status, 'succeeded');
});

test('complete 回执绑定实际执行补源值，而不是入队前的旧资料', async t => {
  const f = fixture(t); let preparations = 0;
  f.prepare(async () => { if (++preparations === 2) f.supplement(); });
  const first = await f.runtime.queue('run:one'); await f.drain();
  assert.equal((await f.runtime.queue('run:one')).id, first.id); assert.equal(f.calls, 1);
});

test('同 run 存活任务不因补源重复入队，force 仍能重做明确 complete', async t => {
  const f = fixture(t); const first = await f.runtime.queue('run:one'); f.supplement();
  assert.equal((await f.runtime.queue('run:one')).id, first.id); assert.equal(f.executions.length, 1);
  await f.drain(); const forced = await f.runtime.queue('run:one', true); assert.notEqual(forced.id, first.id); await f.drain();
  assert.equal(f.calls, 2);
});

test('重启 reconcile 原生终态再去重，恢复任务不触发普通自动续进', async t => {
  const f = fixture(t); const old = await f.runtime.queue('run:one');
  f.tasks.get(old.nativeTaskId!)!.status = 'timed_out'; f.restart();
  const retry = await f.runtime.queue('run:one'); assert.notEqual(retry.id, old.id); await f.drain();
  f.result(outcome({ complete: false, processedRecords: 1, deferredRecords: 1 }));
  const recovery = { targetVersionId: 'version:synthetic', cutoff: '2026-11-01T00:00:00.000Z', expectedHead: 'initial' } as MemoryV1RecoveryPlan;
  const before = f.calls; await f.runtime.queue('run:one', true, recovery); await f.drain();
  assert.equal(f.calls, before + 1); assert.equal(f.refreshed, 1);
});
