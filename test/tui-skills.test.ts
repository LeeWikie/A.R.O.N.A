import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal, SelectItem } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { AppError } from '../src/domain.js';
import { TerminalApp } from '../src/tui/index.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
const skill = { name: 'synthetic-skill', path: '.agents/skills/synthetic-skill', description: 'A synthetic reusable action', enabled: true, disableModelInvocation: false };
type UI = { command(text: string): Promise<void>; submit(text: string): Promise<void>; capabilities: Set<string>; choose(title: string, items: SelectItem[]): Promise<string | undefined>; prompt(title: string): Promise<string | undefined>; promptLong(title: string): Promise<string | undefined>; note(text: string): void; editor: { getText(): string; setText(text: string): void }; contextRole: string; contextReady: boolean; isMainContext: boolean; currentRunId?: string; pendingAttachments: Map<string, unknown[]>; sharedShell: Map<string, string[]> };
function fixture() {
  const calls: Array<{ route: string; method?: string; body?: unknown; key?: string | null }> = [], notes: string[] = [];
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get('Idempotency-Key') });
    if (route.endsWith('/skill-sources')) return { sources: ['custom-skills'] };
    if (route.endsWith('/skills')) return { skills: [skill] };
    if (route.endsWith('/skills/synthetic-skill')) return { ...skill, instructions: 'Read the synthetic instructions.', references: ['guide.md'], scripts: ['check.js'], assets: ['fixture.txt'] };
    if (route.endsWith('/invoke')) return { status: 'accepted' };
    throw new Error(route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as UI; ui.capabilities = new Set(['workspace-skills', 'workspace-skill-invoke']); ui.contextRole = 'main'; ui.contextReady = true; ui.isMainContext = true; ui.note = text => { notes.push(text); };
  return { app, ui, calls, notes };
}

test('standard skills expose instructions/resources, enable controls, and explicit invocation without expanding local message content', async () => {
  const { app, ui, calls, notes } = fixture();
  try {
    let choices = ['skill:synthetic-skill', 'details']; ui.choose = async () => choices.shift();
    await ui.command('/skills'); assert.match(notes.at(-1)!, /Read the synthetic instructions[\s\S]*guide\.md[\s\S]*check\.js[\s\S]*fixture\.txt/);
    choices = ['skill:synthetic-skill', 'toggle']; await ui.command('/skills'); assert.ok(calls.some(call => call.route.endsWith('/skills/synthetic-skill') && call.method === 'PATCH' && (call.body as { enabled: boolean }).enabled === false));
    await ui.command('/skill:synthetic-skill inspect 中文.txt');
    const { id, ...first } = calls.at(-1)?.body as { id: string }; assert.match(id, /^[\da-f-]{36}$/); assert.deepEqual(first, { content: 'inspect 中文.txt', sourceText: '/skill:synthetic-skill inspect 中文.txt' }); assert.equal(calls.at(-1)?.route, '/contexts/main/skills/synthetic-skill/invoke');
    const original = '  /skill:synthetic-skill   记录原文\n第二行  '; await ui.submit(original);
    const { id: _id, ...second } = calls.at(-1)?.body as { id: string }; assert.deepEqual(second, { content: '记录原文\n第二行', sourceText: original });
    ui.capabilities.delete('workspace-skill-invoke'); const count = calls.length; await ui.command('/skill synthetic-skill inspect'); assert.equal(calls.length, count); assert.match(notes.at(-1)!, /服务端不支持/);
  } finally { await app.stop(); }
});

test('loading and removing a skill source names the core workspace path and preserves files on cancellation', async () => {
  const { app, ui, calls } = fixture();
  try {
    let choices = ['source:add']; ui.choose = async () => choices.shift(); ui.prompt = async title => { assert.match(title, /核心工作区/); return 'custom-skills'; };
    await ui.command('/skills'); assert.ok(calls.some(call => call.route.endsWith('/skill-sources') && call.method === 'POST' && (call.body as { path: string }).path === 'custom-skills'));
    choices = ['source:list', 'no']; await ui.command('/skills'); assert.equal(calls.some(call => call.method === 'DELETE'), false);
    choices = ['source:list', 'yes']; await ui.command('/skills'); assert.ok(calls.some(call => call.method === 'DELETE' && (call.body as { path: string }).path === 'custom-skills'));
  } finally { await app.stop(); }
});

test('an unknown skill submission keeps the original command and reuses its operation key on retry', async () => {
  const keys: Array<string | null> = [];
  const app = new TerminalApp({ async request(_route: string, init?: RequestInit) {
    keys.push(new Headers(init?.headers).get('Idempotency-Key'));
    if (keys.length === 1) throw new AppError('connection_failed', 502);
    return { status: 'accepted' };
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as UI;
  try {
    ui.contextRole = 'main'; ui.contextReady = true; ui.isMainContext = true;
    ui.capabilities = new Set(['workspace-skill-invoke']); await ui.command('/skill synthetic-skill inspect'); assert.equal(ui.editor.getText(), '/skill synthetic-skill inspect');
    ui.editor.setText(''); await ui.command('/skill synthetic-skill inspect'); assert.equal(keys[0], keys[1]);
  } finally { await app.stop(); }
});

test('skill invocation carries selected attachments and shared shell output through the regular queue and confirmation flow', async () => {
  const { app, ui, calls } = fixture();
  const id = '11111111-1111-4111-8111-111111111111'; let confirmations = 0;
  try {
    ui.capabilities.add('message-queue'); ui.currentRunId = 'run.already-active';
    ui.pendingAttachments.set('main', [{ id, name: 'synthetic.txt', mediaType: 'text/plain', bytes: 5, sha256: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00Z' }]);
    ui.sharedShell.set('main', ['synthetic shell result']);
    ui.choose = async title => { confirmations++; assert.match(title, /确认发送.*附件/); return 'yes'; };
    await ui.command('/skill synthetic-skill inspect');
    const body = calls.find(call => call.route.endsWith('/invoke'))?.body as { sourceText: string; content: string; attachments: string[]; mode: string };
    assert.equal(confirmations, 1); assert.equal(body.sourceText, '/skill synthetic-skill inspect'); assert.equal(body.content, 'synthetic shell result\n\ninspect'); assert.deepEqual(body.attachments, [id]); assert.equal(body.mode, 'queue');
    assert.equal(ui.pendingAttachments.get('main')?.length ?? 0, 0); assert.equal(ui.sharedShell.has('main'), false);
  } finally { await app.stop(); }
});
