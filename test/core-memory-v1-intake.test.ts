import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Core } from '../src/core.js';
import { Store } from '../src/store.js';
import { MemoryV1Intake } from '../src/memory/v1/intake.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { finished, until, removeTemp } from './helpers.js';

function fixture() {
  let fail = false; let calls = 0; let gate: Promise<void> | undefined; const prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    calls++; prompts.push(JSON.stringify(request.prompt));
    if (gate) { const wait = gate; gate = undefined; await wait; }
    if (fail) throw new Error('synthetic failure');
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      c.enqueue({ type: 'text-start', id: 'text' }); c.enqueue({ type: 'text-delta', id: 'text', delta: '合成回复' }); c.enqueue({ type: 'text-end', id: 'text' });
      c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) };
  } });
  return { model, prompts, calls: () => calls, pause: () => { let resolve!: () => void; gate = new Promise<void>(done => { resolve = done; }); return resolve; }, fail: () => { fail = true; } };
}
async function setup(t: test.TestContext, shadow = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-v1-intake-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false, ...(shadow ? { memoryContextMode: 'shadow' } : {}) });
  t.after(async () => { await core.close(); await removeTemp(dir); });
  return { core, dir, f };
}
async function send(core: Core, contextId: string, content: string) {
  const receipt = await core.submitMessage({ contextId, content }); await finished(core, receipt.runId!);
  if (core.memoryV1Status().mode === 'shadow') await until(() => core.memoryV1Status(), value => value.intake?.diagnostics.every(d => d.code !== 'awaiting-stable-source') === true);
  return receipt;
}

test('Store真实受理事务内登记，观察失败不保留假收据或资料义务', () => {
  const store = new Store(':memory:'); const intake = new MemoryV1Intake(store, 'test:scope');
  try {
    const signal = { id: 'signal-a', contextId: 'main', type: 'user-message' as const, source: 'authenticated-control', content: '  原文\r\n', output: { kind: 'none' as const, contextId: 'main' } };
    store.receive(signal);
    store.acceptanceObserver = receipt => { intake.accept(receipt); assert.equal(store.db.isTransaction, true); throw new Error('observer rollback'); };
    assert.throws(() => store.accept(signal.id, signal.id, 'run-a', 'wake', 'main'), /observer rollback/);
    assert.equal(store.getSignal(signal.id)!.status, 'received'); assert.equal(store.getRun('run-a'), undefined); assert.equal(intake.status().accepted, 0);
    store.acceptanceObserver = intake.accept;
    store.accept(signal.id, signal.id, 'run-a', 'wake', 'main');
    assert.equal(intake.status().accepted, 1); assert.equal(intake.status().pendingSource, 1);
  } finally { store.close(); }
});

test('真实Core shadow成功后材料化、不新增模型、信号、legacy任务或当前版本', async t => {
  const { core, f } = await setup(t); const resident = core.projectMemory.resident();
  const receipt = await send(core, 'main', '  真正原文\r\n尾空白  ');
  const status = core.memoryV1Status(); assert.equal(status.activeV1, false); assert.equal(status.intake!.accepted, 1); assert.equal(status.intake!.materialized, 1);
  assert.equal(core.projectMemory.jobs().length, 0); assert.deepEqual(core.projectMemory.resident(), resident); assert.equal(f.calls(), 1);
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM signals').get()!.n, 1);
  assert.ok(core.memoryV1RunView(receipt.runId!));
  const ids = core.store.db.prepare('SELECT evidence_id FROM memory_v1_source_refs').all(); assert.ok(ids.length >= 2);
});

