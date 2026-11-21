import assert from 'node:assert/strict';
import test from 'node:test';
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
import { AppError, type SignalRecord } from '../src/domain.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, until } from './helpers.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;

test('legacy client withdrawal survives a lost HTTP receipt and a fresh client, restores complete inputs once, and retains host material after editing', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-queue-restore-')), prompts: string[] = [];
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    prompts.push(JSON.stringify(request.prompt)); if (++calls === 1) await gate;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'done' }); controller.enqueue({ type: 'text-end', id: 'reply' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const skill = path.join(directory, 'workspace', 'skills', 'restore-fixture'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: restore-fixture\ndescription: Synthetic restore action.\ndisable-model-invocation: true\n---\nSYNTHETIC_RESTORED_SKILL');
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client(address, core.controlToken), request = client.request.bind(client);
  let loseReceipt = true;
  client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => {
    const result = await request<T>(route, init);
    if (loseReceipt && route.endsWith('/message-queue/withdraw')) { loseReceipt = false; throw new AppError('connection_failed', 502); }
    return result;
  };
  const firstApp = new TerminalApp(client, 'main', terminal); let secondApp: TerminalApp | undefined;
  async function configure(app: TerminalApp, runId: string) {
    const ui = app as any; ui.capabilities = new Set((await client.handshake()).capabilities.filter(capability=>capability!=='message-queue-editor')); Object.assign(ui, { storageId: core.storageId, instanceId: core.instanceId, contextRole: 'main', contextReady: true, isMainContext: true, currentRunId: runId });
    ui.choose = async (title: string) => title.includes('确认发送') ? 'yes' : 'queue'; return ui;
  }
  try {
    const active = await core.submitMessage({ content: 'hold this run' }); await until(() => calls, value => value === 1);
    const first = await configure(firstApp, active.runId!);
    const a = await core.assets.put(new Response('SYNTHETIC_RESTORED_ATTACHMENT_A').body, 'a.txt'), b = await core.assets.put(new Response('SYNTHETIC_RESTORED_ATTACHMENT_B').body, 'b.txt'), c = await core.assets.put(new Response('SYNTHETIC_CURRENT_ATTACHMENT').body, 'c.txt');
    first.pendingAttachments.set('main', [a]); first.sharedShell.set('main', ['SYNTHETIC_RESTORED_SHELL_A']);
    const original = '  original first wording  '; await first.submit(original);
    first.pendingAttachments.set('main', [b]); first.sharedShell.set('main', ['SYNTHETIC_RESTORED_SHELL_B']);
    const command = '/skill:restore-fixture   second wording'; await first.command(command);
    const queued = core.queuedMessages('main'); assert.deepEqual(queued.map(row => row.content), [original, command]);
    first.editor.setText('keep this current draft'); first.pendingAttachments.set('main', [c]);
    await first.restoreQueue();
    assert.equal(core.queuedMessages('main').length, 0); for (const row of queued) assert.equal(core.store.getSignal(row.id)?.status, 'cancelled');
    assert.equal(first.editor.getText(), 'keep this current draft'); assert.deepEqual(first.pendingAttachments.get('main'), [c]);
    await firstApp.stop();
    const nextClient = new Client(address, core.controlToken); secondApp = new TerminalApp(nextClient, 'main', terminal);
    const second = await configure(secondApp, active.runId!); second.editor.setText('fresh current draft'); second.pendingAttachments.set('main', [c]);
    await second.restoreQueue(); const expected = `${original}\n\n${command}\n\nfresh current draft`;
    assert.equal(second.editor.getText(), expected); assert.deepEqual(second.pendingAttachments.get('main').map((item: any) => item.id), [a.id, b.id, c.id]);
    await second.restoreQueue(); assert.equal(second.editor.getText(), expected); assert.equal(calls, 1);
    const edited = `${expected}\nuser edit`; second.editor.setText(edited); await second.submit(edited);
    const replacement = core.queuedMessages('main')[0]!; assert.equal(replacement.content, edited); assert.deepEqual(replacement.attachments, [a.id, b.id, c.id]);
    assert.deepEqual(await nextClient.request(`/contexts/main/message-queue/withdrawals`), { operations: [] });
    release(); await until(() => core.store.getSignal(replacement.id)?.status, status => status === 'accepted');
    assert.equal((await finished(core, core.store.getSignal(replacement.id)!.runId!))!.status, 'succeeded');
    for (const marker of ['SYNTHETIC_RESTORED_SHELL_A', 'SYNTHETIC_RESTORED_SHELL_B', 'SYNTHETIC_RESTORED_SKILL', 'SYNTHETIC_RESTORED_ATTACHMENT_A', 'SYNTHETIC_RESTORED_ATTACHMENT_B', 'SYNTHETIC_CURRENT_ATTACHMENT']) assert.ok(prompts.at(-1)!.includes(marker), marker);
    assert.equal(core.store.getSignal(queued[0]!.id)?.status, 'cancelled'); assert.equal(core.store.getSignal(queued[1]!.id)?.status, 'cancelled'); assert.equal(calls, 2, 'only the active run and the restored replacement may reach the model');
  } finally {
    release(); await firstApp.stop(); await secondApp?.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
  }
});
