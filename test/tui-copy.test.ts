import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('selection is copied only on explicit user action', async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const identity = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream'] };
  const client = { async handshake() { return identity; }, async snapshot() { return { ...identity, selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], drafts: [], conversation: { messages: [{ id: 'signal:1', contextId: 'main', role: 'user', content: 'copy-target', kind: 'message', status: 'accepted' }], hasMore: false } }; }, async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } } as unknown as Client;
  const copies: string[] = [], terminal = new FakeTerminal();
  const app = new TerminalApp(client, 'main', terminal, { clipboard: { async getText() { return null; }, async getImage() { return null; }, async setText(text) { copies.push(text); } } });
  const state = app as unknown as { ui: { getScreenLines: () => string[]; hasActiveSelection: () => boolean } };
  try {
    const running = app.run(); await new Promise(resolve => setTimeout(resolve, 80));
    const screen = state.ui.getScreenLines().map(stripTerminalSequences); const row = screen.findIndex(line => line.includes('copy-target')); assert.ok(row >= 0);
    const column = screen[row]!.indexOf('copy-target'); const y = row + 1, x = column + 1;
    terminal.input(`\x1b[<0;${x};${y}M`); terminal.input(`\x1b[<32;${x + 10};${y}M`); terminal.input(`\x1b[<0;${x + 10};${y}m`);
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(state.ui.hasActiveSelection(), true); assert.deepEqual(copies, []);
    terminal.input('\x03'); await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(copies, ['copy-target']);
    await app.stop(); await running;
  } finally { await app.stop(); if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY; }
});
