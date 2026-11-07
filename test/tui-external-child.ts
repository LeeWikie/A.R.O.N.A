import type { Client } from '../src/client.js';
import { runTui } from '../src/tui/index.js';
const handshake = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream'] };
const client = { async handshake() { return handshake; }, async snapshot() { return { ...handshake, selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], drafts: [], conversation: { messages: [], hasMore: false } }; }, async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }, async request(route: string) { if (route === '/messages') return { status: 'accepted' }; throw new Error(route); } } as unknown as Client;
await runTui(client);