test('稳定失败、缺snapshot、null槽和Source.gaps都保留可重试资料义务', async t => {
  const { core, f } = await setup(t);
  const first = await send(core, 'main', '有来源');
  const prepare = core.prepareMemorySource.bind(core); const source = await prepare(first.runId!);
  core.prepareMemorySource = async () => ({ ...source, contents: new Map([...source.contents].map(([id, value]) => [id, { ...value, partBindings: null }])) });
  await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 1); assert.ok(core.memoryV1Status().intake!.diagnostics[0]!.unmapped > 0);
  core.prepareMemorySource = async () => ({ ...source, contents: new Map([...source.contents].map(([id, value]) => [id, { ...value, partBindings: [{ partKey: 'body', slots: [{ kind: 'body' as const, ref: 'content:forged' }] }] }])) });
  await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 1);
  core.prepareMemorySource = async () => ({ ...source, gaps: [{ contextId: 'main', runId: first.runId!, reason: 'missing-source' }] });
  await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.diagnostics[0]!.gaps, 1);
  core.prepareMemorySource = prepare; await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 0);
  f.fail(); const failed = await send(core, 'main', '失败但已接收');
  assert.equal(core.store.getRun(failed.runId!)!.status, 'failed'); assert.equal(core.memoryV1Status().intake!.accepted, 2);
  const originalSnapshot = core.store.db.prepare('SELECT * FROM model_snapshots WHERE run_id=?').get(first.runId!)!;
  core.store.db.prepare('DELETE FROM model_snapshots WHERE run_id=?').run(first.runId!);
  await core.reconcileMemoryV1(); assert.ok(core.memoryV1Status().intake!.diagnostics.some(d => d.runId === first.runId));
  core.store.db.prepare(`INSERT INTO model_snapshots(${Object.keys(originalSnapshot).join(',')}) VALUES(${Object.keys(originalSnapshot).map(() => '?').join(',')})`).run(...Object.values(originalSnapshot) as import('node:sqlite').SQLInputValue[]);
  await core.reconcileMemoryV1(); assert.ok(!core.memoryV1Status().intake!.diagnostics.some(d => d.runId === first.runId));
});

test('重启从真实受理对账，memoryEnabled=false不消除义务，不修改原文与来源证明', async t => {
  const { core, dir, f } = await setup(t, false);
  const receipt = await send(core, 'main', 'legacy接收仍待处理');
  const bodies = core.store.db.prepare('SELECT * FROM signals').all(); const snapshot = core.projectMemory.snapshot(receipt.runId!);
  await core.close();
  const reopened = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false, memoryContextMode: 'shadow' });
  t.after(() => reopened.close());
  assert.equal(reopened.memoryV1Status().intake!.accepted, 1); assert.equal(reopened.memoryV1Status().intake!.materialized, 1);
  assert.deepEqual(reopened.store.db.prepare('SELECT * FROM signals').all(), bodies); assert.deepEqual(reopened.projectMemory.snapshot(receipt.runId!), snapshot); assert.equal(f.calls(), 1);
  await reopened.close();
});

test('真实Core受理观察失败与Store事务共同回滚，provider不运行未受理输入', async t => {
  const { core, f } = await setup(t);
  core.store.db.exec("CREATE TRIGGER reject_shadow_intake BEFORE INSERT ON memory_v1_intake BEGIN SELECT RAISE(ABORT,'synthetic intake failure'); END;");
  await assert.rejects(core.submitMessage({ content: '不应形成受理' }));
  assert.equal(core.memoryV1Status().intake!.accepted, 0); assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n, 0);
  assert.equal(core.store.db.prepare("SELECT COUNT(*) n FROM signals WHERE status='accepted'").get()!.n, 0); assert.equal(f.calls(), 0);
  core.store.db.exec('DROP TRIGGER reject_shadow_intake');
});

test('根用户与执行别名共享nativeId时同事务分别登记，但材料只有一份根原文', async t => {
  const { core } = await setup(t); const original = '  根事实\r\n';
  const row = await core.submitSignal({ source: 'fixture', type: 'user-message', content: original, output: { kind: 'artifact', contextId: 'main' } }); await finished(core, row.runId!);
  await until(() => core.memoryV1Status(), status => status.intake!.diagnostics.every(d => d.runId !== row.runId || d.code !== 'awaiting-stable-source'));
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM memory_v1_intake WHERE run_id=?').get(row.runId!)!.n, 2);
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM signals WHERE native_id=?').get(row.nativeSignalId!)!.n, 2);
  const source = await core.prepareMemorySource(row.runId!); const users = source.records.filter(record => record.kind === 'user-statement');
  assert.equal(users.length, 1); assert.equal(Buffer.from(source.contents.get(users[0]!.contentRef)!.body).toString(), original);
  assert.equal(core.memoryV1Status().intake!.diagnostics.filter(d => d.runId === row.runId).length, 0);
});

