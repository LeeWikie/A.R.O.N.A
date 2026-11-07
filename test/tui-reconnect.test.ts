import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('checkpoint with a new core identity forces a fresh snapshot', async () => {
  const previousIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const previousOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const storageId = '00000000-0000-4000-8000-000000000002';
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000003';
  let instanceId = first; let snapshots = 0; let streams = 0;
  const client = {
    async handshake() { return { protocolVersion: 1, instanceId, storageId, capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] }; },
    async snapshot() { snapshots++; return { protocolVersion: 1, instanceId, storageId, selectedContextId: 'main', watermark: snapshots * 10, conversation: { messages: [], nextCursor: null, hasMore: false } }; },
    async *events({ signal }: { signal: AbortSignal }) {
      streams++;
      if (streams === 1) { instanceId = second; yield { type: 'checkpoint' as const, instanceId, storageId, cursor: 11 }; return; }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  try {
    const running = app.run(); await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(snapshots, 2); assert.equal(streams, 2);
    const state = app as unknown as { cursor: number; instanceId: string };
    assert.equal(state.instanceId, second); assert.equal(state.cursor, 20);
    await app.stop(); await running;
  } finally {
    await app.stop();
    if (previousIn) Object.defineProperty(process.stdin, 'isTTY', previousIn); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (previousOut) Object.defineProperty(process.stdout, 'isTTY', previousOut); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
