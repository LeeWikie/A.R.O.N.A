import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  send(text: string) { for (const char of text) this.input(char); }
}

test('provider auth polls ordered events and expires a stale prompt before responding', { timeout: 10_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const handshake = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] };
  const seen: unknown[] = []; let polls = 0;
  const events = [{ sequence: 1, event: { type: 'auth_url', url: 'https://example.invalid/authorize' } }, { sequence: 2, event: { type: 'device_code', verificationUri: 'https://example.invalid/device', userCode: 'SAMPLE' } }];
  const client = {
    async handshake() { return handshake; },
    async snapshot() { return { ...handshake, selectedContextId: 'main', watermark: 0, drafts: [], conversation: { messages: [], hasMore: false }, contexts: [], runs: [] }; },
    async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    async request(route: string, init?: RequestInit) {
      if (route.startsWith('/contexts/main/message-queue')) return [];
      if (route === '/auth/providers') return { providers: [{ id: 'provider', name: 'Provider', methods: [{ type: 'oauth', name: 'Login' }] }] };
      if (route === '/auth/status/provider') return { configured: false };
      if (route === '/auth/provider/start') return { id: 'job', state: 'running' };
      if (route === '/auth/jobs/job') { polls++; return { id: 'job', state: 'running', promptId: polls === 1 ? 'first-id' : 'second-id', prompt: { type: 'secret', message: 'Enter code' }, events: polls === 1 ? [events[0]] : events }; }
      if (route === '/auth/jobs/job/respond') { seen.push(JSON.parse(String(init?.body))); return { id: 'job', state: 'completed', events: [] }; }
      throw new Error(route);
    },
  } as unknown as Client;
  const terminal = new FakeTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { choose: () => Promise<string | undefined>; providerAuth: () => Promise<void>; note: (text: string) => void };
  const choices = ['provider', 'oauth']; const notes: string[] = [];
  target.choose = async () => choices.shift(); target.note = text => { notes.push(text); };
  try {
    const running = app.run(); await new Promise(resolve => setTimeout(resolve, 40));
    const auth = target.providerAuth();
    for (let i = 0; i < 30 && polls < 2; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(polls >= 2); await new Promise(resolve => setTimeout(resolve, 50)); terminal.send('fixture-secret\r'); await auth;
    assert.deepEqual(seen, [{ value: 'fixture-secret', promptId: 'second-id' }]);
    assert.ok(notes.some(note => note.includes('https://example.invalid/authorize'))); assert.ok(notes.some(note => note.includes('SAMPLE')));
    assert.equal(terminal.output.includes('fixture-secret'), false);
    await app.stop(); await running;
  } finally { await app.stop(); if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY; }
});
