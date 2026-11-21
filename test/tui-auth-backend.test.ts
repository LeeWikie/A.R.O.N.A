import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { fauxProvider } from '@earendil-works/pi-ai';
import type { NativeClipboard, Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  send(text: string) { for (const char of text) this.input(char); }
}

test('fake upstream OAuth uses actual Core auth endpoints and masked UI', { timeout: 30_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-auth-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const provider = fauxProvider({ provider: 'fake-tui' }).provider;
  const authorizationUrl = `https://example.invalid/authorize?state=${'a'.repeat(310)}&redirect_uri=http%3A%2F%2Flocalhost%3A1455`; let starts = 0;
  core.providerRegistry.setProvider({ ...provider, auth: { oauth: {
    name: 'Fixture OAuth', login: async interaction => { starts++; interaction.notify({ type: 'auth_url', url: authorizationUrl }); const code = await interaction.prompt({ type: 'manual_code', message: 'Fixture code' }); return { type: 'oauth', access: code, refresh: 'fixture-refresh', expires: Date.now() + 60_000 }; },
    refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const copied: string[] = []; const terminal = new FakeTerminal(); const app = new TerminalApp(client, 'main', terminal, { clipboard: { setText: async text => { copied.push(text); } } as NativeClipboard });
  const target = app as unknown as { choose: () => Promise<string | undefined>; providerAuth: () => Promise<void>; note: (text: string) => void };
  const opened: string[] = []; (app as any).openWebUrl = async (url: string) => { opened.push(url); };
  const choices = ['fake-tui', 'oauth']; const notes: string[] = []; target.choose = async () => choices.shift(); target.note = text => { notes.push(text); };
  try {
    const running = app.run(); await until(() => terminal.output, text => text.includes('已连接'));
    (app as any).editor.setText('原来的未发送草稿');
    const auth = target.providerAuth(); await until(() => terminal.output, text => text.includes('Fixture code'));
    terminal.send('fixture-oauth-'); terminal.send('\x18'); terminal.send('\x0f');
    await until(() => opened.length, count => count === 2);
    assert.deepEqual(copied, [authorizationUrl]);
    terminal.send('secret\r'); await auth;
    assert.equal((await core.auth.status('fake-tui')).configured, true);
    assert.ok(terminal.output.includes('https://example.invalid/authorize')); assert.deepEqual(opened, [authorizationUrl, authorizationUrl]); assert.equal(starts, 1);
    assert.equal((app as any).editor.getText(), '原来的未发送草稿');
    assert.equal(terminal.output.includes('fixture-oauth-secret'), false);
    await app.stop(); await running;
  } finally {
    await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
