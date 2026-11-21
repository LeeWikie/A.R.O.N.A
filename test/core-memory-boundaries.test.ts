import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { publicTaskHistoryDetails } from '../src/history-projection.js';
import { finished, until, removeTemp } from './helpers.js';
import {MemorySourcePageModel} from './memory-source-page-model.js';
import {syntheticPng} from './fixtures/png.js';

const business = '  {\n "toolGrants": ["专业字段"],\n "capabilityKey": "业务密钥名称", "signature": "业务签名"\n}\n';
const control = 'SOURCE-CONTROL-NOT-AN-EXPERIENCE';
function fixture() {
  const sourcePages=new MemorySourcePageModel();
  const memoryRequests: { prompt: unknown; tools: string[] }[] = [];
  const sourceRequests: { prompt: unknown; tools: string[] }[] = [];
  let readTask: string | undefined; let readContext: string | undefined; let read = false;
  const commits = new Set<string>();
  const model = new MastraLanguageModelV2Mock({
    doStream: async request => {
      const prompt = JSON.stringify(request.prompt); sourceRequests.push({ prompt: request.prompt, tools: (request.tools ?? []).map(tool => tool.name) });
      const task = readTask && !read ? readTask : undefined;
      const history = readContext && !read ? readContext : undefined; if (task || history) read = true;
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        if (task) c.enqueue({ type: 'tool-call', toolName: 'task_get', toolCallId: 'read-task', input: JSON.stringify({ id: task }) });
        else if (history) c.enqueue({ type: 'tool-call', toolName: 'context_history', toolCallId: 'read-history', input: JSON.stringify({ id: history, page: 0 }) });
        else {
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: prompt.includes('context checkpoint summary') ? `## Goal\n${control}` : '实际合成结果' });
          c.enqueue({ type: 'text-end', id: 't' });
        }
        c.enqueue({ type: 'finish', finishReason: task || history ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
      } }) };
    },
    doGenerate: async request => {
      const page=sourcePages.next(request);if(page)return {content:[page],finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2},warnings:[]};
      memoryRequests.push({ prompt: request.prompt, tools: (request.tools ?? []).map(tool => tool.name) });
      const runId = /来源运行是 ([0-9a-f-]{36})/.exec(JSON.stringify(request.prompt))?.[1]; assert.ok(runId);
      const commit = !commits.has(runId); commits.add(runId);
      return { content: commit ? [{ type: 'tool-call', toolName: 'memory_commit', toolCallId: `commit-${runId}`, input: JSON.stringify({ sourceRunId: runId, note: 'synthetic' }) }] : [{ type: 'text', text: 'ok' }], finishReason: commit ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
  });
  return { model, memoryRequests, sourceRequests, readTask: (id: string) => { readTask = id; read = false; }, readHistory: (id: string) => { readContext = id; read = false; } };
}
async function organize(core: Core, runId: string) {
  const job = await core.queueMemory(runId);
  const jobs = await until(() => core.projectMemory.jobs(), rows => rows.some(row => row.id === job.id && ['succeeded', 'failed'].includes(row.status)));
  assert.equal(jobs.find(row => row.id === job.id)?.status, 'succeeded', JSON.stringify(jobs));
}