test('真实中断仍材料化已受理用户资料，不以执行成功作为资料完成前提', async t => {
  const { core, f } = await setup(t); const release = f.pause();
  t.after(release);
  const row = await core.submitMessage({ content: '中断前真实受理' }); await until(() => f.calls(), calls => calls > 0);
  core.sessions.peek('main')!.abort(); release(); await finished(core, row.runId!);
  await core.reconcileMemoryV1(); assert.equal(core.store.getRun(row.runId!)!.status, 'interrupted');
  assert.equal(core.memoryV1Status().intake!.accepted, 1);
  const source = await core.prepareMemorySource(row.runId!); assert.ok(source.records.some(record => record.kind === 'user-statement'));
  assert.equal(core.memoryV1Status().intake!.pendingSource, 0);
});

test('真实附件元数据消失产生null槽，重启仍能按原受理补源而不洗写证明', async t => {
  const { core, dir, f } = await setup(t); const release = f.pause(); t.after(release);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
  const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(image); c.close(); } }), 'synthetic.png');
  const row = await core.submitMessage({ content: '含附件受理', attachments: [asset.id] }); await until(() => f.calls(), value => value > 0);
  const metadata = core.store.db.prepare('SELECT * FROM asset_records WHERE id=?').get(asset.id)!; core.store.db.prepare('DELETE FROM asset_records WHERE id=?').run(asset.id);
  release(); await finished(core, row.runId!); await core.reconcileMemoryV1();
  const source = await core.prepareMemorySource(row.runId!); const user = source.records.find(record => record.kind === 'user-statement')!;
  assert.equal(source.contents.get(user.contentRef)!.partBindings, null); assert.equal(core.memoryV1Status().intake!.pendingSource, 1);
  assert.ok(JSON.stringify(core.store.db.prepare('SELECT body FROM memory_v1_source_issues WHERE run_id=?').get(row.runId!)!).includes(user.id));
  const snapshot = core.projectMemory.snapshot(row.runId!); await core.close();
  const reopened = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false, memoryContextMode: 'shadow' }); t.after(() => reopened.close());
  assert.equal(reopened.memoryV1Status().intake!.pendingSource, 1);
  reopened.store.db.prepare(`INSERT INTO asset_records(${Object.keys(metadata).join(',')}) VALUES(${Object.keys(metadata).map(() => '?').join(',')})`).run(...Object.values(metadata) as import('node:sqlite').SQLInputValue[]);
  await reopened.reconcileMemoryV1(); assert.equal(reopened.memoryV1Status().intake!.pendingSource, 0); assert.deepEqual(reopened.projectMemory.snapshot(row.runId!), snapshot); assert.equal(f.calls(), 1);
  await reopened.close();
});

for (const mode of ['legacy', 'shadow'] as const) test(`显式开启记忆时${mode}保持既定隔离，legacy整理调用不退回`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-v1-legacy-')); const f = fixture(); let organizeCalls = 0; const commits = new Set<string>();
  Object.assign(f.model, { doGenerate: async (request: { prompt: unknown }) => {
    organizeCalls++; const runId = /来源运行是 ([0-9a-f-]{36})/.exec(JSON.stringify(request.prompt))?.[1]; assert.ok(runId);
    const commit = !commits.has(runId); commits.add(runId);
    return { content: commit ? [{ type: 'tool-call', toolName: 'memory_commit', toolCallId: `commit-${runId}`, input: JSON.stringify({ sourceRunId: runId, note: '合成来源' }) }] : [{ type: 'text', text: '完成' }], finishReason: commit ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: true, ...(mode === 'shadow' ? { memoryContextMode: mode } : {}) });
  t.after(async () => { await core.close(); await removeTemp(dir); });
  const row = await send(core, 'main', '合成整理原文');
  if (mode === 'legacy') { await until(() => core.projectMemory.jobs(), jobs => jobs.some(job => job.runId === row.runId && job.status === 'succeeded')); assert.ok(organizeCalls > 0); assert.equal(core.memoryV1Status().intake, null); }
  else { assert.equal(core.projectMemory.jobs().length, 0); assert.equal(organizeCalls, 0); assert.equal(core.memoryV1Status().intake!.materialized, 1); assert.equal(core.requestMemory('main', row.runId!, '合成明确请求', [row.id]).scheduled, false); }
});

test('受理后原始body变更保持可恢复冲突，不重写已登记内容绑定', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '受理时原文');
  const original = core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(row.id)!;
  const binding = core.store.db.prepare('SELECT body_hash FROM memory_v1_intake WHERE signal_id=?').get(row.id)!;
  core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(String(original.body)), content: '受理后篡改' }), row.id);
  const status = await core.reconcileMemoryV1(); assert.equal(status.intake!.pendingSource, 1); assert.equal(status.intake!.diagnostics[0]!.code, 'memory_intake_binding_conflict');
  assert.deepEqual(core.store.db.prepare('SELECT body_hash FROM memory_v1_intake WHERE signal_id=?').get(row.id), binding);
  core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(String(original.body), row.id);
  await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 0);
});

