import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { isMacCopyShortcut, isRepeatedCopyOrInterrupt } from '../src/tui/terminal-editor.js';

class TypingTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = true; stopped = false; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() { this.stopped = true; } async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const frame = () => new Promise<void>(resolve => setTimeout(resolve, 40));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const terminal = new TypingTerminal(), copies: string[] = [], writes: string[] = [];
  const app = new TerminalApp({ async request(route: string) { writes.push(route); return {}; } } as unknown as Client, 'main', terminal, { clipboard: { async getText() { return null; }, async getImage() { return null; }, async setText(text) { copies.push(text); } } });
  const state = app as any; state.started = true; state.ui.setFocus(state.editor); state.ui.start(); state.lastAssistant.set('main', 'last assistant fixture');
  return { app, state, terminal, copies, writes };
}
async function select(f: ReturnType<typeof fixture>) {
  f.state.note('copy-target'); await frame();
  const lines = f.state.ui.getScreenLines().map(stripTerminalSequences), row = lines.findIndex((line: string) => line.includes('copy-target')); assert.ok(row >= 0);
  const x = lines[row]!.indexOf('copy-target') + 1, y = row + 1;
  f.terminal.input(`\x1b[<0;${x};${y}M`); f.terminal.input(`\x1b[<32;${x + 10};${y}M`); f.terminal.input(`\x1b[<0;${x + 10};${y}m`);
  assert.equal(f.state.ui.hasActiveSelection(), true); assert.deepEqual(f.copies, []);
}

test('Kitty Ctrl+C release and autorepeat never become a second interrupt press', async () => {
  const f = fixture();
  try {
    f.terminal.input('\x1b[99;5u');
    for (let index = 0; index < 5; index++) f.terminal.input('\x1b[99;5:2u');
    f.terminal.input('\x1b[99;5:3u'); await tick(); assert.equal(f.state.stopped, false);
    f.terminal.input('\x1b[99;5u'); await tick(); assert.equal(f.state.stopped, true, 'two independent press events retain the existing exit gesture');
  } finally { await f.app.stop(); }
});

test('a held Ctrl+C clears a draft only once and sends one interrupt for a running job', async () => {
  const f = fixture();
  try {
    f.state.editor.setText('editable draft'); f.terminal.input('\x1b[99;5u');
    f.terminal.input('\x1b[99;5:2u'); f.terminal.input('\x1b[99;5:3u'); await tick(); assert.equal(f.state.editor.getText(), ''); assert.equal(f.state.stopped, false); assert.equal(f.state.lastCtrlC, 0);
    f.state.currentRunId = 'run'; f.state.isMainContext = true; f.state.capabilities.add('foreground-interrupt');
    f.terminal.input('\x1b[99;5u'); f.terminal.input('\x1b[99;5:2u'); f.terminal.input('\x1b[99;5:3u'); await tick();
    assert.deepEqual(f.writes, ['/contexts/main/interrupt']); assert.equal(f.state.stopped, false);
  } finally { await f.app.stop(); }
});

test('Ctrl+C copies the actual application selection once and repeat after selection clearing preserves the draft', async () => {
  const f = fixture();
  try {
    f.state.editor.setText('keep current draft'); await select(f); f.terminal.input('\x1b[99;5u'); await tick(); assert.deepEqual(f.copies, ['copy-target']);
    f.state.ui.resetTextSelection(); f.terminal.input('\x1b[99;5:2u'); f.terminal.input('\x1b[99;5:3u'); await tick();
    assert.equal(f.state.editor.getText(), 'keep current draft'); assert.equal(f.state.stopped, false); assert.deepEqual(f.writes, []); assert.deepEqual(f.copies, ['copy-target']);
  } finally { await f.app.stop(); }
});

test('macOS Command+C is selection-only copy, with no fallback or destructive effect after clearing', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture();
  try {
    f.state.editor.setText('keep current draft'); await select(f);
    f.terminal.input('\x1b[99;9u'); f.terminal.input('\x1b[99;9:2u'); f.terminal.input('\x1b[99;9:3u'); await tick(); assert.deepEqual(f.copies, ['copy-target']);
    f.state.ui.resetTextSelection(); f.terminal.input('\x1b[99;9:2u'); f.terminal.input('\x1b[99;9:3u'); f.terminal.input('\x1b[99;9u'); await tick();
    assert.deepEqual(f.copies, ['copy-target']); assert.equal(f.state.editor.getText(), 'keep current draft'); assert.equal(f.state.stopped, false); assert.deepEqual(f.writes, []);
  } finally { await f.app.stop(); }
});

test('Ctrl+X and Ctrl+Shift+C retain their last-answer copy behavior and discard releases and repeats', async () => {
  const f = fixture();
  try {
    for (const code of ['120;5', '99;6']) { f.terminal.input(`\x1b[${code}u`); f.terminal.input(`\x1b[${code}:2u`); f.terminal.input(`\x1b[${code}:3u`); }
    await tick(); assert.deepEqual(f.copies, ['last assistant fixture', 'last assistant fixture']); assert.equal(f.state.stopped, false);
  } finally { await f.app.stop(); }
});

test('non-copy action releases are ignored while printable and arrow autorepeat keep editing', async () => {
  const f = fixture(); let toggles = 0; f.state.toggleAllTools = () => { toggles++; };
  try {
    f.terminal.input('\x1b[111;5u'); f.terminal.input('\x1b[111;5:3u'); assert.equal(toggles, 1);
    f.terminal.input('\x1b[120;1u'); f.terminal.input('\x1b[120;1:2u'); assert.equal(f.state.editor.getText(), 'xx');
    f.terminal.input('\x1b[1;1:2D'); assert.deepEqual(f.state.editor.getCursor(), { line: 0, col: 1 });
  } finally { await f.app.stop(); }
});

test('Super+C is copied only on macOS and legacy independent Ctrl+C presses are not time-filtered', async () => {
  assert.equal(isMacCopyShortcut('\x1b[99;9u', 'darwin'), true); assert.equal(isMacCopyShortcut('\x1b[99;9u', 'win32'), false); assert.equal(isMacCopyShortcut('\x1b[99;9u', 'linux'), false);
  assert.equal(isRepeatedCopyOrInterrupt('\x1b[99;9:2u', 'win32'), false); assert.equal(isRepeatedCopyOrInterrupt('\x03'), false);
  const f = fixture();
  try { f.terminal.input('\x03'); f.terminal.input('\x03'); await tick(); assert.equal(f.state.stopped, true); }
  finally { await f.app.stop(); }
});
