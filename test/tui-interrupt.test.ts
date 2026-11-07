import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('Ctrl-C targets the exact observed foreground run', async () => {
  const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'); const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const writes: unknown[] = [];
  const client = {
    async handshake() { return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] }; },
    async snapshot() { return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', watermark: 0, selectedContextId: 'main', contexts: [{ id: 'main', role: 'main' }], runs: [{ id: 'run-exact', status: 'running' }], conversation: { messages: [], nextCursor: null, hasMore: false } }; },
    async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    async request(route: string, init?: RequestInit) { writes.push({ route, method: init?.method, body: JSON.parse(String(init?.body)) }); return {}; },
  } as unknown as Client;
  const terminal = new FakeTerminal(); const app = new TerminalApp(client, 'main', terminal);
  try {
    const running = app.run(); await new Promise(resolve => setTimeout(resolve, 50)); terminal.input('\x03'); await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(writes, [{ route: '/contexts/main/interrupt', method: 'POST', body: { expectedRunId: 'run-exact' } }]);
    await app.stop(); await running;
  } finally {
    await app.stop();
    if (inputDescriptor) Object.defineProperty(process.stdin, 'isTTY', inputDescriptor); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (outputDescriptor) Object.defineProperty(process.stdout, 'isTTY', outputDescriptor); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
