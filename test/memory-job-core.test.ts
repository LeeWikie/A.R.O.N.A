import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import type { MemoryJob } from '../src/memory/index.js';
import { finished, removeTemp, until } from './helpers.js';

const business = '  用户业务原文\n{\n  "nativeTaskId": "业务订单号",\n  "binding": { "nativeTaskId": "嵌套业务字段" }\n}\n';
const jobKeys = ['id', 'runId', 'contextId', 'status', 'error', 'createdAt'].sort();
function assertPublicJob(value: unknown, expected: MemoryJob) {
  assert.deepEqual(Object.keys(value as object).sort(), [...jobKeys, ...(expected.resolvedBy ? ['resolvedBy'] : [])].sort());
  const { nativeTaskId, allowWhileDisabled, stopGeneration, ...publicJob } = expected;
  assert.deepEqual(value, publicJob);
  if (nativeTaskId) assert.ok(!JSON.stringify(value).includes(nativeTaskId));
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-job-core-'));
  let releaseGate!: () => void;
  let notifyStarted!: () => void;
  const gate = { promise: new Promise<void>(resolve => { releaseGate = resolve; }), resolve: () => releaseGate() };
  const started = { promise: new Promise<void>(resolve => { notifyStarted = resolve; }), resolve: () => notifyStarted() };
  const sourcePrompts: unknown[] = [];
  const memoryPrompts: unknown[] = [];
  let commit = true;
  const committed = new Set<string>();
  const model = new MastraLanguageModelV2Mock({
    doStream: async request => {
      sourcePrompts.push(request.prompt);
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'text' });
        controller.enqueue({ type: 'text-delta', id: 'text', delta: '已收到普通用户信息' });
        controller.enqueue({ type: 'text-end', id: 'text' });
        controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
        controller.close();
      } }) };
    },
    doGenerate: async request => {
      memoryPrompts.push(request.prompt);
      started.resolve();
      await gate.promise;
      request.abortSignal?.throwIfAborted();
      const runId = /来源运行是 ([0-9a-f-]{36})/.exec(JSON.stringify(request.prompt))?.[1];
      assert.ok(runId);
      const shouldCommit = commit && !committed.has(runId);
      if (shouldCommit) committed.add(runId);
      return {
        content: shouldCommit
          ? [{ type: 'tool-call', toolName: 'memory_commit', toolCallId: `commit-${runId}`, input: JSON.stringify({ sourceRunId: runId, note: 'synthetic' }) }]
          : [{ type: 'text', text: '合成整理结束' }],
        finishReason: shouldCommit ? 'tool-calls' : 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [],
      };
    },
  });
  let core: Core;
  try { core = await Core.open({ dataDir: directory, model, memoryEnabled: false }); }
  catch (error) { await removeTemp(directory); throw error; }
  const app = createApp(core);
  const request = (url: string, body?: unknown) => app.request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${core.controlToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const manager = core.sessions.controller.getMastra()?.backgroundTaskManager;
  assert.ok(manager);
  return {
    core, manager, request, sourcePrompts, memoryPrompts, started: started.promise,
    release: () => gate.resolve(), allowCommit: (value: boolean) => { commit = value; },
    async send() {
      const receipt = await core.submitMessage({ content: business });
      assert.ok(receipt.runId);
      assert.equal((await finished(core, receipt.runId))?.status, 'succeeded');
      assert.deepEqual(core.projectMemory.jobs(), [], 'memoryEnabled:false 不自动创建整理任务');
      return receipt.runId;
    },
    async terminal(id: string, status: MemoryJob['status']) {
      const jobs = await until(() => core.projectMemory.jobs(), rows => rows.some(row => row.id === id && row.status === status));
      return jobs.find(row => row.id === id)!;
    },
    async close() { gate.resolve(); await core.close(); await removeTemp(directory); },
  };
}

async function assertError(response: Response, status: number, error: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
}

test('真实 Core manager 绑定私有记忆任务，并发及完成后的同源请求不重复整理', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const runId = await f.send();
    const [first, second, response] = await Promise.all([
      f.core.queueMemory(runId), f.core.queueMemory(runId), f.request('/memory/requests', { runId }),
    ]);
    assert.equal(first.id, second.id);
    assert.ok(first.nativeTaskId);
    assert.equal(response.status, 202);
    const publicJob = await response.json();
    assert.equal(publicJob.id, first.id);
    assert.deepEqual(Object.keys(publicJob).sort(), jobKeys);
    assert.ok(!JSON.stringify(publicJob).includes(first.nativeTaskId));
    await f.started;
    const running = f.core.projectMemory.jobs()[0]!;
    assert.equal(running.status, 'running');
    assert.equal(running.nativeTaskId, first.nativeTaskId);
    const native = await f.manager.getTask(first.nativeTaskId);
    assert.ok(native);
    assert.equal(native.toolName, 'organize-memory');
    assert.equal(native.agentId, 'memory-organizer');
    assert.equal(native.runId, runId);
    assert.equal(native.toolCallId, `memory:${runId}`);
    assert.deepEqual(native.args, { jobId: first.id });
    assert.equal(native.maxRetries, 0);
    const status = await (await f.request('/memory')).json();
    assert.equal(status.enabled, false);
    assertPublicJob(status.jobs[0], running);
    await assertError(await f.request(`/memory/jobs/${first.id}/retry`, {}), 409, 'memory_job_not_retryable');
    assert.equal(f.memoryPrompts.length, 1);
    const parts = (f.memoryPrompts[0] as { content: { type: string; text?: string }[] }[]).flatMap(row => row.content);
    assert.ok(parts.some(part => part.type === 'text' && part.text === business), '同名业务 JSON 及用户正文逐字保留');
    const historyBefore = await f.core.history('main');
    assert.ok(JSON.stringify(historyBefore).includes('业务订单号'));
    f.release();
    const completed = await f.terminal(first.id, 'succeeded');
    assert.equal(completed.nativeTaskId, first.nativeTaskId);
    await until(() => f.manager.getTask(first.nativeTaskId!), task => task?.status === 'completed');
    const calls = f.memoryPrompts.length;
    assert.equal(calls, 1, 'a successful memory_commit does not require another provider request');
    const repeated = await f.request('/memory/requests', { runId });
    assert.equal(repeated.status, 202);
    assertPublicJob(await repeated.json(), completed);
    assert.deepEqual(await f.core.queueMemory(runId), completed);
    assert.equal(f.core.projectMemory.jobs().length, 1);
    assert.equal((await f.manager.listTasks({ runId })).tasks.length, 1);
    assert.equal(f.memoryPrompts.length, calls);
    assert.equal(f.sourcePrompts.length, 1);
    assert.deepEqual(await f.core.history('main'), historyBefore);
    assertPublicJob((await (await f.request('/memory')).json()).jobs[0], completed);
  } finally { await f.close(); }
});

