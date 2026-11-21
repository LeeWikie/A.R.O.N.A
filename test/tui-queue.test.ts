import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; input: (s: string) => void = () => {}; output = '';
  start(input: (s: string) => void) { this.input = input; } stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('legacy Core UI queues, replaces, withdraws, and targets the observed run for steer', { timeout: 35_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-queue-'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { if (++calls === 1) await gate; return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Fixture response' }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); } }) }; } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const handshake=client.handshake.bind(client);client.handshake=async(...args:Parameters<Client['handshake']>)=>{const result=await handshake(...args);return {...result,capabilities:result.capabilities.filter(capability=>capability!=='message-queue-editor')};};
  const terminal = new FakeTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { currentRunId?: string; queueCount: number; choose: () => Promise<string | undefined>; promptLong: () => Promise<string | undefined>; submit: (text: string) => Promise<void>; messageQueue: () => Promise<void> };
  let choices: string[] = []; target.choose = async () => choices.shift(); target.promptLong = async () => 'edited queue message';
  try {
    const running = app.run(); await until(() => terminal.output, text => text.includes('已连接'));
    await target.submit('first'); await until(() => target.currentRunId, id => !!id); const runId = target.currentRunId!;
    choices = ['queue']; await target.submit('original queue message');
    const original = core.queuedMessages('main')[0]!; assert.equal(original.content, 'original queue message'); await until(() => target.queueCount, count => count === 1);
    choices = [original.id, 'edit', 'yes']; await target.messageQueue();
    const replacement = core.queuedMessages('main')[0]!; assert.equal(replacement.content, 'edited queue message'); assert.equal(core.store.getSignal(original.id)?.status, 'cancelled');
    choices = [replacement.id, 'cancel', 'yes']; await target.messageQueue(); assert.equal(core.queuedMessages('main').length, 0); await until(() => target.queueCount, count => count === 0);
    choices = ['queue']; await target.submit('runs next');
    const next = core.queuedMessages('main')[0]!;
    const rows = (app as unknown as { userRows: Map<string, { status: string }> }).userRows;
    await until(() => rows.get(next.id)?.status, status => status === 'queued');
    choices = ['steer']; await target.submit('current run supplement');
    const signal = core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.content')='current run supplement'").get();
    const delivered = core.store.getSignal(String(signal?.id)); assert.equal(delivered?.action, 'deliver'); assert.equal(delivered?.runId, runId);
    release();
    await until(() => core.store.getSignal(next.id)?.status, status => status === 'accepted');
    await until(() => rows.get(next.id)?.status, status => status === 'accepted');
    await app.stop(); await running;
  } finally {
    release(); await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test('legacy Core Alt+Enter queues without a prompt, preview shows it, Alt+Up withdraws back into the editor', { timeout: 35_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-followup-'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { if (++calls === 1) await gate; return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Fixture response' }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); } }) }; } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const handshake=client.handshake.bind(client);client.handshake=async(...args:Parameters<Client['handshake']>)=>{const result=await handshake(...args);return {...result,capabilities:result.capabilities.filter(capability=>capability!=='message-queue-editor')};};
  const terminal = new FakeTerminal(); const app = new TerminalApp(client, 'main', terminal);
  const target = app as unknown as { currentRunId?: string; queueCount: number; choose: (title: string) => Promise<string | undefined>; submit: (text: string) => Promise<void>;
    editor: { getText(): string; setText(text: string): void }; queuePreview: { children: Array<{ text?: string }> }; transcript: { children: Array<{ text?: string }> } };
  const prompts: string[] = []; target.choose = async title => { prompts.push(title); return undefined; };
  const preview = () => target.queuePreview.children.map(child => child.text ?? '').join('\n');
  const send = (text: string) => { for (const char of text) terminal.input(char); };
  try {
    const running = app.run(); await until(() => terminal.output, text => text.includes('已连接'));
    await target.submit('first'); await until(() => target.currentRunId, id => !!id);
    send('first follow-up'); terminal.input('\x1b\r');
    await until(() => core.queuedMessages('main').length, count => count === 1);
    send('second follow-up'); terminal.input('\x1b\r');
    await until(() => core.queuedMessages('main').length, count => count === 2);
    assert.deepEqual(prompts, [], 'Alt+Enter never opens the busy-mode chooser');
    assert.deepEqual(core.queuedMessages('main').map(row => row.content), ['first follow-up', 'second follow-up']);
    await until(() => preview(), text => text.includes('排队：second follow-up'));
    const states = () => [...(app as unknown as { userRows: Map<string, { status: string }> }).userRows.values()].map(row => row.status);
    assert.equal(states().filter(status => status === 'queued').length, 2, 'queued rows are labelled in the transcript');
    assert.match(preview(), /Alt\+↑/);

    target.editor.setText('draft in progress');
    terminal.input('\x1b[1;3A');
    await until(() => core.queuedMessages('main').length, count => count === 0);
    await until(() => target.editor.getText(), text => text === 'first follow-up\n\nsecond follow-up\n\ndraft in progress');
    assert.equal(target.editor.getText(), 'first follow-up\n\nsecond follow-up\n\ndraft in progress');
    await until(() => preview(), text => text === '');
    for (const row of core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.content') LIKE '%follow-up'").all()) assert.equal(core.store.getSignal(String(row.id))?.status, 'cancelled');
    const rows = (app as unknown as { userRows: Map<string, { status: string }> }).userRows;
    await until(() => [...rows.values()].filter(row => row.status === 'cancelled').length, count => count === 2);

    target.editor.setText('');
    terminal.input('\x1b[1;3A');
    await until(() => target.transcript.children.map(child => child.text ?? '').join('\n'), text => text.includes('没有可恢复的队列消息'));
    release(); await until(() => target.currentRunId, id => !id);
    send('idle follow-up'); terminal.input('\x1b\r');
    await until(() => core.store.db.prepare("SELECT status FROM signals WHERE json_extract(body,'$.content')='idle follow-up'").get(), row => row?.status === 'accepted');
    assert.equal(core.queuedMessages('main').length, 0, 'Alt+Enter while idle sends normally');
    await app.stop(); await running;
  } finally {
    release(); await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
