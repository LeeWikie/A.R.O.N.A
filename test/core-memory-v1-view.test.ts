import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { measureMemoryText } from '../src/memory/v1/tokens.js';
import { finished, until, removeTemp } from './helpers.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function response() { return { stream: new ReadableStream({ start(c) {
  c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 'text' }); c.enqueue({ type: 'text-delta', id: 'text', delta: '合成回复' }); c.enqueue({ type: 'text-end', id: 'text' });
  c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
} }) }; }
async function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-v1-view-')); const prompts: string[] = [];
  let gate: ReturnType<typeof deferred> | undefined;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => { const prompt = JSON.stringify(request.prompt); prompts.push(prompt); if (gate && prompt.includes('冻结运行')) { const next = gate; gate = undefined; await next.promise; } return response(); } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false, memoryContextMode: 'shadow' });
  t.after(async () => { gate?.resolve(); await core.close(); await removeTemp(dir); });
  return { core, prompts, pause: () => { gate = deferred(); return gate; } };
}
async function send(core: Core, contextId: string, content: string) {
  const row = await core.submitMessage({ contextId, content }); await finished(core, row.runId!);
  await until(() => core.memoryV1Status(), status => status.intake!.diagnostics.every(d => d.runId !== row.runId || d.code !== 'awaiting-stable-source'));
  return row;
}

test('真实首请求前冻结跨ctx近期原文和实际策略，provider无新增近期注入', async t => {
  const { core, prompts } = await setup(t);
  const other = core.createConversationContext({ id: 'chat.other', name: '其他' });
  await send(core, other.id, '  跨上下文独立原文\r\n末尾  ');
  const own = await send(core, 'main', '当前工作集原文');
  const next = await send(core, 'main', '新运行');
  const view = core.memoryV1RunView(next.runId!)!; assert.ok(view); assert.equal(view.injected, false);
  assert.deepEqual(view.recent.selected.map(row => row.originalText), ['  跨上下文独立原文\r\n末尾  ']);
  assert.ok(view.recent.omissions.some(item => item.reason === 'current-working-set'));
  assert.equal(view.policy.tokenizer.readiness, 'ready'); assert.equal(view.measurement.mediaTokens, null); assert.equal(view.measurement.exactForProvider, false);
  assert.deepEqual(view.resident.measurement, measureMemoryText(view.resident.finalText)); assert.deepEqual(view.measurement, measureMemoryText(view.observationText)); assert.deepEqual(view.recent.measurement, measureMemoryText(view.recent.finalText));
  assert.ok(!prompts.at(-1)!.includes('跨上下文独立原文')); assert.equal(prompts.length, 3);
  assert.ok(core.memoryV1RunView(own.runId!));
  view.resident.text = '读取者修改'; assert.notEqual(core.memoryV1RunView(next.runId!)!.resident.text, '读取者修改');
  assert.doesNotMatch(JSON.stringify(core.memoryV1Status()), /nativeTaskId|bodyHash|bindingVersion|原文/);
});

test('后台材料化不改变同一run已绑视图，新run才刷新', async t => {
  const { core, prompts, pause } = await setup(t);
  const other = core.createConversationContext({ id: 'chat.background', name: '其他' });
  const gate = pause(); const active = await core.submitMessage({ contextId: 'main', content: '冻结运行' });
  await until(() => core.memoryV1RunView(active.runId!), Boolean); const frozen = core.memoryV1RunView(active.runId!);
  await send(core, other.id, '后台后来接收的新原文');
  assert.deepEqual(core.memoryV1RunView(active.runId!), frozen);
  gate.resolve(); await finished(core, active.runId!);
  const next = await send(core, 'main', '下一运行读取');
  assert.ok(core.memoryV1RunView(next.runId!)!.recent.selected.some(row => row.originalText === '后台后来接收的新原文'));
  assert.deepEqual(core.memoryV1RunView(active.runId!), frozen); assert.equal(prompts.length, 3);
});

