import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { Core } from '../src/core.js';
import { signalSchema } from '../src/domain.js';
import { finished, until, removeTemp, scriptedModel } from './helpers.js';

for (const natural of [false, true]) test(`main actual tools exclude execution delivery (natural=${natural})`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-'));
  const tools: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    tools.push((request.tools ?? []).map(tool => tool.name));
    await gate;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
      controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: dir, model });
  try {
    const receipt = natural ? await core.submitMessage({ content: '你好' }) : await core.submitSignal({ source: 'test', type: 'user-message', content: '你好' });
    await until(() => tools.length, count => count > 0);
    assert.equal(tools[0]!.includes('save_artifact'), false);
    assert.equal(tools[0]!.includes('report_scheduled_task'), false);
    assert.equal(tools[0]!.some(name => /mastra_workspace|execute_command/.test(name)), false);
    const context = { runId: receipt.runId, agent: { threadId: 'main', toolCallId: randomUUID() } } as unknown as ToolExecutionContext;
    assert.throws(() => core.publish('artifact', [receipt.id], '# Forced artifact', context), /worker_capability_required/);
  } finally { release(); await core.close(); await removeTemp(dir); }
});

test('ordinary main conversation publishes without creating an execution task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-chat-'));
  const core = await Core.open({ dataDir: dir, model: scriptedModel().model });
  try {
    const receipt = await core.submitSignal({ source: 'test', type: 'user-message', content: '普通文字交流' });
    await finished(core, receipt.runId!);
    assert.equal(core.runtime.tasks().length, 0);
    assert.deepEqual(core.store.outputsForSignal(receipt.id).map(output => output.kind), ['message']);
  } finally { await core.close(); await removeTemp(dir); }
});

function heldModel() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: { prompt: string; tools: string[] }[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    requests.push({ prompt: JSON.stringify(request.prompt), tools: (request.tools ?? []).map(tool => tool.name) });
    await gate;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
      controller.close();
    } }) };
  } });
  return { model, release: () => release(), requests };
}
const toolContext = (threadId: string, runId: string, toolCallId = randomUUID()) => ({ runId, agent: { threadId, toolCallId } }) as unknown as ToolExecutionContext;

for (const kind of ['artifact', 'both'] as const) test(`root ${kind} preserves original identity, target and actual admission`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-binding-'));
  const fixture = heldModel();
  let core = await Core.open({ dataDir: dir, model: fixture.model });
  const body = { id: randomUUID(), source: 'fixture', type: 'user-message', content: '完整格式要求\n  原始内容', output: { kind, contextId: 'destination' } };
  try {
    const receipts = await Promise.all(Array.from({ length: 6 }, () => core.submitSignal(body)));
    const receipt = receipts[0]!;
    assert.ok(receipts.every(value => value.runId === receipt.runId && value.nativeSignalId === receipt.nativeSignalId));
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.content, body.content);
    assert.equal(receipt.contextId, 'main');
    assert.equal(receipt.id, body.id);
    assert.deepEqual(receipt.output, body.output);
    assert.equal(core.runtime.tasks().length, 1);
    const task = core.runtime.tasks()[0]!;
    assert.notEqual(task.signalId, receipt.id);
    assert.equal(core.store.getRun(receipt.runId!)?.contextId, task.contextId);
    assert.equal(core.runtime.context(task.contextId)?.role, 'work');
    assert.equal(core.store.getSignal(task.signalId)?.output.kind, 'none');
    await until(() => fixture.requests.length, count => count > 0);
    assert.ok(fixture.requests[0]!.tools.includes('save_artifact'));
    assert.equal(fixture.requests[0]!.tools.includes('report_scheduled_task'), false);
    assert.ok(fixture.requests[0]!.prompt.includes('完整格式要求'));
    const context = toolContext(task.contextId, receipt.runId!);
    const output = core.publish('artifact', [task.signalId], '# Result', context, 'Result');
    assert.equal(core.publish('artifact', [task.signalId], '# Result', context, 'Result').id, output.id);
    if (kind === 'both') core.publish('message', [receipt.id], 'Result ready', toolContext(task.contextId, receipt.runId!));
    else assert.throws(() => core.publish('message', [receipt.id], 'Unauthorized chat', toolContext(task.contextId, receipt.runId!)), /output_kind_not_allowed/);
    const outputs = core.store.outputsForSignal(receipt.id);
    assert.deepEqual(outputs.map(value => value.kind), kind === 'both' ? ['artifact', 'message'] : ['artifact']);
    assert.ok(outputs.every(value => value.contextId === 'destination' && value.runId === receipt.runId && value.signalIds.length === 1 && value.signalIds[0] === receipt.id));
    assert.equal(core.store.outputsForSignal(task.signalId).length, 0);
    assert.equal(core.runtime.events('destination', 0, 100).filter(event => event.kind === 'delivery').length, outputs.length);
    await assert.rejects(core.submitSignal({ ...body, content: 'changed' }), /signal_id_conflict/);
    fixture.release();
    await finished(core, receipt.runId!);
    await until(() => core.runtime.task(task.id).status, status => status === 'unreported');
    assert.equal(core.runtime.pendingNotifications().length, 0, 'root output authorization does not add ordinary completion chat');
    await core.close();
    const resumed = heldModel();
    core = await Core.open({ dataDir: dir, model: resumed.model });
    assert.equal((await core.submitSignal(body)).runId, receipt.runId);
    assert.equal(resumed.requests.length, 0);
    assert.equal(core.store.outputsForSignal(receipt.id).length, outputs.length);
  } finally { fixture.release(); await core.close(); await removeTemp(dir); }
});

