import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class TerminalFixture implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const delay = () => new Promise(resolve => setTimeout(resolve, 80));

test('snapshot pagination and replay preserve each authorized message once', async () => {
  const descriptors = [Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')];
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const requests: string[] = [];
  const message = (id: string) => ({ id, contextId: 'main', role: 'user', content: id, createdAt: '2026-01-01T00:00:00.000Z', runId: null, status: 'accepted', kind: 'message' });
  const client = { async request(route: string) {
    requests.push(route);
    if (route === '/protocol') return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] };
    if (route.startsWith('/snapshot?')) return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', selectedContextId: 'main', watermark: 10, conversation: { messages: [message('signal:1')], nextCursor: 'page-1', hasMore: true } };
    if (route.startsWith('/conversation?')) return { messages: [message('signal:2')], nextCursor: 'page-2', hasMore: false };
    if (route.startsWith('/event-page?')) return { events: [{ seq: 11, contextId: 'main', kind: 'conversation', data: message('signal:2') }, { seq: 12, contextId: 'main', kind: 'conversation', data: message('signal:3') }], nextCursor: 12, hasMore: false };
    throw new Error(route);
  },
  async handshake(this: { request: (route: string) => Promise<unknown> }) { return this.request('/protocol'); },
  async snapshot(this: { request: (route: string) => Promise<unknown> }, contextId: string) { return this.request(`/snapshot?contextId=${contextId}`); },
  async conversation(this: { request: (route: string) => Promise<unknown> }, contextId: string, after: string) { return this.request(`/conversation?contextId=${contextId}&after=${after}`); },
  async *events({ after, signal }: { after: number; signal: AbortSignal }) {
    requests.push(`/event-stream?after=${after}`);
    yield { type: 'event' as const, event: { seq: 11, contextId: 'main', kind: 'conversation', data: message('signal:2') } };
    yield { type: 'event' as const, event: { seq: 12, contextId: 'main', kind: 'conversation', data: message('signal:3') } };
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new TerminalFixture());
  try {
    const running = app.run(); await delay();
    const internals = app as unknown as { seen: Set<string>; transcript: { children: unknown[] } };
    assert.deepEqual([...internals.seen], ['signal:1', 'signal:2', 'signal:3']);
    assert.equal(internals.transcript.children.length, 3);
    assert.ok(requests.some(route => route.startsWith('/conversation?') && route.includes('after=page-1')));
    assert.ok(requests.some(route => route.startsWith('/event-stream?after=10')));
    await app.stop(); await running;
  } finally {
    await app.stop();
    for (const [stream, descriptor] of [[process.stdin, descriptors[0]], [process.stdout, descriptors[1]]] as const) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else delete (stream as { isTTY?: boolean }).isTTY;
    }
  }
});
