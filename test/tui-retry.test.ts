import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { AppError } from '../src/domain.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('uncertain task creation retries with same idempotency key', async () => {
  const keys: string[] = [];
  const client = { async request(_route: string, init: RequestInit) { keys.push(new Headers(init.headers).get('Idempotency-Key')!); if (keys.length === 1) throw new AppError('connection_failed', 502); return {}; } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const write = (app as unknown as { write: (route: string, body: unknown) => Promise<unknown> }).write.bind(app);
  try {
    await assert.rejects(write('/tasks', { title: 'task' }), /connection_failed/);
    await write('/tasks', { title: 'task' }); await write('/tasks', { title: 'task' });
    assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
  } finally { await app.stop(); }
});
