import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Editor, Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, until } from './helpers.js';

class InteractiveTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input = (_data: string) => {};
  start(onInput: (data: string) => void) { this.input = onInput; } stop() {} async drainInput() {} write(text: string) { this.output += text; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('a question from another context reaches the terminal, waits for the current draft, and resumes only its original native run', { timeout: 30000 }, async () => {
  const priorIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), priorOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-interaction-core-'));
  const prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    prompts.push(JSON.stringify(request.prompt)); const answered = request.prompt.some(message => message.role === 'tool');
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (!answered) controller.enqueue({ type: 'tool-call', toolCallId: 'format-choice', toolName: 'ask_user', input: JSON.stringify({ question: 'Choose a synthetic format', options: [{ label: 'Markdown' }, { label: 'Plain text' }] }) });
      else { controller.enqueue({ type: 'text-start', id: 'answer' }); controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Accepted synthetic format' }); controller.enqueue({ type: 'text-end', id: 'answer' }); }
      controller.enqueue({ type: 'finish', finishReason: answered ? 'stop' : 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const terminal = new InteractiveTerminal();
  const app = new TerminalApp(new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), 'main', terminal);
  const ui = app as unknown as { contextReady: boolean; editor: Editor; pendingInteractions: Array<{ id: string }>; pendingModal?: () => void; contextId: string };
  const running = app.run();
  try {
    await until(() => ui.contextReady, Boolean); ui.editor.setText('unfinished draft');
    const other = core.createConversationContext({ name: 'Other synthetic dialogue' });
    const receipt = await core.submitMessage({ contextId: other.id, content: 'Make a synthetic document' });
    const items = await until(() => core.interactions(), rows => rows.some(row => row.status === 'pending'));
    const question = items.find(row => row.status === 'pending')!;
    await until(() => ui.pendingInteractions, rows => rows.some(row => row.id === question.id));
    assert.equal(ui.pendingModal, undefined); assert.equal(ui.editor.getText(), 'unfinished draft'); assert.equal(ui.contextId, 'main');
    terminal.input('\x03'); await until(() => ui.pendingModal, value => Boolean(value));
    await until(() => terminal.output, text => text.includes('Choose a synthetic format')); terminal.input('\r');
    await until(() => core.interactions().find(row => row.id === question.id)?.status, state => state === 'answered');
    assert.equal((await finished(core, receipt.runId!))!.status, 'succeeded'); assert.match(prompts.at(-1)!, /Markdown/);
    assert.equal(ui.contextId, 'main'); assert.doesNotMatch(terminal.output, /Accepted synthetic format/);
  } finally {
    await app.stop(); await running;
    if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (priorIn) Object.defineProperty(process.stdin, 'isTTY', priorIn); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (priorOut) Object.defineProperty(process.stdout, 'isTTY', priorOut); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
