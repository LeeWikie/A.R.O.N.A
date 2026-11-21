import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Editor, Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { AppError } from '../src/domain.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
type UI = { editor: Editor; submit(text: string, preset?: 'queue' | 'steer', source?: Editor): Promise<void>; contextRole: string; contextReady: boolean; currentRunId?: string; isMainContext: boolean; storageId: string; capabilities: Set<string>; switchContext(id: string): void };

test('arrow navigation recalls submitted slash, text and shell input, preserves a draft, and keeps multiline cursor movement', async () => {
  const received: string[] = [];
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    if (route === '/messages') { received.push(JSON.parse(String(init?.body)).content); return { status: 'accepted' }; }
    throw new Error('unexpected route: ' + route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as UI;
  try {
    ui.contextRole = 'main'; ui.contextReady = true; ui.isMainContext = true; ui.storageId = 'fixture';
    await ui.submit('first line\nsecond line');
    await ui.submit('/help');
    await ui.submit('/unknown-command');
    await ui.submit('!!printf synthetic-history');
    assert.deepEqual(received, ['first line\nsecond line']);
    const editor = ui.editor;
    editor.setText(''); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), '!!printf synthetic-history'); assert.deepEqual(editor.getCursor(), { line: 0, col: 26 });
    editor.handleInput('\x1b[A'); assert.equal(editor.getText(), '/unknown-command');
    editor.handleInput('\x1b[A'); assert.equal(editor.getText(), '/help');
    editor.handleInput('\x1b[A'); assert.equal(editor.getText(), 'first line\nsecond line'); assert.deepEqual(editor.getCursor(), { line: 1, col: 11 });
    editor.handleInput('\x1b[A'); assert.equal(editor.getText(), 'first line\nsecond line'); assert.equal(editor.getCursor().line, 0);
    editor.handleInput('\x1b[B'); assert.equal(editor.getText(), 'first line\nsecond line'); assert.deepEqual(editor.getCursor(), { line: 1, col: 11 });
    editor.handleInput('\x1b[B'); assert.equal(editor.getText(), '/help'); assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
    editor.handleInput('\x1b[B'); editor.handleInput('\x1b[B'); editor.handleInput('\x1b[B'); assert.equal(editor.getText(), '');
    editor.setText('draft'); editor.handleInput('\x01'); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), '!!printf synthetic-history');
    editor.handleInput('\x1b[B'); assert.equal(editor.getText(), 'draft'); assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    editor.setText('one\ntwo'); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), 'one\ntwo'); assert.equal(editor.getCursor().line, 0);
  } finally { await app.stop(); }
});

test('busy modal input and stale editors never pollute another context input history', async () => {
  const app = new TerminalApp({} as Client, 'main', terminal), ui = app as unknown as UI & { modalFlow?: symbol };
  try {
    const editor = ui.editor;
    ui.modalFlow = Symbol('fixture');
    await ui.submit('/help');
    editor.setText(''); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), '');
    ui.modalFlow = undefined;
    await ui.submit('/help');
    editor.setText(''); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), '/help');
    const stale = Object.create(editor) as Editor;
    await ui.submit('/status', undefined, stale);
    editor.setText(''); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), '/help');
  } finally { await app.stop(); }
});

test('a submitted input remains both an editable draft and retrievable input history after an unconfirmed network result', async () => {
  const app = new TerminalApp({ request() { throw new AppError('connection_failed', 502); } } as unknown as Client, 'main', terminal), ui = app as unknown as UI;
  try {
    ui.contextRole = 'main'; ui.contextReady = true; ui.isMainContext = true; ui.storageId = 'fixture';
    await ui.submit('retry this exact text'); assert.equal(ui.editor.getText(), 'retry this exact text');
    ui.editor.setText(''); ui.editor.handleInput('\x1b[A'); assert.equal(ui.editor.getText(), 'retry this exact text');
  } finally { await app.stop(); }
});
