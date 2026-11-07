import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Terminal } from '@earendil-works/pi-tui';
import type { ContextRecord } from '../src/runtime-store.js';
import { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { conversationPage } from '../src/event-stream.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = '';
  start() {} stop() {} async drainInput() {} write(data: string) { this.output += data; } moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('UI creates conversation, branches a verified turn, and treats work contexts as read-only', { timeout: 40_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-context-'));
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Fixture response' }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); } }) }) });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new FakeTerminal(), app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { contextId: string; contextRole?: string; choose: () => Promise<string | undefined>; prompt: () => Promise<string | undefined>; createContext: () => Promise<void>; branchContext: (source: ContextRecord) => Promise<void>; switchContext: (id: string) => void; submit: (text: string) => Promise<void>; editor: { getText: () => string } };
  let choices: string[] = [], prompts: string[] = []; target.choose = async () => choices.shift(); target.prompt = async () => prompts.shift();
  try {
    const running = app.run(); await until(() => terminal.output, text => text.includes('已连接'));
    choices = ['default']; prompts = ['New conversation', 'Purpose']; await target.createContext();
    const created = core.runtime.context(target.contextId); assert.equal(created?.role, 'main');
    const first = await core.submitMessage({ content: 'first fixture' }); await finished(core, first.runId!);
    const second = await core.submitMessage({ content: 'second fixture' }); await finished(core, second.runId!);
    choices = [first.runId!, 'full', 'yes']; prompts = ['Branch fixture']; await target.branchContext(core.runtime.context('main')!);
    const branch = core.runtime.context(target.contextId)!; assert.equal(branch.parentContextId, 'main'); assert.equal(branch.parentRunId, first.runId);
    const history = conversationPage(core, branch.id).messages; assert.ok(history.some(message => message.content === 'first fixture' && message.originContextId === 'main')); assert.ok(!history.some(message => message.content === 'second fixture'));
    await until(() => terminal.output, text => text.includes('来自上下文 main'));
    choices = [second.runId!, 'range', second.runId!, 'yes']; prompts = ['Selected range']; await target.branchContext(core.runtime.context('main')!);
    const selected = core.runtime.context(target.contextId)!; assert.equal(selected.workingSet?.fromRunId, second.runId); assert.equal(selected.workingSet?.throughRunId, second.runId);
    const selectedHistory = conversationPage(core, selected.id).messages; assert.ok(selectedHistory.some(message => message.content === 'second fixture')); assert.ok(!selectedHistory.some(message => message.content === 'first fixture'));
    assert.ok(conversationPage(core, 'main').messages.some(message => message.content === 'first fixture'));
    const work = core.createWorkContext({ name: 'Work only' }); target.switchContext(work.id); await until(() => target.contextRole, role => role === 'work');
    const before = core.store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()!.n;
    await target.submit('must stay local'); assert.equal(target.editor.getText(), 'must stay local'); assert.equal(core.store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()!.n, before);
    await app.stop(); await running;
  } finally {
    await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
