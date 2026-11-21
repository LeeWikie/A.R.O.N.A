import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Terminal, Editor } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { decodeSessionArchive, encodeSessionArchive, MAX_SESSION_TRANSFER_BYTES, readSessionArchive, writeSessionExport, type SessionTransferArchive } from '../src/tui/session-transfer.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
const archive: SessionTransferArchive = { format: 'shittimchest-session', version: 1,
  context: { id: 'main', name: 'Synthetic dialogue', purpose: '', modelProfile: 'default', workspaceId: 'default', createdAt: '2026-01-01T00:00:00Z' },
  messages: [{ id: 'signal:fixture', contextId: 'main', role: 'user', content: 'original\nmultiline', status: 'accepted', kind: 'message', runId: 'run.fixture', createdAt: '2026-01-01T00:00:00Z' }] };

test('session JSONL round trips full public records and rejects broken envelopes or unrelated input', () => {
  const encoded = encodeSessionArchive(archive);
  assert.deepEqual(decodeSessionArchive(encoded), archive);
  assert.deepEqual(decodeSessionArchive('\uFEFF' + encoded.replace(/\n/g, '\r\n')), archive);
  for (const input of ['', '{}', '{broken', JSON.stringify({ type: 'session', ...archive, version: 2 }), encoded + '{"type":"tool","value":"untrusted"}']) assert.throws(() => decodeSessionArchive(input), /invalid_session_archive/);
  assert.throws(() => decodeSessionArchive(' '.repeat(MAX_SESSION_TRANSFER_BYTES + 1)), /session_archive_too_large/);
});

