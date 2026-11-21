import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { removeTemp, scriptedModel } from './helpers.js';

async function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-management-lifecycle-'));
  const directory = fs.realpathSync(temporary);
  const core = await Core.open({ dataDir: directory, model: scriptedModel().model, memoryEnabled: false });
  const http = createApp(core);
  const request = (route: string, method = 'GET', body?: unknown) => http.request(route, { method, headers: { Authorization: `Bearer ${core.controlToken}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { directory, core, request, async close() { await core.close(); await removeTemp(temporary); } };
}

test('management mutations reject a stale storage or instance before changing state', async () => {
  const f = await fixture();
  try {
    const http = createApp(f.core);
    for (const [storage, instance, expected] of [
      ['other-storage', f.core.instanceId, 'core_storage_changed'],
      [f.core.storageId, 'old-instance', 'core_instance_changed'],
    ]) {
      const response = await http.request('/contexts', { method: 'POST', headers: { Authorization: `Bearer ${f.core.controlToken}`, 'Content-Type': 'application/json', 'X-ShittimChest-Storage-Id': storage!, 'X-ShittimChest-Instance-Id': instance! }, body: JSON.stringify({ id: 'chat.must-not-exist', name: 'Blocked' }) });
      assert.equal(response.status, 409); assert.equal((await response.json() as { error: string }).error, expected);
      assert.equal(f.core.runtime.context('chat.must-not-exist'), undefined);
    }
  } finally { await f.close(); }
});

test('workspace path repair resets used native sessions and reads the moved directory', async () => {
  const f = await fixture();
  try {
    const original = path.join(f.directory, 'original'); fs.mkdirSync(original); fs.writeFileSync(path.join(original, 'result.txt'), 'moved data');
    f.core.capabilities.saveRoot({ id: 'project', name: 'Project', path: original });
    const context = f.core.createWorkContext({ name: 'Worker', workspaceId: 'project' });
    const session = await f.core.sessions.get(context);
    const first = await f.core.runWorkflow('verify-files', { paths: ['result.txt'] }, context.id); assert.equal(first.status, 'success');
    const paused = f.core.runtime.createTask({ title: 'Paused', content: 'Waiting', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'paused', grants: { write: true, execute: true, mcp: true } });
    const duty = f.core.scheduleCreate({ version: 2, name: 'Duty', task: 'Read a file', contextId: context.id, timing: { kind: 'once', at: '2099-01-01T00:00:00Z' } }, 'workspace-move-duty', 'main');
    f.core.runtime.setSetting(`duty-grants:${duty.id}`, { write: true, execute: true, mcp: true });
    const moved = path.join(f.directory, 'moved'); fs.renameSync(original, moved);
    const response = await f.request('/workspaces/project', 'PATCH', { path: moved, name: 'Moved', expectedPath: original });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { id: 'project', name: 'Moved', path: moved });
    assert.notEqual(await f.core.sessions.get(context), session);
    assert.deepEqual(f.core.runtime.task(paused.id).grants, { write: false, execute: false, mcp: true });
    assert.deepEqual(f.core.runtime.setting(`duty-grants:${duty.id}`, {}), { write: false, execute: false, mcp: true });
    const result = await f.core.runWorkflow('verify-files', { paths: ['result.txt'] }, context.id); assert.equal(result.status, 'success');
    assert.equal((await f.request('/workspaces/project', 'PATCH', { path: original, expectedPath: original })).status, 409);
    assert.equal((await f.request('/workspaces/project', 'DELETE')).status, 409);
    assert.equal((await f.request('/workspaces/default', 'DELETE')).status, 409);
    const unused = path.join(f.directory, 'unused'); fs.mkdirSync(unused);
    f.core.capabilities.saveRoot({ id: 'unused', name: 'Unused', path: unused });
    assert.equal((await f.request('/workspaces/unused', 'DELETE')).status, 200);
    assert.ok(fs.existsSync(unused));
  } finally { await f.close(); }
});

test('workspace migration fences new tasks, contexts and workflows while resetting sessions', async () => {
  const f = await fixture();
  try {
    const before = path.join(f.directory, 'before'); const after = path.join(f.directory, 'after'); fs.mkdirSync(before); fs.mkdirSync(after);
    f.core.capabilities.saveRoot({ id: 'project', name: 'Project', path: before });
    const context = f.core.createWorkContext({ name: 'Worker', workspaceId: 'project' });
    let entered!: () => void; let release!: () => void;
    const seen = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const reset = f.core.sessions.reset.bind(f.core.sessions);
    f.core.sessions.reset = async id => { entered(); await gate; await reset(id); };
    const pending = f.core.updateWorkspace('project', { path: after, expectedPath: before });
    try {
      await seen;
      assert.throws(() => f.core.createWorkContext({ name: 'Blocked', workspaceId: 'project' }), /workspace_busy/);
      await assert.rejects(f.core.runWorkflow('verify-files', { paths: ['result.txt'] }, context.id), /context_busy/);
      await assert.rejects(f.core.submitTask({ title: 'Blocked', content: 'Read', contextId: context.id }, 'blocked-move'), /context_busy/);
      assert.equal(f.core.runtime.tasks({ contextId: context.id }).length, 0);
      await assert.rejects(f.core.updateWorkspace('project', { path: after, expectedPath: before }), /workspace_busy/);
    } finally { release(); await pending; }
    assert.equal(f.core.capabilities.root('project').path, after);
  } finally { await f.close(); }
});

test('workspace moves reject active task owners before clearing their sessions', async () => {
  const f = await fixture();
  try {
    const before = path.join(f.directory, 'before'); const after = path.join(f.directory, 'after'); fs.mkdirSync(before); fs.mkdirSync(after);
    f.core.capabilities.saveRoot({ id: 'project', name: 'Project', path: before });
    const context = f.core.createWorkContext({ name: 'Worker', workspaceId: 'project' });
    const session = await f.core.sessions.get(context);
    f.core.runtime.createTask({ title: 'Waiting', content: 'Waiting', contextId: context.id, returnContextId: 'main', sourceSignalIds: [], status: 'waiting' });
    await assert.rejects(f.core.updateWorkspace('project', { path: after, expectedPath: before }), /workspace_busy/);
    assert.equal(f.core.capabilities.root('project').path, before);
    assert.equal(f.core.sessions.peek(context.id), session);
  } finally { await f.close(); }
});

test('method revision discovery exposes saved snapshots and the restored revision', async () => {
  const f = await fixture();
  try {
    const evidence = f.core.runtime.createTask({ title: 'Verified', content: 'Verified', contextId: 'main', returnContextId: 'main', sourceSignalIds: [], status: 'succeeded', report: { outcome: 'succeeded', summary: 'Done', checks: [{ description: 'Checked', passed: true }], deliveries: [], unresolved: [] } });
    const method = { name: 'verified', description: 'Description', instructions: 'Original', references: {}, evidenceTaskIds: [evidence.id] };
    f.core.methods.save(method); f.core.methods.save({ ...method, instructions: 'Revised' }, 1);
    let response = await f.request('/methods/verified/revisions'); assert.equal(response.status, 200);
    let body = await response.json() as { revisions: { revision: number; instructions: string }[] };
    assert.deepEqual(body.revisions.map(value => value.revision), [2, 1]); assert.equal(body.revisions[1]!.instructions, 'Original');
    response = await f.request('/methods/verified/rollback', 'POST', { revision: 2, restoreRevision: 1 }); assert.equal(response.status, 200);
    response = await f.request('/methods/verified/revisions'); body = await response.json() as typeof body;
    assert.deepEqual(body.revisions.map(value => value.revision), [3, 2, 1]); assert.equal(body.revisions[0]!.instructions, 'Original');
    assert.equal((await f.request('/methods/missing/revisions')).status, 404);
  } finally { await f.close(); }
});


test('workspace migration refuses workflows already admitted before the path change', async () => {
  const f = await fixture();
  try {
    const before = path.join(f.directory, 'before'); const after = path.join(f.directory, 'after'); fs.mkdirSync(before); fs.mkdirSync(after); fs.writeFileSync(path.join(before, 'result.txt'), 'data');
    f.core.capabilities.saveRoot({ id: 'project', name: 'Project', path: before });
    const context = f.core.createWorkContext({ name: 'Worker', workspaceId: 'project' });
    let entered!: () => void; let release!: () => void;
    const seen = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const workflow = f.core.workflows['verify-files']; const createRun = workflow.createRun.bind(workflow);
    workflow.createRun = (async (...args: Parameters<typeof createRun>) => { entered(); await gate; return createRun(...args); }) as typeof workflow.createRun;
    const running = f.core.runWorkflow('verify-files', { paths: ['result.txt'] }, context.id);
    try { await seen; await assert.rejects(f.core.updateWorkspace('project', { path: after, expectedPath: before }), /workspace_busy/); }
    finally { release(); assert.equal((await running).status, 'success'); }
    assert.equal(f.core.capabilities.root('project').path, before);
  } finally { await f.close(); }
});

test('method revision discovery includes validated legacy archives and rejects linked archives', async () => {
  const f = await fixture();
  try {
    const evidence = f.core.runtime.createTask({ title: 'Verified', content: 'Verified', contextId: 'main', returnContextId: 'main', sourceSignalIds: [], status: 'succeeded', report: { outcome: 'succeeded', summary: 'Done', checks: [{ description: 'Checked', passed: true }], deliveries: [], unresolved: [] } });
    const first = f.core.methods.save({ name: 'archived', description: 'Description', instructions: 'Original', references: {}, evidenceTaskIds: [evidence.id] });
    f.core.methods.control('archived', false, 1);
    f.core.runtime.db.prepare('DELETE FROM method_revisions WHERE name=? AND revision=1').run('archived');
    const directory = path.join(f.core.dataDir, 'methods', 'archived'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '1.json'), JSON.stringify(first));
    assert.deepEqual(f.core.methods.revisions('archived').map(record => record.revision), [2, 1]);
    fs.unlinkSync(path.join(directory, '1.json')); const linked = path.join(f.directory, 'linked.json'); fs.writeFileSync(linked, JSON.stringify(first)); fs.linkSync(linked, path.join(directory, '1.json'));
    assert.throws(() => f.core.methods.revisions('archived'), /invalid_method_archive/);
  } finally { await f.close(); }
});
