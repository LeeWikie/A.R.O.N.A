import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import type { ContextRecord } from '../src/runtime-store.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('branch picker verifies old run IDs from every conversation page', async () => {
  const older = '00000000-0000-4000-8000-000000000055'; const requests: string[] = [];
  const source = { id: 'main', name: 'Main', role: 'main', purpose: '', workspaceId: 'default' } as ContextRecord;
  const client = {
    async snapshot(context: string) { return { selectedContextId: context, runs: [], conversation: { messages: [], hasMore: true, nextCursor: 'page-1' } }; },
    async conversation() { return { messages: [{ runId: older }], hasMore: false, nextCursor: 'page-2' }; },
    async request(route: string) { requests.push(route); if (route === `/runs/${older}`) return { id: older, contextId: 'main', status: 'succeeded', createdAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:01:00Z' }; throw new Error(route); },
  } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { branchContext: (source: ContextRecord) => Promise<void>; choose: (title: string, items: Array<{ value: string }>) => Promise<string | undefined> };
  let offered: string[] = []; target.choose = async (_title, items) => { offered = items.map(item => item.value); return undefined; };
  try { await target.branchContext(source); assert.deepEqual(offered, [older]); assert.ok(requests.includes(`/runs/${older}`)); }
  finally { await app.stop(); }
});
