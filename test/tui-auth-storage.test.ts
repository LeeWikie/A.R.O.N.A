import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const action of ['cancel', 'replace-storage', 'stop'] as const) {
  test(`认证清理仅作用于原存储，操作=${action}`, { timeout: 5000 }, async () => {
    const priorFetch = globalThis.fetch;
    const writes: Array<{ storage: string; generation: number; signalAborted: boolean }> = [];
    let state: any;
    const client = new Client('http://synthetic.invalid', 'synthetic-only-control-token');
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      let body: unknown;
      if (route === '/auth/providers') body = { providers: [{ id: 'fixture', name: 'Fixture', methods: [{ type: 'oauth', name: 'Fixture login' }] }] };
      else if (route === '/auth/status/fixture') body = { configured: false };
      else if (route === '/auth/fixture/start') body = { id: 'fixture-job', state: 'running' };
      else if (route === '/auth/jobs/fixture-job') {
        if (init?.method === 'DELETE') {
          writes.push({ storage: state.storageId, generation: state.storageGeneration, signalAborted: init.signal?.aborted ?? false }); body = {};
        } else body = { id: 'fixture-job', state: 'running', promptId: 'fixture-prompt', prompt: { type: 'secret', message: 'Synthetic credential' } };
      } else throw new Error(`unexpected route ${route}`);
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const app = new TerminalApp(client, 'main', new FakeTerminal()); state = app as any;
    Object.assign(state, { contextRole: 'main', contextReady: true, isMainContext: true, storageId: 'old' });
    const operation = state.withModalFlow(() => state.providerAuth('fixture'));
    const outcome = operation.catch((error: unknown) => error);
    try {
      await tick(); assert.equal(typeof state.pendingModal, 'function');
      if (action === 'replace-storage') {
        client.snapshot = async () => ({ protocolVersion: 1, storageId: 'new', instanceId: 'new-instance', selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], conversation: { messages: [], hasMore: false } }) as any;
        for (const method of ['refreshModel', 'refreshUsage', 'refreshTasks', 'refreshQueue', 'connectStream']) state[method] = async () => {};
        await state.loadContext(state.generation);
      } else if (action === 'stop') await app.stop();
      else state.pendingModal();
      await outcome;
      assert.equal(writes.length, action === 'replace-storage' ? 0 : 1, JSON.stringify(writes));
      for (const write of writes) { assert.equal(write.storage, 'old'); assert.equal(write.generation, 0); assert.equal(write.signalAborted, false); }
      assert.equal(state.pendingModal, undefined);
    } finally {
      state.pendingModal?.(); await outcome; await app.stop(); globalThis.fetch = priorFetch;
    }
  });
}