test('真实整理未提交时公开失败，failed retry 创建新原生任务且成功后保持去重', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    f.allowCommit(false);
    const runId = await f.send();
    const response = await f.request('/memory/requests', { runId });
    assert.equal(response.status, 202);
    const admitted = await response.json();
    await f.started;
    f.release();
    const failed = await f.terminal(admitted.id, 'failed');
    assert.ok(failed.nativeTaskId);
    assert.equal(failed.error, 'memory_not_committed');
    await until(() => f.manager.getTask(failed.nativeTaskId!), task => task?.status === 'failed');
    assertPublicJob((await (await f.request('/memory')).json()).jobs[0], failed);
    f.allowCommit(true);
    const retried = await f.request(`/memory/jobs/${failed.id}/retry`, {});
    assert.equal(retried.status, 202);
    const publicRetry = await retried.json();
    assert.deepEqual(Object.keys(publicRetry).sort(), jobKeys);
    assert.notEqual(publicRetry.id, failed.id);
    const complete = await f.terminal(publicRetry.id, 'succeeded');
    assert.ok(complete.nativeTaskId);
    assert.notEqual(complete.nativeTaskId, failed.nativeTaskId);
    await until(() => f.manager.getTask(complete.nativeTaskId!), task => task?.status === 'completed');
    const jobs = (await (await f.request('/memory')).json()).jobs;
    assert.equal(jobs.find((job: MemoryJob) => job.id === failed.id).resolvedBy, complete.id);
    assert.equal(jobs.find((job: MemoryJob) => job.id === failed.id).status, 'failed');
    assert.equal(jobs.find((job: MemoryJob) => job.id === failed.id).error, failed.error);
    for (const row of f.core.projectMemory.jobs()) assertPublicJob(jobs.find((job: MemoryJob) => job.id === row.id), row);
    assert.equal((await f.manager.listTasks({ runId })).tasks.length, 2);
    const calls = f.memoryPrompts.length;
    const repeatedRetry = await f.request(`/memory/jobs/${failed.id}/retry`, {});
    assert.equal(repeatedRetry.status, 202);
    assertPublicJob(await repeatedRetry.json(), complete);
    assert.equal(f.memoryPrompts.length, calls);
    assert.equal(f.core.projectMemory.jobs().length, 2);
    await assertError(await f.request(`/memory/jobs/${complete.id}/retry`, {}), 409, 'memory_job_not_retryable');
    await assertError(await f.request(`/memory/jobs/${complete.nativeTaskId}/retry`, {}), 404, 'memory_job_not_found');
    await assertError(await f.request('/memory/jobs/missing/retry', {}), 404, 'memory_job_not_found');
    await assertError(await f.request('/memory/requests', { runId: 'missing' }), 409, 'context_snapshot_unavailable');
    assert.equal(f.core.projectMemory.jobs().length, 2);
  } finally { await f.close(); }
});

test('真实原生任务取消产生 interrupted，合法 retry 重新绑定并完成', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const runId = await f.send();
    const admitted = await f.core.queueMemory(runId);
    assert.ok(admitted.nativeTaskId);
    await f.started;
    await f.manager.cancel(admitted.nativeTaskId);
    f.release();
    const interrupted = await f.terminal(admitted.id, 'interrupted');
    assert.equal(interrupted.nativeTaskId, admitted.nativeTaskId);
    assert.equal(interrupted.error, 'memory_native_cancelled');
    assert.equal((await f.manager.getTask(admitted.nativeTaskId))?.status, 'cancelled');
    assertPublicJob((await (await f.request('/memory')).json()).jobs[0], interrupted);
    const response = await f.request(`/memory/jobs/${interrupted.id}/retry`, {});
    assert.equal(response.status, 202);
    const publicRetry = await response.json();
    assert.deepEqual(Object.keys(publicRetry).sort(), jobKeys);
    const complete = await f.terminal(publicRetry.id, 'succeeded');
    assert.notEqual(complete.id, interrupted.id);
    assert.ok(complete.nativeTaskId);
    assert.notEqual(complete.nativeTaskId, admitted.nativeTaskId);
    await until(() => f.manager.getTask(complete.nativeTaskId!), task => task?.status === 'completed');
    assertPublicJob((await (await f.request('/memory')).json()).jobs[1], complete);
    assert.equal((await f.manager.listTasks({ runId })).tasks.length, 2);
  } finally { await f.close(); }
});
