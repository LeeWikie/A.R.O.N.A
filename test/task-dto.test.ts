import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { Core } from '../src/core.js';
import { managementTools } from '../src/management.js';
import { publicHistory, publicTaskHistoryDetails, projectHistoryToolResults } from '../src/history-projection.js';
import { publicTask, taskToolResult } from '../src/task-view.js';
import { serializeConversation, type NativeMessage } from '../src/compaction.js';
import type { TaskRecord } from '../src/runtime-store.js';
import { authenticatedApp, finished, removeTemp } from './helpers.js';

const privateMarkers = /PRIVATE-TOOL-BINDING|PRIVATE-MCP-BINDING|PRIVATE-NATIVE-QUEUE|PRIVATE-PUBLISH-BINDING/;
const business = { toolGrants: 'business rules', mcpKeys: ['business keys'], capabilityKey: 'business key', nativeTaskId: 'business queue' };
function task(): TaskRecord {
  return { id: '11111111-1111-4111-8111-111111111111', title: 'fixture task', content: '完整请求\n保持格式及附件引用', contextId: 'work.dto', returnContextId: 'main', parentId: null, signalId: '22222222-2222-4222-8222-222222222222', sourceSignalIds: [], occurrenceId: null, status: 'pending', revision: 1, attempt: 1, nativeTaskId: 'PRIVATE-NATIVE-QUEUE', runIds: [], grants: { write: false, execute: true, mcp: false }, toolGrants: [{ toolName: 'fixture', args: {}, contextId: 'work.dto', capabilityKey: 'PRIVATE-TOOL-BINDING' }], mcpKeys: ['PRIVATE-MCP-BINDING'], report: { outcome: 'succeeded', summary: 'business report', checks: [{ description: 'checked', passed: true }], deliveries: [{ kind: 'json', title: 'business data', value: business }], unresolved: [] }, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', ...{ publicationBinding: 'PRIVATE-PUBLISH-BINDING' } };
}
function details() {
  const value = task();
  return { ...value, runs: [], events: [
    { seq: 1, contextId: value.contextId, taskId: value.id, runId: null, kind: 'task_created', data: value, createdAt: value.createdAt },
    { seq: 2, contextId: value.contextId, taskId: value.id, runId: null, kind: 'input', data: { id: value.signalId, source: `task:${value.id}`, type: 'external-event', contextId: value.contextId, content: JSON.stringify({ taskId: value.id, title: value.title, goal: value.content, authorization: { capabilityKey: 'PRIVATE-TOOL-BINDING' }, sources: [{ id: 'source', type: 'user-message', content: JSON.stringify(business) }], childResults: [], continuation: 'PRIVATE-PUBLISH-BINDING' }), output: { kind: 'none', contextId: 'main' } }, createdAt: value.createdAt },
    { seq: 3, contextId: value.contextId, taskId: value.id, runId: null, kind: 'task_report', data: value.report, createdAt: value.createdAt },
  ] };
}
function clean(value: unknown) { assert.doesNotMatch(JSON.stringify(value), privateMarkers); }
function reportKept(value: unknown) { assert.match(JSON.stringify(value), /business rules/); assert.match(JSON.stringify(value), /business key/); }

test('task HTTP list, details, snapshot and async mutation responses project host bindings', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-dto-http-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false, controlToken: 'fixture-control-token-0123456789' });
  try {
    core.runtime.createContext({ id: 'work.dto', name: 'DTO', role: 'work' });
    core.runtime.createTask(task());
    for (const event of details().events) core.runtime.event(event);
    const app = authenticatedApp(core);
    clean(core.taskDetails(task().id)); reportKept(core.taskDetails(task().id));
    for (const url of ['/tasks', `/tasks/${task().id}`, '/snapshot']) {
      const response = await app.request(url); assert.equal(response.status, 200); const value = await response.json(); clean(value); reportKept(value);
    }
    // Exercise the actual HTTP async return sites independently of execution/admission.
    core.submitTask = async () => task();
    core.tasks.control = async () => task();
    core.taskMessage = (async () => ({ id: 'receipt', status: 'queued', taskId: task().id })) as unknown as Core['taskMessage'];
    for (const [url, body] of [['/tasks', {}], [`/tasks/${task().id}/pause`, { revision: 1 }], [`/tasks/${task().id}/messages`, { content: 'supplement' }]] as const) {
      const response = await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 202); clean(await response.json());
    }
    assert.match(JSON.stringify(core.runtime.task(task().id)), privateMarkers, 'private runtime task stays unchanged');
    assert.match(JSON.stringify(core.runtime.taskOwnEvents(task().id)), privateMarkers, 'private events stay unchanged');
  } finally { await core.close(); await removeTemp(directory); }
});

