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

test('/compact posts focus text, switches to the derived context and shows the summary', async () => {
  const posts: Array<{ route: string; body: unknown }> = [];
  const client = { async request(route: string, init?: RequestInit) {
    if (route === '/contexts/main/compact') { posts.push({ route, body: JSON.parse(String(init?.body)) }); return { context: { id: 'chat.compact', name: 'x', role: 'main' }, summary: '## Goal\n- keep going', summarizedMessages: 8, keptMessages: 2 }; }
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as Internals & { compact(text?: string): Promise<void>; transcript: { children: Array<{ text?: string }> } };
  const switched: string[] = []; target.switchContext = id => { switched.push(id); (app as unknown as { afterLoad?: () => void }).afterLoad?.(); };
  try {
    target.isMainContext = true;
    await target.compact('focus on API');
    assert.deepEqual(posts, [{ route: '/contexts/main/compact', body: { instructions: 'focus on API' } }]);
    assert.deepEqual(switched, ['chat.compact']);
    const text = target.transcript.children.map(child => child.text ?? '').join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(text, /已压缩：摘要 8 条较早消息，原样保留最近 2 条/); assert.match(text, /原上下文 main 未修改/);
  } finally { await app.stop(); }
});

test('attachments in the transcript are labelled by name, type and size', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const client = { async request(route: string) {
    if (route === `/assets/${id}/metadata`) return { id, name: 'photo.png', mediaType: 'image/png', bytes: 2048, sha256: 'x', createdAt: '' };
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { message(message: unknown): void; transcript: { children: Array<{ children?: Array<{ text?: string }> }> } };
  try {
    target.message({ id: 'signal:a', contextId: 'main', role: 'user', content: 'see', createdAt: '', runId: null, status: 'accepted', kind: 'message', attachments: [id] });
    await new Promise(resolve => setTimeout(resolve, 20));
    const text = target.transcript.children.flatMap(child => child.children ?? []).map(child => child.text ?? '').join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(text, /附件 · photo\.png · image\/png · 2\.0 KB/);
  } finally { await app.stop(); }
});

test('/export writes the public conversation as Markdown or JSONL without overwriting', async () => {
  const { default: fs } = await import('node:fs'); const { default: os } = await import('node:os'); const { default: path } = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-export-'));
  const messages = [
    { id: 'signal:1', contextId: 'main', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00Z', runId: 'r', status: 'accepted', kind: 'message' },
    { id: 'signal:2', contextId: 'main', role: 'user', content: 'withdrawn', createdAt: '2026-01-01T00:00:01Z', runId: null, status: 'cancelled', kind: 'message' },
    { id: 'out:1', contextId: 'main', role: 'assistant', content: 'hi there', createdAt: '2026-01-01T00:00:02Z', runId: 'r', status: 'committed', kind: 'message' },
  ];
  const client = { async conversation() { return { messages, nextCursor: null, hasMore: false }; } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal(), { completionBase: dir });
  const target = app as unknown as Internals;
  const notes: string[] = []; target.note = text => { notes.push(text); };
  try {
    await target.command('/export chat.md');
    const md = fs.readFileSync(path.join(dir, 'chat.md'), 'utf8');
    assert.match(md, /## 用户[\s\S]*hello[\s\S]*## 阿罗娜[\s\S]*hi there/); assert.doesNotMatch(md, /withdrawn/);
    await target.command('/export chat.md');
    assert.match(notes.at(-1)!, /文件已存在，未覆盖/);
    await target.command('/export out/chat.jsonl');
    const rows = fs.readFileSync(path.join(dir, 'out', 'chat.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.content), ['hello', 'hi there']);
    await target.command('/export .private/leak.md');
    assert.match(notes.at(-1)!, /export_private_path/);
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/sessions lists the most recently active context first and marks the current one', async () => {
  const contexts = [
    { id: 'main', name: '主对话', role: 'main', archived: false, updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'chat.new', name: 'Newer', role: 'main', archived: false, updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'chat.child', name: 'Child', role: 'main', archived: false, parentContextId: 'main', updatedAt: '2026-01-03T00:00:00Z' },
  ];
  const client = { async request() { return { contexts }; } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as Omit<Internals, 'choose'> & { contexts(): Promise<void>; choose: (title: string, items: Array<{ value: string; label: string }>) => Promise<string | undefined> };
  try {
    let items: Array<{ value: string; label: string }> = [];
    target.choose = async (_title, offered) => { items = offered; return undefined; };
    await target.contexts();
    assert.deepEqual(items.map(item => item.value), ['chat.new', 'main', 'chat.child']);
    assert.match(items[1]!.label, /^✓ /); assert.match(items[2]!.label, /└─ Child/);
  } finally { await app.stop(); }
});
