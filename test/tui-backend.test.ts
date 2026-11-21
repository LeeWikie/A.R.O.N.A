import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import type { Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp, until } from './helpers.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

class TestTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input: (s: string) => void = () => {};
  start(input: (s: string) => void) { this.input = input; } stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  send(text: string) { for (const char of text) this.input(char); }
}

test('real authenticated core delivers authorized chat over SSE', { timeout: 30_000 }, async () => {
  const oldIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'); const oldOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-live-'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' });
    controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Visible partial' });
    void gate.then(() => { controller.enqueue({ type: 'text-delta', id: 'reply', delta: ' completed' }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); });
  } }) }) });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false, controlToken: 'Z-synthetic-control-token-0123456789' });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const terminal = new TestTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const terminal2 = new TestTerminal(); const app2 = new TerminalApp(client, 'main', terminal2);
  try {
    const running = app.run();
    await until(() => terminal.output, output => output.includes('已连接'));
    terminal.send('synthetic question\r');
    await until(() => terminal.output, output => output.includes('Visible partial'));
    const active = app as unknown as { drafts: Map<string, unknown>; seen: Set<string> };
    assert.equal(active.drafts.size, 1);
    const running2 = app2.run();
    await until(() => terminal2.output, output => output.includes('Visible partial'));
    assert.equal((app2 as unknown as { drafts: Map<string, unknown> }).drafts.size, 1);
    release();
    await until(() => active.drafts.size, count => count === 0);
    await until(() => terminal.output, output => output.includes('Visible partial completed'));
    assert.ok(terminal.output.includes('synthetic question'));
    assert.equal([...active.seen].filter(id => id.startsWith('output:')).length, 1);
    assert.equal((app as unknown as { transcript: { children: unknown[] } }).transcript.children.length, 4);
    await app2.stop(); await running2; await app.stop(); await running;
  } finally {
    release(); await app2.stop(); await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (oldIn) Object.defineProperty(process.stdin, 'isTTY', oldIn); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (oldOut) Object.defineProperty(process.stdout, 'isTTY', oldOut); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
