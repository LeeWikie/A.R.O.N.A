import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import type { Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, scriptedModel, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = '';
  start() {} stop() {} async drainInput() {} write(data: string) { this.output += data; } moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('tool cards restore real native activity and update from SSE', { timeout: 30_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-tools-')); const core = await Core.open({ dataDir: directory, model: scriptedModel().model, memoryEnabled: false });
  const first = await core.submitSignal({ version: 2, type: 'user-message', source: 'fixture', content: 'synthetic request' }); await finished(core, first.runId!);
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new FakeTerminal(), app = new TerminalApp(client, 'main', terminal);
  const state = app as unknown as { toolCards: Map<string, { data: { toolName: string; state: string; summary?: unknown } }> };
  try {
    const running = app.run(); await until(() => [...state.toolCards.values()], cards => cards.some(card => card.data.toolName === 'emit_message' && card.data.state === 'finished'));
    core.runtime.event({ contextId: 'main', runId: first.runId, kind: 'public_tool', data: { toolCallId: 'fixture-live', toolName: 'read', state: 'running', args: { path: 'safe.txt' }, progress: { bytes: 4 } } });
    await until(() => [...state.toolCards.values()], cards => cards.some(card => card.data.toolName === 'read' && card.data.state === 'running'));
    core.runtime.event({ contextId: 'main', runId: first.runId, kind: 'public_tool', data: { toolCallId: 'fixture-live', toolName: 'read', state: 'finished', summary: { bytes: 4 } } });
    await until(() => [...state.toolCards.values()], cards => cards.some(card => card.data.toolName === 'read' && card.data.state === 'finished'));
    assert.equal([...state.toolCards.values()].filter(card => card.data.toolName === 'read').length, 1);
    await app.stop(); await running;
  } finally {
    await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
