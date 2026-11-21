import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { AppError } from '../src/domain.js';
import type { TaskStatus } from '../src/runtime-store.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
function fixture(status: TaskStatus) {
  let current = status; let choices: Array<string | undefined> = [];
  const menus: string[][] = [], notes: string[] = [], calls: Array<{ route: string; method?: string; body?: unknown }> = [];
  let send = async () => ({ status: 'queued' }); let control = async () => ({});
  const client = { async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const task = { id: 'task', title: 'Task', status: current, revision: 7, contextId: 'work.task' };
    if (route === '/tasks') return { tasks: [{ ...task, status }] };
    if (route === '/tasks/task') return task;
    if (route === '/tasks/task/messages') return send();
    if (route.startsWith('/tasks/task/')) return control();
    throw new Error(route);
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { tasks(): Promise<void>; choose(title: string, items: Array<{ value: string }>): Promise<string | undefined>; promptLong(title: string, initial?: string): Promise<string | undefined>; note(text: string): void; taskMessageDrafts: Map<string, string>; editor: { getText(): string; setText(value: string): void } };
  target.choose = async (_title, items) => { menus.push(items.map(item => item.value)); return choices.shift(); };
  target.note = text => { notes.push(text); };
  return { app, target, menus, notes, calls, select: (...values: Array<string | undefined>) => { choices = values; }, status: (value: TaskStatus) => { current = value; }, sending: (handler: typeof send) => { send = handler; }, controlling: (handler: typeof control) => { control = handler; } };
}

test('任务菜单按最新状态展示有意义的动作', async () => {
  const expected: Record<TaskStatus, string[]> = {
    pending: ['message', 'pause', 'cancel'], running: ['message', 'pause', 'cancel'], waiting: ['message', 'pause', 'cancel'],
    pausing: ['cancel'], cancelling: [], paused: ['cancel', 'resume'], succeeded: [], cancelled: [],
    failed: ['retry'], interrupted: ['retry'], blocked: ['retry'], unreported: ['retry'],
  };
  for (const [status, actions] of Object.entries(expected)) {
    const { app, target, menus, select, status: setStatus } = fixture('running');
    try {
      // 列表仍显示 running，但选中后要以新读取的状态为准。
      setStatus(status as TaskStatus);
      select('task', undefined); await target.tasks();
      assert.deepEqual(menus[1], ['details', 'open', 'history', 'relations', ...actions], status);
    } finally { await app.stop(); }
  }
});

test('补充失败保留完整草稿，任务结束后可取回且不覆盖当前输入', async () => {
  const { app, target, menus, notes, select, status, sending } = fixture('running');
  const content = '第一行\n第二行：保留标点与空格  ';
  target.promptLong = async () => content;
  sending(async () => { status('succeeded'); throw new AppError('task_not_active', 409); });
  try {
    select('task', 'message'); await assert.rejects(target.tasks(), /task_not_active/);
    assert.equal(target.taskMessageDrafts.get('task'), content);
    assert.ok(notes.some(note => note.includes('草稿已保留')));
    target.editor.setText('已有输入'); select('task', 'draft'); await target.tasks();
    assert.equal(menus.at(-1)?.includes('message'), false);
    assert.equal(target.editor.getText(), `已有输入\n\n${content}`);
    assert.equal(target.taskMessageDrafts.has('task'), false);
  } finally { await app.stop(); }
});

test('只有明确受理或排队才清理草稿，不自动重发拒绝的补充', async () => {
  const { app, target, calls, select, sending } = fixture('running');
  const initial: string[] = []; target.promptLong = async (_title, value) => { initial.push(value ?? ''); return 'draft'; };
  try {
    sending(async () => ({ status: 'rejected' }));
    select('task', 'message'); await assert.rejects(target.tasks(), /task_message_not_accepted/);
    assert.equal(target.taskMessageDrafts.get('task'), 'draft');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    sending(async () => ({ status: 'queued' })); select('task', 'message'); await target.tasks();
    assert.deepEqual(initial, ['', 'draft']); assert.equal(target.taskMessageDrafts.has('task'), false);
  } finally { await app.stop(); }
});

test('任务版本冲突刷新状态，不重试控制操作', async () => {
  const { app, target, calls, notes, select, status, controlling } = fixture('running');
  controlling(async () => { status('succeeded'); throw new AppError('task_revision_conflict', 409); });
  try {
    select('task', 'pause', 'yes'); await target.tasks();
    assert.deepEqual(calls.find(call => call.method === 'POST')?.body, { revision: 7 });
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.match(notes.at(-1)!, /状态已更新为 succeeded.*本次操作未执行/);
  } finally { await app.stop(); }
});
