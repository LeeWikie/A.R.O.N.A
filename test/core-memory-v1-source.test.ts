import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { finished, until, removeTemp } from './helpers.js';

function fixture() {
  const commits = new Set<string>(); const memoryPrompts: unknown[] = []; let targets: string[] = [];
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => {
      const target = targets.shift();
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        if (target) c.enqueue({ type: 'tool-call', toolName: 'context_history', toolCallId: 'source-call', input: target === 'invalid-tool' ? '{"unexpected":true}' : JSON.stringify({ id: target, page: 0 }) });
        else { c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: '合成助手结论' }); c.enqueue({ type: 'text-end', id: 't' }); }
        c.enqueue({ type: 'finish', finishReason: target ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
      } }) };
    },
    doGenerate: async request => {
      memoryPrompts.push(request.prompt);
      const runId = /来源运行是 ([0-9a-f-]{36})/.exec(JSON.stringify(request.prompt))?.[1]; assert.ok(runId);
      const commit = !commits.has(runId); commits.add(runId);
      return { content: commit ? [{ type: 'tool-call', toolName: 'memory_commit', toolCallId: `commit-${runId}`, input: JSON.stringify({ sourceRunId: runId, note: '合成来源' }) }] : [{ type: 'text', text: '完成' }], finishReason: commit ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
  });
  return { model, memoryPrompts, read: (...ids: string[]) => { targets = ids; } };
}
async function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-v1-source-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  t.after(async () => { await core.close(); await removeTemp(dir); });
  return { core, dir, f };
}
async function send(core: Core, contextId: string, content: string, attachments?: string[]) {
  const row = await core.submitMessage({ contextId, content, ...(attachments ? { attachments } : {}) }); await finished(core, row.runId!); return row;
}
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const native = (snapshot: ReturnType<Core['projectMemory']['snapshot']>) => snapshot.nativeMessages as { messages: import('../src/compaction.js').NativeMessage[] };
const snapshotBytes = (core: Core, runId: string) => String(core.store.db.prepare('SELECT body FROM model_snapshots WHERE run_id=?').get(runId)!.body);
function report(core: Core, contextId: string, runId: string, summary: string) {
  core.runtime.event({ contextId, runId, kind: 'task_report', data: { outcome: 'succeeded', summary, checks: [], deliveries: [], unresolved: [] } });
}

test('真实 Core V1 来源保留原文 bytes、附件与未知发生时间，legacy 整理仍可用', async t => {
  const { core, f } = await setup(t);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
  const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(image); c.close(); } }), 'sample.png');
  const original = '  原文\r\n尾部空白  \n'; const row = await send(core, 'main', original, [asset.id]);
  const before = core.projectMemory.snapshot(row.runId!); const history = await core.history('main');
  const source = await core.prepareMemorySource(row.runId!);
  const user = source.records.find(record => record.kind === 'user-statement')!; assert.ok(user);
  assert.equal(user.contentHash, digest(original)); assert.equal(user.occurredAt, null); assert.equal(user.timeBasis, 'unknown');
  assert.equal(user.receivedAt, core.store.getSignal(row.id)!.createdAt);
  assert.equal(user.origin.namespace, core.storageId);
  const content = source.contents.get(user.contentRef)!;
  assert.deepEqual(Buffer.from(content.body), Buffer.from(original)); assert.equal(content.codec, 'utf8');
  assert.deepEqual(Buffer.from(content.attachments![0]!.bytes), image); assert.equal(user.coverage.status, 'complete');
  assert.deepEqual(await core.prepareMemorySource(row.runId!), source);
  assert.deepEqual(core.projectMemory.snapshot(row.runId!), before); assert.deepEqual(await core.history('main'), history);
  assert.equal(core.projectMemory.jobs().length, 0);
  const job = await core.queueMemory(row.runId!);
  const jobs = await until(() => core.projectMemory.jobs(), rows => rows.some(item => item.id === job.id && ['succeeded', 'failed'].includes(item.status)));
  assert.equal(jobs.find(item => item.id === job.id)?.status, 'succeeded');
  assert.ok(JSON.stringify(f.memoryPrompts).includes('原文')); assert.deepEqual(core.projectMemory.snapshot(row.runId!), before);
});

function texts(source: Awaited<ReturnType<Core['prepareMemorySource']>>, kind?: string) {
  return source.records.filter(record => !kind || record.kind === kind).map(record => Buffer.from(source.contents.get(record.contentRef)!.body).toString('utf8'));
}
function userRecords(source: Awaited<ReturnType<Core['prepareMemorySource']>>) { return source.records.filter(record => record.kind === 'user-statement'); }

