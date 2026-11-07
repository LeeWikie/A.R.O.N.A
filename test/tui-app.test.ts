import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { safeTerminalText, TerminalApp } from '../src/tui/index.js';

class TestTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; stopped = false;
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void) { this.stopped = false; this.input = onInput; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  send(text: string) { for (const char of text) this.input(char); }
}
const wait = () => new Promise(resolve => setTimeout(resolve, 60));

test('terminal text rejects control sequences and directional overrides', () => {
  assert.equal(safeTerminalText('abc\x1b]0;evil\x07\x1b[2Jx‮y'), 'abcxy');
});

test('chat and context management drive backend and cleanly stop', async () => {
  const priorIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const priorOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const terminal = new TestTerminal();
  const submissions: Array<[string, string]> = [];
  const requests: string[] = [];
  const writes: Array<{ route: string; body: unknown }> = [];
  const client = {
    async request(route: string, init?: RequestInit) {
      requests.push(route);
      if (init?.body) writes.push({ route, body: JSON.parse(String(init.body)) as unknown });
      if (route === '/protocol') return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] };
      if (route.startsWith('/snapshot?')) { const contextId = new URL(route, 'http://localhost').searchParams.get('contextId'); return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', watermark: 0, selectedContextId: contextId, contexts: [{ id: contextId, role: 'main' }], runs: [], conversation: { messages: [], nextCursor: null, hasMore: false }, approvals: writes.some(x => x.route === '/approvals/approval-1') ? [] : [{ id: 'approval-1', contextId: 'other', toolName: 'write_file', args: { path: 'file.txt' }, status: 'pending', createdAt: '2026-01-01T00:00:00Z' }] }; }
      if (route.startsWith('/event-page?')) return { events: [], nextCursor: 0, hasMore: false };
      if (route === '/messages') { const body = JSON.parse(String(init?.body)) as { content: string; contextId: string }; submissions.push([body.content, body.contextId]); return { status: 'accepted' }; }
      if (route === '/contexts') return { contexts: [{ id: 'other', name: '其他', archived: false }] };
      if (route === '/approvals') return { approvals: writes.some(x => x.route === '/approvals/approval-1') ? [] : [{ id: 'approval-1', contextId: 'other', toolName: 'write_file', args: { path: 'file.txt' }, status: 'pending', createdAt: '2026-01-01T00:00:00Z' }] };
      if (route === '/approvals/approval-1') return {};
      if (route === '/models') return { models: [{ id: 'profile-1', name: 'Fixture', modelId: 'model', thinking: {} }] };
      if (route === '/credentials') return { credentials: [] };
      if (route === '/credentials/FIXTURE_KEY') return {};
      if (route === '/auth/providers') return { providers: [{ id: 'fixture', name: 'Fixture provider', methods: [{ type: 'api_key', name: 'API key' }] }] };
      if (route === '/auth/status/fixture') return { configured: false };
      if (route === '/auth/fixture/start') return { id: 'job-1', state: 'running' };
      if (route === '/auth/jobs/job-1') return { id: 'job-1', state: 'running', promptId: 'prompt-1', prompt: { type: 'secret', message: 'Provider key' }, events: [] };
      if (route === '/auth/jobs/job-1/respond') return { id: 'job-1', state: 'completed' };
      if (route === '/contexts/other/model') return {};
      throw new Error(`unexpected route ${route}`);
    },
    async handshake(this: { request: (route: string) => Promise<unknown> }) { return this.request('/protocol'); },
    async snapshot(this: { request: (route: string) => Promise<unknown> }, contextId: string) { return this.request(`/snapshot?contextId=${encodeURIComponent(contextId)}`); },
    async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    async submit(text: string, _type: string, context: string) { submissions.push([text, context]); },
  } as unknown as Client;
  const app = new TerminalApp(client, 'main', terminal);
  try {
    const running = app.run(); await wait();
    // A pending approval in any context is presented at once; 1 = approve this call.
    assert.ok(terminal.output.includes('需要审批'));
    terminal.send('1'); await wait();
    assert.deepEqual(writes.find(x => x.route === '/approvals/approval-1')?.body, { decision: 'approve', scope: 'once' });
    terminal.send('hello\r'); await wait();
    assert.deepEqual(submissions, [['hello', 'main']]);
    terminal.send('/menu\r'); await wait();
    terminal.send('\r'); await wait();
    assert.ok(requests.includes('/contexts'));
    terminal.send('其他\r'); await wait();
    terminal.send('\r'); await wait();
    terminal.send('next\r'); await wait();
    assert.deepEqual(submissions, [['hello', 'main'], ['next', 'other']]);
    terminal.send('/menu\r'); await wait(); terminal.send('切换模型\r'); await wait(); terminal.send('\r'); await wait(); terminal.send('\r'); await wait();
    assert.deepEqual(writes.find(x => x.route === '/contexts/other/model')?.body, { profileId: 'profile-1' });
    terminal.send('/menu\r'); await wait(); terminal.send('凭据\r'); await wait(); terminal.send('\r'); await wait(); terminal.send('FIXTURE_KEY\r'); await wait(); terminal.send('fixture-secret\r'); await wait();
    assert.deepEqual(writes.find(x => x.route === '/credentials/FIXTURE_KEY')?.body, { value: 'fixture-secret' });
    assert.equal(terminal.output.includes('fixture-secret'), false);
    terminal.send('/menu\r'); await wait(); terminal.send('provider-auth\r'); await wait(); terminal.send('\r'); await wait(); terminal.send('\r'); await wait(); terminal.send('provider-secret\r'); await wait();
    assert.deepEqual(writes.find(x => x.route === '/auth/jobs/job-1/respond')?.body, { value: 'provider-secret', promptId: 'prompt-1' });
    assert.equal(terminal.output.includes('provider-secret'), false);
    terminal.send('/quit\r'); await running;
    assert.equal(terminal.stopped, true);
    assert.ok(requests.some(route => route.includes('contextId=other')));
  } finally {
    app.stop();
    if (priorIn) Object.defineProperty(process.stdin, 'isTTY', priorIn); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (priorOut) Object.defineProperty(process.stdout, 'isTTY', priorOut); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
