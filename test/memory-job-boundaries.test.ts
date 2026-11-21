import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import type { Core } from '../src/core.js';
import { AppError } from '../src/domain.js';
import { createApp } from '../src/http.js';
import { ProjectMemory, type ContextSnapshot, type MemoryJob } from '../src/memory/index.js';
import { MemoryFiles } from '../src/memory/files.js';
import { RuntimeStore } from '../src/runtime-store.js';

const jobKeys = ['id', 'runId', 'contextId', 'status', 'error', 'createdAt'].sort();
const privateMarker = 'SYNTHETIC-PRIVATE-MEMORY-QUEUE';
const business = '{\n  "nativeTaskId": "业务订单号",\n  "binding": { "nativeTaskId": "业务嵌套字段" }\n}';
const residentText = `# 合成记录\n保留原话与换行\n${business}\n`;
function expectedJob(job: MemoryJob) {
  return { id: job.id, runId: job.runId, contextId: job.contextId, status: job.status, error: job.error, createdAt: job.createdAt };
}
function assertPublicJob(value: unknown, job: MemoryJob) {
  assert.deepEqual(Object.keys(value as object).sort(), jobKeys);
  assert.deepEqual(value, expectedJob(job));
  assert.doesNotMatch(JSON.stringify(value), new RegExp(privateMarker));
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-job-boundaries-'));
  const db = new DatabaseSync(path.join(directory, 'synthetic.sqlite'));
  const store = new RuntimeStore(db);
  const memory = new ProjectMemory(store, directory);
  function archive(runId: string, sequence = 1) {
    const source: ContextSnapshot = { contextId: 'synthetic-context', runId, sequence, modelProfile: 'synthetic-only', createdAt: '2026-11-08T00:00:00.000Z', prompt: [{ role: 'user', content: [{ type: 'text', text: residentText }] }], nativeMessages: [], providerOptions: {} };
    memory.archive(source); return source;
  }
  return { directory, db, store, memory, archive, close: () => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
function routeFixture() {
  const state = fixture();
  let enqueued = 0;
  let failNext = false;
  // 只模拟宿主入队绑定，不打开 Core、不调用模型或后台服务。
  const core = { controlToken: 'synthetic-memory-http-control-token', projectMemory: state.memory, memoryEnabled: () => true,
    queueMemory: async (runId: string) => {
      const job = state.memory.newJob(runId);
      if (job.nativeTaskId || ['succeeded', 'superseded'].includes(job.status)) return job;
      if (failNext) { failNext = false; state.memory.rejectAdmission(job.id, 'synthetic_queue_unavailable'); throw new AppError('synthetic_queue_unavailable', 503); }
      state.memory.bind(job.id, `${privateMarker}-${++enqueued}`);
      const bound = state.memory.jobs().find(row => row.id === job.id)!;
      // 未知宿主字段也必须留在私有记录，不能依赖只删除一个已知字段。
      const extended = { ...bound, admissionBinding: `${privateMarker}-future` };
      state.store.setSetting('memory-jobs', state.memory.jobs().map(row => row.id === job.id ? extended : row));
      return extended;
    },
  } as unknown as Core;
  const app = createApp(core);
  function request(url: string, body?: unknown, authorized = true) {
    return app.request(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authorized ? { Authorization: `Bearer ${core.controlToken}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { ...state, app, request, enqueued: () => enqueued, failNext: () => { failNext = true; } };
}

test('公开记忆状态按白名单投影所有任务状态，不改写私有绑定或业务正文', () => {
  const f = fixture();
  try {
    const statuses: MemoryJob['status'][] = ['pending', 'running', 'succeeded', 'failed', 'interrupted', 'superseded'];
    const jobs = statuses.map((status, i) => ({ id: `job-${i}`, runId: `run-${i}`, contextId: 'synthetic-context', nativeTaskId: i ? `${privateMarker}-${i}` : null, status, error: status === 'failed' ? `请检查文件后重试\n${business}` : null, createdAt: '2026-11-08T00:00:00.000Z', admissionBinding: `${privateMarker}-future` }));
    f.store.setSetting('memory-jobs', jobs);
    const source = { contextId: 'synthetic-context', runId: 'run-2', sequence: 2 };
    f.store.setSetting('memory-version', { ...f.memory.version(), generation: 2, source });
    new MemoryFiles(f.memory.version().filesDirectory).write('notes/nativeTaskId.md', residentText);
    const status = f.memory.status();
    assert.equal(status.jobs.length, jobs.length);
    status.jobs.forEach((job, i) => assertPublicJob(job, jobs[i]!));
    assert.equal(status.generation, 2); assert.deepEqual(status.source, source);
    assert.deepEqual(status.files, [{ path: 'notes/nativeTaskId.md', bytes: Buffer.byteLength(residentText) }]);
    assert.equal(f.memory.resident().text, `<file path="notes/nativeTaskId.md">\n${residentText}\n</file>`);
    assert.deepEqual(f.memory.jobs(), jobs);
    const view = status.jobs[0]!; view.error = '只修改公开副本';
    assert.equal(f.memory.jobs()[0]!.error, null);
  } finally { f.close(); }
});

test('私有绑定仍用于同源去重，重启恢复保留绑定并允许新重试任务', () => {
  const f = fixture();
  try {
    f.archive('synthetic-restart');
    const job = f.memory.newJob('synthetic-restart');
    f.memory.bind(job.id, privateMarker);
    assert.equal(f.memory.newJob(job.runId).id, job.id);
    assert.equal(f.memory.newJob(job.runId).nativeTaskId, privateMarker);
    assert.equal(f.memory.jobs().length, 1);
    const reopened = new DatabaseSync(path.join(f.directory, 'synthetic.sqlite'));
    try {
      const restored = new ProjectMemory(new RuntimeStore(reopened), f.directory);
      const interrupted = restored.jobs()[0]!;
      assert.equal(interrupted.id, job.id); assert.equal(interrupted.nativeTaskId, privateMarker);
      assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.error, 'process_interrupted');
      assertPublicJob(restored.status().jobs[0], interrupted);
      const retry = restored.newJob(job.runId);
      assert.notEqual(retry.id, job.id); assert.equal(retry.nativeTaskId, null);
      restored.bind(retry.id, `${privateMarker}-retry`);
      assert.equal(restored.newJob(job.runId).id, retry.id);
      assert.equal(restored.jobs().length, 2);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('真实 Hono GET /memory 与 resident 保留业务内容且不公开任务绑定', async () => {
  const f = routeFixture();
  try {
    const source = f.archive('synthetic-http-source');
    f.store.setSetting('memory-version', { ...f.memory.version(), generation: 3, source: { contextId: source.contextId, runId: source.runId, sequence: source.sequence } });
    new MemoryFiles(f.memory.version().filesDirectory).write('nativeTaskId.md', residentText);
    const job = f.memory.newJob(source.runId); f.memory.bind(job.id, privateMarker);
    const response = await f.request('/memory'); assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.enabled, true); assert.equal(value.generation, 3);
    assert.deepEqual(value.source, { contextId: source.contextId, runId: source.runId, sequence: source.sequence });
    assert.deepEqual(value.files, [{ path: 'nativeTaskId.md', bytes: Buffer.byteLength(residentText) }]);
    assertPublicJob(value.jobs[0], f.memory.jobs()[0]!);
    const resident = await f.request('/memory/resident'); assert.equal(resident.status, 200);
    assert.deepEqual(await resident.json(), { version: 'initial', text: `<file path="nativeTaskId.md">\n${residentText}\n</file>` });
    assert.equal((await f.request('/memory', undefined, false)).status, 401);
  } finally { f.close(); }
});

test('真实 Hono request 与 failed/interrupted retry 统一投影异步返回，保留入队去重', async () => {
  const f = routeFixture();
  try {
    f.archive('synthetic-http-request');
    let response = await f.request('/memory/requests', { runId: 'synthetic-http-request' }); assert.equal(response.status, 202);
    let value = await response.json();
    let privateJob = f.memory.jobs().find(row => row.id === value.id)!;
    assertPublicJob(value, privateJob); assert.equal(f.enqueued(), 1);
    response = await f.request('/memory/requests', { runId: privateJob.runId }); assert.equal(response.status, 202);
    assertPublicJob(await response.json(), privateJob); assert.equal(f.enqueued(), 1);
    for (const status of ['failed', 'interrupted'] as const) {
      f.store.setSetting('memory-jobs', f.memory.jobs().map(row => row.id === privateJob.id ? { ...row, status, error: `可操作错误\n${business}` } : row));
      response = await f.request(`/memory/jobs/${privateJob.id}/retry`, {}); assert.equal(response.status, 202);
      value = await response.json(); assert.notEqual(value.id, privateJob.id);
      const next = f.memory.jobs().find(row => row.id === value.id)!;
      assertPublicJob(value, next);
      const memoryResponse = await f.request('/memory'); assert.equal(memoryResponse.status, 200);
      const publicStatus = await memoryResponse.json();
      for (const job of f.memory.jobs()) assertPublicJob(publicStatus.jobs.find((row: { id: string }) => row.id === job.id), job);
      privateJob = next;
    }
    assert.equal(f.enqueued(), 3); assert.equal(f.memory.jobs().length, 3);
    assert.ok(f.memory.jobs().every(row => row.nativeTaskId?.startsWith(privateMarker)));
  } finally { f.close(); }
});

test('loopback HTTP 实际传输的查询、入队及 retry 响应不携带私有绑定', { timeout: 15_000 }, async () => {
  const f = routeFixture();
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: 'Bearer synthetic-memory-http-control-token', 'Content-Type': 'application/json' };
    f.archive('synthetic-loopback');
    const admitted = await fetch(`${origin}/memory/requests`, { method: 'POST', headers, body: JSON.stringify({ runId: 'synthetic-loopback' }) });
    assert.equal(admitted.status, 202);
    const first = await admitted.json(); assertPublicJob(first, f.memory.jobs()[0]!);
    f.memory.rejectAdmission(first.id, `请稍后重试\n${business}`);
    const status = await fetch(`${origin}/memory`, { headers }); assert.equal(status.status, 200);
    assertPublicJob((await status.json()).jobs[0], f.memory.jobs()[0]!);
    const retried = await fetch(`${origin}/memory/jobs/${first.id}/retry`, { method: 'POST', headers, body: '{}' });
    assert.equal(retried.status, 202);
    const next = await retried.json(); assertPublicJob(next, f.memory.jobs().find(job => job.id === next.id)!);
    assert.notEqual(first.id, next.id); assert.equal(f.enqueued(), 2);
    const missing = await fetch(`${origin}/memory/jobs/unknown/retry`, { method: 'POST', headers, body: '{}' });
    assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: 'memory_job_not_found' });
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
    f.close();
  }
});

test('真实 Hono 请求失败、retry 合法性及认证边界不变', async () => {
  const f = routeFixture();
  try {
    const assertError = async (response: Response, status: number, error: string) => { assert.equal(response.status, status); assert.deepEqual(await response.json(), { error }); };
    await assertError(await f.request('/memory/requests', {}), 400, 'invalid_request');
    await assertError(await f.request('/memory/requests', { runId: 'missing', nativeTaskId: 'business' }), 400, 'invalid_request');
    await assertError(await f.app.request('/memory/requests', { method: 'POST', headers: { Authorization: 'Bearer synthetic-memory-http-control-token', 'Content-Type': 'application/json' }, body: '{' }), 400, 'invalid_json');
    await assertError(await f.request('/memory/requests', { runId: 'missing' }), 409, 'context_snapshot_unavailable');
    f.archive('synthetic-admission-failure'); f.failNext();
    await assertError(await f.request('/memory/requests', { runId: 'synthetic-admission-failure' }), 503, 'synthetic_queue_unavailable');
    const failed = f.memory.jobs()[0]!; assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'synthetic_queue_unavailable');
    const retry = await f.request(`/memory/jobs/${failed.id}/retry`, {}); assert.equal(retry.status, 202);
    const retried = await retry.json(); assertPublicJob(retried, f.memory.jobs().find(row => row.id === retried.id)!);
    for (const status of ['pending', 'running', 'succeeded', 'superseded'] as const) {
      f.store.setSetting('memory-jobs', [{ ...f.memory.jobs().find(row => row.id === retried.id)!, status }]);
      await assertError(await f.request(`/memory/jobs/${retried.id}/retry`, {}), 409, 'memory_job_not_retryable');
    }
    await assertError(await f.request(`/memory/jobs/${privateMarker}-1/retry`, {}), 404, 'memory_job_not_found');
    await assertError(await f.request('/memory/jobs/missing/retry', {}), 404, 'memory_job_not_found');
    await assertError(await f.request('/memory/requests', { runId: 'synthetic-admission-failure' }, false), 401, 'authentication_required');
    await assertError(await f.request(`/memory/jobs/${retried.id}/retry`, {}, false), 401, 'authentication_required');
    assert.equal(f.enqueued(), 1);
  } finally { f.close(); }
});