test('两次 capture、二代 copy 和同文独立来源保持规范身份，不重计原始事实', async t => {
  const { core } = await setup(t); const original = '  同文独立来源\n';
  const first = await send(core, 'main', original); const source = await core.prepareMemorySource(first.runId!);
  const root = userRecords(source)[0]!;
  const copy = await core.branchContext('main', first.runId!, '副本', 'chat.copy');
  const second = await send(core, copy.id, '副本新增');
  const secondSource = await core.prepareMemorySource(second.runId!);
  assert.deepEqual(secondSource.records.find(row => row.id === root.id), root);
  for (const assistant of source.records.filter(row => row.kind === 'assistant-statement')) assert.deepEqual(secondSource.records.find(row => row.id === assistant.id), assistant);
  const two = await core.branchContext(copy.id, second.runId!, '二代副本', 'chat.copy.two');
  const third = await send(core, two.id, '二代新增'); const thirdSource = await core.prepareMemorySource(third.runId!);
  assert.deepEqual(thirdSource.records.find(row => row.id === root.id), root);
  assert.equal(userRecords(thirdSource).filter(row => row.contentHash === digest(original)).length, 1);
  core.createConversationContext({ id: 'chat.independent', name: '独立来源' });
  const independent = await send(core, 'chat.independent', original); const other = userRecords(await core.prepareMemorySource(independent.runId!))[0]!;
  assert.equal(root.contentHash, other.contentHash); assert.notEqual(root.id, other.id); assert.notEqual(root.origin.sourceRef, other.origin.sourceRef);
});

test('真实工具校验失败没有 started 或业务成功，退出 7 覆盖成功文案并按确切身份归并', async t => {
  const { core, f } = await setup(t); f.read('invalid-tool');
  const row = await send(core, 'main', '合成工具失败请求');
  const initial = await core.prepareMemorySource(row.runId!); const failed = initial.observations[0]!;
  assert.ok(failed); assert.equal(failed.toolTerminal, 'failed'); assert.equal(failed.request.state, 'requested');
  assert.equal(failed.execution.state, 'unknown'); assert.equal(failed.businessOutcome.state, 'unknown');
  assert.ok(initial.records.some(record => record.kind === 'task-request' && record.actor === 'assistant' && record.operationRef === failed.identity.operationRef));
  const actual = core.store.db.prepare("SELECT data FROM runtime_events WHERE run_id=? AND kind='tool_start'").get(row.runId!)!;
  const call = JSON.parse(String(actual.data)).toolCallId;
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'tool_end', data: { toolCallId: call, result: '全部成功，已确认业务完成', isError: false } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'command_exit', data: { toolCallId: call, exitCode: '7', success: true } });
  core.runtime.event({ contextId: 'wrong.context', runId: row.runId!, kind: 'command_exit', data: { toolCallId: call, exitCode: 0, success: true } });
  core.runtime.event({ contextId: 'main', runId: 'wrong-run', kind: 'command_exit', data: { toolCallId: call, exitCode: 0, success: true } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'command_exit', data: { toolCallId: 'wrong-call', exitCode: 0, success: true } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'command_exit', data: { toolCallId: call, exitCode: 7, success: false } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'command_exit', data: { toolCallId: call, exitCode: 0, success: true } });
  const source = await core.prepareMemorySource(row.runId!); const observation = source.observations[0]!;
  assert.equal(source.observations.length, 1); assert.equal(observation.toolTerminal, 'failed');
  assert.equal(observation.execution.state, 'completed'); assert.equal(observation.businessOutcome.state, 'unknown');
  assert.deepEqual(observation.terminalEvidence.filter(event => event.kind === 'command-exit').map(event => event.exitCode), [7, 0]);
  const { publicToolEvent } = await import('../src/tool-activity.js');
  const last = core.runtime.eventHead();
  assert.equal(publicToolEvent(core, { seq: last, contextId: 'main', runId: row.runId!, taskId: null, kind: 'command_exit', data: { toolCallId: call, exitCode: 0, success: true }, createdAt: new Date().toISOString() }).state, observation.toolTerminal);
});

test('普通工具完成不证明执行，真实审批账本的拒绝不冒称用户陈述', async t => {
  const { core, f } = await setup(t); core.createConversationContext({ id: 'chat.history', name: '历史' });
  await send(core, 'chat.history', '工具可读事实'); f.read('chat.history');
  const row = await send(core, 'main', '读取工具'); const before = await core.prepareMemorySource(row.runId!);
  const initial = before.observations[0]!; assert.equal(initial.toolTerminal, 'finished'); assert.equal(initial.execution.state, 'unknown');
  const call = JSON.parse(String(core.store.db.prepare("SELECT data FROM runtime_events WHERE run_id=? AND kind='tool_start'").get(row.runId!)!.data)).toolCallId;
  const approvalId = `main:${row.runId}:${call}`;
  core.runtime.addApproval({ id: approvalId, contextId: 'main', runId: row.runId!, taskId: null, toolCallId: call, toolName: 'context_history', args: {}, capabilityKey: 'PRIVATE-APPROVAL-BINDING', status: 'pending', createdAt: new Date().toISOString() });
  core.runtime.decideApproval(approvalId, 'declined');
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'tool_end', data: { toolCallId: call, denied: true, result: '成功文案' } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'command_exit', data: { toolCallId: call, exitCode: 0, success: true } });
  const source = await core.prepareMemorySource(row.runId!); const denied = source.observations.find(item => item.identity.operationRef === initial.identity.operationRef)!;
  assert.equal(denied.authorization.state, 'denied'); assert.equal(denied.toolTerminal, 'denied'); assert.equal(denied.businessOutcome.state, 'unknown');
  const authorization = source.records.find(item => item.kind === 'authorization')!; assert.equal(authorization.actor, 'external');
  assert.doesNotMatch(texts(source).join('\n') + JSON.stringify(source.records), /PRIVATE-APPROVAL-BINDING|capabilityKey/);
});

