import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import type { CompanionRhythmView } from '../src/companion-rhythm.js';
import { removeTemp } from './helpers.js';

class TestTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
type UI = { storageId: string; capabilities: Set<string>; choose(): Promise<string | undefined>; prompt(): Promise<string | undefined>; note(text: string): void; runtimeSettings(): Promise<void>; companionSettings(): Promise<void> };

test('terminal companion settings persist through Core, recover a lost acknowledgement and refuse stale concurrent edits', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-companion-ui-'));
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { calls++; throw new Error('No model request belongs to configuration'); } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const transport = Object.create(client) as Client; let lost = true, writes = 0;
  transport.request = async <T>(route: string, init?: Parameters<Client['request']>[1]) => {
    const result = await client.request<T>(route, init);
    if (route === '/companion' && init?.method === 'PUT') { writes++; if (lost) { lost = false; throw new Error('synthetic configuration acknowledgement lost'); } }
    return result;
  };
  const app = new TerminalApp(transport, 'main', new TestTerminal()), ui = app as unknown as UI, notes: string[] = [];
  ui.storageId = core.storageId; ui.capabilities = new Set(['companion-state']); ui.note = text => notes.push(text);
  const state = () => client.request<CompanionRhythmView>('/companion');
  try {
    assert.equal((await state()).status, 'disabled'); assert.equal(calls, 0);
    let choices: Array<string | undefined> = ['companion', 'enabled', 'on']; ui.choose = async () => choices.shift(); ui.prompt = async () => '3';
    await ui.runtimeSettings();
    const configured = await state(); assert.equal(configured.revision, 1); assert.equal(configured.configuration.intervalMinutes, 3); assert.equal(configured.status, 'running');
    assert.equal(writes, 1); assert.match(notes.at(-1)!, /已保存/); assert.equal(calls, 0);
    const snapshot = await client.request<{ companion: CompanionRhythmView }>('/snapshot?contextId=main'); assert.deepEqual(snapshot.companion, configured);
    const latest = configured.configuration;
    choices = ['interval']; ui.prompt = async () => {
      await client.request('/companion', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, configuration: { ...latest, intervalMinutes: 7 } }) });
      return '9';
    };
    await assert.rejects(ui.companionSettings(), /companion_revision_changed/);
    assert.equal((await state()).configuration.intervalMinutes, 7); assert.equal((await state()).revision, 2); assert.equal(notes.length, 1);
    choices = [undefined]; await ui.companionSettings(); assert.equal((await state()).revision, 2);
    choices = ['enabled', 'off']; await ui.companionSettings(); assert.equal((await state()).status, 'disabled'); assert.equal((await state()).revision, 3);
    assert.equal(calls, 0);
  } finally {
    await app.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
  }
});
