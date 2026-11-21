import assert from 'node:assert/strict';
import test from 'node:test';
import headless from '@xterm/headless';
import { CURSOR_MARKER, Editor, KeybindingsManager, TuiAltScreen, TUI_KEYBINDINGS, setKeybindings, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { TerminalEditor } from '../src/tui/terminal-editor.js';
import { plainTheme } from '../src/tui/upstream/theme.js';

class EmulatedTerminal implements Terminal {
  columns = 40; rows = 18; kittyProtocolActive = false;
  readonly screen = new headless.Terminal({ cols: this.columns, rows: this.rows, allowProposedApi: true });
  input: (data: string) => void = () => {}; private onResize: () => void = () => {};
  flushed = Promise.resolve(); output = '';
  start(input: (data: string) => void, onResize: () => void) { this.input = input; this.onResize = onResize; }
  stop() {} async drainInput() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  write(data: string) { this.output += data; this.flushed = this.flushed.then(() => new Promise<void>(resolve => this.screen.write(data, resolve))); }
  resize(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.screen.resize(columns, rows); this.onResize(); }
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 40));

test('Pi default directional history remains intact while the product opts into history at the end', async () => {
  for (const Factory of [Editor, TerminalEditor]) {
    const terminal = new EmulatedTerminal(), ui = new TuiAltScreen(terminal);
    const editor = new Factory(ui, plainTheme.editor());
    try {
      editor.addToHistory('older'); editor.addToHistory('中文\nlast'); editor.setText(''); editor.handleInput('\x1b[A');
      assert.equal(editor.getText(), '中文\nlast');
      assert.deepEqual(editor.getCursor(), Factory === Editor ? { line: 0, col: 0 } : { line: 1, col: 4 });
      if (Factory === TerminalEditor) { editor.handleInput('\x1b[A'); assert.equal(editor.getCursor().line, 0); }
      editor.handleInput('\x1b[A'); assert.equal(editor.getText(), 'older');
      editor.handleInput('\x1b[B'); assert.equal(editor.getText(), '中文\nlast'); assert.deepEqual(editor.getCursor(), { line: 1, col: 4 });
    } finally { ui.stop(); terminal.screen.dispose(); }
  }
});

test('history placement does not replace native draft cursor snapshots or undo', async () => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.editor.historyPrevious': 'ctrl+r', 'tui.editor.historyNext': 'ctrl+s' }));
  const terminal = new EmulatedTerminal(), ui = new TuiAltScreen(terminal), editor = new TerminalEditor(ui, plainTheme.editor());
  try {
    editor.addToHistory('history 中文'); editor.setText('保留 draft'); editor.handleInput('\x1b[D'); editor.handleInput('\x1b[D');
    const original = editor.getCursor(); editor.handleInput('\x12'); assert.deepEqual(editor.getCursor(), { line: 0, col: 10 });
    editor.handleInput('\x13'); assert.equal(editor.getText(), '保留 draft'); assert.deepEqual(editor.getCursor(), original);
    editor.handleInput('\x12'); editor.handleInput('!'); assert.equal(editor.getText(), 'history 中文!');
    editor.handleInput('\x1f'); assert.equal(editor.getText(), 'history 中文');
    editor.handleInput('\x1f'); assert.equal(editor.getText(), '保留 draft'); assert.deepEqual(editor.getCursor(), original);
  } finally { setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); ui.stop(); terminal.screen.dispose(); }
});