test('独立 history 使用真实原文，选区排除沿多代 lineage 与 checkpoint 保留', async t => {
  const { core, f } = await setup(t);
  await send(core, 'main', '排除的祖先原文'); const retained = await send(core, 'main', '选中的原文  \n');
  const selected = await core.branchContext('main', retained.runId!, '选区', 'chat.selected', retained.runId!);
  const middle = await send(core, selected.id, '选区中间的原文');
  const compacted = await core.compactContext(selected.id, { id: 'chat.compacted', keepRecentTokens: 1 });
  const compactedRun = await send(core, compacted.context.id, '压缩后事实');
  const copy = await core.branchContext(compacted.context.id, compactedRun.runId!, '多代副本', 'chat.descendant');
  core.createConversationContext({ id: 'chat.independent', name: '独立' }); f.read('main');
  await send(core, 'chat.independent', '独立事实  \r\n'); f.read('chat.independent');
  const current = await send(core, copy.id, '当前原文');
  const before = core.projectMemory.snapshot(current.runId!); const source = await core.prepareMemorySource(current.runId!);
  const users = texts(source, 'user-statement');
  for (const text of ['选中的原文  \n', '选区中间的原文', '压缩后事实', '独立事实  \r\n', '当前原文']) assert.ok(users.includes(text), text);
  assert.ok(!users.includes('排除的祖先原文')); assert.ok(source.gaps.some(gap => gap.reason === 'unresolved-history'));
  assert.deepEqual(core.projectMemory.snapshot(current.runId!), before); assert.ok(core.projectMemory.snapshot(middle.runId!));
});

test('共享 nativeSignalId 的根用户与执行别名只保留完整根原文，不泄露绑定或执行信封', async t => {
  const { core } = await setup(t);
  const original = '  根用户事实 {"signature":"业务数据"}\n';
  const row = await core.submitSignal({ source: 'fixture', type: 'user-message', content: original, output: { kind: 'artifact', contextId: 'main' } }); await finished(core, row.runId!);
  assert.equal(core.store.db.prepare('SELECT count(*) AS n FROM signals WHERE native_id=?').get(row.nativeSignalId!)!.n, 2);
  const source = await core.prepareMemorySource(row.runId!);
  assert.deepEqual(texts(source, 'user-statement'), [original]); assert.equal(userRecords(source).length, 1);
  assert.doesNotMatch(texts(source).join('\n'), /bodyHash|bindingVersion|additionalSafetyChecksApply|sourceSignalId|preauthorized/);
});

test('手动 SourceRequest 用户证明保持原始文本，worker 报告不提升为独立业务核验', async t => {
  const { core } = await setup(t);
  const original = '  手动用户任务的完整原文\r\n'; const task = await core.submitTask({ title: '合成手动任务', content: original }, 'manual-source');
  const ready = await until(() => core.runtime.task(task.id), item => item.runIds.length > 0); const runId = ready.runIds[0]!; await finished(core, runId);
  core.runtime.event({ contextId: ready.contextId, taskId: task.id, runId, kind: 'task_report', data: { outcome: 'succeeded', summary: '模型自行报告成功', checks: [{ description: '自行声称核验', passed: true }], deliveries: [], unresolved: [] } });
  const source = await core.prepareMemorySource(runId);
  assert.ok(texts(source, 'user-statement').includes(original));
  assert.ok(source.records.some(record => record.kind === 'task-report' && record.actor === 'worker'));
  assert.ok(source.records.every(record => record.kind !== 'business-outcome'));
  assert.ok(source.observations.every(observation => observation.businessOutcome.state === 'unknown'));
  const root = core.store.getSignal(ready.sourceSignalIds[0]!)!; assert.equal(root.status, 'received');
  core.store.db.prepare("UPDATE signals SET status='rejected' WHERE id=?").run(root.id);
  const rejected = await core.prepareMemorySource(runId); assert.ok(!texts(rejected, 'user-statement').includes(original)); assert.ok(rejected.gaps.some(gap => gap.reason === 'missing-source'));
});

