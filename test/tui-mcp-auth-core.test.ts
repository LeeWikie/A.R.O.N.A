import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { SelectItem, Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp, until } from './helpers.js';
import { oauthFixture } from './mcp-oauth-fixture.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;

test('MCP login runs from terminal management through HTTP and native OAuth to usable tools and logout', { timeout: 30000 }, async () => {
  const f = await oauthFixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-mcp-core-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false }); await core.capabilities.saveMCP(f.capabilities.mcpConfigs()[0]);
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const app = new TerminalApp(client, 'main', terminal);
  const ui = app as unknown as { capabilities: Set<string>; command(text: string): Promise<void>; choose(title: string, items: SelectItem[]): Promise<string | undefined>; pendingModal?: () => void; note(text: string): void; openWebUrl(url: string): Promise<void> };
  let browserRequests = 0, loggedOut = false; const notes: string[] = [];
  try {
    ui.capabilities = new Set((await client.handshake()).capabilities); ui.note = text => { notes.push(text); };
    ui.openWebUrl = async url => { browserRequests++; assert.ok(url.startsWith(f.base + '/authorize?')); assert.equal((await fetch(url)).ok, true); };
    ui.choose = async (_title, items) => {
      if (items.some(item => item.value === 'server:fixture')) return 'server:fixture';
      if (items.some(item => item.value === 'auth')) return loggedOut ? 'logout' : 'auth';
      if (items.some(item => item.value === 'yes')) return 'yes';
      if (items.some(item => item.value === 'open') && !browserRequests) return 'open';
      return new Promise(resolve => { ui.pendingModal = () => { ui.pendingModal = undefined; resolve(undefined); }; });
    };
    await ui.command('/mcp'); assert.equal(browserRequests, 1);
    await until(() => core.capabilities.mcpStatus()[0]?.connected, Boolean);
    const tool = core.capabilities.tools(true).ext_fixture_read_fixture as { execute(input: unknown): Promise<unknown> };
    assert.match(JSON.stringify(await tool.execute({})), /Authenticated synthetic result/); assert.equal(f.tokenCount(), 1);
    assert.match(notes.join('\n'), /MCP 登录完成/); assert.doesNotMatch(notes.join('\n'), /synthetic-access-|synthetic-refresh-/);
    loggedOut = true; await ui.command('/mcp'); assert.equal(core.capabilities.mcpStatus()[0]?.connected, false);
    await assert.rejects(tool.execute({}), /mcp_connection_changed/);
  } finally {
    await app.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); await f.close();
  }
});