test('real task_list and task_get tool results are clean in the next LLM request', { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-dto-prompt-'));
  const legacyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-dto-legacy-'));
  const prompts: unknown[] = []; let round = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    prompts.push(request.prompt); const name = ['task_list', 'task_get'][round++];
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      if (name) c.enqueue({ type: 'tool-call', toolCallId: `call-${round}`, toolName: name, input: name === 'task_get' ? JSON.stringify({ id: task().id }) : '{}' });
      else { c.enqueue({ type: 'text-start', id: 'answer' }); c.enqueue({ type: 'text-delta', id: 'answer', delta: 'business answer' }); c.enqueue({ type: 'text-end', id: 'answer' }); }
      c.enqueue({ type: 'finish', finishReason: name ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) };
  } });
  let core = await Core.open({ dataDir: directory, memoryEnabled: false, model, controlToken: 'fixture-control-token-0123456789' });
  try {
    core.runtime.createContext({ id: 'work.dto', name: 'DTO', role: 'work' }); core.runtime.createTask(task());
    for (const event of details().events) core.runtime.event(event);
    const receipt = await core.submitMessage({ content: 'list then inspect task' });
    assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded'); assert.equal(prompts.length, 3);
    const results = (prompts[2] as { role: string; content: unknown[] }[]).filter(m => m.role === 'tool');
    assert.equal(results.length, 2); clean(results); reportKept(results);
    const saved = await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
    const legacy = structuredClone(saved.messages.find(message => message.content.parts.some(part => part.type === 'tool-invocation' && part.toolInvocation.toolName === 'task_get'))!);
    assert.ok(legacy);
    for (const part of legacy.content.parts) if (part.type === 'tool-invocation' && part.toolInvocation.toolName === 'task_get') part.toolInvocation.result = details();
    await core.close();
    const storage = new LibSQLStore({ id: 'arona-storage', url: 'file:' + path.join(legacyDirectory, 'history.sqlite').replaceAll('\\', '/') });
    await storage.init();
    const memory = new Memory({ storage, options: { lastMessages: false, generateTitle: false, semanticRecall: false, workingMemory: { enabled: false } } });
    let legacyBefore: string;
    try {
      await memory.createThread({ threadId: 'main', resourceId: 'local' });
      await memory.saveMessages({ messages: saved.messages.map(message => message.id === legacy.id ? legacy : message) });
      legacyBefore = JSON.stringify((await memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false })).messages.find(message => message.id === legacy.id));
    } finally { await storage.close(); }
    const storedRows = () => {
      const db = new DatabaseSync(path.join(legacyDirectory, 'history.sqlite'), { readOnly: true });
      try { return db.prepare('SELECT * FROM mastra_messages WHERE id=?').all(legacy.id); }
      finally { db.close(); }
    };
    const beforeRows = storedRows(); assert.equal(beforeRows.length, 1); assert.match(legacyBefore, privateMarkers);
    core = await Core.open({ dataDir: legacyDirectory, memoryEnabled: false, model, controlToken: 'fixture-control-token-0123456789' });
    const followup = await core.submitMessage({ content: 'continue with the stored task result' });
    assert.equal((await finished(core, followup.runId!))?.status, 'succeeded');
    const oldResults = (prompts.at(-1) as { role: string; content: unknown[] }[]).filter(m => m.role === 'tool');
    assert.ok(oldResults.length >= 2); clean(oldResults); reportKept(oldResults);
    const privateStored = (await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false })).messages.find(message => message.id === legacy.id);
    assert.match(JSON.stringify(privateStored), privateMarkers, 'request projection never rewrites old native history');
    assert.equal(JSON.stringify(privateStored), legacyBefore, 'original legacy native record remains unchanged');
    assert.deepEqual(storedRows(), beforeRows, 'legacy SQLite row fields and serialized content bytes remain unchanged');
    assert.match(JSON.stringify(core.projectMemory.snapshot(followup.runId!).nativeMessages), privateMarkers, 'private native snapshots retain original task replay data');
  } finally { await core.close(); await removeTemp(directory); await removeTemp(legacyDirectory); }
});

