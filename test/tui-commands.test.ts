import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp, tuiCommands } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start(_onInput?: (data: string) => void) {} stop() {} async drainInput() {} write(_data: string) {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
type Internals = {
  command: (text: string) => Promise<void>; note: (text: string) => void; switchContext: (id: string) => void;
  choose: () => Promise<string | undefined>; prompt: () => Promise<string | undefined>; promptLong: () => Promise<string | undefined>;
  capabilities: Set<string>; currentRunId?: string; isMainContext: boolean; contextId: string;
};

function fixture() {
  const calls: Array<{ route: string; method?: string; body?: unknown }> = [];
  const client = { async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
    if (route === '/contexts' && !init?.method) return { contexts: [{ id: 'main', name: '主对话', role: 'main', modelProfile: 'fast', archived: false }, { id: 'chat.two', name: '第二', role: 'main', modelProfile: 'fast', archived: false }] };
    if (route === '/contexts' && init?.method === 'POST') return { id: 'chat.new', name: 'Fresh', role: 'main' };
    if (route === '/models') return { models: [{ id: 'fast', name: 'Fast', modelId: 'fast-1' }, { id: 'deep', name: 'Deep', modelId: 'deep-1' }] };
    if (route === '/workspaces') return { workspaces: [{ id: 'default', name: 'Default', path: '/fixture' }] };
    if (route === '/tasks') return { id: 'task-1', status: 'pending' };
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as Internals;
  const notes: string[] = []; const switched: string[] = [];
  target.note = text => { notes.push(text); };
  target.switchContext = id => { switched.push(id); target.contextId = id; };
  return { app, target, calls, notes, switched };
}

test('slash commands drive existing flows with typed backend requests', async () => {
  const { app, target, calls, notes, switched } = fixture();
  try {
    await target.command('/help');
    assert.ok(notes.at(-1)?.includes('/think <等级|default>'));
    assert.ok(notes.at(-1)?.includes('/quit'));

    await target.command('/new Fresh');
    assert.deepEqual(calls.find(x => x.route === '/contexts' && x.method === 'POST')?.body, { name: 'Fresh', role: 'main' });
    assert.deepEqual(switched, ['chat.new']);

    await target.command('/sessions 第二');
    assert.equal(switched.at(-1), 'chat.two');
    await target.command('/resume missing');
    assert.match(notes.at(-1) ?? '', /没有找到上下文/);

    target.contextId = 'main';
    await target.command('/model Deep');
    assert.deepEqual(calls.find(x => x.route === '/contexts/main/model')?.body, { profileId: 'deep' });

    await target.command('/think HIGH');
    assert.deepEqual(calls.filter(x => x.route === '/contexts/main/model').at(-1)?.body, { profileId: 'fast', thinkingLevel: 'high' });
    await target.command('/thinking default');
    assert.deepEqual(calls.filter(x => x.route === '/contexts/main/model').at(-1)?.body, { profileId: 'fast', thinkingLevel: null });
    const before = calls.length;
    await target.command('/think turbo');
    assert.equal(calls.length, before + 1, 'invalid level only reads context, never writes');
    assert.match(notes.at(-1) ?? '', /不支持的思考等级/);

    await target.command('/name 新名字');
    assert.deepEqual(calls.find(x => x.route === '/contexts/main' && x.method === 'PATCH')?.body, { name: '新名字' });

    let choices = ['default', 'safe', 'yes']; let prompts = ['检查文件'];
    target.choose = async () => choices.shift(); target.prompt = async () => prompts.shift();
    await target.command('/task 读取 input.txt 并报告');
    assert.deepEqual(calls.find(x => x.route === '/tasks' && x.method === 'POST')?.body, { title: '检查文件', content: '读取 input.txt 并报告', workspaceId: 'default', returnContextId: 'main' });
  } finally { await app.stop(); }
});

test('slash commands respect capabilities, run state and unknown names', async () => {
  const { app, target, calls, notes } = fixture();
  try {
    await target.command('/stop');
    assert.match(notes.at(-1) ?? '', /服务端不支持/);
    target.capabilities = new Set(['foreground-interrupt']);
    await target.command('/abort');
    assert.match(notes.at(-1) ?? '', /没有可停止的运行/);
    target.currentRunId = 'run-1'; target.isMainContext = true;
    await target.command('/stop');
    assert.deepEqual(calls.find(x => x.route === '/contexts/main/interrupt')?.body, { expectedRunId: 'run-1' });

    const count = calls.length;
    await target.command('/frobnicate now');
    assert.equal(calls.length, count, 'unknown command is never sent to the core');
    assert.match(notes.at(-1) ?? '', /未知命令 \/frobnicate/);
  } finally { await app.stop(); }
});

class TypingTerminal extends FakeTerminal {
  output = ''; input: (data: string) => void = () => {};
  override start(onInput?: (data: string) => void) { if (onInput) this.input = onInput; }
  override write(data: string) { this.output += data; }
  send(text: string) { for (const char of text) this.input(char); }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 80));

test('typed slash commands autocomplete and run without reaching the model', async () => {
  const priorIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const priorOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const terminal = new TypingTerminal(); const messages: unknown[] = [];
  const ids = { instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002' };
  const client = {
    async request(route: string, init?: RequestInit) {
      if (route === '/protocol') return { protocolVersion: 1, ...ids, capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream'] };
      if (route.startsWith('/snapshot?')) return { protocolVersion: 1, ...ids, watermark: 0, selectedContextId: 'main', contexts: [{ id: 'main', role: 'main' }], runs: [], conversation: { messages: [], nextCursor: null, hasMore: false }, approvals: [] };
      if (route.startsWith('/event-page?')) return { events: [], nextCursor: 0, hasMore: false };
      if (route === '/messages') { messages.push(JSON.parse(String(init?.body))); return { status: 'accepted' }; }
      return {};
    },
    async handshake(this: { request: (route: string) => Promise<unknown> }) { return this.request('/protocol'); },
    async snapshot(this: { request: (route: string) => Promise<unknown> }) { return this.request('/snapshot?contextId=main'); },
    async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
  } as unknown as Client;
  const app = new TerminalApp(client, 'main', terminal);
  try {
    const running = app.run(); await settle();
    terminal.send('/thi'); await settle();
    assert.ok(terminal.output.includes('设置思考等级'), 'command suggestion is rendered');
    assert.equal(terminal.output.includes('停止当前运行'), false, 'unsupported /stop is hidden without capability');
    terminal.send('\x1b'); await settle();
    terminal.send('\x15'); await settle();
    const transcript = () => (app as unknown as { transcript: { children: Array<{ text?: string }> } }).transcript.children.map(child => child.text ?? '').join('\n');
    terminal.send('/help\r'); await settle();
    assert.ok(transcript().includes('可用命令'));
    terminal.send('/nope\r'); await settle();
    assert.ok(transcript().includes('未知命令 /nope'));
    assert.deepEqual(messages, []);
    terminal.send('/quit\r'); await running;
  } finally {
    await app.stop();
    if (priorIn) Object.defineProperty(process.stdin, 'isTTY', priorIn); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (priorOut) Object.defineProperty(process.stdout, 'isTTY', priorOut); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test('command table has unique names and aliases', () => {
  const names = tuiCommands.flatMap(command => [command.name, ...(command.aliases ?? [])]);
  assert.equal(new Set(names).size, names.length);
  for (const name of ['help', 'new', 'sessions', 'model', 'think', 'stop', 'quit']) assert.ok(names.includes(name), name);
});

test('Ctrl+P cycles configured models and the picker marks the current one first', async () => {
  const writes: Array<{ route: string; body: unknown }> = []; let profile = 'fast';
  const client = { async request(route: string, init?: RequestInit) {
    if (init?.body) { const body = JSON.parse(String(init.body)) as { profileId: string }; writes.push({ route, body }); profile = body.profileId; return {}; }
    if (route === '/models') return { models: [{ id: 'fast', name: 'Fast', modelId: 'f-1', providerId: 'p' }, { id: 'deep', name: 'Deep', modelId: 'd-1' }] };
    if (route === '/contexts/main/model') return { profileId: profile, name: profile, modelId: null, thinkingLevel: null, source: 'provider-default', unavailable: null, configuredProfiles: 2 };
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as Omit<Internals, 'choose'> & { refreshModel(): Promise<void>; cycleModel(): Promise<void>; models(): Promise<void>; choose: (title: string, items: Array<{ value: string; label: string; description?: string }>) => Promise<string | undefined> };
  try {
    target.isMainContext = true; await target.refreshModel();
    await target.cycleModel(); assert.deepEqual(writes.at(-1), { route: '/contexts/main/model', body: { profileId: 'deep' } });
    await target.cycleModel(); assert.deepEqual(writes.at(-1)?.body, { profileId: 'fast' }, 'wraps around');
    let shown: Array<{ value: string; label: string; description?: string }> = [];
    target.choose = async (_title, items) => { shown = shown.length ? shown : items; return undefined; };
    await target.models();
    assert.equal(shown[0]?.value, 'fast'); assert.match(shown[0]!.label, /^✓ /); assert.match(shown[0]!.description ?? '', /\[p\] · 当前/);
  } finally { await app.stop(); }
});