test('宿主来源索引不能修改Ledger规范身份，诊断数量有界且无原文', async t => {
  const { core } = await setup(t); await send(core, 'main', '不广播原文');
  const indexed = core.store.db.prepare('SELECT * FROM memory_v1_source_refs LIMIT 1').get()!;
  const location = JSON.parse(String(indexed.location_json)); location.contextId = 'forged-context';
  core.store.db.prepare('UPDATE memory_v1_source_refs SET location_json=? WHERE evidence_id=?').run(JSON.stringify(location), String(indexed.evidence_id));
  const intake = new MemoryV1Intake(core.store, `native:${core.storageId}`);
  assert.throws(() => intake.references(), /memory_intake_origin_conflict/);
  core.store.db.prepare('UPDATE memory_v1_source_refs SET location_json=? WHERE evidence_id=?').run(String(indexed.location_json), String(indexed.evidence_id));
  for (let i = 0; i < 55; i++) {
    const id = `synthetic-${i}`;
    core.store.receive({ id, contextId: 'synthetic', type: 'user-message', source: 'fixture', content: '不广播原文', output: { kind: 'none', contextId: 'main' } });
    core.store.accept(id, id, `synthetic-run-${i}`, 'wake', 'synthetic');
  }
  const status = core.memoryV1Status(); assert.equal(status.intake!.diagnostics.length, 50); assert.equal(status.intake!.diagnosticsTruncated, true); assert.equal(status.activeV1, false);
  assert.ok(!JSON.stringify(status).includes('不广播原文'));
});

test('真实结束时archive失败不会把整份不可用snapshot视为处理完成', async t => {
  const { core, dir, f } = await setup(t); const archive = core.projectMemory.archive.bind(core.projectMemory);
  core.projectMemory.archive = () => { throw new Error('synthetic unavailable snapshot'); };
  const row = await send(core, 'main', '有受理但快照不可用'); core.projectMemory.archive = archive;
  assert.equal(core.store.getRun(row.runId!)!.status, 'failed'); assert.equal(core.memoryV1Status().intake!.pendingSource, 1); assert.equal(core.memoryV1Status().intake!.materialized, 0);
  const signal = core.store.getSignal(row.id)!; assert.equal(signal.content, '有受理但快照不可用'); assert.ok(signal.nativeSignalId);
  await core.close();
  const reopened = await Core.open({ dataDir: dir, model: f.model, memoryContextMode: 'shadow', memoryEnabled: true }); t.after(() => reopened.close());
  assert.equal(reopened.memoryV1Status().intake!.pendingSource, 1); assert.equal(reopened.memoryV1Status().intake!.accepted, 1); assert.equal(reopened.memoryV1Status().organization, 'not-connected');
  assert.equal(f.calls(), 1); assert.equal(reopened.projectMemory.jobs().length, 0); await reopened.close();
});

test('原生任务恢复再次受理根原文保留首次规范定位，不重计来源或洗写旧证明', async t => {
  const { core } = await setup(t);
  const first = await core.submitSignal({ source: 'fixture', type: 'user-message', content: '重受理的同源根原文', output: { kind: 'artifact', contextId: 'main' } }); await finished(core, first.runId!);
  const task = await until(() => core.runtime.tasks().find(task => task.runIds.includes(first.runId!)), task => task?.status === 'unreported'); assert.ok(task);
  await core.reconcileMemoryV1();
  const before = core.store.db.prepare("SELECT * FROM memory_v1_source_refs WHERE json_extract(location_json,'$.recordId')=?").get(`signal:${first.id}:user-statement`)!; assert.ok(before);
  await core.tasks.control(task.id, 'resume', task.revision);
  const resumed = await until(() => core.runtime.task(task.id), task => task.runIds.length === 2 && task.status === 'unreported');
  await core.reconcileMemoryV1();
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM memory_v1_intake WHERE signal_id=?').get(first.id)!.n, 2);
  assert.deepEqual(core.store.db.prepare('SELECT * FROM memory_v1_source_refs WHERE evidence_id=?').get(String(before.evidence_id)), before);
  assert.equal(core.memoryV1Status().intake!.diagnostics.filter(d => resumed.runIds.includes(d.runId)).length, 0);
  const source = await core.prepareMemorySource(resumed.runIds[1]!); assert.equal(source.records.filter(record => record.kind === 'user-statement').length, 1);
  assert.ok(!core.memoryV1RunView(resumed.runIds[1]!)!.recent.selected.some(record => record.originalText === '重受理的同源根原文'));
});