test('all management task results await and use the same business projection', async () => {
  const receipt = { id: 'supplement', status: 'queued', taskId: task().id };
  const core = {
    authorizeTaskCreation: () => ({ signalIds: [], threadId: 'main', key: 'auth' }),
    authorizeTaskTarget: () => ({ threadId: 'main' }), activeTool: () => ({ runId: 'run' }),
    createTask: async () => task(), taskDetails: () => details(), taskMessage: async () => receipt,
    runtime: { tasks: () => [task()], task: () => task() },
    tasks: { control: async () => task(), report: async () => task() },
  } as unknown as Core;
  const tools = managementTools(core, true) as unknown as Record<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>;
  for (const name of ['task_list', 'task_get', 'task_create', 'task_control', 'task_report', 'task_message']) {
    const result = await tools[name]!.execute({ id: task().id, signalIds: [task().signalId], task: { title: 'fixture', content: 'complete request' }, report: task().report, content: 'supplement', revision: 1, action: 'pause' }, {});
    clean(result); if (name !== 'task_message') reportKept(result); else assert.deepEqual(result, receipt);
  }
});

test('historical native task results and context_history wrappers project without touching business JSON or replay metadata', () => {
  const nested = { messages: [{ role: 'assistant', content: { parts: [{ type: 'tool-invocation', toolInvocation: { toolName: 'task_get', result: details(), state: 'result' } }] } }] };
  const prompt = [{ role: 'assistant', content: [{ type: 'reasoning', text: '', providerOptions: { pi: { thinkingSignature: 'OUTER-OPAQUE', redacted: true } } }] }, { role: 'tool', content: [
    { type: 'tool-result', toolName: 'task_get', output: { type: 'json', value: details() }, providerOptions: { pi: { signature: 'OUTER-SIGNATURE' } } },
    { type: 'tool-result', toolName: 'context_history', output: { type: 'text', value: JSON.stringify(nested) } },
    { type: 'tool-result', toolName: 'invoice_read', output: { type: 'json', value: business } },
  ] }];
  const original = structuredClone(prompt); const projected = projectHistoryToolResults(prompt); clean(projected); reportKept(projected);
  assert.deepEqual(projected[0], prompt[0]); assert.deepEqual(projected[1]!.content[0]!.providerOptions, prompt[1]!.content[0]!.providerOptions);
  assert.deepEqual(projected[1]!.content[2], prompt[1]!.content[2]); assert.deepEqual(prompt, original);
  const page = publicHistory(nested); clean(page); reportKept(page); clean(serializeConversation(nested.messages as NativeMessage[]));
  assert.match(JSON.stringify(nested), privateMarkers, 'private native storage is not rewritten');
});