test('actual ANSI cursor follows history at the end, Chinese graphemes, multiline motion, resize and draft restoration', { timeout: 10000 }, async () => {
  const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const identity = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream'] };
  const client = {
    async handshake() { return identity; },
    async snapshot() { return { ...identity, selectedContextId: 'main', watermark: 0, drafts: [], contexts: [{ id: 'main', role: 'main' }], runs: [], conversation: { messages: [], hasMore: false } }; },
    async *events({ signal }: { signal: AbortSignal }) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    async request() { return {}; },
  } as unknown as Client;
  const terminal = new EmulatedTerminal(), app = new TerminalApp(client, 'main', terminal);
  const state = app as unknown as { editor: Editor; contextReady: boolean; choose(title: string, items: Array<{ value: string; label: string }>): Promise<string | undefined>; ui: { hasOverlay(): boolean } };
  const running = app.run();
  async function frame() { await pause(); await terminal.flushed; }
  async function assertCursor(text: string, logical: { line: number; col: number }, column: number) {
    await frame(); assert.equal(state.editor.getText(), text); assert.deepEqual(state.editor.getCursor(), logical);
    assert.equal(state.editor.focused, true);
    const lines = state.editor.render(terminal.columns), markers = lines.filter(line => line.includes(CURSOR_MARKER));
    assert.equal(markers.length, 1); assert.equal(visibleWidth(markers[0]!.split(CURSOR_MARKER)[0]!), column);
    const buffer = terminal.screen.buffer.active, current = buffer.getLine(buffer.cursorY)!.translateToString(true);
    assert.equal(buffer.cursorX, column); assert.match(current, text ? /尾行中文|较早历史|第一行中文/ : /^\s*$/);
    assert.match(terminal.output, /\x1b\[\?25h/);
  }
  try {
    for (let n = 0; n < 50 && !state.contextReady; n++) await pause(); assert.equal(state.contextReady, true);
    const editor = state.editor, recalled = '第一行中文\n尾行中文';
    editor.addToHistory('较早历史'); editor.addToHistory(recalled); editor.setText('');
    terminal.input('\x1b[A'); await assertCursor(recalled, { line: 1, col: 4 }, 9);
    const beforeResize = terminal.screen.buffer.active.cursorY;
    terminal.input('\x1b[D'); await assertCursor(recalled, { line: 1, col: 3 }, 7);
    terminal.input('\x1b[C'); await assertCursor(recalled, { line: 1, col: 4 }, 9);
    terminal.resize(14, 14); await assertCursor(recalled, { line: 1, col: 4 }, 9); assert.notEqual(terminal.screen.buffer.active.cursorY, beforeResize);
    const choice = state.choose('选择', [{ value: 'one', label: 'one' }, { value: 'two', label: 'two' }]);
    await frame(); assert.equal(state.ui.hasOverlay(), true); assert.equal(editor.focused, false); assert.equal(editor.getText(), recalled);
    terminal.resize(40, 18); await frame(); assert.equal(state.ui.hasOverlay(), true);
    terminal.input('two'); terminal.input('\r'); assert.equal(await choice, 'two');
    await assertCursor(recalled, { line: 1, col: 4 }, 9); assert.equal(state.ui.hasOverlay(), false);
    terminal.resize(40, 2); await assertCursor(recalled, { line: 1, col: 4 }, 9);
    terminal.resize(40, 1); await assertCursor(recalled, { line: 1, col: 4 }, 9);
    terminal.resize(14, 14); await assertCursor(recalled, { line: 1, col: 4 }, 9);
    terminal.input('\x1b[A'); await assertCursor(recalled, { line: 0, col: 4 }, 9);
    terminal.input('\x1b[A'); await assertCursor('较早历史', { line: 0, col: 4 }, 9);
    terminal.input('\x1b[B'); await assertCursor(recalled, { line: 1, col: 4 }, 9);
    terminal.input('\x1b[B'); await assertCursor('', { line: 0, col: 0 }, 1);
    editor.setText('草稿 中文'); terminal.input('\x01'); terminal.input('\x1b[A'); await assertCursor(recalled, { line: 1, col: 4 }, 9);
    terminal.input('\x1b[B'); await frame(); assert.equal(editor.getText(), '草稿 中文'); assert.deepEqual(editor.getCursor(), { line: 0, col: 0 }); assert.equal(terminal.screen.buffer.active.cursorX, 1);
  } finally {
    await app.stop(); await running; await terminal.flushed; terminal.screen.dispose();
    if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