for (const variant of ['native-hash', 'action'] as const) {
  const corrupt = (core: Core, signalId: string) => {
    if (variant === 'native-hash') {
      const row = core.store.db.prepare('SELECT * FROM memory_v1_intake_native WHERE intake_id=(SELECT id FROM memory_v1_intake WHERE signal_id=?)').get(signalId)!;
      core.store.db.prepare('UPDATE memory_v1_intake_native SET native_hash=? WHERE intake_id=?').run('0'.repeat(64), String(row.intake_id));
      return (target: Core) => { target.store.db.prepare('UPDATE memory_v1_intake_native SET native_hash=? WHERE intake_id=?').run(String(row.native_hash), String(row.intake_id)); };
    }
    const row = core.store.getSignal(signalId)!;
    core.store.db.prepare('UPDATE signals SET action=? WHERE id=?').run(row.action === 'wake' ? 'deliver' : 'wake', signalId);
    return (target: Core) => { target.store.db.prepare('UPDATE signals SET action=? WHERE id=?').run(row.action!, signalId); };
  };
  const blocked = (core: Core, runId: string) => {
    const status = core.memoryV1Status();
    assert.equal(status.intake!.pendingSource, 1);
    assert.equal(status.intake!.diagnostics.find(row => row.runId === runId)?.code, 'memory_intake_binding_conflict');
  };

  test(`${variant}对账冲突在同进程、重复对账和重启后保持，修复真实绑定后恢复`, async t => {
    const { core, dir, f } = await setup(t); const receipt = await send(core, 'main', '合成对账完整性材料');
    const snapshot = core.projectMemory.snapshot(receipt.runId!); const view = core.memoryV1RunView(receipt.runId!);
    const snapshotRow = core.store.db.prepare('SELECT * FROM model_snapshots WHERE run_id=?').get(receipt.runId!)!;
    const refs = core.store.db.prepare('SELECT * FROM memory_v1_source_refs').all();
    const batch = core.store.db.prepare('SELECT * FROM memory_v1_source_batches').all();
    const repair = corrupt(core, receipt.id);
    await core.reconcileMemoryV1(); blocked(core, receipt.runId!);
    await core.reconcileMemoryV1(); blocked(core, receipt.runId!);
    assert.deepEqual(core.store.db.prepare('SELECT * FROM memory_v1_source_batches').all(), batch);
    await core.close();
    const reopened = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false, memoryContextMode: 'shadow' }); t.after(() => reopened.close());
    blocked(reopened, receipt.runId!); await reopened.reconcileMemoryV1(); blocked(reopened, receipt.runId!);
    reopened.store.db.prepare('DELETE FROM model_snapshots WHERE run_id=?').run(receipt.runId!);
    await reopened.reconcileMemoryV1(); blocked(reopened, receipt.runId!);
    repair(reopened); await reopened.reconcileMemoryV1();
    assert.equal(reopened.memoryV1Status().intake!.pendingSource, 1);
    assert.equal(reopened.memoryV1Status().intake!.diagnostics[0]!.code, 'memory_source_unavailable');
    reopened.store.db.prepare(`INSERT INTO model_snapshots(${Object.keys(snapshotRow).join(',')}) VALUES(${Object.keys(snapshotRow).map(() => '?').join(',')})`).run(...Object.values(snapshotRow) as import('node:sqlite').SQLInputValue[]);
    await reopened.reconcileMemoryV1(); await reopened.reconcileMemoryV1();
    assert.equal(reopened.memoryV1Status().intake!.pendingSource, 0);
    assert.deepEqual(reopened.store.db.prepare('SELECT * FROM memory_v1_source_refs').all(), refs);
    assert.deepEqual(reopened.projectMemory.snapshot(receipt.runId!), snapshot); assert.deepEqual(reopened.memoryV1RunView(receipt.runId!), view);
    assert.equal(reopened.store.db.prepare('SELECT COUNT(*) n FROM signals').get()!.n, 1); assert.equal(f.calls(), 1);
    assert.equal(reopened.projectMemory.jobs().length, 0); assert.equal(reopened.memoryV1Status().activeV1, false);
    await reopened.close();
  });

  test(`${variant}在异步补源期间改变时不能被早先成功材料覆盖，修复后仍需补齐缺口`, async t => {
    const { core, f } = await setup(t); const receipt = await send(core, 'main', '合成并发补源');
    const prepare = core.prepareMemorySource.bind(core); const source = await prepare(receipt.runId!);
    core.prepareMemorySource = async () => ({ ...source, gaps: [{ contextId: 'main', runId: receipt.runId!, reason: 'missing-source' }] });
    await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.diagnostics[0]!.gaps, 1);
    let release!: () => void; let entered!: () => void; const gate = new Promise<void>(done => { release = done; }); const ready = new Promise<void>(done => { entered = done; });
    t.after(() => release()); let first = true;
    core.prepareMemorySource = async () => { if (first) { first = false; entered(); await gate; } return source; };
    const pending = core.reconcileMemoryV1(); await ready;
    const repair = corrupt(core, receipt.id);
    try {
      await core.reconcileMemoryV1(); blocked(core, receipt.runId!);
      assert.equal(core.memoryV1Status().intake!.diagnostics[0]!.gaps, 1);
    } finally { release(); await pending; }
    blocked(core, receipt.runId!);
    repair(core);
    core.prepareMemorySource = async () => ({ ...source, contents: new Map([...source.contents].map(([id, value]) => [id, { ...value, partBindings: null }])) });
    await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 1); assert.ok(core.memoryV1Status().intake!.diagnostics[0]!.unmapped > 0);
    core.prepareMemorySource = prepare; await core.reconcileMemoryV1(); await core.reconcileMemoryV1();
    assert.equal(core.memoryV1Status().intake!.pendingSource, 0); assert.equal(f.calls(), 1);
  });
}