for (const name of ['task_list', 'task_get', 'task_create', 'task_control', 'task_report', 'task_message']) test(`${name} old json/text/raw outputs share the host projection`, () => {
  const input = name === 'task_list' ? [task()] : name === 'task_get' ? details() : name === 'task_message' ? { id: 'receipt', status: 'accepted', runId: 'run', nativeSignalId: 'PRIVATE-NATIVE-QUEUE', capabilityKey: 'PRIVATE-TOOL-BINDING' } : task();
  for (const value of [input, JSON.stringify(input), { type: 'json', value: input }, { type: 'text', value: JSON.stringify(input) }]) {
    const old = structuredClone(value); const safe = taskToolResult(name, value); clean(safe);
    if (name !== 'task_message') reportKept(safe);
    assert.deepEqual(value, old);
  }
});

for (const name of ['task_list', 'task_get', 'task_create', 'task_control', 'task_report', 'task_message']) test(`${name} preserves failure and denial envelopes throughout history projection`, () => {
  for (const output of [
    { type: 'error-text', value: 'task_context_not_available' },
    { type: 'error-json', value: { error: 'task_revision_conflict', expected: 2, actual: 3 } },
    { type: 'execution-denied', reason: 'The user declined this operation.' },
  ]) {
    const source = structuredClone(output);
    assert.deepEqual(taskToolResult(name, output), source);
    assert.deepEqual(JSON.parse(taskToolResult(name, JSON.stringify(output))), source);
    const prompt = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'original-call', toolName: name, output, providerOptions: { synthetic: { signature: 'ORIGINAL-OPAQUE' } } }] }];
    assert.deepEqual(projectHistoryToolResults(prompt), prompt);
    assert.deepEqual(output, source);
  }
});

test('public task retains complete business state, grants and report references as a detached whitelist', () => {
  const source = task(); const safe = publicTask(source);
  assert.equal(safe.id, source.id); assert.equal(safe.revision, source.revision); assert.equal(safe.attempt, source.attempt);
  assert.equal(safe.content, source.content); assert.equal(safe.signalId, source.signalId); assert.equal(safe.status, source.status);
  assert.deepEqual(safe.grants, source.grants); assert.deepEqual(safe.report, source.report);
  assert.equal('toolGrants' in safe, false); assert.equal('mcpKeys' in safe, false); assert.equal('nativeTaskId' in safe, false); assert.equal('publicationBinding' in safe, false);
  safe.report!.deliveries[0]!.value = 'changed'; safe.runIds.push('changed'); safe.grants.execute = false;
  assert.deepEqual(source.report!.deliveries[0]!.value, business); assert.deepEqual(source.runIds, []); assert.equal(source.grants.execute, true);
});

test('task details project nested host event envelopes but preserve arbitrary user text and tool business data', () => {
  const value = details(); const template = value.events[0]!;
  const userText = '  {\n "toolGrants": ["PRIVATE-TOOL-BINDING"],\n "capabilityKey": "ordinary user data"\n}\n';
  const events = [
    ...value.events,
    { ...template, seq: 4, kind: 'input', data: { id: 'user', type: 'user-message', source: 'fixture', content: userText } },
    { ...template, seq: 5, runId: 'r', kind: 'tool_start', data: { toolCallId: 'task-read', toolName: 'task_get', args: { id: task().id }, capabilityKey: 'PRIVATE-TOOL-BINDING' } },
    { ...template, seq: 6, runId: 'r', kind: 'tool_end', data: { toolCallId: 'task-read', result: details(), capabilityKey: 'PRIVATE-TOOL-BINDING' } },
    { ...template, seq: 7, runId: 'r', kind: 'tool_start', data: { toolCallId: 'invoice', toolName: 'invoice_read', args: business } },
    { ...template, seq: 8, runId: 'r', kind: 'tool_end', data: { toolCallId: 'invoice', result: business } },
    { ...template, seq: 9, kind: 'tool_approval_required', data: { toolCallId: 'a', toolName: 'invoice_read', args: business, status: 'pending', capabilityKey: 'PRIVATE-TOOL-BINDING' } },
    { ...template, seq: 10, kind: 'model_request', data: { publicationBinding: 'PRIVATE-PUBLISH-BINDING' } },
  ];
  const safe = publicTaskHistoryDetails({ ...value, events });
  assert.equal((safe.events.find(e => e.seq === 4)!.data as { content: string }).content, userText, 'user JSON formatting is not rewritten');
  clean(safe.events.filter(e => e.seq !== 4));
  assert.deepEqual((safe.events.find(e => e.seq === 8)!.data as { result: unknown }).result, business);
  assert.deepEqual((safe.events.find(e => e.seq === 9)!.data as { args: unknown }).args, business);
  assert.match(JSON.stringify(events), privateMarkers);
  const input = safe.events.find(e => e.seq === 2)!.data as { content: string };
  const content = JSON.parse(input.content); assert.equal(content.goal, task().content);
  assert.equal('authorization' in content, false); assert.equal('continuation' in content, false);
  assert.equal(content.sources[0].content, JSON.stringify(business));
});

