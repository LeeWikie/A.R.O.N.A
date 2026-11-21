import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class TypingTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; stopped = false; input: (data: string) => void = () => {};
  start(onInput: (data: string) => void) { this.input = onInput; } stop() { this.stopped = true; } async drainInput() {}
  write(data: string) { this.output += data; } moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const ids = { instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002' };

function fixture(events: Array<Record<string, unknown>> = [], runs: unknown[] = []) {
  const writes: Array<{ route: string; body: unknown }> = [];
  let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
  const client = {
    async request(route: string, init?: RequestInit) {
      if (init?.body) writes.push({ route, body: JSON.parse(String(init.body)) as unknown });
      if (route === '/protocol') return { protocolVersion: 1, ...ids, capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'foreground-interrupt'] };
      if (route.startsWith('/snapshot?')) return { protocolVersion: 1, ...ids, watermark: 0, selectedContextId: 'main', contexts: [{ id: 'main', role: 'main' }], runs, conversation: { messages: [], nextCursor: null, hasMore: false }, approvals: [] };
      if (route === '/approvals') return { approvals: [] };
      if (route === '/models') return { models: [] };
      return {};
    },
    async handshake(this: { request: (route: string) => Promise<unknown> }) { return this.request('/protocol'); },
    async snapshot(this: { request: (route: string) => Promise<unknown> }) { return this.request('/snapshot?contextId=main'); },
    async *events({ signal }: { signal: AbortSignal }) {
      await ready;
      for (const event of events) yield { type: 'event', event };
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  } as unknown as Client;
  return { client, writes, release };
}
async function withTty<T>(run: () => Promise<T>) {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  try { return await run(); } finally {
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}
const transcript = (app: TerminalApp) => (app as unknown as { transcript: { children: Array<{ text?: string }> } }).transcript.children.map(child => child.text ?? '').join('\n').replace(/\x1b\[[0-9;]*m/g, '');

test('idle Ctrl+C needs a second press, Ctrl+D quits only on empty input', () => withTty(async () => {
  const { client, release } = fixture(); release();
  const terminal = new TypingTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const running = app.run(); await settle();
  terminal.input('\x03'); await settle();
  assert.equal(terminal.stopped, false, 'one idle Ctrl+C does not quit');
  assert.match(transcript(app), /再按一次 Ctrl\+C 退出/);
  await settle(600);
  terminal.input('\x03'); await settle();
  assert.equal(terminal.stopped, false, 'presses further apart than 500 ms do not quit');
  terminal.input('abc'); terminal.input('\x04'); await settle();
  assert.equal(terminal.stopped, false, 'Ctrl+D with text does not quit');
  terminal.input('\x03'); await settle();
  terminal.input('\x04'); await running;
  assert.equal(terminal.stopped, true);
}));

test('double Ctrl+C quits within 500 ms', () => withTty(async () => {
  const { client, release } = fixture(); release();
  const terminal = new TypingTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const running = app.run(); await settle();
  terminal.input('\x03'); terminal.input('\x03'); await running;
  assert.equal(terminal.stopped, true);
}));

test('Escape leaves idle shell input and double Escape opens the context tree without quitting', () => withTty(async () => {
  const { client, release } = fixture(); release();
  const terminal = new TypingTerminal(), app = new TerminalApp(client, 'main', terminal);
  const ui = app as unknown as { editor: { setText(text: string): void; getText(): string }; contexts(): Promise<void> };
  let opened = 0; ui.contexts = async () => { opened++; };
  const running = app.run();
  try {
    await settle(); ui.editor.setText('!!printf not-executed'); terminal.input('\x1b'); assert.equal(ui.editor.getText(), '');
    terminal.input('\x1b'); terminal.input('\x1b'); await settle(); assert.equal(opened, 1); assert.equal(terminal.stopped, false);
  } finally { await app.stop(); await running; }
}));

test('automatic context work reports its real phase and clears stale capacity after completion', async () => {
  const { client } = fixture(); const app = new TerminalApp(client, 'main', new TypingTerminal());
  const ui = app as unknown as { event(event: unknown): void; capacityText: string; automaticCompaction: boolean; contextId: string; editor: { getText(): string; setText(text: string): void } };
  try {
    ui.editor.setText('keep this draft'); ui.capacityText = '旧容量 95%';
    ui.event({ contextId: 'main', runId: 'run', kind: 'compaction', data: { state: 'running', automatic: true, reason: 'threshold' } }); assert.equal(ui.automaticCompaction, true);
    ui.event({ contextId: 'main', runId: 'run', kind: 'compaction', data: { state: 'finished', automatic: true, coveredMessages: 12 } });
    assert.equal(ui.automaticCompaction, false); assert.equal(ui.capacityText, ''); assert.equal(ui.contextId, 'main'); assert.equal(ui.editor.getText(), 'keep this draft');
    assert.match(transcript(app), /自动整理[\s\S]*12 条记录/);
    ui.event({ contextId: 'main', runId: 'run', kind: 'compaction', data: { state: 'failed', automatic: true, code: 'auto_compaction_failed' } }); assert.match(transcript(app), /整理未完成[\s\S]*\/compact/);
  } finally { await app.stop(); }
});

test('Esc stops the observed run; failures and aborts are explained in the transcript', () => withTty(async () => {
  const run = { id: 'run-1', contextId: 'main', status: 'running', createdAt: new Date().toISOString() };
  const { client, writes, release } = fixture([
    { seq: 1, contextId: 'main', runId: 'run-1', kind: 'error', data: { code: 'context_capacity_exceeded' } },
    { seq: 2, contextId: 'main', runId: 'run-1', kind: 'run', data: { state: 'ended', reason: 'error' } },
    { seq: 3, contextId: 'main', runId: 'run-2', kind: 'run', data: { state: 'running' } },
    { seq: 4, contextId: 'main', runId: 'run-2', kind: 'run', data: { state: 'ended', reason: 'aborted' } },
  ], [run]);
  const terminal = new TypingTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { currentRunId?: string; working?: unknown };
  try {
    const running = app.run(); await settle();
    assert.equal(target.currentRunId, 'run-1'); assert.ok(target.working, 'working indicator shown for a running run');
    terminal.input('\x1b'); await settle(120);
    assert.deepEqual(writes.find(x => x.route === '/contexts/main/interrupt')?.body, { expectedRunId: 'run-1' });
    release(); await settle(120);
    const text = transcript(app);
    assert.match(text, /运行失败：上下文超出模型输入预算/);
    assert.match(text, /\/context/);
    assert.equal((text.match(/运行失败：/g) ?? []).length, 1, 'error event and run end are reported once');
    assert.match(text, /已停止当前回复/);
    assert.equal(target.working, undefined, 'indicator removed when the run ends');
    terminal.input('\x03'); terminal.input('\x03'); await running;
  } finally { await app.stop(); }
}));

test('footer accumulates usage per step and /usage prints a table, not JSON', () => withTty(async () => {
  const { client, release } = fixture([
    { seq: 1, contextId: 'main', runId: 'r', kind: 'usage', data: { promptTokens: 1200, completionTokens: 30, cachedInputTokens: 1000 } },
    { seq: 2, contextId: 'main', runId: 'r', kind: 'usage', data: { promptTokens: 1300, completionTokens: 20 } },
    { seq: 3, contextId: 'main', runId: 'r', kind: 'capacity', data: { estimatedInputTokens: 9000, availableInputTokens: 10000, overBudget: false, blockedBeforeProvider: false } },
  ]);
  const base = client.request.bind(client) as (route: string, init?: RequestInit) => Promise<unknown>;
  (client as unknown as { request: typeof base }).request = async (route, init) => route.startsWith('/usage')
    ? { contexts: [{ contextId: 'main', usage: { promptTokens: 0, completionTokens: 0 } }], runs: [{ runId: 'r', modelProfile: 'a', usage: { promptTokens: 2500, completionTokens: 50 } }, { runId: 's', modelProfile: 'b', usage: { promptTokens: 10, completionTokens: 1 } }] }
    : base(route, init);
  const terminal = new TypingTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { footer: { render(width: number): string[] }; command(text: string): Promise<void> };
  try {
    const running = app.run(); await settle(); release(); await settle(150);
    const footer = target.footer.render(160).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(footer, /↑2\.5k ↓50 R1\.0k/, 'per-step usage is summed; cache read shown once reported');
    assert.doesNotMatch(footer, / W\d/, 'unreported cache write is omitted');
    assert.match(footer, /上下文 ~90\.0%\/10k/);
    await target.command('/usage');
    const text = transcript(app);
    assert.match(text, /缓存读取  未报告/);
    assert.match(text, /按模型配置：/);
    assert.match(text, /费用：未知/);
    assert.doesNotMatch(text, /[{}]/);
    terminal.input('\x03'); terminal.input('\x03'); await running;
  } finally { await app.stop(); }
}));
