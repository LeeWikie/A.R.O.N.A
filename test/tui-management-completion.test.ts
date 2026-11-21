import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Terminal } from '@earendil-works/pi-tui';
import { TerminalApp } from '../src/tui/index.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { AppError, signalSchema } from '../src/domain.js';
import type { Client } from '../src/client.js';
import { removeTemp, scriptedModel } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
type Item = { value: string; label: string };
type UI = { schedules(): Promise<void>; workspaces(): Promise<void>; mcp(): Promise<void>; methods(): Promise<void>; workflows(): Promise<void>; createTask(): Promise<void>; tasks(): Promise<void>; choose(title: string, items: Item[]): Promise<string | undefined>; prompt(title: string, initial?: string): Promise<string | undefined>; promptLong(title: string, initial?: string): Promise<string | undefined>; note(text: string): void; taskCreationDrafts: Map<string, unknown> };
async function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-management-completion-'));
  const directory = fs.realpathSync(temporary);
  const core = await Core.open({ dataDir: directory, model: scriptedModel().model, memoryEnabled: false });
  const http = createApp(core); const chat = core.createConversationContext({ name: 'Current conversation' });
  const calls: { route: string; method: string; body?: unknown }[] = []; let submitTask: (() => Promise<unknown>) | undefined;
  const client = { async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (route === '/tasks' && init?.method === 'POST' && submitTask) return submitTask();
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${core.controlToken}`);
    const response = await http.request(route, { ...init, headers }); const body = await response.json() as { error?: string };
    if (!response.ok) throw new AppError(body.error ?? 'request_failed', response.status); return body;
  } } as unknown as Client;
  const app = new TerminalApp(client, chat.id, new FakeTerminal()); const ui = app as unknown as UI;
  const notes: string[] = []; const menus: { title: string; values: string[] }[] = []; let choices: string[] = [], prompts: string[] = [];
  ui.choose = async (title, items) => {
    menus.push({ title, values: items.map(item => item.value) });
    const selected = choices.shift(); if (selected !== undefined) assert.ok(items.some(item => item.value === selected), `Missing choice ${selected} in ${title}: ${items.map(item => item.value)}`); return selected;
  };
  ui.prompt = async (_title, initial) => prompts.shift() ?? initial;
  ui.promptLong = async (_title, initial) => prompts.shift() ?? initial;
  ui.note = text => { notes.push(text); };
  return { core, ui, chat, notes, calls, menus, directory, client, select: (...values: string[]) => { choices = values; }, input: (...values: string[]) => { prompts = values; }, submitting: (handler: () => Promise<unknown>) => { submitTask = handler; }, async close() { await app.stop(); await core.close(); await removeTemp(temporary); } };
}

test('ordinary conversation creates a duty with separate execution and delivery, and references protect archive', async () => {
  const f = await fixture();
  try {
    f.select('__add__', 'once', 'message', 'yes'); f.input('Read later', 'Check a file', '2099-01-01T00:00:00Z', 'Asia/Shanghai');
    await f.ui.schedules(); const schedule = f.core.schedules.list()[0]!;
    assert.equal(f.core.runtime.context(schedule.contextId)?.role, 'work'); assert.notEqual(schedule.contextId, f.chat.id); assert.equal(schedule.output.contextId, f.chat.id);
    assert.throws(() => f.core.archiveContext(schedule.contextId, true), /context_used_by_schedule/);
    assert.throws(() => f.core.archiveContext(f.chat.id, true), /context_used_by_schedule/);
    const paused = f.core.schedules.control(schedule.id, 'pause', schedule.revision);
    assert.throws(() => f.core.archiveContext(schedule.contextId, true), /context_used_by_schedule/);
    f.core.schedules.control(schedule.id, 'cancel', paused.revision);
    f.core.archiveContext(schedule.contextId, true); f.core.archiveContext(f.chat.id, true);
  } finally { await f.close(); }
});

test('duty updates reject invalid execution or delivery contexts without publishing a new revision', async () => {
  const f = await fixture();
  try {
    const schedule = f.core.scheduleCreate({ version: 2, name: 'Duty', task: 'Read', timing: { kind: 'once', at: '2099-01-01T00:00:00Z' } }, 'validated-duty', f.chat.id);
    const archived = f.core.createWorkContext({ name: 'Archived' }); f.core.archiveContext(archived.id, true);
    for (const patch of [{ contextId: f.chat.id }, { contextId: archived.id }, { contextId: 'missing' }, { output: { kind: 'message', contextId: archived.id } }]) {
      await assert.rejects(f.client.request(`/schedules/${schedule.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: schedule.revision, ...patch }) }), /schedule_(context|output)_not_available/);
      assert.equal(f.core.schedules.get(schedule.id).revision, schedule.revision);
    }
  } finally { await f.close(); }
});

test('task creation failure preserves text, workspace and explicit permission draft until confirmed receipt', async () => {
  const f = await fixture();
  try {
    const title = 'Keep my task'; const content = 'Original content\nTwo spaces  ';
    f.select('custom', 'write', 'done', 'yes'); f.input(title, content); f.submitting(async () => { throw new AppError('core_unavailable', 503); });
    await assert.rejects(f.ui.createTask(), /core_unavailable/);
    const saved = f.ui.taskCreationDrafts.get(f.chat.id) as { title: string; content: string; workspaceId: string; permissionMode: string; grants: { write: boolean } };
    assert.equal(saved.title, title); assert.equal(saved.content, content); assert.equal(saved.workspaceId, 'default'); assert.equal(saved.permissionMode, 'custom'); assert.equal(saved.grants.write, true);
    const starts: string[] = []; f.ui.prompt = async (_title, initial) => { starts.push(initial ?? ''); return initial; }; f.ui.promptLong = async (_title, initial) => { starts.push(initial ?? ''); return initial; };
    f.select('custom', 'done', 'yes'); f.submitting(async () => ({ id: randomUUID(), title, status: 'pending' })); await f.ui.createTask();
    assert.deepEqual(starts, [title, content]); assert.equal(f.ui.taskCreationDrafts.has(f.chat.id), false);
    assert.equal(f.calls.filter(call => call.route === '/tasks' && call.method === 'POST').length, 2);
  } finally { await f.close(); }
});