test('local transfers reject redirects, private paths and oversized files, and never overwrite existing files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-session-transfer-'));
  try {
    const file = path.join(dir, 'public.jsonl'); await writeSessionExport(file, encodeSessionArchive(archive));
    assert.deepEqual(await readSessionArchive(file), archive);
    await assert.rejects(writeSessionExport(file, 'replacement'), /EEXIST/);
    fs.mkdirSync(path.join(dir, '.private')); const secret = path.join(dir, '.private', 'session.jsonl'); fs.writeFileSync(secret, encodeSessionArchive(archive));
    await assert.rejects(readSessionArchive(secret), /import_private_path/);
    const alias = path.join(dir, 'alias.jsonl'); fs.symlinkSync(secret, alias); await assert.rejects(readSessionArchive(alias), /import_private_path/);
    const big = path.join(dir, 'large.jsonl'); fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, MAX_SESSION_TRANSFER_BYTES + 1); await assert.rejects(readSessionArchive(big), /session_archive_too_large/);
    fs.symlinkSync(path.join(dir, '.private'), path.join(dir, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeSessionExport(path.join(dir, 'redirect', 'copy.jsonl'), 'do not write'), /export_private_path/);
    assert.equal(fs.existsSync(path.join(dir, '.private', 'copy.jsonl')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clone and JSONL import/export use capability-backed core actions without replaying messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-session-actions-'));
  const calls: Array<{ route: string; method?: string; body?: unknown }> = [], switched: string[] = [], notes: string[] = [];
  const client = { async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (route === '/contexts/main/export') return archive;
    if (route === '/contexts/main/clone') return { id: 'chat.clone' };
    if (route === '/contexts/import') return { id: 'chat.imported' };
    throw new Error('unexpected route ' + route);
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', terminal, { completionBase: dir });
  const ui = app as unknown as { command(text: string): Promise<void>; capabilities: Set<string>; choose(): Promise<string>; switchContext(id: string): void; note(text: string): void };
  try {
    ui.capabilities = new Set(['context-clone', 'context-transfer']); ui.choose = async () => 'yes'; ui.switchContext = id => { switched.push(id); }; ui.note = text => { notes.push(text); };
    await ui.command('/clone Another name'); assert.deepEqual(calls[0], { route: '/contexts/main/clone', method: 'POST', body: { name: 'Another name' } });
    await ui.command('/export "dialogue with spaces.jsonl"');
    assert.deepEqual(await readSessionArchive(path.join(dir, 'dialogue with spaces.jsonl')), archive);
    await ui.command('/import "dialogue with spaces.jsonl"');
    assert.deepEqual(calls.find(call => call.route === '/contexts/import')?.body, { archive });
    assert.deepEqual(switched, ['chat.clone', 'chat.imported']); assert.equal(calls.some(call => call.route === '/messages'), false);
    const count = calls.length; ui.choose = async () => 'no'; await ui.command('/import "dialogue with spaces.jsonl"'); assert.equal(calls.length, count);
    ui.capabilities.clear(); await ui.command('/clone'); assert.match(notes.at(-1)!, /服务端不支持/); assert.equal(calls.length, count);
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fork from a user message uses its exact boundary and returns the original draft to the new editor', async () => {
  let body: unknown; const app = new TerminalApp({ async conversation() { return { messages: archive.messages, hasMore: false, nextCursor: null }; }, async request(route: string, init?: RequestInit) {
    if (route === '/contexts') return { contexts: [{ ...archive.context, role: 'main', archived: false }] };
    if (route === '/contexts/main/fork') { body = JSON.parse(String(init?.body)); return { context: { id: 'chat.fork' }, draft: archive.messages[0]!.content }; }
    throw new Error(route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as { command(text: string): Promise<void>; editor: Editor; capabilities: Set<string>; choose(): Promise<string>; switchContext(id: string): void };
  let selected: string | undefined;
  try {
    ui.capabilities = new Set(['context-branch', 'context-fork-message']); ui.choose = async () => archive.messages[0]!.id; ui.switchContext = id => { selected = id; };
    await ui.command('/fork'); assert.equal(selected, 'chat.fork'); assert.deepEqual(body, { sourceMessageId: archive.messages[0]!.id }); assert.equal(ui.editor.getText(), 'original\nmultiline');
  } finally { await app.stop(); }
});

test('new conversation inherits the current workspace and model without additional forms', async () => {
  const calls: Array<{ route: string; body?: unknown }> = []; let switched: string | undefined;
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    calls.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (route === '/contexts' && !init?.method) return { contexts: [{ id: 'main', workspaceId: 'project', modelProfile: 'selected-model' }] };
    if (route === '/contexts' && init?.method === 'POST') return { id: 'chat.new' };
    throw new Error(route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as { command(text: string): Promise<void>; prompt(): Promise<string>; choose(): Promise<string>; switchContext(id: string): void };
  try {
    ui.prompt = async () => { throw new Error('unexpected form'); }; ui.choose = ui.prompt; ui.switchContext = id => { switched = id; };
    await ui.command('/new'); assert.deepEqual(calls.at(-1)?.body, { name: '新对话', purpose: '', workspaceId: 'project', modelProfile: 'selected-model', role: 'main' }); assert.equal(switched, 'chat.new');
  } finally { await app.stop(); }
});

test('logout has a direct command, supports cancellation, and refreshes the selected model only after removal', async () => {
  const writes: string[] = []; let confirmation = 'no', refreshes = 0;
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    if (init?.method === 'DELETE') { writes.push(route); return { removed: true }; }
    if (route === '/auth/providers') return { providers: [{ id: 'fixture', name: 'Fixture' }] };
    if (route === '/auth/status/fixture') return { configured: true };
    throw new Error(route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as { command(text: string): Promise<void>; capabilities: Set<string>; choose(): Promise<string>; refreshModel(): Promise<void> };
  try {
    ui.capabilities = new Set(['provider-auth']); ui.choose = async () => confirmation; ui.refreshModel = async () => { refreshes++; };
    await ui.command('/logout Fixture'); assert.deepEqual(writes, []); assert.equal(refreshes, 0);
    confirmation = 'yes'; await ui.command('/logout fixture'); assert.deepEqual(writes, ['/auth/providers/fixture']); assert.equal(refreshes, 1);
  } finally { await app.stop(); }
});

test('model cycling wraps in both directions and handles an unavailable current profile', async () => {
  const selected: string[] = [];
  let actualProfile = 'first';
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    if (route === '/models') return { models: [{ id: 'first', name: 'First' }, { id: 'middle', name: 'Middle' }, { id: 'last', name: 'Last' }] };
    if (route === '/contexts/main/model' && init?.method) { actualProfile = JSON.parse(String(init.body)).profileId; selected.push(actualProfile); return {}; }
    if (route === '/contexts/main/model') return { contextId: 'main', profileId: actualProfile, name: actualProfile, modelId: actualProfile };
    throw new Error(route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as { isMainContext: boolean; model: { profileId: string }; cycleModel(direction?: 1 | -1): Promise<void>; refreshModel(): Promise<void> };
  try {
    ui.isMainContext = true; ui.model = { profileId: 'first' }; ui.refreshModel = async () => {};
    await ui.cycleModel(-1); ui.model.profileId = 'stale-display'; await ui.cycleModel(1); actualProfile = 'missing'; await ui.cycleModel(-1);
    assert.deepEqual(selected, ['last', 'first', 'last']);
  } finally { await app.stop(); }
});

test('working record backups are explicit, portable through JSONL, and never used by ordinary export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-session-backup-'));
  const routes: string[] = [], notes: string[] = [];
  const backup: SessionTransferArchive = { ...archive, continuation: { messages: [{ id: 'native.fixture', role: 'user', createdAt: archive.context.createdAt, content: { format: 2, parts: [{ type: 'text', text: 'synthetic working input' }] } }], publicMessageMap: { 'signal:fixture': 'native.fixture' }, checkpoint: { summary: 'Synthetic checkpoint', summarizedMessages: 1 }, assets: [] } };
  const app = new TerminalApp({ async request(route: string) { routes.push(route); return route.includes('?continuation=1') ? backup : archive; } } as unknown as Client, 'main', terminal, { completionBase: dir });
  const ui = app as unknown as { command(text: string): Promise<void>; capabilities: Set<string>; note(text: string): void };
  try {
    ui.capabilities = new Set(['context-transfer']); ui.note = text => { notes.push(text); };
    await ui.command('/export --backup work.jsonl'); assert.deepEqual(routes, []); assert.match(notes.at(-1)!, /context_continuation_unavailable/);
    ui.capabilities.add('context-continuation'); await ui.command('/export public.jsonl'); await ui.command('/export --backup work.jsonl');
    assert.deepEqual(await readSessionArchive(path.join(dir, 'public.jsonl')), archive);
    assert.deepEqual(await readSessionArchive(path.join(dir, 'work.jsonl')), backup);
    assert.deepEqual(routes, ['/contexts/main/export', '/contexts/main/export?continuation=1']);
    assert.match(notes.at(-1)!, /工作记录备份/);
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
