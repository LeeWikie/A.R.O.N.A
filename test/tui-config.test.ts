import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('configuration forms preserve existing fields and edit typed values', async () => {
  const profile = { id: 'model', name: 'Model', protocol: 'responses', baseURL: 'https://example.invalid', modelId: 'model-id', apiKeyEnv: 'MODEL_KEY', authHeader: 'bearer', thinking: { low: { reasoningEffort: 'low' } } };
  const providerProfile = { id: 'provider-model', name: 'Provider model', providerId: 'provider', modelId: 'model-id', defaultThinkingLevel: 'low' };
  const mcp = { id: 'server', enabled: true, url: 'https://example.invalid/mcp', args: [], headersEnv: { Authorization: 'OLD_KEY' }, env: {}, protocolVersion: 'legacy' };
  const calls: Array<{ route: string; body: unknown }> = [];
  const client = { async request(route: string, init?: RequestInit) {
    if (init?.body) calls.push({ route, body: JSON.parse(String(init.body)) as unknown });
    if (route === '/configuration') return { modelProfiles: [profile, providerProfile], mcpConfigurations: [mcp], runtime: { memoryEnabled: true, maxSteps: 64, defaultWorkModel: 'model', memoryModel: 'same' }, models: [{ id: 'model', name: 'Model' }] };
    if (route === '/provider-models?provider=provider') return { models: [{ modelId: 'model-id', thinkingLevels: ['minimal', 'low', 'high'] }] };
    if (route === '/schedules') return { schedules: [{ id: 'duty', name: 'Duty', status: 'active', revision: 7, task: 'Work', timing: { kind: 'once', at: '2028-01-01T00:00:00Z' }, timezone: 'UTC', contextId: 'main', output: { kind: 'message', contextId: 'main' } }] };
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { choose: (title: string, items: Array<{ value: string }>) => Promise<string | undefined>; prompt: () => Promise<string | undefined>; editModel: () => Promise<void>; editMcp: (id: string) => Promise<void>; runtimeSettings: () => Promise<void>; schedules: () => Promise<void> };
  let choices: string[] = [], prompts: string[] = []; const menus: Array<{ title: string; values: string[] }> = [];
  target.choose = async (title, items) => { menus.push({ title, values: items.map(item => item.value) }); return choices.shift(); }; target.prompt = async () => prompts.shift();
  try {
    choices = ['model', 'thinking', 'high', 'set', 'high']; await target.editModel();
    assert.deepEqual(calls.find(x => x.route === '/configuration/model')?.body, { ...profile, thinking: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } } });
    choices = ['provider-model', 'defaultThinkingLevel', 'high']; await target.editModel();
    assert.deepEqual(calls.filter(x => x.route === '/configuration/model').at(-1)?.body, { ...providerProfile, defaultThinkingLevel: 'high' });
    assert.deepEqual(menus.filter(menu => menu.title.startsWith('默认思考模式')).at(-1)?.values, ['unset', 'low', 'high']);
    choices = ['provider-model', 'defaultThinkingLevel', 'unset']; await target.editModel();
    const { defaultThinkingLevel: _, ...withoutDefault } = providerProfile;
    assert.deepEqual(calls.filter(x => x.route === '/configuration/model').at(-1)?.body, withoutDefault);
    choices = ['headersEnv', 'item:Authorization', 'edit', 'done', 'yes']; prompts = ['NEW_KEY']; await target.editMcp('server');
    assert.deepEqual(calls.find(x => x.route === '/configuration/mcp')?.body, { ...mcp, headersEnv: { Authorization: 'NEW_KEY' } });
    choices = ['maxSteps']; prompts = ['128']; await target.runtimeSettings();
    assert.deepEqual(calls.find(x => x.route === '/configuration/runtime')?.body, { maxSteps: 128 });
    choices = ['duty', 'edit', 'timing', 'cron']; prompts = ['0 9 * * 1']; await target.schedules();
    assert.deepEqual(calls.find(x => x.route === '/schedules/duty')?.body, { revision: 7, timing: { kind: 'cron', expression: '0 9 * * 1' } });
  } finally { await app.stop(); }
});