test('workspace edit and remove use the existing root identity and retain directory contents', async () => {
  const f = await fixture();
  try {
    const root = path.join(f.directory, 'project'); const moved = path.join(f.directory, 'moved'); fs.mkdirSync(root); fs.mkdirSync(moved); fs.writeFileSync(path.join(moved, 'kept.txt'), 'Keep');
    f.core.capabilities.saveRoot({ id: 'project', name: 'Project', path: root });
    f.select('workspace:project', 'edit', 'yes'); f.input('Moved project', moved); await f.ui.workspaces();
    assert.equal(f.core.capabilities.root('project').path, moved);
    f.select('workspace:project', 'remove', 'yes'); await f.ui.workspaces(); assert.equal(f.core.capabilities.roots().some(row => row.id === 'project'), false); assert.equal(fs.readFileSync(path.join(moved, 'kept.txt'), 'utf8'), 'Keep');
  } finally { await f.close(); }
});

test('MCP details show tools and the actual connection error and deletion removes configuration', async () => {
  const f = await fixture();
  try {
    await f.core.capabilities.saveMCP({ id: 'fixture', url: 'https://example.invalid/mcp' });
    const capabilities = f.core.capabilities as unknown as { health: Map<string, { connected: boolean; tools: string[]; error?: string }> };
    capabilities.health.set('fixture', { connected: false, tools: ['ext_fixture_read'], error: 'mcp_connection_failed' });
    f.select('server:fixture', 'details'); await f.ui.mcp(); assert.ok(f.notes.some(note => note.includes('ext_fixture_read') && note.includes('mcp_connection_failed')));
    f.select('server:fixture', 'remove', 'yes'); await f.ui.mcp(); assert.deepEqual(f.core.capabilities.mcpConfigs(), []);
  } finally { await f.close(); }
});

test('method rollback selects an actual saved revision and workflow form follows the server schema', async () => {
  const f = await fixture();
  try {
    const evidence = f.core.runtime.createTask({ title: 'Verified', content: 'Verified', contextId: f.chat.id, returnContextId: f.chat.id, sourceSignalIds: [], status: 'succeeded', report: { outcome: 'succeeded', summary: 'Done', checks: [{ description: 'Checked', passed: true }], deliveries: [], unresolved: [] } });
    const method = { name: 'verified', description: 'Description', instructions: 'Original', references: {}, evidenceTaskIds: [evidence.id] };
    f.core.methods.save(method); f.core.methods.save({ ...method, instructions: 'Revised' }, 1);
    f.select('verified', 'rollback', '1', 'yes'); await f.ui.methods(); assert.equal(f.core.methods.get('verified').instructions, 'Original');
    const work = f.core.createWorkContext({ name: 'Workflow' }); fs.writeFileSync(path.join(f.core.capabilities.root(work.workspaceId).path, 'result.txt'), 'Verify');
    f.select('done', 'yes'); f.input('result.txt'); await f.ui.workflows();
    const invocation = f.calls.find(call => call.route === '/workflows/verify-files/run'); assert.deepEqual(invocation?.body, { contextId: work.id, input: { paths: ['result.txt'] } });
    assert.equal(f.menus.some(menu => menu.values.length === 1 && menu.values[0] === 'add'), false);
  } finally { await f.close(); }
});

test('task timeline loads real lifecycle events and related tasks remain navigable', async () => {
  const f = await fixture();
  try {
    const work = f.core.createWorkContext({ name: 'Worker' }); const runId = randomUUID();
    const task = f.core.runtime.createTask({ title: 'Parent', content: 'Synthetic', contextId: work.id, returnContextId: f.chat.id, sourceSignalIds: [], status: 'succeeded', runIds: [runId], attempt: 2 });
    const child = f.core.runtime.createTask({ title: 'Child', content: 'Synthetic', contextId: work.id, returnContextId: f.chat.id, sourceSignalIds: [], status: 'succeeded', parentId: task.id });
    const signal = signalSchema.parse({ type: 'user-message', source: 'fixture', contextId: work.id, content: 'Synthetic' }); f.core.store.receive(signal); f.core.store.accept(signal.id, randomUUID(), runId, 'wake', work.id); f.core.store.finishRun(runId, 'succeeded');
    f.core.runtime.event({ contextId: work.id, taskId: task.id, runId, kind: 'agent_start', data: {} }); f.core.runtime.event({ contextId: work.id, taskId: task.id, runId, kind: 'agent_end', data: { reason: 'complete' } });
    f.select(task.id, 'history'); await f.ui.tasks(); assert.ok(f.notes.some(note => note.includes('第 2 次尝试') && note.includes('succeeded'))); assert.ok(f.notes.some(note => note.includes('开始') && note.includes('完成'))); assert.ok(f.calls.some(call => call.route.includes('/events?after=')));
    f.select(task.id, 'relations', child.id); await f.ui.tasks(); assert.ok(f.menus.some(menu => menu.title === '关联任务' && menu.values.includes(child.id)));
  } finally { await f.close(); }
});