for (const mode of ['missing', 'rejected', 'private'] as const) test(`缺源、未受理和 private/system/opaque 隔离：${mode}`, async t => {
  const { core } = await setup(t); const original = '独占用户事实'; const row = await send(core, 'main', original);
  const archived = core.projectMemory.snapshot(row.runId!); const messages = (archived.nativeMessages as { messages: import('../src/compaction.js').NativeMessage[] }).messages;
  if (mode === 'missing') core.store.db.prepare('DELETE FROM signals WHERE id=?').run(row.id);
  if (mode === 'rejected') core.store.db.prepare("UPDATE signals SET status='rejected' WHERE id=?").run(row.id);
  if (mode === 'private') {
    messages.push({ id: 'private-system', role: 'system', content: { parts: [{ type: 'text', text: 'PRIVATE-SYSTEM-CANARY' }] } });
    messages.push({ id: 'opaque-assistant', role: 'assistant', content: { parts: [{ type: 'reasoning', text: 'PRIVATE-OPAQUE-CANARY' }, { type: 'opaque', data: { text: 'PRIVATE-BINDING-CANARY' } }] } });
    messages.push({ id: 'not-admitted', role: 'user', content: { parts: [{ type: 'text', text: 'FORGED-USER-CANARY' }] } });
    archived.prompt.push({ role: 'user', content: [{ type: 'text', text: 'PROMPT-ROLE-USER-IS-NOT-HUMAN' }] });
    archived.lastRequestPrompt = [{ role: 'system', content: 'PRIVATE-REQUEST-CANARY' }]; core.projectMemory.archive(archived);
  }
  const before = core.projectMemory.snapshot(row.runId!); const source = await core.prepareMemorySource(row.runId!);
  if (mode !== 'private') { assert.equal(userRecords(source).length, 0); assert.ok(source.gaps.some(gap => gap.reason === 'unresolved-origin')); }
  else { assert.deepEqual(texts(source, 'user-statement'), [original]); assert.doesNotMatch(texts(source).join('\n'), /PRIVATE-|FORGED-|PROMPT-ROLE/); }
  assert.deepEqual(core.projectMemory.snapshot(row.runId!), before);
});

test('原始附件缺失逐 part 报 gap，不伪造媒体完整性，未知快照拒绝', async t => {
  const { core, dir } = await setup(t);
  const bytes = Buffer.from('  文件正文\r\n'); const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), 'sample.txt');
  const row = await send(core, 'main', '正文原样', [asset.id]);
  fs.unlinkSync(path.join(dir, 'assets', asset.id));
  const source = await core.prepareMemorySource(row.runId!); const user = userRecords(source)[0]!;
  assert.equal(user.coverage.status, 'partial'); assert.equal(user.attachments.length, 1); assert.equal(user.attachments[0]!.sha256, digest(bytes));
  assert.ok(user.coverage.parts.some(part => part.status === 'unavailable')); assert.ok(source.gaps.some(gap => gap.reason === 'missing-source'));
  assert.equal(source.contents.get(user.contentRef)!.attachments.length, 0); assert.deepEqual(texts(source, 'user-statement'), ['正文原样']);
  await assert.rejects(core.prepareMemorySource('missing-run'), /context_snapshot_unavailable/);
});

test('来源内容可直接交给 ledger 与 recent；空白、附件和原文哈希一致', async t => {
  const { core } = await setup(t); const original = ' \t\r\n    ';
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
  const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(image); c.close(); } }), 'sample.png');
  const row = await send(core, 'main', original, [asset.id]); const source = await core.prepareMemorySource(row.runId!);
  const { MemoryEvidenceLedger } = await import('../src/memory/v1/ledger.js');
  const { projectRecentMemory } = await import('../src/memory/v1/recent.js');
  const { resolveMemoryContextPolicy } = await import('../src/memory/v1/binding.js');
  const { evidenceIdempotencyKey } = await import('../src/memory/v1/validate.js');
  const ledger = new MemoryEvidenceLedger(core.store.db);
  for (const record of source.records) { const content = source.contents.get(record.contentRef)!; assert.ok(content.partBindings); ledger.putEvidence(record, { ...content, partBindings: content.partBindings }); }
  const user = userRecords(source)[0]!; assert.deepEqual(Buffer.from(ledger.readContent(user.id) as Uint8Array), Buffer.from(original));
  const recent = projectRecentMemory({
    records: userRecords(source).map(evidence => {
      const content = source.contents.get(evidence.contentRef)!;
      return { evidence, originalTextBytes: content.body, attachments: content.attachments.map(item => ({ ...item, mediaType: evidence.attachments.find(part => part.sourceId === item.sourceId)!.mediaType })) };
    }),
    asOf: new Date().toISOString(), policy: resolveMemoryContextPolicy(), scope: { id: 'synthetic', allows: new Set(userRecords(source).map(evidenceIdempotencyKey)) }, exclusions: { currentWorkingSet: new Set(), excludedAncestors: new Set() }, model: { id: 'synthetic', supportedImageMediaTypes: new Set(['image/png']) },
  });
  assert.equal(recent.selected.length, 1); assert.equal(recent.selected[0]!.originalText, original); assert.equal(recent.selected[0]!.attachments[0]!.status, 'included');
  assert.equal(recent.complete, true);
});