test('root binding rejects mismatched source, destination, attempt, cancellation and changed original body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-proof-'));
  const fixture = heldModel();
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    const source = await core.submitSignal({ source: 'fixture', type: 'user-message', content: 'Authorized artifact', output: { kind: 'artifact' } });
    const task = core.runtime.tasks()[0]!;
    const context = toolContext(task.contextId, source.runId!);
    assert.throws(() => core.publish('artifact', [randomUUID()], '# Wrong source', context, 'No'), /output_source_not_in_run/);
    assert.throws(() => core.publish('artifact', [source.id, task.signalId], '# Mixed proof', context, 'No'), /output_source_not_in_run/);
    for (const patch of [{ returnContextId: 'other' }, { sourceSignalIds: [randomUUID()] }, { attempt: 2 }, { status: 'cancelling' as const }, { status: 'cancelled' as const }]) {
      core.runtime.updateTask(task.id, patch);
      assert.throws(() => core.publish('artifact', [task.signalId], '# Not allowed', context, 'No'), /execution_binding_not_active/);
      core.runtime.updateTask(task.id, { returnContextId: task.returnContextId, sourceSignalIds: task.sourceSignalIds, attempt: task.attempt, status: task.status });
    }
    const original = core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(source.id)!.body as string;
    core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(original), output: { kind: 'both', contextId: 'other' } }), source.id);
    assert.throws(() => core.publish('artifact', [task.signalId], '# Modified original', context, 'No'), /execution_binding_not_active/);
    core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(original, source.id);
    const originalEvent = core.runtime.event.bind(core.runtime);
    core.runtime.event = input => { if (input.kind === 'delivery') throw new Error('synthetic-delivery-write-failure'); return originalEvent(input); };
    assert.throws(() => core.publish('artifact', [task.signalId], '# Atomic', context, 'No'), /synthetic-delivery-write-failure/);
    assert.equal(core.store.outputsForSignal(source.id).length, 0);
    core.runtime.event = originalEvent;
    core.publish('artifact', [task.signalId], '# Allowed', context, 'Yes');
    assert.equal(core.store.outputsForSignal(source.id).length, 1);
  } finally { fixture.release(); await core.close(); await removeTemp(dir); }
});

