import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; started = false;
  start() { this.started = true; } stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('shutdown aborts a pending handshake before terminal start', async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const client = { async handshake(signal: AbortSignal) { await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } } as unknown as Client;
  const terminal = new FakeTerminal(); const app = new TerminalApp(client, 'main', terminal);
  try { const run = app.run(); await app.stop(); await run; assert.equal(terminal.started, false); }
  finally { await app.stop(); if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY; }
});
