import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('multiline editor preserves line breaks and escape cancels', async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const client = { async handshake() { return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] }; }, async snapshot() { return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', selectedContextId: 'main', watermark: 0, drafts: [], conversation: { messages: [], hasMore: false } }; }, async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } } as unknown as Client;
  const terminal = new FakeTerminal(), app = new TerminalApp(client, 'main', terminal);
  try {
    const running = app.run(); await new Promise(resolve => setTimeout(resolve, 30));
    const prompt = (app as unknown as { promptLong: (title: string) => Promise<string | undefined> }).promptLong.bind(app);
    const first = prompt('Content'); terminal.input('first'); terminal.input('\x1b[13;2u'); terminal.input('second'); terminal.input('\r');
    assert.equal(await first, 'first\nsecond');
    const second = prompt('Content'); terminal.input('\x1b'); assert.equal(await second, undefined);
    await app.stop(); await running;
  } finally {
    await app.stop(); if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