test('ordinary child inherits neither root output binding nor legacy occurrence tool', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-child-'));
  const fixture = heldModel();
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    const source = await core.submitSignal({ source: 'fixture', type: 'user-message', content: 'Root work', output: { kind: 'both' } });
    const root = core.runtime.tasks()[0]!;
    const authority = core.authorizeTaskCreation(undefined, toolContext(root.contextId, source.runId!));
    assert.deepEqual(authority.signalIds, [root.signalId]);
    const child = await core.createTask({ title: 'Child work', content: 'Independent child work' }, { sourceSignalIds: authority.signalIds, returnContextId: root.contextId }, 'child-fixture');
    const admitted = await until(() => core.store.getSignal(child.signalId), value => value?.status === 'accepted');
    assert.equal(admitted!.output.kind, 'none');
    assert.equal(core.store.taskBinding(child.id), undefined);
    const context = toolContext(child.contextId, admitted!.runId!);
    assert.throws(() => core.publish('artifact', [child.signalId], '# Escalation', context, 'No'), /output_kind_not_allowed/);
    assert.throws(() => core.publish('artifact', [source.id], '# Parent proof', context, 'No'), /output_source_not_in_run/);
    assert.throws(() => core.reportLegacyOccurrence(randomUUID(), 'succeeded', 'No', context), /execution_binding_not_active/);
    await until(() => fixture.requests.length, value => value >= 2);
    const childRequest = fixture.requests.find(value => value.prompt.includes('Independent child work'))!;
    assert.equal(childRequest.tools.includes('save_artifact'), false);
    assert.equal(childRequest.tools.includes('report_scheduled_task'), false);
  } finally { fixture.release(); await core.close(); await removeTemp(dir); }
});

test('queued root waits for actual admission and rejects cancellation without a fabricated run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-admission-'));
  const fixture = heldModel();
  const core = await Core.open({ dataDir: dir, model: fixture.model, concurrency: 1 });
  try {
    await core.submitSignal({ source: 'fixture', type: 'external-event', content: 'Hold concurrency slot' });
    let settled = false;
    const pending = core.submitSignal({ source: 'fixture', type: 'external-event', content: 'Queued root' }).finally(() => { settled = true; });
    void pending.catch(() => {});
    const task = await until(() => core.runtime.tasks().find(task => task.content === 'Queued root'), value => !!value?.nativeTaskId);
    assert.equal(settled, false);
    assert.equal(core.store.getSignal(task!.sourceSignalIds[0]!)?.runId, null);
    assert.equal(core.runtime.task(task!.id).status, 'pending');
    await core.tasks.control(task!.id, 'cancel', core.runtime.task(task!.id).revision);
    await assert.rejects(pending, /task_cancelled_during_admission/);
    assert.equal(core.store.getSignal(task!.sourceSignalIds[0]!)?.runId, null);
  } finally { fixture.release(); await core.close(); await removeTemp(dir); }
});

