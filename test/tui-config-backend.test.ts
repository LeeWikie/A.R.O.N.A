import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { AppError } from '../src/domain.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp } from './helpers.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('configuration forms round-trip through real Core schemas', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-config-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const http = createApp(core);
  const client = { async request(route: string, init?: RequestInit) {
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${core.controlToken}`);
    const response = await http.request(route, { ...init, headers }); const body = await response.json() as { error?: string };
    if (!response.ok) throw new AppError(body.error ?? 'request_failed', response.status); return body;
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { choose: () => Promise<string | undefined>; prompt: () => Promise<string | undefined>; promptLong: () => Promise<string | undefined>; editModel: () => Promise<void>; editMcp: (id: string) => Promise<void>; runtimeSettings: () => Promise<void>; webSettings: () => Promise<void>; schedules: () => Promise<void>; mcp: () => Promise<void>; methods: () => Promise<void>; workflows: () => Promise<void>; memory: () => Promise<void> };
  let choices: string[] = [], prompts: string[] = [];
  target.choose = async () => choices.shift(); target.prompt = async () => prompts.shift(); target.promptLong = async () => prompts.shift();
  try {
    core.configure('model', { id: 'fixture', name: 'Fixture', protocol: 'responses', baseURL: 'https://example.invalid/v1', modelId: 'fixture', apiKeyEnv: 'FIXTURE_KEY', authHeader: 'bearer', thinking: { low: { reasoningEffort: 'low' } } });
    await core.configure('mcp', { id: 'fixture', enabled: true, url: 'https://example.invalid/mcp', headersEnv: { Authorization: 'OLD_KEY' } });
    const schedule = core.schedules.create({ name: 'Fixture duty', task: 'Synthetic task', timing: { kind: 'once', at: '2099-01-01T00:00:00Z' }, contextId: 'main', output: { kind: 'message' } });
    choices = ['thinking', 'high', 'set', 'high']; await target.editModel();
    const profile = core.models.profile('fixture'); assert.ok(profile && 'thinking' in profile); assert.deepEqual(profile.thinking, { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } });
    const model = core.providerRegistry.getModels().find(item => getSupportedThinkingLevels(item).includes('high')); assert.ok(model);
    core.configure('model', { id: 'provider-fixture', name: 'Provider fixture', providerId: model.provider, modelId: model.id });
    choices = ['provider-fixture', 'defaultThinkingLevel', 'high']; await target.editModel();
    const providerProfile = core.models.profile('provider-fixture'); assert.ok(providerProfile && 'providerId' in providerProfile); assert.equal(providerProfile.defaultThinkingLevel, 'high');
    choices = ['provider-fixture', 'defaultThinkingLevel', 'unset']; await target.editModel();
    const clearedProfile = core.models.profile('provider-fixture'); assert.ok(clearedProfile && 'providerId' in clearedProfile); assert.equal(clearedProfile.defaultThinkingLevel, undefined);
    choices = ['headersEnv', 'item:Authorization', 'edit', 'done', 'yes']; prompts = ['NEW_KEY']; await target.editMcp('fixture');
    assert.equal(core.capabilities.mcpConfigs().find(row => row.id === 'fixture')?.headersEnv.Authorization, 'NEW_KEY');
    choices = ['__add__', 'stdio', 'add', 'done', 'add', 'done', 'default', 'yes']; prompts = ['process-fixture', 'fixture-program', '--flag', 'TOKEN', 'PROCESS_KEY']; await target.mcp();
    const processConfig = core.capabilities.mcpConfigs().find(row => row.id === 'process-fixture');
    assert.deepEqual(processConfig?.args, ['--flag']); assert.deepEqual(processConfig?.env, { TOKEN: 'PROCESS_KEY' });
    choices = ['maxSteps']; prompts = ['128']; await target.runtimeSettings(); assert.equal((core.configure('runtime', {}) as { maxSteps: number }).maxSteps, 128);
    choices = ['brave', 'yes']; prompts = ['WEB_KEY']; await target.webSettings(); assert.deepEqual(core.runtime.setting('web', {}), { type: 'brave', apiKeyEnv: 'WEB_KEY' });
    choices = ['searxng', 'yes']; prompts = ['https://example.invalid/search']; await target.webSettings(); assert.deepEqual(core.runtime.setting('web', {}), { type: 'searxng', baseURL: 'https://example.invalid/search' });
    choices = ['none', 'yes']; await target.webSettings(); assert.deepEqual(core.runtime.setting('web', {}), { type: 'none' });
    choices = [schedule.id, 'edit', 'timing', 'cron']; prompts = ['0 9 * * 1']; await target.schedules();
    assert.deepEqual(core.schedules.get(schedule.id).timing, { kind: 'cron', expression: '0 9 * * 1' });
    const evidence = core.runtime.createTask({ title: 'Verified', content: 'Fixture work', contextId: 'main', returnContextId: 'main', sourceSignalIds: [], status: 'succeeded', report: { outcome: 'succeeded', summary: 'Done', checks: [{ description: 'Verified', passed: true }], deliveries: [], unresolved: [] } });
    choices = ['__add__', 'done', `task:${evidence.id}`, 'done', 'yes']; prompts = ['fixture-method', 'When applicable', 'First line\nSecond line']; await target.methods();
    assert.equal(core.methods.get('fixture-method').instructions, 'First line\nSecond line');
    choices = ['fixture-method', 'edit', 'instructions']; prompts = ['Updated\nInstructions']; await target.methods();
    assert.equal(core.methods.get('fixture-method').revision, 2); assert.equal(core.methods.get('fixture-method').instructions, 'Updated\nInstructions');
    const work = core.createWorkContext({ name: 'Workflow fixture' });
    fs.writeFileSync(path.join(core.capabilities.root(work.workspaceId).path, 'fixture.txt'), 'synthetic file');
    choices = ['done', 'yes']; prompts = ['fixture.txt']; await target.workflows();
    choices = ['resident']; await target.memory();
  } finally { await app.stop(); await core.close(); await removeTemp(directory); }
});
