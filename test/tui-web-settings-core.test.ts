import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Terminal } from '@earendil-works/pi-tui';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { AppError } from '../src/domain.js';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
type UI = { webSettings(): Promise<void>; choose(title: string, items: Array<{ value: string; label: string; description?: string }>): Promise<string | undefined>; prompt(title: string, initial?: string): Promise<string | undefined>; note(text: string): void };
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-web-settings-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false, model: new MastraLanguageModelV2Mock({ doStream: async () => { throw Error('No model calls while configuring'); } }) }), http = createApp(core);
  const writes: unknown[] = [], notes: string[] = [], visible: string[] = [];
  let choices: string[] = [], prompts: string[] = [], fail = false;
  const client = { async request(route: string, init?: RequestInit) {
    if (route === '/configuration/web' && init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); if (fail) throw new AppError('connection_failed', 502); }
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${core.controlToken}`);
    const response = await http.request(route, { ...init, headers }), body = await response.json() as { error?: string };
    if (!response.ok) throw new AppError(body.error ?? 'request_failed', response.status); return body;
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal()), ui = app as unknown as UI;
  ui.choose = async (title, items) => { visible.push(title, JSON.stringify(items)); const choice = choices.shift(); if (choice !== undefined) assert.ok(items.some(row => row.value === choice), `${choice} unavailable in ${title}`); return choice; };
  ui.prompt = async (title, initial) => { visible.push(title, initial ?? ''); return prompts.shift(); }; ui.note = text => { notes.push(text); visible.push(text); };
  return { core, ui, notes, visible, writes, select(...values: string[]) { choices = values; }, input(...values: string[]) { prompts = values; }, failure(value: boolean) { fail = value; }, async close() { await app.stop(); await core.close(); await removeTemp(directory); } };
}

test('automatic web settings round-trip complete typed options and show actual routes without credential values', async () => {
  const f = await fixture();
  try {
    const secret = 'SYNTHETIC_WEB_VALUE_DO_NOT_SHOW'; f.core.credentials.set('ARONA_WEB_FIXTURE', secret);
    f.select('auto', 'search', 'parallel', 'extract', 'direct', 'both', 'exa', 'providers', 'exa', 'key', 'providers', 'firecrawl', 'endpoint', 'providers', 'exa', 'tier', 'free', 'fallback', 'false', 'rescue', 'false', 'cache', 'false', 'ttl', 'save', 'yes');
    f.input('ARONA_WEB_FIXTURE', 'https://fixture.invalid/api', '45'); await f.ui.webSettings();
    assert.deepEqual(f.core.webConfiguration(), { type: 'auto', searchBackend: 'parallel', extractBackend: 'direct', backend: 'exa', keylessFallback: false, keylessRescue: false, cacheEnabled: false, cacheTtlMinutes: 45, providerTiers: { exa: 'free' }, providers: { exa: { apiKeyEnv: 'ARONA_WEB_FIXTURE' }, firecrawl: { baseURL: 'https://fixture.invalid/api' } } });
    assert.match(f.notes.at(-1)!, /搜索：parallel/); assert.match(f.notes.at(-1)!, /读取：直接读取原网页/); assert.doesNotMatch(f.visible.join('\n'), new RegExp(secret)); assert.doesNotMatch(JSON.stringify(f.writes), new RegExp(secret));
    f.select('none', 'yes'); await f.ui.webSettings(); assert.deepEqual(f.core.webConfiguration(), { type: 'none' });
    const disabled = f.core.webProviders(); assert.ok(disabled.catalog.some(row => row.id === 'exa')); assert.equal('search' in disabled, false); assert.equal('extract' in disabled, false);
    f.select('auto', 'search', 'none', 'extract', 'direct', 'save', 'yes'); await f.ui.webSettings();
    assert.equal(f.core.webConfiguration().type, 'auto'); assert.match(f.notes.at(-1)!, /搜索：已停用/); assert.match(f.notes.at(-1)!, /读取：直接读取原网页/);
  } finally { await f.close(); }
});

test('a failed settings save preserves the complete local draft for retry and explicit cancellation leaves Core unchanged', async () => {
  const f = await fixture();
  try {
    const original = f.core.webConfiguration(); f.failure(true); f.select('auto', 'search', 'none', 'ttl', 'save', 'yes'); f.input('71'); await assert.rejects(f.ui.webSettings(), /connection_failed/);
    assert.deepEqual(f.core.webConfiguration(), original); f.failure(false); f.select('auto', 'save', 'yes'); await f.ui.webSettings(); assert.equal(f.core.webConfiguration().type, 'auto'); assert.deepEqual(f.writes[1], f.writes[0]);
    const saved = f.core.webConfiguration(); f.select('auto', 'extract', 'none', 'cancel'); await f.ui.webSettings(); assert.deepEqual(f.core.webConfiguration(), saved); assert.equal(f.writes.length, 2);
  } finally { await f.close(); }
});