for (const mode of ['proof-missing', 'proof-forged', 'source-missing'] as const) test(`V1 不放宽复制来源证明：${mode}`, async t => {
  const { core } = await setup(t); const original = '  原始复制证据  \n'; const root = await send(core, 'main', original);
  const copy = await core.branchContext('main', root.runId!, '副本', 'chat.proof');
  const key = `context-lineage:${copy.id}`;
  const lineage = core.runtime.setting<{ sourceRunId: string; storageTextProofs?: Record<string, string> }>(key, null!);
  if (mode === 'proof-missing') delete lineage.storageTextProofs;
  if (mode === 'proof-forged') lineage.storageTextProofs = { [root.nativeSignalId!]: 'a'.repeat(64) };
  if (mode === 'source-missing') core.store.db.prepare('DELETE FROM model_snapshots WHERE run_id=?').run(root.runId!);
  else core.runtime.setSetting(key, lineage);
  const current = await send(core, copy.id, '有效的新输入'); const source = await core.prepareMemorySource(current.runId!);
  assert.ok(!texts(source, 'user-statement').includes(original)); assert.ok(texts(source, 'user-statement').includes('有效的新输入'));
  assert.ok(source.gaps.some(gap => gap.reason === 'unresolved-origin'));
});

for (const mode of ['body-hash', 'attempt', 'execution-unaccepted'] as const) test(`V1 根执行绑定不能被旧运行或变更原始 body 冒用：${mode}`, async t => {
  const { core } = await setup(t); const original = '根用户授权原文';
  const row = await core.submitSignal({ source: 'fixture', type: 'user-message', content: original, output: { kind: 'artifact', contextId: 'main' } }); await finished(core, row.runId!);
  const task = core.runtime.tasks().find(item => item.runIds.includes(row.runId!))!; assert.ok(task);
  if (mode === 'body-hash') {
    const stored = core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(row.id)!;
    const body = JSON.parse(String(stored.body)); body.content = '被改写的原文'; core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(body), row.id);
  }
  if (mode === 'attempt') core.runtime.setSetting('task-signal-attempts', { ...core.runtime.setting<Record<string, number>>('task-signal-attempts', {}), [task.signalId]: 999 });
  if (mode === 'execution-unaccepted') core.store.db.prepare("UPDATE signals SET status='rejected' WHERE id=?").run(task.signalId);
  const source = await core.prepareMemorySource(row.runId!);
  assert.ok(!texts(source, 'user-statement').includes(original)); assert.ok(!texts(source, 'user-statement').includes('被改写的原文'));
  assert.ok(source.gaps.length > 0);
});

test('手动用户证明必须匹配完整宿主 body，不能只凭正文相同确认', async t => {
  const { core } = await setup(t);
  const task = await core.submitTask({ title: '证明合同', content: '手动原文' }, 'manual-exact-body');
  const ready = await until(() => core.runtime.task(task.id), item => item.runIds.length > 0); const runId = ready.runIds[0]!; await finished(core, runId);
  const id = ready.sourceSignalIds[0]!; const row = core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(id)!;
  const body = JSON.parse(String(row.body)); body.output = { kind: 'artifact', contextId: 'main' };
  core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(body), id);
  const source = await core.prepareMemorySource(runId);
  assert.ok(!texts(source, 'user-statement').includes('手动原文')); assert.ok(source.gaps.some(gap => gap.reason === 'missing-source'));
});

test('拒绝不能无损 UTF-8 编码的原文，不将替代字符冒充精确证据', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '孤立代理项\ud800');
  await assert.rejects(core.prepareMemorySource(row.runId!), /memory_source_invalid_utf8/);
});

test('只有图片的真实用户输入保留空正文与媒体证据', async t => {
  const { core } = await setup(t);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
  const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(image); c.close(); } }), 'image.png');
  const row = await send(core, 'main', '', [asset.id]); const source = await core.prepareMemorySource(row.runId!); const user = userRecords(source)[0]!;
  assert.deepEqual(texts(source, 'user-statement'), ['']); assert.equal(user.contentHash, digest('')); assert.equal(user.coverage.status, 'complete');
  assert.deepEqual(Buffer.from(source.contents.get(user.contentRef)!.attachments[0]!.bytes), image);
});