for (const kind of ['artifact', 'both', 'message', 'none'] as const) test(`legacy occurrence ${kind} gets only its own delivery and report tools`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-occurrence-'));
  const fixture = heldModel();
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    const schedule = core.schedules.create({ name: 'Legacy duty', task: 'Complete fixture duty', timing: { kind: 'once', at: new Date(Date.now() + 3600_000).toISOString() }, output: { kind, contextId: 'legacy-target' } });
    const occurrence = await core.schedules.run(schedule.id);
    const task = core.runtime.tasks()[0]!;
    assert.equal(occurrence.signal?.status, 'accepted');
    assert.equal(occurrence.signal?.id, occurrence.signalId);
    assert.notEqual(task.signalId, occurrence.signalId);
    assert.equal(core.store.getSignal(task.signalId)?.output.kind, 'none');
    const context = toolContext(task.contextId, occurrence.signal!.runId!);
    await until(() => fixture.requests.length, value => value > 0);
    const tools = fixture.requests[0]!.tools;
    assert.equal(tools.includes('save_artifact'), kind === 'artifact' || kind === 'both');
    assert.equal(tools.includes('emit_message'), kind === 'message' || kind === 'both');
    assert.equal(tools.includes('report_scheduled_task'), true);
    assert.equal(tools.includes('task_report'), false);
    assert.throws(() => core.reportLegacyOccurrence(randomUUID(), 'succeeded', 'Wrong occurrence', context), /occurrence_not_in_active_run/);
    const current = core.runtime.task(task.id);
    core.runtime.updateTask(task.id, { attempt: (current.attempt ?? 1) + 1 });
    assert.throws(() => core.reportLegacyOccurrence(occurrence.id, 'succeeded', 'Stale attempt', context), /execution_binding_not_active/);
    core.runtime.updateTask(task.id, { attempt: current.attempt });
    if (kind === 'artifact' || kind === 'both') core.publish('artifact', [task.signalId], '# Legacy result', toolContext(task.contextId, occurrence.signal!.runId!), 'Legacy');
    if (kind === 'message' || kind === 'both') core.publish('message', [task.signalId], 'Legacy message', toolContext(task.contextId, occurrence.signal!.runId!));
    core.reportLegacyOccurrence(occurrence.id, 'succeeded', 'Legacy reported', context);
    fixture.release();
    await finished(core, occurrence.signal!.runId!);
    await until(() => core.runtime.task(task.id).status, status => status === 'succeeded');
    assert.equal(core.runtime.taskOwnEvents(task.id).filter(event => event.kind === 'task_report').length, 0);
    const completed = core.schedules.occurrence(occurrence.id);
    assert.equal(completed.report.status, 'succeeded');
    assert.equal(completed.outputs.length, kind === 'both' ? 2 : kind === 'none' ? 0 : 1);
    assert.ok(completed.outputs.every(output => output.contextId === 'legacy-target' && output.signalIds.length === 1 && output.signalIds[0] === occurrence.signalId));
    assert.equal(core.runtime.pendingNotifications().length, 0);
  } finally { fixture.release(); await core.close(); await removeTemp(dir); }
});

test('v2 scheduled task keeps task_report and host occurrence settlement, without legacy reporter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-v2-'));
  const fixture = heldModel();
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    const context = core.createWorkContext({ id: 'duty.fixture', name: 'V2 fixture', purpose: 'Fixture duty' });
    const schedule = core.schedules.create({ version: 2, contextId: context.id, name: 'V2 duty', task: 'Complete v2 duty', timing: { kind: 'once', at: new Date(Date.now() + 3600_000).toISOString() }, output: { kind: 'artifact', contextId: 'main' } });
    const occurrence = await core.schedules.run(schedule.id);
    const task = core.runtime.tasks().find(task => task.occurrenceId === occurrence.id)!;
    const signal = await until(() => core.store.getSignal(task.signalId), value => value?.status === 'accepted');
    await until(() => fixture.requests.length, value => value > 0);
    assert.equal(fixture.requests[0]!.tools.includes('report_scheduled_task'), false);
    assert.equal(fixture.requests[0]!.tools.includes('task_report'), true);
    assert.equal(core.store.taskBinding(task.id), undefined);
    core.publish('artifact', [signal!.id], '# V2 result', toolContext(task.contextId, signal!.runId!), 'V2');
    await core.tasks.report(task.id, { outcome: 'succeeded', summary: 'V2 reported', checks: [{ description: 'Synthetic result verified', passed: true }], deliveries: [], unresolved: [] }, signal!.runId!, (task, report) => core.verifyReport(task, report));
    fixture.release();
    await finished(core, signal!.runId!);
    await until(() => core.runtime.task(task.id).status, status => status === 'succeeded');
    await until(() => core.schedules.occurrence(occurrence.id).report.summary, summary => summary === 'V2 reported');
    assert.equal(core.schedules.occurrence(occurrence.id).report.status, 'succeeded');
    assert.equal(core.store.outputsForSignal(occurrence.signalId).length, 1);
  } finally { fixture.release(); await core.close(); await removeTemp(dir); }
});

