import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import type { SignalRecord } from '../src/domain.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, until } from './helpers.js';

class ErrorTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input = (_data: string) => {};
  start(onInput: (data: string) => void) { this.input = onInput; } stop() {} async drainInput() {} write(text: string) { this.output += text; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

for (const fixture of [{ status: 401, code: 'model_authentication_failed', title: '模型登录失效', hint: '/login' }, { status: 429, code: 'model_rate_limited', title: '模型请求受到限流', hint: '稍后重试' }]) test(`actual provider HTTP ${fixture.status} is classified through native Core, SSE and terminal without generic-first masking`, { timeout: 30000 }, async () => {
  const priorIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), priorOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  let providerCalls = 0;
  const provider = createServer((request, response) => { providerCalls++; request.resume(); response.writeHead(fixture.status, { 'content-type': 'application/json', 'retry-after': '0' }); response.end(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_BODY_DO_NOT_DISPLAY', type: fixture.status === 401 ? 'authentication_error' : 'rate_limit_error', code: fixture.status === 401 ? 'invalid_api_key' : 'rate_limit_exceeded' } })); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-provider-errors-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false, modelConfig: { protocol: 'chat-completions', baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, modelId: 'synthetic-model', apiKey: 'synthetic-credential-only', authHeader: 'bearer' } });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), observed: { receipt?: SignalRecord } = {};
  const original = client.request.bind(client); client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => { const result = await original<T>(route, init); if (route === '/messages') observed.receipt = result as SignalRecord; return result; };
  const terminal = new ErrorTerminal(), app = new TerminalApp(client, 'main', terminal);
  const ui = app as unknown as { contextReady: boolean; editor: { setText(text: string): void; handleInput(text: string): void }; transcript: { children: Array<{ text?: string }> } };
  const shown = () => ui.transcript.children.map(child => child.text ?? '').join('\n');
  const running = app.run();
  let reopened: TerminalApp | undefined, reopenedRun: Promise<void> | undefined;
  try {
    await until(() => ui.contextReady, Boolean); ui.editor.setText('Synthetic provider failure check'); ui.editor.handleInput('\r');
    await until(() => observed.receipt, value => Boolean(value?.runId)); assert.ok(observed.receipt?.runId);
    const ended = await finished(core, observed.receipt.runId); assert.equal(ended?.status, 'failed'); assert.equal(ended.errorCode, fixture.code);
    await until(shown, text => text.includes(fixture.title)); assert.ok(shown().includes(fixture.hint));
    assert.equal((shown().match(/运行失败：/g) ?? []).length, 1); assert.doesNotMatch(shown(), /PRIVATE_PROVIDER_BODY|synthetic-credential-only|运行失败：模型请求未完成/);
    const page = await client.request<{ events: Array<{ kind: string; data: unknown }> }>('/event-page?after=0&contextId=main');
    assert.ok(page.events.some(event => event.kind === 'error' && (event.data as { code?: string }).code === fixture.code));
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_PROVIDER_BODY|synthetic-credential-only/);
    const beforeReopen = providerCalls; await app.stop(); await running;
    reopened = new TerminalApp(client, 'main', new ErrorTerminal()); reopenedRun = reopened.run();
    const fresh = reopened as unknown as { contextReady: boolean; transcript: { children: Array<{ text?: string }> } };
    await until(() => fresh.contextReady, Boolean); const restored = fresh.transcript.children.map(child => child.text ?? '').join('\n');
    assert.ok(restored.includes(fixture.title)); assert.ok(restored.includes(fixture.hint)); assert.equal((restored.match(/运行失败：/g) ?? []).length, 1); assert.equal(providerCalls, beforeReopen, 'viewing a failed run never replays its model request');
  } finally {
    await app.stop(); await running; if (reopened) await reopened.stop(); if (reopenedRun) await reopenedRun; if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await removeTemp(directory);
    if (priorIn) Object.defineProperty(process.stdin, 'isTTY', priorIn); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (priorOut) Object.defineProperty(process.stdout, 'isTTY', priorOut); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
