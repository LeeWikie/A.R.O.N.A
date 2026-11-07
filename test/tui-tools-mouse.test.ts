import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('tool card expands and folds through actual mouse dispatch', async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const identity = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream'] };
  const client = { async handshake() { return identity; }, async snapshot() { return { ...identity, selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], drafts: [], toolActivity: [{ contextId: 'main', runId: 'run', toolCallId: 'call', toolName: 'fixture-tool', state: 'finished', args: { command: 'unique-argument-value' }, startedAt: '2020-01-01T00:00:00Z' }], conversation: { messages: [], hasMore: false } }; }, async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } } as unknown as Client;
  const terminal = new FakeTerminal(), app = new TerminalApp(client, 'main', terminal);
  const state = app as unknown as { ui: { getScreenLines: () => string[] } };
  const screen = () => state.ui.getScreenLines().map(stripTerminalSequences);
  const click = () => { const lines = screen(), row = lines.findIndex(line => line.includes('fixture-tool')); assert.ok(row >= 0); const column = lines[row]!.indexOf('fixture-tool'); terminal.input(`\x1b[<0;${column + 1};${row + 1}M`); terminal.input(`\x1b[<0;${column + 1};${row + 1}m`); };
  try {
    const running = app.run(); await new Promise(resolve => setTimeout(resolve, 80)); assert.ok(!screen().join('').includes('unique-argument-value'));
    click(); await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(screen().join('').includes('unique-argument-value'));
    click(); await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(!screen().join('').includes('unique-argument-value'));
    await app.stop(); await running;
  } finally { await app.stop(); if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY; }
});