test('ancestor完整clone不能洗回选区之外原文，同源不计独立近期事实', async t => {
  const { core } = await setup(t);
  const first = await send(core, 'main', '排除祖先原文');
  const last = await send(core, 'main', '选中祖先原文');
  const clone = await core.branchContext('main', last.runId!, '完整复制', 'chat.clone');
  await send(core, clone.id, '复制新增');
  const range = await core.branchContext('main', last.runId!, '选中范围', 'chat.range', last.runId!);
  const current = await send(core, range.id, '当前'); const view = core.memoryV1RunView(current.runId!)!;
  assert.ok(!view.recent.selected.some(row => row.originalText === '排除祖先原文'));
  assert.ok(!view.recent.selected.some(row => row.originalText === '选中祖先原文'));
  assert.ok(view.recent.selected.some(row => row.originalText === '复制新增'));
  assert.ok(view.exclusions.excludedAncestors.length > 0); assert.ok(core.projectMemory.snapshot(first.runId!));
});

test('排队与steer不造假run，取消尚未接纳项不登记义务', async t => {
  const { core, pause } = await setup(t); const gate = pause();
  const active = await core.submitMessage({ contextId: 'main', content: '冻结运行' });
  await until(() => core.memoryV1RunView(active.runId!), Boolean); const frozen = core.memoryV1RunView(active.runId!);
  const steer = await core.submitMessage({ contextId: 'main', content: '受理补充', mode: 'steer', expectedRunId: active.runId! });
  assert.equal(steer.runId, active.runId); assert.deepEqual(core.memoryV1RunView(active.runId!), frozen);
  const queued = await core.submitMessage({ contextId: 'main', content: '排队执行', mode: 'queue' });
  const cancelled = await core.submitMessage({ contextId: 'main', content: '排队取消', mode: 'queue' });
  assert.equal(queued.status, 'queued'); assert.equal(core.memoryV1RunView(queued.runId!), null); assert.equal(core.memoryV1Status().intake!.accepted, 2);
  core.cancelQueuedMessage(cancelled.id, core.queuedMessages('main').find(row => row.id === cancelled.id)!.revision);
  gate.resolve(); await finished(core, active.runId!);
  const admitted = await until(() => core.store.getSignal(queued.id), row => row?.status === 'accepted'); await finished(core, admitted!.runId!);
  assert.notEqual(admitted!.runId, active.runId); assert.ok(core.memoryV1RunView(admitted!.runId!)); assert.equal(core.memoryV1RunView(cancelled.id), null);
  assert.equal(core.memoryV1Status().intake!.accepted, 3); assert.equal(core.store.getSignal(cancelled.id)!.status, 'cancelled');
});

test('Core拒绝未知模式与伪造ready计量身份，不写运行或调用模型', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-v1-policy-'));
  try {
    await assert.rejects(Core.open({ dataDir: directory, memoryContextMode: 'unknown' as never }), /memory_context_mode_invalid/);
    const { createDefaultMemoryContextPolicy } = await import('../src/memory/v1/policy.js');
    const policy = createDefaultMemoryContextPolicy();
    policy.tokenizer = { ...policy.tokenizer, readiness: 'ready', version: 'forged', vocabularyHash: '0'.repeat(64) };
    await assert.rejects(Core.open({ dataDir: directory, memoryContextMode: 'shadow', memoryContextPolicy: policy }), /memory_tokenizer_identity_mismatch/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { await removeTemp(directory); }
});

test('未知模型媒体兼容性与成本显式保留，不向provider硬塞历史图片', async t => {
  const { core, prompts } = await setup(t); const context = core.createConversationContext({ id: 'chat.media', name: '合成媒体' });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
  const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(image); c.close(); } }), 'synthetic.png');
  const first = await core.submitMessage({ contextId: context.id, content: '媒体来源原文', attachments: [asset.id] }); await finished(core, first.runId!); await core.reconcileMemoryV1();
  const next = await send(core, 'main', '独立新运行'); const view = core.memoryV1RunView(next.runId!)!;
  const selected = view.recent.selected.find(row => row.originalText === '媒体来源原文')!; assert.ok(selected);
  assert.equal(selected.attachments[0]!.status, 'omitted'); assert.equal(selected.attachments[0]!.reason, 'unsupported-media'); assert.ok(!('bytes' in selected.attachments[0]!));
  assert.equal(view.measurement.mediaTokens, null); assert.equal(view.measurement.mediaCostKnown, false); assert.equal(view.measurement.modelId, null);
  assert.ok(!prompts.at(-1)!.includes('媒体来源原文')); assert.ok(!prompts.at(-1)!.includes(image.toString('base64')));
});