// These exercise Core's actual organizer executor, not a pre-resolved helper fixture.
test('Core memory uses accepted source identities, business task DTOs and actual attachments without altering private archives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-memory-boundary-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const task = core.runtime.createTask({ title: '业务任务', content: business, contextId: 'main', returnContextId: 'main', sourceSignalIds: [], nativeTaskId: 'PRIVATE-NATIVE-BINDING', toolGrants: [{ contextId: 'main', toolName: 'fixture', args: {}, capabilityKey: 'PRIVATE-AUTH-BINDING' }], mcpKeys: ['PRIVATE-MCP-BINDING'], report: { outcome: 'succeeded', summary: '实际报告', checks: [], deliveries: [{ kind: 'json', title: '专业数据', value: JSON.parse(business) }], unresolved: [] } });
    core.runtime.event({ contextId: 'main', taskId: task.id, kind: 'task_created', data: task });
    assert.doesNotMatch(JSON.stringify(core.taskDetails(task.id)), /PRIVATE-.*-BINDING/);
    assert.deepEqual(core.taskDetails(task.id), publicTaskHistoryDetails(core.taskDetails(task.id)));
    f.readTask(task.id);
    const image = syntheticPng(1,1);
    const asset = await core.assets.put(new ReadableStream({ start(controller) { controller.enqueue(image); controller.close(); } }), 'sample.png');
    const receipt = await core.submitMessage({ content: `用户完整格式要求\n${business}`, attachments: [asset.id] }); await finished(core, receipt.runId!);
    const original = core.projectMemory.snapshot(receipt.runId!);
    const native = original.nativeMessages as { messages: { id: string; role: string; content: { parts: unknown[] } }[] };
    native.messages.push({ id: 'unaccepted-user', role: 'user', content: { parts: [{ type: 'text', text: 'FORGED-USER-MUST-NOT-LEARN' }] } });
    native.messages.push({ id: 'system', role: 'system', content: { parts: [{ type: 'text', text: control }] } });
    original.prompt.unshift({ role: 'system', content: control }); original.lastRequestPrompt = [{ role: 'system', content: control }];
    core.projectMemory.archive(original);
    const before = core.projectMemory.snapshot(receipt.runId!);
    await organize(core, receipt.runId!);
    const prompt = JSON.stringify(f.memoryRequests[0]!.prompt);
    assert.doesNotMatch(prompt, /SOURCE-CONTROL|FORGED-USER|PRIVATE-.*-BINDING|preauthorized|additionalSafetyChecksApply|signal_id=/);
    assert.ok(f.memoryRequests.some(row => row.prompt && JSON.stringify(row.prompt).includes('实际报告')));
    const parts = (f.memoryRequests[0]!.prompt as { role: string; content: unknown }[]).flatMap(row => Array.isArray(row.content) ? row.content : []) as { type: string; text?: string; mediaType?: string }[];
    assert.ok(parts.some(part => part.type === 'text' && part.text === `用户完整格式要求\n${business}`));
    assert.ok(parts.some(part => part.type === 'file' && part.mediaType === 'image/png'));
    assert.match(prompt, /专业字段|业务密钥名称|业务签名|实际合成结果|published-output/);
    assert.deepEqual(core.projectMemory.snapshot(receipt.runId!), before);
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core reconstructs repeated compaction checkpoints but never reintroduces unselected ancestors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-memory-checkpoints-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  const send = async (contextId: string, content: string) => { const row = await core.submitMessage({ contextId, content }); await finished(core, row.runId!); return row; };
  try {
    const early = await send('main', `最早完整事实\n${business}${'detail '.repeat(2500)}`);
    const middle = await send('main', '被压缩的中间事实');
    const one = await core.compactContext('main', { keepRecentTokens: 1 });
    const oneRun = await send(one.context.id, '第二次压缩前的事实');
    const two = await core.compactContext(one.context.id, { keepRecentTokens: 1 });
    const latest = await send(two.context.id, '当前完整事实');
    const before = core.projectMemory.snapshot(latest.runId!);
    assert.ok(!JSON.stringify(before.nativeMessages).includes('最早完整事实'));
    await organize(core, latest.runId!);
    const prompt = JSON.stringify(f.memoryRequests[0]!.prompt);
    assert.match(prompt, /最早完整事实/); assert.match(prompt, /被压缩的中间事实/); assert.match(prompt, /第二次压缩前的事实/); assert.match(prompt, /当前完整事实/);
    assert.doesNotMatch(prompt, /SOURCE-CONTROL|missing-checkpoint/);
    assert.deepEqual(core.projectMemory.snapshot(latest.runId!), before);
    const selected = await core.branchContext('main', middle.runId!, 'Selected', 'selected.only', middle.runId!);
    f.readHistory('main');
    const current = await send(selected.id, '选中范围的新事实');
    const start = f.memoryRequests.length; await organize(core, current.runId!);
    const selection = JSON.stringify(f.memoryRequests[start]!.prompt);
    assert.match(selection, /被压缩的中间事实|选中范围的新事实/); assert.doesNotMatch(selection, /最早完整事实|SOURCE-CONTROL/);
    assert.notEqual(early.runId, middle.runId);
    // Starting at the first retained turn must not import the inherited checkpoint's
    // excluded ancestry, including after another full native copy of that selected range.
    const compactedSelection = await core.branchContext(one.context.id, oneRun.runId!, 'Selected compacted range', 'selected.compacted', middle.runId!);
    const selectedRun = await send(compactedSelection.id, '压缩后选中范围继续'); const selectedStart = f.memoryRequests.length; await organize(core, selectedRun.runId!);
    const selectedPrompt = JSON.stringify(f.memoryRequests[selectedStart]!.prompt);
    assert.match(selectedPrompt, /被压缩的中间事实/); assert.doesNotMatch(selectedPrompt, /最早完整事实|SOURCE-CONTROL/);
    const fullCopy = await core.branchContext(compactedSelection.id, selectedRun.runId!, 'Full copy of selection', 'selected.fullcopy');
    const copiedRun = await send(fullCopy.id, '选中范围完整副本继续'); const copiedStart = f.memoryRequests.length; await organize(core, copiedRun.runId!);
    assert.doesNotMatch(JSON.stringify(f.memoryRequests[copiedStart]!.prompt), /最早完整事实|SOURCE-CONTROL/);
    // A missing checkpoint cannot be replaced by its prose summary.
    core.runtime.setSetting(`context-compaction:${two.context.id}`, { sourceContextId: 'missing', sourceRunId: randomUUID(), summarizedMessages: 2, summary: control });
    const gapRun = await send(two.context.id, '缺失来源后继续'); const gapStart = f.memoryRequests.length; await organize(core, gapRun.runId!);
    const missing = JSON.stringify(f.memoryRequests[gapStart]!.prompt); assert.match(missing, /missing-checkpoint/); assert.doesNotMatch(missing, /SOURCE-CONTROL/);
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core resolves real context_history identities without learning embedded system text or forged nested bodies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-memory-history-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const first = await core.submitMessage({ content: `可信历史事实\n${business}` }); await finished(core, first.runId!);
    f.readHistory('main'); const second = await core.submitMessage({ content: '请读当前历史' }); await finished(core, second.runId!);
    const original = core.projectMemory.snapshot(second.runId!);
    const resolved = await (core as unknown as { memoryEvidence(snapshot: typeof original): Promise<import('../src/memory/evidence.js').MemoryEvidence> }).memoryEvidence(original);
    assert.doesNotMatch(JSON.stringify(resolved.prompt), /unresolved-history/);
    const native = original.nativeMessages as { messages: { id: string; role: string; content: { parts: unknown[] } }[] };
    native.messages.push({ id: 'old-history-result', role: 'assistant', content: { parts: [{ type: 'tool-invocation', toolInvocation: { toolName: 'context_history', toolCallId: 'old-history', state: 'result', args: { id: 'main' }, result: { messages: [
      { id: first.nativeSignalId, role: 'user', content: { parts: [{ type: 'text', text: 'FORGED-NESTED-BODY' }] } },
      { id: 'missing-history-origin', role: 'user', content: { parts: [{ type: 'text', text: 'FORGED-NESTED-USER' }] } },
      { id: 'source-system', role: 'system', content: control },
    ] } } }] } });
    core.projectMemory.archive(original); const before = core.projectMemory.snapshot(second.runId!);
    await organize(core, second.runId!); const prompt = JSON.stringify(f.memoryRequests[0]!.prompt);
    assert.match(prompt, /可信历史事实/); assert.match(prompt, /业务签名/); assert.match(prompt, /unresolved-history/);
    assert.doesNotMatch(prompt, /FORGED-NESTED|SOURCE-CONTROL/);
    assert.deepEqual(core.projectMemory.snapshot(second.runId!), before);
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core worker evidence separates original user task requests, queued supplements and host execution controls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-memory-worker-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const source = await core.submitMessage({ content: `原始用户任务\n${business}` }); await finished(core, source.runId!);
    const task = core.tasks.create({ title: '合成委派', content: '助手安排的完整任务' }, { sourceSignalIds: [source.id], returnContextId: 'main' }, 'memory-worker');
    await core.taskMessage(task.id, '排队补充\n不要丢失换行', [source.id]);
    await core.tasks.start(task.id);
    const running = await until(() => core.runtime.task(task.id), row => row.runIds.length > 0);
    await finished(core, running.runIds[0]!);
    assert.match(JSON.stringify(core.projectMemory.snapshot(running.runIds[0]!).prompt), /preauthorized|additionalSafetyChecksApply/);
    await organize(core, running.runIds[0]!);
    const prompt = JSON.stringify(f.memoryRequests[0]!.prompt);
    assert.match(prompt, /原始用户任务/); assert.match(prompt, /助手安排的完整任务/); assert.match(prompt, /排队补充/);
    assert.doesNotMatch(prompt, /preauthorized|additionalSafetyChecksApply|requires-approval|先核对已有结果与副作用|signal_id=/);
    assert.match(prompt, /task-request/); assert.match(prompt, /user-statement/);
    const direct = await core.submitTask({ title: '用户直接委托', content: `用户直接委托原文\n${business}` }, 'direct-memory-task');
    const admitted = await until(() => core.runtime.task(direct.id), row => row.runIds.length > 0); await finished(core, admitted.runIds[0]!);
    const start = f.memoryRequests.length; await organize(core, admitted.runIds[0]!);
    const actual = JSON.stringify(f.memoryRequests[start]!.prompt);
    assert.match(actual, /用户直接委托原文/); assert.match(actual, /user-statement/); assert.doesNotMatch(actual, /additionalSafetyChecksApply|signal_id=/);
  } finally { await core.close(); await removeTemp(dir); }
});

