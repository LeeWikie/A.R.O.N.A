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

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('startup model edits preserve secret reference and default without returning the secret', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-seed-')); const secret = 'fixture-startup-secret';
  const core = await Core.open({ dataDir: directory, memoryEnabled: false, modelConfig: { protocol: 'responses', baseURL: 'https://example.invalid/v1', modelId: 'fixture', apiKey: secret, authHeader: 'bearer', reasoningEffort: 'high' } });
  const http = createApp(core); let responseText = '';
  const client = { async request(route: string, init?: RequestInit) { const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${core.controlToken}`); const response = await http.request(route, { ...init, headers }); const text = await response.text(); responseText += text; const body = JSON.parse(text) as { error?: string }; if (!response.ok) throw new AppError(body.error ?? 'request_failed', response.status); return body; } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { choose: () => Promise<string | undefined>; prompt: () => Promise<string | undefined>; editModel: () => Promise<void>; models: () => Promise<void> };
  let choices = ['default', 'name']; target.choose = async () => choices.shift(); target.prompt = async () => 'Changed name';
  try {
    await target.editModel(); const saved = core.models.profile('default'); assert.ok(saved && 'apiKeyEnv' in saved);
    assert.equal(saved.apiKeyEnv, 'SHITTIMCHEST_STARTUP_MODEL_KEY'); assert.equal(saved.defaultThinkingLevel, 'high'); assert.equal(saved.name, 'Changed name');
    assert.equal(responseText.includes(secret), false); assert.doesNotThrow(() => core.models.resolve('default'));
    choices = ['default', 'high']; await target.models();
    assert.equal((core.sessions.peek('main')?.state.get() as { thinkingLevel?: string }).thinkingLevel, 'high');
    choices = ['default', 'reset']; await target.models();
    assert.equal((core.sessions.peek('main')?.state.get() as { thinkingLevel?: string }).thinkingLevel, undefined);
    choices = ['default', 'thinking', 'high', 'remove', 'yes']; await target.editModel();
    const cleared = core.models.profile('default'); assert.ok(cleared && 'apiKeyEnv' in cleared); assert.equal(cleared.defaultThinkingLevel, undefined); assert.equal(cleared.thinking.high, undefined);
  } finally { await app.stop(); await core.close(); await removeTemp(directory); }
});
