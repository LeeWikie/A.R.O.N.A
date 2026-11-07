import type { Client } from '../src/client.js';
import { runTui } from '../src/tui/index.js';

const handshake = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream', 'message-queue', 'provider-auth', 'foreground-interrupt', 'context-branch', 'web-tools', 'attachments'] };
const client = {
  async handshake() { return handshake; },
  async snapshot() { return { ...handshake, selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], drafts: [], conversation: { messages: [], hasMore: false } }; },
  async request() { return []; },
  async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
} as unknown as Client;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 1200);
try { await runTui(client, 'main', controller.signal); } finally { clearTimeout(timer); }