test('完成前逐项核对receipt、真实native、action、来源context与接收时间，不自动补造已丢绑定', async t => {
  const { core, f } = await setup(t); const receipt = await send(core, 'main', '合成绑定核对'); const runId = receipt.runId!;
  const intake = core.store.db.prepare('SELECT * FROM memory_v1_intake WHERE signal_id=?').get(receipt.id)!;
  const native = core.store.db.prepare('SELECT * FROM memory_v1_intake_native WHERE intake_id=?').get(String(intake.id))!;
  const signal = core.store.db.prepare('SELECT * FROM signals WHERE id=?').get(receipt.id)!;
  for (const [table, column, value, original, id] of [
    ['signals', 'native_id', 'synthetic-other-native', signal.native_id, receipt.id],
    ['signals', 'action', null, signal.action, receipt.id],
    ['signals', 'status', 'rejected', signal.status, receipt.id],
    ['signals', 'run_id', 'synthetic-other-run', signal.run_id, receipt.id],
    ['memory_v1_intake', 'context_id', 'synthetic-other-context', intake.context_id, intake.id],
    ['memory_v1_intake', 'source_context_id', 'synthetic-other-source', intake.source_context_id, intake.id],
    ['memory_v1_intake', 'received_at', '2000-01-01T00:00:00.000Z', intake.received_at, intake.id],
  ] as const) {
    core.store.db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value, String(id));
    await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.diagnostics[0]?.code, 'memory_intake_binding_conflict', `${table}.${column}`);
    core.store.db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(original!, String(id));
    await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 0);
  }
  core.store.db.prepare('DELETE FROM memory_v1_intake_native WHERE intake_id=?').run(String(intake.id));
  await core.reconcileMemoryV1(); await core.reconcileMemoryV1();
  assert.equal(core.memoryV1Status().intake!.diagnostics[0]?.code, 'memory_intake_binding_conflict');
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM memory_v1_intake_native WHERE intake_id=?').get(String(intake.id))!.n, 0);
  core.store.db.prepare('INSERT INTO memory_v1_intake_native VALUES(?,?)').run(String(intake.id), String(native.native_hash));
  await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 0); assert.equal(f.calls(), 1);
  assert.equal(core.store.getRun(runId)!.status, 'succeeded');
});