test('同一工具和助手经独立 history 与 clone 两条路径读到仍只保留同一规范证据', async t => {
  const { core, f } = await setup(t);
  core.createConversationContext({ id: 'chat.original', name: '原始' }); f.read('invalid-tool');
  const root = await send(core, 'chat.original', '来源原文'); const rootSource = await core.prepareMemorySource(root.runId!);
  const copy = await core.branchContext('chat.original', root.runId!, '复制', 'chat.dual'); await send(core, copy.id, '复制后原文');
  f.read(copy.id, 'chat.original'); const current = await send(core, 'main', '双路径读取');
  const source = await core.prepareMemorySource(current.runId!);
  for (const record of rootSource.records) assert.equal(source.records.filter(item => item.id === record.id).length, 1);
  const { validateMemoryCandidate } = await import('../src/memory/v1/validate.js');
  const refs = source.records.flatMap(record => record.coverage.parts.map(part => ({ evidenceId: record.id, partKey: part.key })));
  const validation = validateMemoryCandidate({
    batchId: 'synthetic-source-check', auditedAt: new Date().toISOString(), evidence: source.records, observations: source.observations,
    previousEntries: [], entries: [], entities: [], relations: [], organizations: [], overrides: [], legacyCoverage: [],
    coverage: refs.map(ref => ({ ref, decision: 'pending-review', entryIds: [], rationale: '只核对来源合同，尚未整理' })),
    protectionChecks: refs.map(ref => ({ ref, decision: 'pending-review', entryIds: [], rationale: '尚未评估' })),
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues)); assert.equal(validation.coverageComplete, false);
});

test('独立读取祖先的完整 clone 不能洗回选区之外的原始事实', async t => {
  const { core, f } = await setup(t);
  await send(core, 'main', '被排除的原始祖先'); const keep = await send(core, 'main', '选中的独立事实');
  const full = await core.branchContext('main', keep.runId!, '完整副本', 'chat.full.alias');
  const selected = await core.branchContext('main', keep.runId!, '选区', 'chat.selected.alias', keep.runId!);
  f.read(full.id); const current = await send(core, selected.id, '读取祖先副本但保留选区');
  const source = await core.prepareMemorySource(current.runId!);
  assert.ok(texts(source, 'user-statement').includes('选中的独立事实'));
  assert.ok(!texts(source, 'user-statement').includes('被排除的原始祖先'));
  assert.ok(source.gaps.some(gap => gap.reason === 'unresolved-history'));
});

test('附件元数据缺失明确阻塞 ledger 槽绑定，不伪造摘要', async t => {
  const { core } = await setup(t); const bytes = Buffer.from('精确附件正文');
  const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), 'source.txt');
  const row = await send(core, 'main', '正文', [asset.id]); core.store.db.prepare('DELETE FROM asset_records WHERE id=?').run(asset.id);
  const source = await core.prepareMemorySource(row.runId!); const user = userRecords(source)[0]!;
  assert.equal(user.coverage.status, 'partial'); assert.equal(user.attachments.length, 0);
  assert.equal(source.contents.get(user.contentRef)!.partBindings, null);
  assert.deepEqual([...source.attachmentRefs.values()], [{ assetId: asset.id, name: null }]);
});

test('同一存储附件的重复引用保留顺序，但不产生重复内容槽和独立佐证', async t => {
  const { core } = await setup(t); const bytes = Buffer.from('同一附件原文');
  const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), 'same.txt');
  const row = await send(core, 'main', '重复附件引用', [asset.id, asset.id]);
  const source = await core.prepareMemorySource(row.runId!); const user = userRecords(source)[0]!; const content = source.contents.get(user.contentRef)!;
  assert.equal(user.attachments.length, 1); assert.equal(content.attachments.length, 1);
  assert.deepEqual(content.attachmentOrder, [user.attachments[0]!.sourceId, user.attachments[0]!.sourceId]);
  assert.equal(user.coverage.status, 'complete'); assert.deepEqual(Buffer.from(content.attachments[0]!.bytes), bytes);
});

test('归档缺少工具部件时仍由同一受理运行的持久化 start/end/exit 恢复真实事件', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '受理后执行的合成请求');
  const call = 'durable-only';
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'tool_start', data: { toolCallId: call, toolName: 'synthetic_tool', args: { query: '业务数据' }, privateBinding: 'PRIVATE-EVENT-ONLY-BINDING' } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'tool_end', data: { toolCallId: call, result: '成功' } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'command_exit', data: { toolCallId: call, exitCode: 7, success: false } });
  const source = await core.prepareMemorySource(row.runId!); const observation = source.observations[0]!;
  assert.ok(observation); assert.equal(observation.request.state, 'requested'); assert.equal(observation.toolTerminal, 'failed');
  assert.equal(observation.execution.state, 'completed'); assert.equal(observation.businessOutcome.state, 'unknown');
  assert.ok(texts(source).some(text => text.includes('业务数据'))); assert.doesNotMatch(texts(source).join('\n'), /PRIVATE-EVENT-ONLY-BINDING/);
});

