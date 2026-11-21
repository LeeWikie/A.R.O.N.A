import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { Editor, Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, until } from './helpers.js';
import type { ModelState } from '../src/models.js';

class TestTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = '';
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void) { this.input = onInput; }
  stop() {} async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  type(text: string) { for (const char of text) this.input(char); }
}

type UI = { editor: Editor; model?: ModelState; command(text: string): Promise<void>; cycleThinking(): Promise<void>; refreshModel(): Promise<void>; editModel(): Promise<void>;
  switchContext(id: string): void; choose(title: string, items: Array<{ value: string; label: string; description?: string }>): Promise<string | undefined> };
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

test('terminal thinking selection, completion, repeated cycling and model changes use real Core state and provider effort', { timeout: 30_000 }, async () => {
  const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-thinking-ui-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const provider = fauxProvider({ provider: 'thinking-ui', models: [{ id: 'reasoner', reasoning: true, contextWindow: 64000, maxTokens: 2000 }, { id: 'plain', reasoning: false, contextWindow: 64000, maxTokens: 2000 }] });
  provider.getModel('reasoner')!.thinkingLevelMap = { max: 'max', xhigh: null };
  const efforts: Array<string | undefined> = [];
  provider.setResponses([(context, options) => { efforts.push(options?.reasoning); return fauxAssistantMessage('synthetic answer'); }]);
  core.providerRegistry.setProvider(provider.provider);
  core.models.save({ id: 'reasoner.profile', name: 'Synthetic Reasoner', providerId: 'thinking-ui', modelId: 'reasoner', defaultThinkingLevel: 'max' });
  core.models.save({ id: 'plain.profile', name: 'Synthetic Plain', providerId: 'thinking-ui', modelId: 'plain' });
  await core.switchModel('main', 'reasoner.profile');
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const terminal = new TestTerminal(), app = new TerminalApp(client, 'main', terminal), ui = app as unknown as UI;
  const running = app.run();
  try {
    await until(() => ui.model?.thinkingLevel, value => value === 'max');
    for (const command of ['think', 'thinking']) {
      ui.editor.setText(''); terminal.type(`/${command} mi`); await settle();
      assert.equal(ui.editor.isShowingAutocomplete(), true, `${command} has live argument completion`);
      terminal.input('\t'); assert.equal(ui.editor.getText(), `/${command} minimal`);
    }
    ui.editor.setText(''); terminal.type('/model reasoner.'); await settle(); terminal.input('\t');
    assert.equal(ui.editor.getText(), '/model reasoner.profile', 'dotted profile IDs are values, not local file paths');
    ui.editor.setText(''); terminal.type('/thinking xh'); await settle();
    assert.equal(ui.editor.isShowingAutocomplete(), false, 'unsupported levels are not offered');

    let offered: Array<{ value: string; label: string; description?: string }> = [];
    const choose = ui.choose;
    ui.choose = (title, items) => { offered = items; return choose.call(app, title, items); };
    ui.editor.setText('');
    const selection = ui.command('/think');
    await until(() => offered.length, count => count > 0); await settle();
    terminal.type('minimal'); terminal.input('\r'); await selection;
    assert.ok(offered.some(item => item.value === 'default'));
    assert.ok(offered.some(item => item.value === 'max' && item.description?.includes('当前生效')));
    assert.ok(!offered.some(item => item.value === 'xhigh'));
    assert.equal((await core.modelState('main')).thinkingLevel, 'minimal');
    assert.equal(ui.model?.thinkingLevel, 'minimal');

    await ui.command('/thinking default'); assert.equal((await core.modelState('main')).thinkingLevel, 'max');
    await Promise.all([ui.cycleThinking(), ui.cycleThinking(), ui.cycleThinking()]);
    assert.equal((await core.modelState('main')).thinkingLevel, 'low', 'each queued key uses the previous committed level');
    await ui.command('/think xhigh');
    assert.equal((await core.modelState('main')).thinkingLevel, 'max');
    assert.equal((await core.modelState('main')).requestedThinkingLevel, 'xhigh', 'explicit preference survives a capability clamp');
    await ui.command('/model plain.profile');
    assert.equal(ui.model?.thinkingLevel, 'off');
    assert.deepEqual(ui.model?.thinkingLevels, ['off']);
    await ui.command('/think high'); assert.equal((await core.modelState('main')).thinkingLevel, 'off');
    await ui.command('/model reasoner.profile'); assert.equal(ui.model?.thinkingLevel, 'max', 'target profile default wins');
    await ui.command('/think minimal');
    const receipt = await client.request<{ runId: string }>('/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextId: 'main', content: 'synthetic request' }) });
    assert.equal((await finished(core, receipt.runId))?.status, 'succeeded');
    assert.deepEqual(efforts, ['minimal']);
    ui.choose = choose;
    const cancelled = ui.command('/think'); await settle(); terminal.input('\x1b'); await cancelled;
    assert.equal((await core.modelState('main')).thinkingLevel, 'minimal', 'cancel does not mutate selection');

    core.models.save({ id: 'legacy', name: 'Legacy proxy', protocol: 'responses', baseURL: 'https://example.invalid/v1', modelId: 'gpt-6-luna', apiKeyEnv: 'SYNTHETIC_NOT_CONFIGURED', thinking: { max: { reasoningEffort: 'max' } }, defaultThinkingLevel: 'max' });
    let choices = ['legacy', 'defaultThinkingLevel', 'high']; let grades: string[] = [];
    ui.choose = async (title, items) => { if (title.startsWith('默认思考模式')) grades = items.map(item => item.value); return choices.shift(); };
    await ui.editModel();
    assert.deepEqual(grades, ['unset', ...core.models.thinking('legacy').thinkingLevels]);
    assert.ok(grades.includes('low') && grades.includes('high'), 'a saved single wire override does not restrict the default-level editor');
    assert.equal(core.models.profile('legacy')?.defaultThinkingLevel, 'high');
    choices = ['legacy', 'thinkingMode', 'manual']; await ui.editModel();
    assert.deepEqual(core.models.thinking('legacy').thinkingLevels, ['max']);
    choices = ['legacy', 'thinkingMode', 'auto']; await ui.editModel();
    assert.ok(core.models.thinking('legacy').thinkingLevels.includes('low'));
    assert.equal(provider.state.callCount, 1, 'configuration and capability discovery never send inference requests');
    ui.choose = choose;
  } finally {
    await app.stop(); await running; (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test('delayed thinking reads cannot change a newly selected context', async () => {
  let release!: (state: ModelState) => void;
  const delayed = new Promise<ModelState>(resolve => { release = resolve; }); const writes: string[] = [];
  const state: ModelState = { contextId: 'main', profileId: 'synthetic', name: 'Synthetic', modelId: 'synthetic', providerId: null, thinkingLevel: 'medium', requestedThinkingLevel: null, defaultThinkingLevel: 'medium', thinkingLevels: ['low', 'medium', 'high'], nextThinkingLevel: 'high', supportsThinking: true, thinkingCapabilitySource: 'profile', source: 'model-default', unavailable: null, configuredProfiles: 1 };
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) { if (init?.method) { writes.push(route); return {}; } return delayed; } } as unknown as Client, 'main', new TestTerminal());
  const ui = app as unknown as UI & { isMainContext: boolean; contextId: string };
  ui.isMainContext = true;
  try {
    const action = ui.cycleThinking(); await Promise.resolve(); ui.contextId = 'other'; release(state);
    await assert.rejects(action, /context_changed/); assert.deepEqual(writes, []);
  } finally { await app.stop(); }
});
