import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { TaskRecord, ApprovalRecord } from '../src/runtime-store.js';
import type { InteractionRecord } from '../src/interactions.js';
import type { RunRecoveryEnvelope } from '../src/run-recovery.js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { until, removeTemp } from './helpers.js';

interface NativeTask { id: string; status: string; startedAt?: string; timeoutMs: number }
interface Inspection { type: 'inspection'; calls: number; workerCalls: number; tasks: TaskRecord[]; interactions: InteractionRecord[]; approvals: ApprovalRecord[]; recoveries: Array<RunRecoveryEnvelope | null>; nativeTasks: Array<NativeTask | null>; suspensions: unknown; history: Array<{ contextId: string; messages: MastraDBMessage[] }>; events: unknown[] }
async function launch(directory: string, mode: string, timeoutMs?: number) {
  const child = fork(fileURLToPath(new URL('./control-recovery-boundary-fixture.ts', import.meta.url)), [directory, mode], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ...(timeoutMs ? { SYNTHETIC_TASK_TIMEOUT_MS: String(timeoutMs) } : {}) } });
  const messages: Array<Record<string, unknown>> = []; let logs = '';
  child.on('message', value => { if (value && typeof value === 'object') messages.push(value as Record<string, unknown>); });
  child.stdout?.on('data', value => { logs = (logs + String(value)).slice(-12000); }); child.stderr?.on('data', value => { logs = (logs + String(value)).slice(-12000); });
  const ready = await until(() => { if (child.exitCode !== null || child.signalCode !== null) throw Error(`fixture_exited: ${logs}`); return messages.find(row => row.type === 'ready') as { port: number; token: string; storageId: string } | undefined; }, Boolean, 20000);
  return { child, ready: ready!,
    async request<T = unknown>(route: string, body?: unknown) { const response = await fetch(`http://127.0.0.1:${ready!.port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) }); const result = { status: response.status, body: await response.json() as T }; fs.appendFileSync(path.join(directory, 'control-http.jsonl'), JSON.stringify({ pid: child.pid, route, request: body, response: result }) + '\n'); return result; },
    async inspect() { const start = messages.length; child.send({ type: 'inspect' }); const result = await until(() => messages.slice(start).find(row => row.type === 'inspection') as unknown as Inspection | undefined, Boolean, 10000) as Inspection; fs.writeFileSync(path.join(directory, `inspection-${child.pid}.json`), JSON.stringify(result, null, 2)); return result; },
  };
}
async function stop(child: ChildProcess, hard = false) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill(hard ? 'SIGKILL' : 'SIGTERM'); let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 7000); })]); } finally { clearTimeout(timer); } }
function sourceHashes() { return Object.fromEntries(['core.ts', 'run-recovery.ts'].map(name => [name, createHash('sha256').update(fs.readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)))).digest('hex')])); }
async function cleanup(directory: string, children: ChildProcess[], label: string) { for (const child of children) await stop(child); if (process.env.ARONA_TEST_ARTIFACTS) { const destination = path.join(process.env.ARONA_TEST_ARTIFACTS, label); fs.mkdirSync(destination, { recursive: true }); fs.cpSync(directory, destination, { recursive: true }); } await removeTemp(directory); }
function sealed(state: Inspection, gates: Array<{ runId: string; toolCallId: string }>) { return gates.every(gate => state.recoveries.some(envelope => envelope?.runId === gate.runId && envelope.gates.some(value => value.toolCallId === gate.toolCallId))); }
function effects(directory: string) { const file = path.join(directory, 'control-observations.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row) as { kind: string; value: { identity?: { runId: string; threadId: string } } }).filter(row => row.kind === 'configuration-effect') : []; }

test('a cold worker retains its original wall-clock deadline including downtime', { timeout: 55000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovery-deadline-')); const children: ChildProcess[] = [];
  try {
    const source = sourceHashes(); const first = await launch(directory, 'deadline', 30000); children.push(first.child);
    const submitted = await first.request<TaskRecord>('/tasks', { title: 'Synthetic deadline', content: 'Wait for a synthetic choice.' }); assert.equal(submitted.status, 202);
    const before = await until(() => first.inspect(), state => state.interactions.some(row => row.status === 'pending') && state.recoveries.some(Boolean));
    const native = before.nativeTasks.find(row => row?.id === before.tasks[0]!.nativeTaskId)!; assert.equal(native.timeoutMs, 30000); assert.ok(native.startedAt);
    const deadline = Date.parse(native.startedAt) + native.timeoutMs;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() - 15000)));
    await stop(first.child, true); const killedAt = Date.now(); await new Promise(resolve => setTimeout(resolve, 4000));
    assert.deepEqual(sourceHashes(), source, 'both processes must use the same recovery implementation');
    const after = await launch(directory, 'deadline', 30000); children.push(after.child); const restored = await after.inspect();
    fs.writeFileSync(path.join(directory, 'deadline-evidence.json'), JSON.stringify({ original: native, deadline, killedAt, restoredAt: Date.now(), restored: restored.nativeTasks, runIds: restored.tasks[0]?.runIds }, null, 2));
    assert.equal(restored.calls, 0); assert.equal(restored.tasks[0]!.id, submitted.body.id); assert.deepEqual(restored.tasks[0]!.runIds, before.tasks[0]!.runIds);
    assert.ok(Date.now() < deadline, 'fixture must restart while time remains');
    const ended = await until(() => after.inspect(), state => state.nativeTasks.some(row => row?.id === native.id && !['pending', 'running'].includes(row.status)), Math.max(1000, deadline - Date.now() + 1200));
    assert.ok(Date.now() <= deadline + 1500, 'restart cannot grant a fresh full timeout');
    assert.equal(ended.nativeTasks.find(row => row?.id === native.id)?.status, 'timed_out');
    assert.notEqual(ended.tasks[0]?.status, 'succeeded'); assert.equal(ended.workerCalls, 0, 'deadline settlement may notify the parent but cannot re-execute the worker');
  } finally { await cleanup(directory, children, 'deadline'); }
});

test('a worker whose deadline elapsed while offline is not restarted or reported as successful', { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovery-expired-')); const children: ChildProcess[] = [];
  try {
    const first = await launch(directory, 'deadline', 5000); children.push(first.child);
    const submitted = await first.request<TaskRecord>('/tasks', { title: 'Synthetic offline expiration', content: 'Wait without granting additional time.' }); assert.equal(submitted.status, 202);
    const before = await until(() => first.inspect(), state => { const pending = state.interactions.filter(row => row.status === 'pending'); return pending.length === 1 && sealed(state, pending); });
    const original = before.nativeTasks.find(row => row?.id === before.tasks[0]!.nativeTaskId)!; assert.equal(original.timeoutMs, 5000); assert.ok(original.startedAt);
    const deadline = Date.parse(original.startedAt) + original.timeoutMs; await stop(first.child, true);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 100)));
    const second = await launch(directory, 'deadline', 5000); children.push(second.child); const restored = await second.inspect();
    assert.equal(restored.workerCalls, 0); assert.equal(restored.tasks[0]!.id, submitted.body.id); assert.deepEqual(restored.tasks[0]!.runIds, before.tasks[0]!.runIds);
    assert.notEqual(restored.tasks[0]!.status, 'succeeded'); assert.ok(!restored.interactions.some(row => row.status === 'pending'));
    assert.ok(restored.events.some(value => value && typeof value === 'object' && 'kind' in value && value.kind === 'run_recovery_unavailable' && 'data' in value && JSON.stringify(value.data).includes('run_recovery_task_expired')));
    assert.ok(restored.nativeTasks.every(row => row && !['pending', 'running', 'suspended'].includes(row.status)), 'an expired source leaves no executable native resource');
    assert.equal(effects(directory).length, 0);
  } finally { await cleanup(directory, children, 'expired'); }
});

test('a later suspension and a second restart retain the first native deadline', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovery-repeated-budget-')); const children: ChildProcess[] = [];
  try {
    const first = await launch(directory, 'sequence', 18000); children.push(first.child);
    const submitted = await first.request<TaskRecord>('/tasks', { title: 'Synthetic continuous budget', content: 'Continue two synthetic question stages.' }); assert.equal(submitted.status, 202);
    const waiting = await until(() => first.inspect(), state => { const pending = state.interactions.filter(row => row.status === 'pending'); return pending.length === 1 && sealed(state, pending); });
    const original = waiting.nativeTasks.find(row => row?.id === waiting.tasks[0]!.nativeTaskId)!; assert.ok(original.startedAt); const deadline = Date.parse(original.startedAt) + original.timeoutMs;
    const resource = waiting.recoveries.find(Boolean)!.resources![0]!; assert.equal(resource.deadlineAt, deadline);
    await stop(first.child, true); await new Promise(resolve => setTimeout(resolve, 1000));
    const second = await launch(directory, 'sequence', 18000); children.push(second.child); const restored = await second.inspect(); assert.equal(restored.workerCalls, 0);
    const question = restored.interactions.find(row => row.status === 'pending')!;
    assert.equal((await second.request(`/interactions/${question.id}/answer`, { expectedRunId: question.runId, answer: 'A' })).status, 202);
    const approval = (await until(() => second.inspect(), state => state.approvals.some(row => row.status === 'pending'))).approvals.find(row => row.status === 'pending')!;
    assert.equal((await second.request(`/approvals/${encodeURIComponent(approval.id)}`, { decision: 'approve' })).status, 200);
    const later = await until(() => second.inspect(), state => { const pending = state.interactions.filter(row => row.status === 'pending' && row.toolCallId === 'question-B'); return pending.length === 1 && sealed(state, pending); });
    assert.deepEqual(later.recoveries.find(Boolean)!.resources![0], resource, 're-sealing a later gate cannot replace the original signed budget');
    await stop(second.child, true); await new Promise(resolve => setTimeout(resolve, 1000));
    const third = await launch(directory, 'sequence', 18000); children.push(third.child); const twice = await third.inspect();
    assert.equal(twice.workerCalls, 0); assert.deepEqual(twice.tasks[0]!.runIds, waiting.tasks[0]!.runIds); assert.deepEqual(twice.recoveries.find(Boolean)!.resources![0], resource);
    const ended = await until(() => third.inspect(), state => state.nativeTasks.some(row => row?.id === original.id && row.status === 'timed_out'), Math.max(1000, deadline - Date.now() + 1200));
    assert.ok(Date.now() <= deadline + 1500); assert.notEqual(ended.tasks[0]!.status, 'succeeded'); assert.equal(ended.workerCalls, 0); assert.equal(effects(directory).length, 1);
  } finally { await cleanup(directory, children, 'repeated-budget'); }
});

test('two questions emitted together retain their native suspension order through a cold restart', { timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovery-parallel-')); const children: ChildProcess[] = [];
  try {
    const first = await launch(directory, 'parallel'); children.push(first.child);
    const submitted = await first.request<TaskRecord>('/tasks', { title: 'Two simultaneous choices', content: 'Resolve both synthetic choices before continuing.' }); assert.equal(submitted.status, 202);
    const waiting = await until(() => first.inspect(), state => { const pending = state.interactions.filter(row => row.status === 'pending'); return pending.length === 1 && sealed(state, pending); });
    const one = waiting.interactions.find(row => row.status === 'pending')!;
    const originalCalls = waiting.history.flatMap(row => row.messages.flatMap(message => message.content.parts.flatMap(part => part.type === 'tool-invocation' ? [part.toolInvocation.toolCallId] : [])));
    assert.ok(originalCalls.includes('question-A')); assert.ok(originalCalls.includes('question-B'));
    await stop(first.child, true); const second = await launch(directory, 'parallel'); children.push(second.child); const restored = await second.inspect();
    assert.equal(restored.workerCalls, 0); assert.deepEqual(restored.interactions.filter(row => row.status === 'pending').map(row => row.id), [one.id]);
    const answer = (item: InteractionRecord, text: string) => second.request(`/interactions/${item.id}/answer`, { expectedRunId: item.runId, answer: text });
    const [a, repeated] = await Promise.all([answer(one!, 'A'), answer(one!, 'A')]); await second.inspect(); assert.equal(a.status, 202); assert.equal(repeated.status, 202);
    const partial = await until(() => second.inspect(), state => state.interactions.find(row => row.id === one.id)?.status === 'answered' && state.interactions.some(row => row.status === 'pending' && row.toolCallId === 'question-B'));
    const two = partial.interactions.find(row => row.status === 'pending' && row.toolCallId === 'question-B')!; assert.equal(partial.workerCalls, 0, 'no model request may run with an unanswered sibling question');
    assert.equal((await answer(two, 'B')).status, 202);
    const firstApproval = (await until(() => second.inspect(), state => state.approvals.some(row => row.status === 'pending'))).approvals.find(row => row.status === 'pending')!;
    assert.equal((await second.request(`/approvals/${encodeURIComponent(firstApproval.id)}`, { decision: 'approve' })).status, 200);
    const lastApproval = (await until(() => second.inspect(), state => state.approvals.some(row => row.status === 'pending' && row.id !== firstApproval.id))).approvals.find(row => row.status === 'pending')!;
    assert.equal((await second.request(`/approvals/${encodeURIComponent(lastApproval.id)}`, { decision: 'approve' })).status, 200);
    const completed = await until(() => second.inspect(), state => state.tasks.find(row => row.id === submitted.body.id)?.status === 'succeeded');
    assert.deepEqual(completed.tasks[0]!.runIds, waiting.tasks[0]!.runIds); assert.equal(effects(directory).length, 2);
  } finally { await cleanup(directory, children, 'parallel'); }
});

test('independent runs retain questions, cold denial and a later suspension without repeating effects', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovery-sequences-')); const children: ChildProcess[] = [];
  try {
    const first = await launch(directory, 'sequence'); children.push(first.child);
    const a = await first.request<TaskRecord>('/tasks', { title: 'Synthetic first run', content: 'Resolve synthetic stages.' }), b = await first.request<TaskRecord>('/tasks', { title: 'Synthetic second run', content: 'Resolve independent stages.' }); assert.equal(a.status, 202); assert.equal(b.status, 202);
    const initial = await until(() => first.inspect(), state => { const pending = state.interactions.filter(row => row.status === 'pending'); return pending.length === 2 && sealed(state, pending); });
    for (const question of initial.interactions.filter(row => row.status === 'pending')) assert.equal((await first.request(`/interactions/${question.id}/answer`, { expectedRunId: question.runId, answer: 'A' })).status, 202);
    const approvalState = await until(() => first.inspect(), state => { const pending = state.approvals.filter(row => row.status === 'pending'); return pending.length === 2 && sealed(state, pending); });
    const approved = approvalState.approvals.find(row => row.taskId === a.body.id)!, denied = approvalState.approvals.find(row => row.taskId === b.body.id)!;
    await stop(first.child, true); const second = await launch(directory, 'sequence'); children.push(second.child); assert.equal((await second.inspect()).workerCalls, 0);
    const decisions = await Promise.all([second.request(`/approvals/${encodeURIComponent(approved.id)}`, { decision: 'approve' }), second.request(`/approvals/${encodeURIComponent(denied.id)}`, { decision: 'decline' })]); assert.ok(decisions.every(row => row.status === 200));
    const again = await until(() => second.inspect(), state => { const pending = state.interactions.filter(row => row.status === 'pending' && row.toolCallId === 'question-B'); return pending.length === 2 && sealed(state, pending); });
    assert.equal(effects(directory).length, 1); assert.equal(effects(directory)[0]!.value.identity?.runId, approved.runId);
    const cancel = await second.request(`/tasks/${b.body.id}/cancel`, { revision: again.tasks.find(row => row.id === b.body.id)!.revision }); assert.equal(cancel.status, 202);
    await stop(second.child, true); const third = await launch(directory, 'sequence'); children.push(third.child); const restored = await third.inspect();
    assert.equal(restored.workerCalls, 0); assert.equal(restored.tasks.find(row => row.id === b.body.id)?.status, 'cancelled');
    const nativeDenied = restored.history.find(row => row.contextId === b.body.contextId)!.messages.flatMap(message => message.content.parts.flatMap(part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'approval-A' ? [part.toolInvocation] : [])).at(-1);
    assert.ok(nativeDenied); assert.equal(nativeDenied.state, 'output-denied'); assert.equal(nativeDenied.approval?.approved, false); assert.ok(!effects(directory).some(row => row.value.identity?.runId === denied.runId));
    const question = restored.interactions.find(row => row.contextId === a.body.contextId && row.status === 'pending')!; assert.ok(question);
    const repeat = await Promise.all([third.request(`/interactions/${question.id}/answer`, { expectedRunId: question.runId, answer: 'B' }), third.request(`/interactions/${question.id}/answer`, { expectedRunId: question.runId, answer: 'B' })]); assert.ok(repeat.every(row => row.status === 202));
    const finalGate = (await until(() => third.inspect(), state => state.approvals.some(row => row.status === 'pending' && row.toolCallId === 'approval-B'))).approvals.find(row => row.status === 'pending' && row.toolCallId === 'approval-B')!;
    const receipts = await Promise.all([third.request(`/approvals/${encodeURIComponent(finalGate.id)}`, { decision: 'approve' }), third.request(`/approvals/${encodeURIComponent(finalGate.id)}`, { decision: 'approve' })]); assert.ok(receipts.every(row => row.status === 200));
    const completed = await until(() => third.inspect(), state => state.tasks.find(row => row.id === a.body.id)?.status === 'succeeded');
    assert.equal(effects(directory).length, 2); assert.ok(effects(directory).every(row => row.value.identity?.runId === approved.runId)); assert.deepEqual(completed.tasks.find(row => row.id === a.body.id)!.runIds, initial.tasks.find(row => row.id === a.body.id)!.runIds);
    await stop(third.child, true); const fourth = await launch(directory, 'sequence'); children.push(fourth.child); assert.equal((await fourth.inspect()).workerCalls, 0); assert.equal(effects(directory).length, 2);
  } finally { await cleanup(directory, children, 'sequences'); }
});
