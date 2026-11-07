import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { approvalKey, approvalTarget, TerminalApp } from '../src/tui/index.js';
import { removeTemp, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; input: (s: string) => void = () => {}; output = '';
  start(input: (s: string) => void) { this.input = input; } stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('approval key dispatch: digits pick, Enter confirms, Esc postpones, v pages', () => {
  const options = ['once', 'task', 'decline', 'later'] as const;
  assert.deepEqual(approvalKey('2', 0, options), { kind: 'choose', choice: 'task' });
  assert.deepEqual(approvalKey('9', 0, options), { kind: 'noop' });
  assert.deepEqual(approvalKey('\r', 2, options), { kind: 'choose', choice: 'decline' });
  assert.deepEqual(approvalKey('\x1b', 0, options), { kind: 'choose', choice: 'later' }, 'Esc never declines');
  assert.deepEqual(approvalKey('\x1b[B', 0, options), { kind: 'move', delta: 1 });
  assert.deepEqual(approvalKey('\x1b[A', 0, options), { kind: 'noop' });
  assert.deepEqual(approvalKey('v', 0, options), { kind: 'page' });
  assert.equal(approvalTarget({ command: 'rm -rf build', cwd: '.' }), 'rm -rf build');
  assert.equal(approvalTarget({ paths: ['a.txt', 'b.txt'] }), 'a.txt, b.txt');
  assert.equal(approvalTarget(null), '');
});

test('a background task approval opens from the chat once input is idle, Esc postpones, /approvals resumes and approves in task scope', { timeout: 40_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-approval-')); const turns = new Map<string, number>();
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt); const names = (request.tools ?? []).map(t => t.name);
    const id = /\\?"taskId\\?":\\?"([0-9a-f-]{36})/.exec(prompt)?.[1]; let action: { toolName: string; input: unknown } | undefined;
    if (id && names.includes('mastra_workspace_write_file')) {
      const turn = turns.get(id) ?? 0; turns.set(id, turn + 1);
      if (turn === 0) action = { toolName: 'mastra_workspace_write_file', input: { path: 'approved.txt', content: 'written after approval' } };
      if (turn === 1) action = { toolName: 'task_report', input: { id, report: { outcome: 'succeeded', summary: 'Wrote file.', checks: [{ description: 'file written', passed: true }], deliveries: [], unresolved: [] } } };
    }
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); if (action) c.enqueue({ type: 'tool-call', toolCallId: `w-${id}-${turns.get(id ?? '')}`, toolName: action.toolName, input: JSON.stringify(action.input) });
      c.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const terminal = new FakeTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { approvalOpen?: string; postponedApprovals: Set<string>; pendingApprovals: unknown[]; switchContext(id: string): void; approvals(): Promise<void>; choose: (title: string) => Promise<string | undefined> };
  try {
    const running = app.run(); await until(() => terminal.output, text => text.includes('已连接'));
    (app as unknown as { editor: { setText(text: string): void } }).editor.setText('typing a message');
    const task = await core.submitTask({ title: 'Write file', content: 'Write approved.txt.' }, 'approval-task');
    const approval = await until(() => core.runtime.approvals(), rows => rows.some(row => row.taskId === task.id && row.status === 'pending')).then(rows => rows.find(row => row.taskId === task.id)!);
    await until(() => target.pendingApprovals.length, count => count === 1);
    assert.equal(target.approvalOpen, undefined, 'a half-typed message is never covered by the prompt');
    (app as unknown as { editor: { setText(text: string): void } }).editor.setText('');
    await until(() => target.approvalOpen, id => id === approval.id);
    await until(() => terminal.output, text => text.includes('approved.txt'));
    assert.ok(terminal.output.includes('同意，并在此任务内放行同类调用'));
    terminal.input('\x1b');
    await until(() => target.postponedApprovals.has(approval.id), value => value);
    assert.equal(core.runtime.approval(approval.id).status, 'pending', 'Esc postpones without deciding');
    assert.equal(fs.existsSync(path.join(core.capabilities.root(core.runtime.context(task.contextId)!.workspaceId).path, 'approved.txt')), false);

    target.choose = async () => approval.id;
    const decided = target.approvals();
    await until(() => target.approvalOpen, id => id === approval.id);
    terminal.input('2'); await decided;
    assert.equal(core.runtime.approval(approval.id).status, 'approved');
    const done = await until(() => core.runtime.task(task.id), row => !['pending', 'running', 'waiting'].includes(row.status));
    assert.equal(done.status, 'succeeded');
    const lines = () => (app as unknown as { transcript: { children: Array<{ text?: string }> } }).transcript.children.map(child => child.text ?? '').join('\n');
    await until(lines, text => text.includes('后台任务已完成：Write file'));
    assert.equal((app as unknown as { activeTasks: number }).activeTasks, 0);
    assert.equal(core.runtime.task(task.id).toolGrants?.length, 1, 'task scope recorded a grant');
    await app.stop(); await running;
  } finally {
    await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
