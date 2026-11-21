import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { AppError } from '../src/domain.js';
import { createApp } from '../src/http.js';
import { finished, removeTemp, scriptedModel, until } from './helpers.js';

function zip(text: string) {
  const bytes = Buffer.from(text), name = Buffer.from('conversations-000.json');
  let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}
test('鉴权导入本地ZIP后，新会话注入近期原文，导入不伪造原生受理', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-import-core-'));
  const prompts: string[] = [], model = scriptedModel({ onCall: text => prompts.push(text) });
  const core = await Core.open({ dataDir: directory, model: model.model, memoryContextMode: 'v1', memoryEnabled: false });
  t.after(async () => { await core.close(); await removeTemp(directory); });
  const archivePath = path.join(directory, 'input.zip');
  fs.writeFileSync(archivePath, zip(JSON.stringify([{ id: 'history', current_node: 'u', mapping: { root: { id: 'root', parent: null, message: null }, u: { id: 'u', parent: 'root', message: { id: 'historic-user', author: { role: 'user' }, create_time: Date.now() / 1000, content: { content_type: 'text', parts: ['原始输入：目前使用青色背景。  '] } } } } }])));
  const app = createApp(core), body = { archivePath, namespace: 'example', sourceRef: 'export', conversation: { index: 0 } };
  assert.equal((await app.request('/memory/imports', { method: 'POST', body: JSON.stringify(body) })).status, 401);
  const request = () => app.request('/memory/imports', { method: 'POST', headers: { authorization: `Bearer ${core.controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await request(); assert.equal(response.status, 201);
  const receipt = await response.json() as { organized: boolean; counts: { evidenceRecords: number } };
  assert.equal(receipt.organized, false); assert.equal(receipt.counts.evidenceRecords, 1);
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM signals').get()!.n, 0);
  assert.equal(core.projectMemory.jobs().length, 0);
  assert.equal((await request()).status, 201);
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM memory_v1_import_messages').get()!.n, 1);
  const signal = await core.submitMessage({ content: '你好' }); await finished(core, signal.runId!);
  assert.ok(prompts.some(prompt => prompt.includes('原始输入：目前使用青色背景。  ')));
  assert.equal(core.memoryV1RunView(signal.runId!)!.recent.selected.filter(row => row.origin.system === 'import').length, 1);
  assert.equal(core.runtime.tasks().length, 0);
});

async function importAdmissionFixture(t: test.TestContext) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-independent-import-')); const scripted = scriptedModel(); const core = await Core.open({ dataDir: directory, model: scripted.model, concurrency: 1, memoryContextMode: 'v1', memoryEnabled: true }); t.after(async () => { await core.close(); await removeTemp(directory); }); const archivePath = path.join(directory, 'synthetic.zip'); fs.writeFileSync(archivePath, zip(JSON.stringify([{ id: 'synthetic-history', current_node: 'u', mapping: { r: { id: 'r', parent: null, message: null, children: ['u'] }, u: { id: 'u', parent: 'r', children: [], message: { id: 'synthetic-user', author: { role: 'user' }, create_time: Date.now() / 1000, content: { content_type: 'text', parts: ['Synthetic review source.'] } } } } }]))); return { core, scripted, input: { archivePath, namespace: 'synthetic', sourceRef: 'independent', conversation: { index: 0 }, organize: true, expectedHead: core.projectMemory.version().id } }; }
test('import manager enqueue failure closes the pending job and preserves raw private import without native user acceptance', async (t) => { const f = await importAdmissionFixture(t), manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!, enqueue = manager.enqueue.bind(manager); manager.enqueue = async () => { throw new AppError('synthetic_admission_denied', 409); }; try {
    await assert.rejects(f.core.importMemory(f.input), /synthetic_admission_denied/);
    const job = f.core.projectMemory.jobs().at(-1)!;
    assert.equal(job.status, 'failed');
    assert.equal(job.nativeTaskId, null);
    assert.equal(f.core.store.db.prepare('SELECT COUNT(*) n FROM signals').get()!.n, 0);
    assert.equal(f.core.store.db.prepare('SELECT COUNT(*) n FROM memory_v1_import_messages').get()!.n, 1);
}
finally {
    manager.enqueue = enqueue;
} });
test('actual manager cancel before import bind is reconciled immediately and cannot leave a permanently pending job', async (t) => { const f = await importAdmissionFixture(t), manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const blocker = await manager.enqueue({ runId: 'synthetic-blocker', toolName: 'independent-review-blocker', toolCallId: 'synthetic-blocker', agentId: 'independent-review', args: {}, maxRetries: 0 }, { executor: { execute: () => gate } }); await until(() => manager.getTask(blocker.task.id), task => task?.status === 'running'); const enqueue = manager.enqueue.bind(manager); manager.enqueue = async (...args) => { const result = await enqueue(...args); if (args[0].toolName === 'organize-memory-v1') {
    assert.equal((await manager.getTask(result.task.id))!.status, 'pending');
    await manager.cancel(result.task.id);
} return result; }; try {
    const imported = await f.core.importMemory(f.input);
    assert.ok('job' in imported);
    const job = await until(() => f.core.projectMemory.jobs().find(row => row.id === imported.job!.id), row => !!row && !['pending', 'running'].includes(row.status));
    assert.equal(job!.status, 'interrupted');
    assert.equal(job!.error, 'memory_native_cancelled');
    const native = await manager.getTask(job!.nativeTaskId!);
    assert.equal(native!.status, 'cancelled');
    assert.equal(native!.agentId, 'memory-organizer');
    assert.ok(native!.toolCallId.startsWith('memory-v1:import:'));
    assert.equal(f.core.projectMemory.version().generation, 0);
}
finally {
    manager.enqueue = enqueue;
    release();
} });
test('disabling memory during imported task admission cancels its queued task before executor entry', async (t) => { const f = await importAdmissionFixture(t), manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const blocker = await manager.enqueue({ runId: 'synthetic-blocker', toolName: 'independent-review-blocker', toolCallId: 'synthetic-blocker', agentId: 'independent-review', args: {}, maxRetries: 0 }, { executor: { execute: () => gate } }); await until(() => manager.getTask(blocker.task.id), task => task?.status === 'running'); const enqueue = manager.enqueue.bind(manager); manager.enqueue = async (...args) => { const result = await enqueue(...args); if (args[0].toolName === 'organize-memory-v1')
    f.core.configure('runtime', { memoryEnabled: false }); return result; }; try {
    const imported = await f.core.importMemory(f.input);
    assert.ok('job' in imported);
    await new Promise(resolve => setTimeout(resolve, 50));
    const job = f.core.projectMemory.jobs().find(row => row.id === imported.job!.id)!;
    const native = await manager.getTask(job.nativeTaskId!);
    assert.equal(native!.status, 'cancelled');
    assert.equal(job.status, 'interrupted');
}
finally {
    manager.enqueue = enqueue;
    release();
} });
