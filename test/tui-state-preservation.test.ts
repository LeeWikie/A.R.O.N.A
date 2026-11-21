import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from '../src/client.js';
import type { Terminal, Editor } from '@earendil-works/pi-tui';
import { AppError } from '../src/domain.js';
import { TerminalApp } from '../src/tui/index.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
type UI = {
  editor: Editor; restoredDrafts: WeakMap<Editor, unknown>; appearanceSettings(): Promise<void>;
  choose(): Promise<string | undefined>; write(route: string, body: unknown): Promise<unknown>;
  storageId: string; storageGeneration: number; uncertainWrites: Map<string, string>;
  taskCreationDrafts: Map<string, unknown>; taskMessageDrafts: Map<string, string>;
  resumeCandidate?: { storageId: string; fallbackContextId: string }; generation: number;
  loadContextSnapshot(generation: number): Promise<void>; switchContext(id: string): void;
};

test('changing appearance preserves editor history, draft and uncertain submission identity', async () => {
  const app = new TerminalApp({} as Client, 'main', terminal), ui = app as unknown as UI;
  try {
    const editor = ui.editor, identity = { id: 'pending-submission' };
    editor.addToHistory('previous input'); editor.setText('unsent draft');
    ui.restoredDrafts.set(editor, identity); ui.choose = async () => 'plain';
    await ui.appearanceSettings();
    assert.equal(ui.editor, editor); assert.equal(editor.getText(), 'unsent draft');
    assert.equal(ui.restoredDrafts.get(editor), identity);
    editor.setText(''); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), 'previous input');
  } finally { await app.stop(); }
});

test('late writes cannot remove a new storage retry key or reuse old task permissions', async () => {
  let resolveOld!: (value: unknown) => void; const keys: string[] = [];
  const client = { request(_route: string, init: RequestInit) {
    keys.push(new Headers(init.headers).get('Idempotency-Key')!);
    if (keys.length === 1) return new Promise(resolve => { resolveOld = resolve; });
    return Promise.reject(new AppError('connection_failed', 502));
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', terminal), ui = app as unknown as UI;
  try {
    ui.storageId = 'A';
    ui.taskCreationDrafts.set('main', { grants: { write: true } }); ui.taskMessageDrafts.set('task', 'old text');
    const old = ui.write('/tasks', { content: 'same' });
    const oldResult = assert.rejects(old, /core_storage_changed/);
    ui.storageId = 'B'; ui.storageGeneration++;
    assert.equal(ui.taskCreationDrafts.size, 0); assert.equal(ui.taskMessageDrafts.size, 0);
    await assert.rejects(ui.write('/tasks', { content: 'same' }), /connection_failed/);
    assert.equal(ui.uncertainWrites.size, 2);
    resolveOld({ accepted: true }); await oldResult;
    assert.equal(ui.uncertainWrites.size, 2);
    await assert.rejects(ui.write('/tasks', { content: 'same' }), /connection_failed/);
    assert.equal(keys[1], keys[2]); assert.notEqual(keys[0], keys[1]);
    ui.storageId = 'A'; ui.storageGeneration++; assert.equal(ui.taskMessageDrafts.get('task'), 'old text');
    await assert.rejects(ui.write('/tasks', { content: 'same' }), /connection_failed/);
    assert.equal(keys[3], keys[0]);
  } finally { await app.stop(); }
});

test('automatic resume checks the first snapshot storage before restoring a context', async () => {
  const client = { async snapshot() { return { protocolVersion: 1, selectedContextId: 'chat.saved', storageId: 'B', watermark: 0 }; } } as unknown as Client;
  const app = new TerminalApp(client, 'chat.saved', terminal), ui = app as unknown as UI;
  let fallback: string | undefined;
  try {
    ui.generation = 1; ui.resumeCandidate = { storageId: 'A', fallbackContextId: 'main' };
    ui.switchContext = id => { fallback = id; };
    await ui.loadContextSnapshot(1); assert.equal(fallback, 'main');
  } finally { await app.stop(); }
});

test('a rejected retry after restart retains the original unknown operation identity', async () => {
  const keys: string[] = [];
  const client = { async request(_route: string, init: RequestInit) {
    keys.push(new Headers(init.headers).get('Idempotency-Key')!);
    if (keys.length === 1) throw new AppError('connection_failed', 502);
    if (keys.length === 2) throw new AppError('core_instance_changed', 409);
    return { status: 'pending' };
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', terminal), ui = app as unknown as UI;
  try {
    ui.storageId = 'A';
    await assert.rejects(ui.write('/tasks', { content: 'same' }), /connection_failed/);
    await assert.rejects(ui.write('/tasks', { content: 'same' }), /core_instance_changed/);
    await ui.write('/tasks', { content: 'same' });
    assert.equal(keys[0], keys[1]); assert.equal(keys[1], keys[2]); assert.equal(ui.uncertainWrites.size, 0);
    await ui.write('/tasks', { content: 'same' }); assert.notEqual(keys[2], keys[3]);
  } finally { await app.stop(); }
});

test('session switch command opens the selected active context with one decision', async () => {
  const client = { async request() { return { contexts: [{ id: 'main', name: 'Main', role: 'main' }, { id: 'chat.next', name: 'Next', role: 'main' }, { id: 'chat.old', name: 'Old', archived: true, role: 'main' }] }; } } as unknown as Client;
  const app = new TerminalApp(client, 'main', terminal);
  const ui = app as unknown as { executeCommand(text: string): Promise<void>; choose(title: string, items: Array<{ value: string }>): Promise<string | undefined>; switchContext(id: string): void };
  let menus = 0, selected: string | undefined;
  try {
    ui.choose = async (_title, items) => { menus++; assert.equal(items.some(item => item.value === 'chat.old'), false); return 'chat.next'; };
    ui.switchContext = id => { selected = id; };
    await ui.executeCommand('/sessions'); assert.equal(menus, 1); assert.equal(selected, 'chat.next');
  } finally { await app.stop(); }
});