test('无有效新增信息的正常问候仍保留来源且不误报归档缺失', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '你好');
  const before = snapshotBytes(core, row.runId!); const source = await core.prepareMemorySource(row.runId!);
  assert.deepEqual(texts(source, 'user-statement'), ['你好']); assert.deepEqual(source.gaps, []);
  assert.equal(snapshotBytes(core, row.runId!), before); assert.deepEqual(core.projectMemory.jobs(), []);
});

test('当前运行的受理仍存在时，空原生归档明确缺源而不是无缺口的空批次', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '受理账本中的原始输入');
  const snapshot = core.projectMemory.snapshot(row.runId!); native(snapshot).messages = []; core.projectMemory.archive(snapshot);
  const before = snapshotBytes(core, row.runId!); const head = core.runtime.eventHead();
  const source = await core.prepareMemorySource(row.runId!);
  assert.ok(source.gaps.some(gap => gap.reason === 'missing-source' && gap.contextId === 'main' && gap.runId === row.runId && gap.messageId === row.id));
  assert.deepEqual(source.records, []); assert.deepEqual(source.observations, []);
  assert.deepEqual(await core.prepareMemorySource(row.runId!), source);
  assert.equal(snapshotBytes(core, row.runId!), before); assert.equal(core.runtime.eventHead(), head);
});

test('同一真实运行中缺失的受理输入逐项留缺口，不用仍在的输入掩盖或补造原生消息', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '仍在归档中的输入');
  core.store.receive({ id: 'synthetic-admitted-supplement', source: 'fixture', type: 'user-message', contextId: 'main', content: '只在受理账本中', output: { kind: 'message', contextId: 'main' } });
  core.store.accept('synthetic-admitted-supplement', 'synthetic-native-supplement', row.runId!, 'deliver', 'main');
  const before = snapshotBytes(core, row.runId!); const source = await core.prepareMemorySource(row.runId!);
  assert.deepEqual(texts(source, 'user-statement'), ['仍在归档中的输入']);
  assert.ok(source.gaps.some(gap => gap.reason === 'missing-source' && gap.messageId === 'synthetic-admitted-supplement'));
  assert.equal(snapshotBytes(core, row.runId!), before);
});

test('只剩用户消息时按实际运行恢复报告和输出，不能依赖助手部件或混入错误上下文的报告', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '形成持久化业务结果');
  report(core, 'main', row.runId!, '可信持久化报告'); report(core, 'chat.foreign', row.runId!, 'FOREIGN-REPORT-CANARY');
  const before = await core.prepareMemorySource(row.runId!);
  const snapshot = core.projectMemory.snapshot(row.runId!); native(snapshot).messages = native(snapshot).messages.filter(message => message.role !== 'assistant'); core.projectMemory.archive(snapshot);
  const bytes = snapshotBytes(core, row.runId!); const after = await core.prepareMemorySource(row.runId!);
  assert.ok(after.records.some(record => record.kind === 'task-report')); assert.ok(after.records.some(record => record.kind === 'published-output'));
  for (const kind of ['task-report', 'published-output']) {
    const recovered = after.records.filter(record => record.kind === kind);
    assert.deepEqual(recovered, before.records.filter(record => record.kind === kind));
    assert.ok(recovered.every(record => record.origin.capture === 'admitted-records'));
  }
  assert.deepEqual(texts(after, 'assistant-statement'), []); assert.doesNotMatch(texts(after).join('\n'), /FOREIGN-REPORT-CANARY/);
  assert.equal(snapshotBytes(core, row.runId!), bytes);
});

