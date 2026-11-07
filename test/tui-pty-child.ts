import { TerminalApp } from '../src/tui/index.js';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';

const client = {
  async request(route: string, init?: RequestInit) {
    if (route === '/protocol') return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] };
    if (route.startsWith('/snapshot?')) return { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', watermark: 0, selectedContextId: new URL(route, 'http://localhost').searchParams.get('contextId'), contexts: [{ id: new URL(route, 'http://localhost').searchParams.get('contextId'), role: 'main' }], runs: [], conversation: { messages: [], nextCursor: null, hasMore: false }, approvals: [] };
    if (route.startsWith('/event-page?')) return { events: [], nextCursor: 0, hasMore: false };
    if (route === '/messages') return { status: 'accepted' };
    if (route === '/contexts') return { contexts: [{ id: 'work', name: 'Work', archived: false }] };
    if (route === '/credentials') return { credentials: [] };
    if (route === '/credentials/FIXTURE_KEY') {
      if (JSON.parse(String(init?.body)).value !== 'conpty-fixture-secret') throw new Error('incorrect credential');
      return {};
    }
    throw new Error(`unexpected route ${route}`);
  },
  async handshake(this: { request: (route: string) => Promise<unknown> }) { return this.request('/protocol'); },
  async snapshot(this: { request: (route: string) => Promise<unknown> }, contextId: string) { return this.request(`/snapshot?contextId=${encodeURIComponent(contextId)}`); },
  async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
  async submit(_text: string, _type: string, _context: string) {},
} as unknown as Client;
await new TerminalApp(client, 'main', new ProcessTerminal(), { fdPath: process.env.SHITTIMCHEST_TEST_FD, completionBase: process.env.SHITTIMCHEST_COMPLETION_DIR }).run();