test('根重受理后的旧receipt依旧执行别名和历史attempt复验，不以当前native和attempt覆盖旧证明', async t => {
  const { core, dir, f } = await setup(t);
  const first = await core.submitSignal({ source: 'fixture', type: 'user-message', content: '合成跨尝试原文', output: { kind: 'artifact', contextId: 'main' } }); await finished(core, first.runId!);
  const task = await until(() => core.runtime.tasks().find(task => task.runIds.includes(first.runId!)), task => task?.status === 'unreported'); assert.ok(task);
  await core.reconcileMemoryV1();
  const sourceRef = core.store.db.prepare('SELECT * FROM memory_v1_source_refs ORDER BY rowid').all(); const snapshot = core.projectMemory.snapshot(first.runId!);
  const historical = core.store.db.prepare('SELECT * FROM memory_v1_intake WHERE run_id=? AND signal_id=?').get(first.runId!, first.id)!;
  const native = core.store.db.prepare('SELECT * FROM memory_v1_intake_native WHERE intake_id=?').get(String(historical.id))!;
  const alias = core.store.db.prepare('SELECT * FROM memory_v1_intake WHERE run_id=? AND signal_id!=?').get(first.runId!, first.id)!;
  const priorSignal = core.store.getSignal(String(alias.signal_id))!;
  await core.tasks.control(task.id, 'resume', task.revision);
  const resumed = await until(() => core.runtime.task(task.id), value => value.runIds.length === 2 && value.status === 'unreported');
  await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 0);
  assert.notEqual(core.store.getSignal(first.id)!.nativeSignalId, priorSignal.nativeSignalId);
  const attempts = core.runtime.setting<Record<string, number>>(`task-run-attempts:${task.id}`, {});
  const originalSignalAttempts = core.runtime.setting<Record<string, number>>('task-signal-attempts', {});
  for (const field of ['native-hash', 'action', 'run-attempt', 'signal-attempt'] as const) {
    if (field === 'native-hash') core.store.db.prepare('UPDATE memory_v1_intake_native SET native_hash=? WHERE intake_id=?').run('0'.repeat(64), String(historical.id));
    if (field === 'action') core.store.db.prepare('UPDATE signals SET action=? WHERE id=?').run(priorSignal.action === 'wake' ? 'deliver' : 'wake', priorSignal.id);
    if (field === 'run-attempt') core.runtime.setSetting(`task-run-attempts:${task.id}`, { ...attempts, [first.runId!]: resumed.attempt });
    if (field === 'signal-attempt') core.runtime.setSetting('task-signal-attempts', { ...originalSignalAttempts, [priorSignal.id]: resumed.attempt });
    await core.reconcileMemoryV1(); await core.reconcileMemoryV1();
    assert.equal(core.memoryV1Status().intake!.diagnostics.find(row => row.runId === first.runId)?.code, 'memory_intake_binding_conflict', field);
    core.store.db.prepare('UPDATE memory_v1_intake_native SET native_hash=? WHERE intake_id=?').run(String(native.native_hash), String(historical.id));
    core.store.db.prepare('UPDATE signals SET action=? WHERE id=?').run(priorSignal.action!, priorSignal.id);
    core.runtime.setSetting(`task-run-attempts:${task.id}`, attempts); core.runtime.setSetting('task-signal-attempts', originalSignalAttempts);
    await core.reconcileMemoryV1(); assert.equal(core.memoryV1Status().intake!.pendingSource, 0, field);
  }
  assert.deepEqual(core.projectMemory.snapshot(first.runId!), snapshot);
  for (const ref of sourceRef) assert.deepEqual(core.store.db.prepare('SELECT * FROM memory_v1_source_refs WHERE evidence_id=?').get(String(ref.evidence_id)), ref);
  const frozen = resumed.runIds.map(id => core.memoryV1RunView(id));
  await core.close();
  const reopened = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false, memoryContextMode: 'shadow' }); t.after(() => reopened.close());
  await reopened.reconcileMemoryV1(); assert.equal(reopened.memoryV1Status().intake!.pendingSource, 0);
  assert.deepEqual(resumed.runIds.map(id => reopened.memoryV1RunView(id)), frozen); assert.equal(f.calls(), 2);
  await reopened.close();
});