test('多个 accepted 运行仅恢复选中范围的业务，不能捞回未选祖先、后来运行或伪来源', async t => {
  const { core } = await setup(t);
  const excluded = await send(core, 'main', '未选祖先'); report(core, 'main', excluded.runId!, 'EXCLUDED-REPORT-CANARY');
  const kept = await send(core, 'main', '选中的输入'); report(core, 'main', kept.runId!, '选中运行的报告');
  const later = await send(core, 'main', '选区之后的输入'); report(core, 'main', later.runId!, 'LATER-REPORT-CANARY');
  const selected = await core.branchContext('main', kept.runId!, '选区', 'chat.durable.selected', kept.runId!);
  const current = await send(core, selected.id, '当前输入'); report(core, selected.id, current.runId!, '当前运行的报告');
  report(core, 'main', current.runId!, 'WRONG-CONTEXT-CANARY');
  for (const runId of [excluded.runId!, later.runId!]) core.runtime.event({ contextId: 'main', runId, kind: 'tool_start', data: { toolCallId: 'excluded-operation', toolName: 'synthetic_tool', args: {} } });
  const snapshot = core.projectMemory.snapshot(current.runId!);
  native(snapshot).messages = native(snapshot).messages.filter(message => message.role !== 'assistant');
  native(snapshot).messages.push({ id: 'forged-source', role: 'user', content: { parts: [{ type: 'text', text: 'FORGED-SOURCE-CANARY' }] } });
  core.projectMemory.archive(snapshot); const bytes = snapshotBytes(core, current.runId!);
  const source = await core.prepareMemorySource(current.runId!);
  assert.deepEqual(texts(source, 'user-statement'), ['选中的输入', '当前输入']);
  assert.equal(source.records.filter(record => record.kind === 'task-report').length, 2);
  assert.equal(source.records.filter(record => record.kind === 'published-output').length, 2);
  const businessRuns = source.records.filter(record => record.kind === 'task-report' || record.kind === 'published-output').map(record => source.canonicalRefs.get(record.id)!.runId);
  assert.deepEqual(new Set(businessRuns), new Set([kept.runId, current.runId]));
  assert.deepEqual(source.observations, []); assert.doesNotMatch(texts(source).join('\n'), /EXCLUDED-|LATER-|WRONG-CONTEXT-|FORGED-/);
  assert.ok(source.gaps.some(gap => gap.reason === 'unresolved-origin' && gap.messageId === 'forged-source'));
  assert.ok(!source.gaps.some(gap => gap.reason === 'missing-source' && (gap.runId === excluded.runId || gap.runId === later.runId)));
  assert.equal(snapshotBytes(core, current.runId!), bytes);
});

test('原生助手全缺失仍按真实运行恢复结构执行，拒绝与失败不被成功文案覆盖', async t => {
  const { core } = await setup(t); const row = await send(core, 'main', '执行请求'); const call = 'durable-no-assistant';
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'tool_start', data: { toolCallId: call, toolName: 'synthetic_tool', args: { query: '业务参数' }, privateBinding: 'PRIVATE-CANARY' } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'tool_end', data: { toolCallId: call, denied: true, result: '全部成功' } });
  core.runtime.event({ contextId: 'main', runId: row.runId!, kind: 'command_exit', data: { toolCallId: call, exitCode: 7, success: false } });
  const before = await core.prepareMemorySource(row.runId!);
  const snapshot = core.projectMemory.snapshot(row.runId!); native(snapshot).messages = native(snapshot).messages.filter(message => message.role !== 'assistant'); core.projectMemory.archive(snapshot);
  const bytes = snapshotBytes(core, row.runId!); const after = await core.prepareMemorySource(row.runId!);
  assert.deepEqual(after.observations, before.observations); assert.equal(after.observations.length, 1);
  assert.equal(after.observations[0]!.request.state, 'requested'); assert.equal(after.observations[0]!.execution.state, 'completed');
  assert.equal(after.observations[0]!.toolTerminal, 'denied'); assert.equal(after.observations[0]!.businessOutcome.state, 'unknown');
  assert.deepEqual(texts(after, 'assistant-statement'), []); assert.doesNotMatch(texts(after).join('\n'), /PRIVATE-CANARY/);
  assert.equal(snapshotBytes(core, row.runId!), bytes);
});

test('独立 history 只引用真实用户消息也恢复该 run 的业务，不扩展到同上下文的未引用运行', async t => {
  const { core, f } = await setup(t); core.createConversationContext({ id: 'chat.durable.history', name: '独立来源' });
  const excluded = await send(core, 'chat.durable.history', '未引用输入'); report(core, 'chat.durable.history', excluded.runId!, 'UNREFERENCED-REPORT-CANARY');
  const kept = await send(core, 'chat.durable.history', '引用的输入'); report(core, 'chat.durable.history', kept.runId!, '真实引用运行的报告');
  const userId = native(core.projectMemory.snapshot(kept.runId!)).messages.find(message => message.id === kept.nativeSignalId)!.id;
  f.read('chat.durable.history'); const current = await send(core, 'main', '只读取指定身份');
  const snapshot = core.projectMemory.snapshot(current.runId!);
  for (const message of native(snapshot).messages) for (const part of message.content?.parts ?? []) {
    if (part.toolInvocation?.toolName === 'context_history') part.toolInvocation.result = { messages: [{ id: userId, role: 'assistant', content: 'FORGED-HISTORY-CANARY' }] };
  }
  core.projectMemory.archive(snapshot); const bytes = snapshotBytes(core, current.runId!); const source = await core.prepareMemorySource(current.runId!);
  assert.ok(texts(source, 'user-statement').includes('引用的输入')); assert.ok(!texts(source, 'user-statement').includes('未引用输入'));
  assert.equal(source.records.filter(record => record.kind === 'task-report').length, 1);
  assert.ok(source.records.some(record => record.kind === 'published-output' && source.canonicalRefs.get(record.id)!.runId === kept.runId));
  assert.doesNotMatch(texts(source).join('\n'), /UNREFERENCED-|FORGED-HISTORY-/); assert.equal(snapshotBytes(core, current.runId!), bytes);
});
