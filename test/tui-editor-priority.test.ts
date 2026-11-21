import assert from 'node:assert/strict';
import test from 'node:test';
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, type Editor, type Terminal, type TuiAltScreen } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('explicit native history shortcuts retain precedence over model cycling and queue restoration', async () => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.editor.historyPrevious': ['ctrl+p', 'alt+up'], 'tui.editor.historyNext': 'ctrl+n' }));
  const terminal = new FakeTerminal(), requests: string[] = [];
  const app = new TerminalApp({ async request(route: string) { requests.push(route); return {}; } } as unknown as Client, 'main', terminal);
  const state = app as unknown as { editor: Editor; ui: TuiAltScreen };
  try {
    state.editor.addToHistory('older'); state.editor.addToHistory('newer'); state.ui.setFocus(state.editor); state.ui.start();
    terminal.input('\x10'); assert.equal(state.editor.getText(), 'newer'); assert.deepEqual(state.editor.getCursor(), { line: 0, col: 5 });
    terminal.input('\x1b[1;3A'); assert.equal(state.editor.getText(), 'older');
    terminal.input('\x0e'); assert.equal(state.editor.getText(), 'newer'); terminal.input('\x0e'); assert.equal(state.editor.getText(), '');
    assert.deepEqual(requests, []);
  } finally { state.ui.stop(); await app.stop(); setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); }
});

test('an autocomplete page binding takes precedence over clipboard paste and falls back after closing', async () => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.select.pageDown': 'ctrl+v' }));
  const terminal = new FakeTerminal(), app = new TerminalApp({} as Client, 'main', terminal);
  const state = app as unknown as { editor: Editor; ui: TuiAltScreen; capabilities: Set<string>; clipboardPaste(): Promise<void> };
  let pastes = 0;
  state.clipboardPaste = async () => { pastes++; }; state.capabilities.add('attachments');
  try {
    state.editor.setAutocompleteProvider({ getSuggestions: async () => ({ prefix: '/', items: Array.from({ length: 12 }, (_, index) => ({ value: `/item${index}`, label: `/item${index}` })) }), applyCompletion(lines, line, col, item) { return { lines: [item.value], cursorLine: 0, cursorCol: item.value.length }; } });
    state.ui.setFocus(state.editor); state.ui.start(); terminal.input('/');
    for (let n = 0; n < 30 && !state.editor.isShowingAutocomplete(); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(state.editor.isShowingAutocomplete(), true); terminal.input('\x16'); terminal.input('\t');
    assert.equal(pastes, 0); assert.equal(state.editor.getText(), '/item5');
    terminal.input('\x1b'); terminal.input('\x16'); assert.equal(pastes, 1);
  } finally { state.ui.stop(); await app.stop(); setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); }
});
