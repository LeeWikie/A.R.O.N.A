import test from 'node:test';
import assert from 'node:assert/strict';
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
import type { PublicEvent } from '../src/protocol.js';
import { removeTemp, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
type Card = { data: { nativeMessageId?: string; state: string; args?: { path?: string } } };
type UI = { event(event: PublicEvent): void; generation: number; loadContext(generation: number): Promise<void>; toolCards: Map<string, Card> };

test('real native occurrences with the same provider ID remain separate in live SSE and snapshot cards', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-tool-occurrences-'));
  let calls = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const worker = request.tools?.some(tool => tool.name === 'task_report'), turn = worker ? ++calls : 0;
    if (turn === 1) await ready;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (turn === 1 || turn === 2) controller.enqueue({ type: 'tool-call', toolCallId: 'same-provider-id', toolName: 'mastra_workspace_read_file', input: JSON.stringify({ path: turn === 1 ? 'missing.txt' : 'available.txt' }) });
      controller.enqueue({ type: 'finish', finishReason: turn === 1 || turn === 2 ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), controller = new AbortController();
  let app: TerminalApp | undefined, reading: Promise<void> | undefined;
  try {
    fs.writeFileSync(path.join(directory, 'workspace', 'available.txt'), 'SECOND_REAL_RESULT');
    const task = await core.submitTask({ title: 'Read both originals', content: 'Read missing.txt then available.txt.' }, 'tui-read-both-originals');
    app = new TerminalApp(client, task.contextId, new FakeTerminal()); const ui = app as unknown as UI;
    reading = (async () => { try { for await (const frame of client.events({ contextId: task.contextId, signal: controller.signal })) if (frame.type === 'event' && frame.event.kind === 'tool') ui.event(frame.event); } catch (error) { if (!controller.signal.aborted) throw error; } })();
    release();
    await until(() => core.runtime.task(task.id), task => ['unreported', 'failed'].includes(task.status));
    await until(() => [...ui.toolCards.values()].map(card => card.data), cards => cards.length === 2 && cards[0]!.state === 'failed' && cards[1]!.state === 'finished');
    const live = [...ui.toolCards.values()].map(card => card.data);
    assert.deepEqual(live.map(card => card.args?.path), ['missing.txt', 'available.txt']); assert.notEqual(live[0]!.nativeMessageId, live[1]!.nativeMessageId); assert.equal(calls, 3);
    controller.abort(); await reading;
    await ui.loadContext(ui.generation); const restored = [...ui.toolCards.values()].map(card => card.data);
    assert.deepEqual(restored.map(card => ({ state: card.state, path: card.args?.path })), [{ state: 'failed', path: 'missing.txt' }, { state: 'finished', path: 'available.txt' }]);
    assert.equal(calls, 3, 'snapshot restoration does not invoke the model');
  } finally {
    release(); controller.abort(); await reading; await app?.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
  }
});
