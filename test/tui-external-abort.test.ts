import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; starts = 0; stops = 0;
  start() { this.starts++; } stop() { this.stops++; } async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('shutdown waits for external editor cancellation without remounting', { timeout: 10_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-editor-abort-')), marker = path.join(directory, 'marker');
  const old = process.env.SHITTIMCHEST_EDITOR_TEST_MARKER; process.env.SHITTIMCHEST_EDITOR_TEST_MARKER = marker;
  const identity = { protocolVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002', capabilities: ['snapshot', 'event-stream', 'conversation-history', 'reply-stream'] };
  const client = { async handshake() { return identity; }, async snapshot() { return { ...identity, selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], drafts: [], conversation: { messages: [], hasMore: false } }; }, async *events({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } } as unknown as Client;
  const terminal = new FakeTerminal(), app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { prompt: () => Promise<string>; choose: () => Promise<string>; editStrings: () => Promise<string[]>; externalEditor: () => Promise<void> };
  target.prompt = async () => process.execPath; target.choose = async () => 'yes'; target.editStrings = async () => [fileURLToPath(new URL('./tui-external-writer.mjs', import.meta.url)), '--hold'];
  try {
    const running = app.run(); await new Promise(resolve => setTimeout(resolve, 40));
    const editing = target.externalEditor();
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(marker), true); const file = fs.readFileSync(marker, 'utf8');
    await app.stop(); await editing.catch(() => {}); await running;
    assert.equal(terminal.starts, 1); assert.equal(terminal.stops, 1); assert.equal(fs.existsSync(file), false);
  } finally {
    await app.stop(); if (old === undefined) delete process.env.SHITTIMCHEST_EDITOR_TEST_MARKER; else process.env.SHITTIMCHEST_EDITOR_TEST_MARKER = old;
    fs.rmSync(directory, { recursive: true, force: true }); if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
