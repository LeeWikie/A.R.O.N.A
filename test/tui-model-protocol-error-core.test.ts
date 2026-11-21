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
import { createApp } from '../src/http.js';
import type { PublicEvent } from '../src/protocol.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
type UI = { generation: number; event(event: PublicEvent): void; loadContext(generation: number): Promise<void>; transcript: { children: Array<{ text?: string }> } };
test('native protocol errors remain non-retryable and actionable through real Core SSE and restored TUI history', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-protocol-error-ui-')); let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { calls++; throw Object.assign(new Error('PRIVATE_TOOL_ID_ARGUMENTS_AND_URL'), { name: 'ToolCallIdentityError', code: 'tool_call_identity_ambiguous' }); } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false }), server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), app = new TerminalApp(client, 'main', new FakeTerminal()), ui = app as unknown as UI, controller = new AbortController();
  const shown = () => ui.transcript.children.map(child => child.text ?? '').join('\n'); let reading: Promise<void> | undefined;
  try {
    reading = (async () => { try { for await (const frame of client.events({ contextId: 'main', signal: controller.signal })) if (frame.type === 'event' && ['run', 'error'].includes(frame.event.kind)) ui.event(frame.event); } catch (error) { if (!controller.signal.aborted) throw error; } })();
    const signal = await core.submitMessage({ content: 'Handle an invalid model response safely.' }), run = await finished(core, signal.runId!); assert.equal(run?.status, 'failed'); assert.equal(run.errorCode, 'model_protocol_error'); assert.equal(calls, 1);
    await until(shown, text => text.includes('无法安全处理')); assert.match(shown(), /\/model.*接口设置/); assert.equal((shown().match(/运行失败：/g) ?? []).length, 1); assert.doesNotMatch(shown(), /PRIVATE_TOOL_ID|tool_call_identity|暂时性错误，可以直接重发/);
    controller.abort(); await reading; await ui.loadContext(ui.generation);
    assert.match(shown(), /无法安全处理[\s\S]*\/model.*接口设置/); assert.doesNotMatch(shown(), /PRIVATE_TOOL_ID|tool_call_identity|暂时性错误，可以直接重发/); assert.equal(calls, 1);
  } finally { controller.abort(); await reading; await app.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
});
