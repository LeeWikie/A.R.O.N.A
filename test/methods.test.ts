import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { InlineSkillSource } from '@mastra/core/skills';
import { RequestContext } from '@mastra/core/request-context';
import { RuntimeStore } from '../src/runtime-store.js';
import { Capabilities } from '../src/capabilities.js';
import { Methods } from '../src/methods.js';
import { bindWorkflowContext, createWorkflows, workflowInvocationSchema, workflowCatalog } from '../src/workflows.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-method-'));
  const db = new DatabaseSync(':memory:'); const store = new RuntimeStore(db);
  const task = store.createTask({ title: 'Fixture', content: 'Fixture', contextId: 'work', returnContextId: 'main', sourceSignalIds: [] });
  const report = { outcome: 'succeeded' as const, summary: 'Verified fixture', checks: [{ description: 'Checked', passed: true }], deliveries: [], unresolved: [] };
  store.updateTask(task.id, { status: 'succeeded', report });
  const methods = new Methods(store, path.join(dir, 'methods'));
  const input = { name: 'fixture-method', description: 'Apply to a fixture', instructions: 'Read and check the named fixture.', references: { 'guide.txt': 'Check the current fixture.' }, evidenceTaskIds: [task.id] };
  return { dir, db, store, task, report, methods, input, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('verified methods are loaded natively, revised, disabled and rolled back', async () => {
  const f = fixture(); try {
    assert.equal(f.methods.save(f.input).revision, 1);
    const source = new InlineSkillSource(f.methods.skills());
    assert.match(String(await source.readFile('inline/fixture-method/SKILL.md')), /Read and check the named fixture/);
    assert.equal(await source.readFile('inline/fixture-method/references/guide.txt'), 'Check the current fixture.');
    assert.equal(f.methods.save({ ...f.input, instructions: 'Check a different fixture.' }, 1).revision, 2);
    assert.throws(() => f.methods.save(f.input, 1), /method_revision_conflict/);
    assert.equal(f.methods.control(f.input.name, false, 2).revision, 3);
    assert.equal(f.methods.skills().length, 0);
    const restored = f.methods.rollback(f.input.name, 1, 3);
    assert.equal(restored.revision, 4); assert.equal(restored.instructions, f.input.instructions); assert.equal(restored.enabled, true);
    assert.equal(f.methods.skills().length, 1);
    assert.throws(() => f.methods.rollback(f.input.name, 1, 3), /method_revision_conflict/);
    assert.throws(() => f.methods.save({ ...f.input, name: 'new-method' }, 2), /method_revision_conflict/);
  } finally { f.close(); }
});

test('method evidence, paths and legacy archive links are checked', () => {
  const f = fixture(); try {
    for (const status of ['running', 'failed', 'interrupted', 'cancelled'] as const) {
      f.store.updateTask(f.task.id, { status, report: f.report });
      assert.throws(() => f.methods.save(f.input), /method_requires_verified_work/);
    }
    f.store.updateTask(f.task.id, { status: 'succeeded', report: { ...f.report, unresolved: ['not resolved'] } });
    assert.throws(() => f.methods.save(f.input), /method_requires_verified_work/);
    f.store.updateTask(f.task.id, { status: 'succeeded', report: f.report });
    for (const ref of ['../outside', '/absolute', 'a/../b', 'a//b', 'a' + String.fromCharCode(92) + 'b', 'C:foo']) {
      assert.throws(() => f.methods.save({ ...f.input, references: { [ref]: 'x' } }), /invalid_method_reference/);
    }
    const saved = f.methods.save(f.input);
    f.store.db.prepare('DELETE FROM method_revisions WHERE name=? AND revision=?').run(saved.name, saved.revision);
    const archive = path.join(f.dir, 'methods', saved.name); fs.mkdirSync(archive, { recursive: true });
    const outside = path.join(f.dir, 'outside.json'); fs.writeFileSync(outside, JSON.stringify(saved)); fs.linkSync(outside, path.join(archive, '1.json'));
    assert.throws(() => f.methods.rollback(saved.name, 1, 1), /invalid_method_archive/);
    assert.throws(() => f.methods.rollback('../outside', 1, 1), /invalid_method_revision/);
    assert.equal(f.methods.get(saved.name).revision, 1);
  } finally { f.close(); }
});

test('verify-files hashes only files in a trusted worker scope', async () => {
  const f = fixture(); const capabilities = new Capabilities(f.store, f.dir);
  try {
    f.store.createContext({ id: 'worker', name: 'Worker', role: 'work' });
    f.store.createContext({ id: 'other', name: 'Other', role: 'work' });
    const root = capabilities.root('default').path;
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'synthetic data');
    fs.writeFileSync(path.join(root, '.env'), 'synthetic secret');
    const outside = path.join(f.dir, 'outside.txt'); fs.writeFileSync(outside, 'outside');
    fs.linkSync(outside, path.join(root, 'linked.txt'));
    const workflow = createWorkflows(f.store, capabilities)['verify-files'];
    const start = async (inputData: { paths: string[]; contextId?: string }, contextId?: string) => {
      const requestContext = new RequestContext(); if (contextId) bindWorkflowContext(requestContext, contextId);
      return (await workflow.createRun()).start({ inputData, requestContext });
    };
    const good = await start({ paths: ['fixture.txt'] }, 'worker');
    assert.equal(good.status, 'success', JSON.stringify(good));
    if (good.status === 'success') assert.deepEqual(good.result.files, [{ path: 'fixture.txt', bytes: 14, sha256: createHash('sha256').update('synthetic data').digest('hex') }]);
    for (const [input, scope] of [[{ paths: ['fixture.txt'], contextId: 'worker' }, undefined], [{ paths: ['fixture.txt'], contextId: 'other' }, 'worker'], [{ paths: ['../outside.txt'] }, 'worker'], [{ paths: ['.env'] }, 'worker'], [{ paths: ['linked.txt'] }, 'worker'], [{ paths: ['.'] }, 'worker']] as const) {
      const result = await start({ ...input, paths: [...input.paths] }, scope); assert.notEqual(result.status, 'success', JSON.stringify(result));
    }
    f.store.updateContext('worker', { archived: true });
    assert.notEqual((await start({ paths: ['fixture.txt'] }, 'worker')).status, 'success');
  } finally { await capabilities.close(); f.close(); }
});


test('workflow discovery and invocation expose the same native input contract',()=>{
  const descriptor=workflowCatalog.find(item=>item.id==='verify-files')!;
  assert.ok('paths' in (descriptor.inputSchema.properties??{}));
  assert.equal(workflowInvocationSchema.safeParse({id:'verify-files',input:{paths:['result.txt']}}).success,true);
  assert.equal(workflowInvocationSchema.safeParse({id:'verify-files',input:{operation:'copy',execute:false}}).success,false);
});
