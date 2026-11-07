import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const wait = () => new Promise(resolve => setTimeout(resolve, 40));

test('editor history and unsent drafts stay scoped to their context', async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const identity = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream'] };
  const client = { async handshake() { return identity; }, async snapshot(id: string) { return { ...identity, selectedContextId: id, watermark: 0, contexts: [{ id, role: 'main' }], runs: [], drafts: [], conversation: { messages: [{ id: `signal:${id}`, contextId: id, role: 'user', content: `old ${id}`, kind: 'message', status: 'accepted' }], hasMore: false } }; }, async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const state = app as unknown as { switchContext: (id: string) => void; contextReady: boolean; editor: { getText: () => string; setText: (value: string) => void; handleInput: (data: string) => void } };
  try {
    const running = app.run(); await wait(); assert.equal(state.contextReady, true);
    state.editor.handleInput('\x1b[A'); assert.equal(state.editor.getText(), 'old main'); state.editor.setText('draft main');
    state.switchContext('other'); await wait(); assert.equal(state.contextReady, true); assert.equal(state.editor.getText(), '');
    state.editor.handleInput('\x1b[A'); assert.equal(state.editor.getText(), 'old other'); state.editor.setText('draft other');
    state.switchContext('main'); await wait(); assert.equal(state.editor.getText(), 'draft main');
    state.switchContext('other'); await wait(); assert.equal(state.editor.getText(), 'draft other');
    await app.stop(); await running;
  } finally { await app.stop(); if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY; }
});
