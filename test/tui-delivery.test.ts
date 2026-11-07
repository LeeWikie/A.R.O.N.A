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
import { removeTemp } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('UI saves verified task delivery locally without overwrite or accepting changed bytes', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-delivery-')); const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { choose: () => Promise<string | undefined>; prompt: () => Promise<string | undefined>; taskDeliveries: (id: string) => Promise<void> };
  let choices: string[] = [], prompts: string[] = []; target.choose = async () => choices.shift(); target.prompt = async () => prompts.shift();
  try {
    const work = core.createWorkContext({ name: 'Fixture' }); const root = core.capabilities.root(work.workspaceId).path;
    const content = Buffer.from('verified synthetic delivery\n'); const source = path.join(root, 'result.txt'); fs.writeFileSync(source, content);
    let task = core.runtime.createTask({ title: 'Fixture', content: 'Work', contextId: work.id, returnContextId: 'main', sourceSignalIds: [], status: 'succeeded' });
    const report = await core.verifyReport(task, { outcome: 'succeeded', summary: 'Done', checks: [{ description: 'Verified', passed: true }], deliveries: [{ kind: 'file', title: 'Result', value: 'result.txt' }], unresolved: [] });
    task = core.runtime.updateTask(task.id, { report }); const destination = path.join(directory, 'download.txt');
    choices = ['0', 'yes']; prompts = [destination]; await target.taskDeliveries(task.id); assert.deepEqual(fs.readFileSync(destination), content);
    choices = ['0', 'yes']; prompts = [destination]; await assert.rejects(target.taskDeliveries(task.id), /EEXIST/); assert.deepEqual(fs.readFileSync(destination), content);
    fs.writeFileSync(source, Buffer.alloc(content.length, 0)); const altered = path.join(directory, 'changed.txt');
    choices = ['0', 'yes']; prompts = [altered]; await assert.rejects(target.taskDeliveries(task.id), /delivery_changed/); assert.equal(fs.existsSync(altered), false);
  } finally { await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
});
