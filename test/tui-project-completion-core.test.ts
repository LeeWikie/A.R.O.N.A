import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { AutocompleteProvider, Editor, Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import type { AssetInfo } from '../src/assets.js';
import type { PublicEvent } from '../src/protocol.js';
import { removeTemp, until } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
type UI = { editor: Pick<Editor, 'setText' | 'getText'> & { autocompleteProvider: AutocompleteProvider }; capabilities: Set<string>; contextReady: boolean; streamController?: AbortController; generation: number; pendingAttachments: Map<string,AssetInfo[]>; choose(title:string,items:Array<{value:string}>):Promise<string|undefined>; command(text:string):Promise<void>; loadContext(generation: number): Promise<void>; switchContext(contextId: string): Promise<void>; event(event: PublicEvent): void; readLocalAttachment(file: string): Promise<{ bytes: Buffer }> };
async function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-project-completion-')), directory = fs.realpathSync(temporary);
  const local = path.join(directory, 'client'), one = path.join(directory, 'project-one'), two = path.join(directory, 'project-two');
  for (const file of [local, one, two]) fs.mkdirSync(file);
  fs.writeFileSync(path.join(local, 'client-only.txt'), 'CLIENT_LOCAL_BYTES'); fs.writeFileSync(path.join(one, 'first-project.txt'), 'FIRST_PROJECT'); fs.writeFileSync(path.join(two, 'second-project.txt'), 'SECOND_PROJECT');
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { throw new Error('Unexpected model call'); } });
  const core = await Core.open({ dataDir: path.join(directory, 'core'), model, memoryEnabled: false });
  core.capabilities.saveRoot({ id: 'one', name: 'One', path: one }); core.capabilities.saveRoot({ id: 'two', name: 'Two', path: two });
  const first = core.createConversationContext({ name: 'First project', workspaceId: 'one' }), second = core.createConversationContext({ name: 'Second project', workspaceId: 'two' });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const calls: Array<{ route: string; body?: unknown }> = [], original = client.request.bind(client);
  client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => { calls.push({ route, ...(init?.body ? { body: typeof init.body==='string'?JSON.parse(init.body):{binary:true} } : {}) }); return original<T>(route, init); };
  const app = new TerminalApp(client, first.id, new FakeTerminal(), { completionBase: local }), ui = app as unknown as UI;
  async function close() { await app.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(temporary); }
  try { ui.capabilities = new Set((await client.handshake()).capabilities); assert.ok(ui.capabilities.has('project-path-completion')); await ui.loadContext(ui.generation); await until(() => ui.contextReady, Boolean); }
  catch (error) { await close(); throw error; }
  return { directory, local, one, two, core, first, second, server, client, original, calls, app, ui, close };
}
function suggest(ui: UI, line: string, force = false) { return ui.editor.autocompleteProvider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal, force }); }

test('actual TUI project references follow Core contexts while shell, attachments and transfer files follow the client directory', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    f.ui.editor.setText('keep first draft');
    const first = await suggest(f.ui, '@first-project'); assert.ok(first?.items.some(row => row.value.includes('first-project.txt'))); assert.equal(await suggest(f.ui, '@client-only'), null);
    for (const line of ['!cat ./client', '/attach ./client', '/import ./client', '/export --backup ./client']) {
      const start = f.calls.length, local = await suggest(f.ui, line, true); assert.ok(local?.items.some(row => row.value === './client-only.txt'), line); assert.equal(f.calls.slice(start).some(row => row.route.includes('/path-completions')), false, line);
    }
    assert.equal((await f.ui.readLocalAttachment('client-only.txt')).bytes.toString(), 'CLIENT_LOCAL_BYTES');
    fs.writeFileSync(path.join(f.local,'中文 文件.txt'),'EXACT_LOCAL_UNICODE_ATTACHMENT');const choose=f.ui.choose.bind(f.ui);f.ui.choose=async(_title,items)=>items.some(item=>item.value==='yes')?'yes':undefined;
    try{await f.ui.command('/attach "./中文 文件.txt"');}finally{f.ui.choose=choose;}
    const attachment=f.ui.pendingAttachments.get(f.first.id)![0]!;assert.equal(attachment.name,'中文 文件.txt');assert.equal((await f.core.assets.read(attachment.id)).bytes.toString(),'EXACT_LOCAL_UNICODE_ATTACHMENT');assert.equal(f.ui.editor.getText(),'keep first draft');
    await f.ui.switchContext(f.second.id); await until(() => f.ui.contextReady, Boolean); f.ui.editor.setText('keep second draft');
    assert.ok((await suggest(f.ui, '@second-project'))?.items.some(row => row.value.includes('second-project.txt'))); assert.equal(await suggest(f.ui, '@first-project'), null);
    await f.ui.switchContext(f.first.id); await until(() => f.ui.contextReady, Boolean); assert.equal(f.ui.editor.getText(), 'keep first draft');
    const line = `${'中文'.repeat(1500000)} @first-project`, result = await suggest(f.ui, line); assert.ok(result);
    const post = f.calls.findLast(row => row.route.endsWith('/path-completions'))!; assert.equal((post.body as { prefix: string }).prefix, '@first-project'); assert.ok(JSON.stringify(post.body).length < 512);
    const applied = f.ui.editor.autocompleteProvider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix); assert.ok(applied.lines[0]!.startsWith('中文'.repeat(1500000))); assert.match(applied.lines[0]!.slice(-80), /first-project\.txt $/);
  } finally { await f.close(); }
});

test('actual directory lease changes retry transparently and late suggestions never cross context or configuration changes', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    f.ui.streamController?.abort();
    let moved = false;
    const traced: Array<{ route: string; error?: string; result?: unknown }> = [];
    const newRoot = path.join(f.directory, 'replacement'); fs.mkdirSync(newRoot); fs.writeFileSync(path.join(newRoot, 'replacement-project.txt'), 'REPLACED_PROJECT');
    f.client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => {
      let result: T; try { result = await f.original<T>(route, init); } catch (error) { traced.push({ route, error: error instanceof Error ? error.message : 'unknown' }); throw error; }
      if (route.endsWith('/project-directory') || route.endsWith('/path-completions')) traced.push({ route, result });
      if (!moved && route.endsWith('/project-directory')) { moved = true; await f.core.updateWorkspace('one', { expectedPath: f.one, path: newRoot }); }
      return result;
    };
    assert.ok((await suggest(f.ui, '@replacement-project'))?.items.some(row => row.value.includes('replacement-project.txt')), JSON.stringify(traced)); assert.equal(moved, true);
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { reached = resolve; });
    f.client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => { const result = await f.original<T>(route, init); if (route.endsWith('/path-completions')) { reached(); await held; } return result; };
    const pending = suggest(f.ui, '@replacement-project'); await requested; await f.ui.switchContext(f.second.id); release(); assert.equal(await pending, null);
    assert.equal(f.ui.editor.getText(), '');
    let releaseConfiguration!: () => void, reachedConfiguration!: () => void;
    const heldConfiguration = new Promise<void>(resolve => { releaseConfiguration = resolve; }), requestedConfiguration = new Promise<void>(resolve => { reachedConfiguration = resolve; });
    f.client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => { const result = await f.original<T>(route, init); if (route.endsWith('/path-completions')) { reachedConfiguration(); await heldConfiguration; } return result; };
    const second = suggest(f.ui, '@second-project'); await requestedConfiguration;
    f.ui.event({ seq: 999999, contextId: f.second.id, runId: null, kind: 'state', createdAt: '', data: { area: 'configuration' } }); releaseConfiguration(); assert.equal(await second, null);
  } finally { await f.close(); }
});