test('restart admits a persisted root that never entered the executor, without replacing source body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-recovery-'));
  const input = signalSchema.parse({ source: 'fixture', type: 'external-event', content: 'Persisted unadmitted root' });
  let core = await Core.open({ dataDir: dir, model: scriptedModel().model });
  try {
    core.store.receive(input);
    const task = core.tasks.create({ title: 'Pending root', content: input.content }, { sourceSignalIds: [input.id], returnContextId: input.output.contextId }, 'pending-root', task => core.store.bindExecution(input.id, task));
    const original = core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(input.id)!.body;
    await core.close();
    core = await Core.open({ dataDir: dir, model: scriptedModel().model });
    const source = await until(() => core.store.getSignal(input.id), value => value?.status === 'accepted');
    assert.equal(core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(input.id)!.body, original);
    assert.equal(core.store.getRun(source!.runId!)?.contextId, task.contextId);
    await finished(core, source!.runId!);
    assert.equal(core.store.outputsForSignal(input.id).length, 1);
    assert.equal(core.runtime.tasks().length, 1);
  } finally { await core.close(); await removeTemp(dir); }
});

test('main forced artifact tool call fails through the real model/controller path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-forced-'));
  const id = randomUUID();
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const force = calls++ === 0;
    assert.equal((request.tools ?? []).some(tool => tool.name === 'save_artifact'), false);
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (force) controller.enqueue({ type: 'tool-call', toolCallId: 'forced-artifact', toolName: 'save_artifact', input: JSON.stringify({ signalIds: [id], title: 'Forbidden', markdown: '# Forbidden' }) });
      controller.enqueue({ type: 'finish', finishReason: force ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
      controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: dir, model });
  try {
    const receipt = await core.submitSignal({ id, source: 'fixture', type: 'user-message', content: 'Ordinary chat' });
    await finished(core, receipt.runId!);
    assert.equal(core.store.listOutputs({ after: 0 }).length, 0);
    const history = await core.history('main', 0, 100);
    assert.ok(history.messages.some(message => message.content.parts.some(part => part.type === 'tool-invocation' && part.toolInvocation.toolName === 'save_artifact' && part.toolInvocation.state === 'output-error')));
  } finally { await core.close(); await removeTemp(dir); }
});

test('reusing a finished root context does not inherit its delivery tool policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-reuse-'));
  const fixture = heldModel();
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    const root = await core.submitSignal({ source: 'fixture', type: 'external-event', content: 'Original root context' });
    const contextId = core.store.getRun(root.runId!)!.contextId;
    fixture.release();
    await finished(core, root.runId!);
    const ordinary = await core.submitTask({ title: 'Ordinary reused context', content: 'Reuse without output authorization', contextId }, 'reuse-fixture');
    const admitted = await until(() => core.store.getSignal(ordinary.signalId), value => value?.status === 'accepted');
    await finished(core, admitted!.runId!);
    assert.equal(admitted!.output.kind, 'none');
    const request = fixture.requests.find(value => value.prompt.includes('Reuse without output authorization'))!;
    assert.ok(request);
    assert.equal(request.tools.includes('save_artifact'), false);
    assert.equal(request.tools.includes('report_scheduled_task'), false);
  } finally { fixture.release(); await core.close(); await removeTemp(dir); }
});

test('a user message delivered after a none-output event can still publish its own reply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-role-none-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = scriptedModel({ gate });
  const core = await Core.open({ dataDir: dir, model: fixture.model });
  try {
    const event = await core.submitSignal({ version: 2, source: 'fixture', type: 'external-event', content: 'Silent business update', output: { kind: 'none' } });
    await until(fixture.calls, value => value > 0);
    const user = await core.submitSignal({ source: 'fixture', type: 'user-message', content: 'Please reply' });
    assert.equal(user.runId, event.runId);
    release();
    await finished(core, user.runId!);
    assert.equal(core.store.outputsForSignal(event.id).length, 0);
    assert.deepEqual(core.store.outputsForSignal(user.id).map(value => value.kind), ['message']);
    assert.equal(core.runtime.tasks().length, 0);
  } finally { release(); await core.close(); await removeTemp(dir); }
});