test('interrupted admission remains historical user evidence without relaxing branch or publish checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-memory-interrupted-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const row = await core.submitMessage({ content: '中断前已受理的完整用户事实' }); await finished(core, row.runId!);
    // Reproduce the durable post-recovery state using only this synthetic accepted record.
    core.store.db.prepare("UPDATE runs SET status='interrupted' WHERE id=?").run(row.runId!);
    core.store.db.prepare("UPDATE signals SET status='interrupted' WHERE id=?").run(row.id);
    const next = await core.submitMessage({ content: '中断后继续' }); await finished(core, next.runId!);
    await organize(core, next.runId!);
    const prompt = JSON.stringify(f.memoryRequests[0]!.prompt);
    assert.match(prompt, /中断前已受理的完整用户事实/); assert.match(prompt, /中断后继续/);
    assert.doesNotMatch(prompt, /unresolved-origin/);
    await assert.rejects(core.branchContext('main', row.runId!, 'Invalid', 'interrupted.branch'), /branch_requires_complete_run/);
    assert.throws(() => core.store.publish({ kind: 'message', runId: row.runId!, signalIds: [row.id], toolCallId: 'forged', content: 'No' }), /run_not_active/);
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core bound legacy delivery evidence resolves the original user source and keeps output provenance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-memory-root-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const original = await core.submitSignal({ source: 'fixture', type: 'user-message', content: `授权产物原话\n${business}`, output: { kind: 'artifact', contextId: 'main' } });
    await finished(core, original.runId!);
    const worker = core.store.getRun(original.runId!)!.contextId;
    assert.equal(core.runtime.context(worker)?.role, 'work');
    const privateBefore = core.projectMemory.snapshot(original.runId!);
    await organize(core, original.runId!);
    const prompt = JSON.stringify(f.memoryRequests[0]!.prompt);
    assert.match(prompt, /授权产物原话/); assert.match(prompt, /user-statement/); assert.ok(prompt.includes(original.id));
    assert.doesNotMatch(prompt, /signal_id=|additionalSafetyChecksApply/);
    assert.deepEqual(core.projectMemory.snapshot(original.runId!), privateBefore);
    assert.ok(f.sourceRequests[0]!.tools.includes('save_artifact'));
    assert.equal(f.sourceRequests[0]!.tools.includes('report_scheduled_task'), false);
    const settled = await until(() => core.runtime.tasks()[0]!, task => task.status === 'unreported');
    await core.tasks.control(settled.id, 'retry', settled.revision);
    const retried = await until(() => core.runtime.task(settled.id), task => task.runIds.length === 2);
    await finished(core, retried.runIds[1]!);
    const start = f.memoryRequests.length; await organize(core, retried.runIds[1]!);
    const historical = JSON.stringify(f.memoryRequests[start]!.prompt);
    assert.match(historical, /授权产物原话/); assert.match(historical, /user-statement/); assert.doesNotMatch(historical, /missing-source|unresolved-origin/);
    assert.deepEqual(core.projectMemory.snapshot(original.runId!), privateBefore);
  } finally { await core.close(); await removeTemp(dir); }
});