test('legacy scheduled business JSON stays byte-for-byte while an identified v2 task envelope is projected', () => {
  const value = details(); const event = value.events[1]!;
  const text = '  {\n "taskId": "invoice-id", "authorization": {"capabilityKey":"business authorization"}, "continuation": "business continuation", "toolGrants": []\n}\n';
  const ordinary = { ...event, kind: 'input', data: { id: 'legacy', type: 'scheduled-task', source: 'schedule:fixture', content: text } };
  const request = { ...event, kind: 'user_task_request', data: { input: { type: 'user-message', content: text }, request: { content: text, grants: { write: true, execute: false, mcp: false, capabilityKey: 'PRIVATE-TOOL-BINDING' } } } };
  const projected = publicTaskHistoryDetails({ ...value, events: [ordinary, request] });
  assert.equal((projected.events[0]!.data as { content: string }).content, text);
  const publicRequest = projected.events[1]!.data as { request: { content: string; grants: unknown } };
  assert.equal(publicRequest.request.content, text);
  assert.deepEqual(publicRequest.request.grants, { write: true, execute: false, mcp: false });
  clean(publicRequest);
  const bound = { ...event, data: { ...(event.data as Record<string, unknown>), source: 'schedule:fixture', type: 'scheduled-task' } };
  const safe = publicTaskHistoryDetails({ ...value, events: [bound] }); clean(safe); reportKept(safe);
  assert.equal('authorization' in JSON.parse((safe.events[0]!.data as { content: string }).content), false);
});

test('context_history inside a historical task_get event projects task data and inner opaque fields', () => {
  const value = details(); const template = value.events[0]!;
  const page = { messages: [{ role: 'assistant', content: { parts: [
    { type: 'reasoning', text: '', providerMetadata: { pi: { thinkingSignature: 'INNER-OPAQUE', redacted: true } } },
    { type: 'tool-invocation', toolInvocation: { toolName: 'task_create', state: 'result', result: task() } },
  ] } }] };
  const result = { ...value, events: [
    { ...template, kind: 'tool_start', data: { toolCallId: 'history', toolName: 'context_history', args: { id: 'main' } } },
    { ...template, seq: 2, kind: 'tool_end', data: { toolCallId: 'history', result: { type: 'text', value: JSON.stringify(page) } } },
  ] };
  const prompt = [{ role: 'tool', content: [{ type: 'tool-result', toolName: 'task_get', result, providerMetadata: { signature: 'OUTER-OPAQUE' } }] }];
  const projected = projectHistoryToolResults(prompt); clean(projected); reportKept(projected);
  assert.doesNotMatch(JSON.stringify(projected), /INNER-OPAQUE/); assert.match(JSON.stringify(projected), /OUTER-OPAQUE/);
  assert.match(JSON.stringify(prompt), /INNER-OPAQUE/);
  clean(publicTaskHistoryDetails(result));
});
