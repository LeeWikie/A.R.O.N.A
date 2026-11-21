import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { Editor, type Terminal, type TuiAltScreen } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import type { SessionTreeNode, SessionTreeView } from '../src/protocol.js';
import { TerminalApp } from '../src/tui/index.js';
import type { SessionControls } from '../src/tui/session-controls.js';
import type { TreeSelectorComponent } from '../src/tui/upstream/tree-selector.js';
import { appBuildInfo } from '../src/version.js';
import { finished, removeTemp, until } from './helpers.js';

class TypingTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input: (value: string) => void = () => {};
  start(input: (value: string) => void) { this.input = input; } stop() {} async drainInput() {} write(value: string) { this.output += value; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  type(value: string) { for (const char of value) this.input(char); }
}
type UI = { editor: Editor; ui: TuiAltScreen; seen: Set<string>; toolCards: Map<string, { data: { toolCallId: string; resultEntryId?: string; afterMessageId?: string | null; resultContent?: Array<{ type: string }> } }>; model?: { profileId: string; thinkingLevel?: string }; sessionSelector?: TreeSelectorComponent; pendingModal?: () => void; contextReady: boolean; contextId: string; command(text: string): Promise<void>; sessionControls(): SessionControls; withModalFlow<T>(action: () => Promise<T>): Promise<T | undefined> };
function flatten(view: SessionTreeView): SessionTreeNode[] { const nodes: SessionTreeNode[] = [], stack = [...view.tree]; while (stack.length) { const node = stack.pop()!; nodes.push(node); stack.push(...node.children); } return nodes; }
function content(node: SessionTreeNode) { const entry = node.entry; return entry.type === 'message' && 'content' in entry.message ? typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('') : ''; }
async function withTTY<T>(run: () => Promise<T>) {
  const input = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), output = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  try { return await run(); } finally { if (input) Object.defineProperty(process.stdin, 'isTTY', input); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (output) Object.defineProperty(process.stdout, 'isTTY', output); else delete (process.stdout as { isTTY?: boolean }).isTTY; }
}

test('actual Core tree labels, user-boundary navigation, sibling continuation and leaf restoration survive a restart through the terminal', { timeout: 30000 }, () => withTTY(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-session-tree-'));
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    const text = `synthetic answer ${++calls}`; controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: text }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
  } }) }) });
  let core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  let server: ReturnType<typeof serve> | undefined, app: TerminalApp | undefined, running: Promise<void> | undefined;
  const copies: string[] = [];
  async function startClient() {
    server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
    const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new TypingTerminal();
    app = new TerminalApp(client, 'main', terminal, { clipboard: { getText: async () => null, getImage: async () => null, setText: async text => { copies.push(text); } } }); running = app.run();
    const ui = app as unknown as UI; await until(() => ui.contextReady, ready => ready); return { client, terminal, ui };
  }
  async function stopClient() { await app?.stop(); await running; if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); } app = undefined; server = undefined; }
  try {
    for (const text of ['first question', 'second question']) { const receipt = await core.submitMessage({ content: text }); assert.equal((await finished(core, receipt.runId!))!.status, 'succeeded'); }
    let { client, terminal, ui } = await startClient();
    const original = await client.request<SessionTreeView>('/contexts/main/tree'), originalLeaf = original.leafId;
    const first = flatten(original).find(node => content(node) === 'first question')!; assert.ok(first);
    const source = ui.editor; source.setText('retained unsent draft');
    let tree = ui.command('/tree'); await until(() => ui.sessionSelector, selector => !!selector);
    terminal.type('first question'); terminal.type('L'); terminal.type('branch bookmark\r');
    await until(async () => flatten(await client.request<SessionTreeView>('/contexts/main/tree')).find(node => node.entry.id === first.entry.id)?.label, label => label === 'branch bookmark');
    await until(() => ui.sessionSelector?.getTreeList().getSelectedNode()?.label, label => label === 'branch bookmark');
    terminal.type('\r'); await until(() => ui.ui.hasOverlay(), visible => visible); terminal.type('\r'); await tree;
    await until(() => ui.contextReady, ready => ready); assert.equal(ui.editor, source); assert.equal(ui.editor.getText(), 'retained unsent draft'); assert.equal(ui.ui.getFocusedComponent(), ui.editor);
    let current = await client.request<SessionTreeView>('/contexts/main/tree'); assert.notEqual(current.leafId, originalLeaf); assert.ok(flatten(current).some(node => node.entry.id === first.entry.id && node.label === 'branch bookmark'));
    ui.editor.setText('replacement question'); terminal.type('\r'); await until(() => calls, value => value === 3);
    await until(async () => (await client.request<SessionTreeView>('/contexts/main/tree')).leafId, leaf => leaf !== current.leafId);
    current = await client.request<SessionTreeView>('/contexts/main/tree'); assert.ok(flatten(current).some(node => content(node) === 'replacement question')); assert.ok(flatten(current).some(node => content(node) === 'second question'));
    const branch = (await client.snapshot('main')).conversation; assert.ok(branch.messages.some(message => message.content === 'replacement question')); assert.equal(branch.messages.some(message => message.content === 'second question'), false);
    tree = ui.command('/tree'); await until(() => ui.sessionSelector, selector => !!selector);
    terminal.type('synthetic answer 2'); terminal.type('\r'); await until(() => ui.ui.hasOverlay(), visible => visible); terminal.type('\r'); await tree;
    await until(async () => (await client.request<SessionTreeView>('/contexts/main/tree')).leafId, leaf => leaf === originalLeaf);
    await stopClient(); await core.close(); core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
    ({ client, terminal, ui } = await startClient());
    const reopened = await client.request<SessionTreeView>('/contexts/main/tree'); assert.equal(reopened.leafId, originalLeaf); assert.ok(flatten(reopened).some(node => node.label === 'branch bookmark')); assert.ok(flatten(reopened).some(node => content(node) === 'replacement question'));
    tree = ui.command('/tree'); await until(() => ui.sessionSelector, selector => !!selector); terminal.type('\x18'); await until(() => copies.length, length => length > 0); assert.match(copies.at(-1)!, /synthetic answer 2/);
    terminal.type('\x1b'); await tree; assert.equal(ui.ui.getFocusedComponent(), ui.editor);
    assert.ok(ui.seen.size > 0); const editor = ui.editor; editor.setText('keep external navigation draft');
    await core.navigateSession('main', { targetId: first.entry.id }); await until(() => ui.contextReady && ui.seen.size === 0, ready => ready);
    assert.equal(ui.editor, editor); assert.equal(editor.getText(), 'keep external navigation draft'); assert.equal(ui.ui.getFocusedComponent(), editor);
  } finally { await stopClient(); await core.close(); await removeTemp(directory); }
}));

test('manual terminal compaction keeps the same session, original records and unsent editor draft while adding a navigable checkpoint', { timeout: 30000 }, () => withTTY(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-compact-tree-'));
  const model = new MastraLanguageModelV2Mock({ doStream: async request => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: JSON.stringify(request.prompt).includes('context checkpoint summary') ? 'SYNTHETIC_TUI_CHECKPOINT' : 'synthetic published reply' }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); } }) }) });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  for (const content of [`old first ${'detail '.repeat(9000)}`, `old second ${'detail '.repeat(9000)}`, 'recent user']) { const receipt = await core.submitMessage({ content }); assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded'); }
  const before = await core.sessionTree('main');
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new TypingTerminal(), app = new TerminalApp(client, 'main', terminal), ui = app as unknown as UI, running = app.run();
  try {
    await until(() => ui.contextReady, ready => ready); const editor = ui.editor; editor.setText('retain compaction draft');
    await ui.command('/compact preserve decisions'); await until(() => ui.contextReady, ready => ready);
    assert.equal(ui.contextId, 'main'); assert.equal(core.runtime.contexts().length, 1); assert.equal(ui.editor, editor); assert.equal(editor.getText(), 'retain compaction draft');
    const after = await core.sessionTree('main'), ids = new Set(flatten(after).map(node => node.entry.id)); for (const node of flatten(before)) assert.ok(ids.has(node.entry.id));
    assert.ok(flatten(after).some(node => node.entry.type === 'compaction' && node.entry.summary === 'SYNTHETIC_TUI_CHECKPOINT'));
    const tree = ui.command('/tree'); await until(() => ui.sessionSelector, value => !!value); terminal.input('\x01'); terminal.type('compaction'); assert.equal(ui.sessionSelector!.getTreeList().getSelectedNode()?.entry.type, 'compaction'); terminal.input('\x1b'); terminal.input('\x1b'); await tree;
    assert.equal(ui.ui.getFocusedComponent(), editor); assert.equal(editor.getText(), 'retain compaction draft');
  } finally { await app.stop(); await running; if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
}));

test('busy tree navigation saves queued originals in one editable document before aborting the exact run and changing the canonical leaf', { timeout: 30000 }, () => withTTY(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-tree-busy-')); let calls = 0, busyAborted = false;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    if (++calls > 1) await new Promise<void>((_resolve, reject) => { assert.ok(request.abortSignal); const abort = () => { busyAborted = true; reject(new DOMException('Synthetic busy abort', 'AbortError')); }; if (request.abortSignal.aborted) abort(); else request.abortSignal.addEventListener('abort', abort, { once: true }); });
    return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'stable source answer' }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const first = await core.submitMessage({ content: 'stable source user' }); assert.equal((await finished(core, first.runId!))?.status, 'succeeded');
  const active = await core.submitMessage({ content: 'busy source user' }); await until(() => calls, value => value === 2);
  const queued = await core.submitMessage({ content: 'queued original to retain', mode: 'queue' }); assert.equal(queued.status, 'queued');
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new TypingTerminal(), app = new TerminalApp(client, 'main', terminal), ui = app as unknown as UI, running = app.run();
  try {
    await until(() => ui.contextReady, ready => ready); ui.editor.setText('current unsent draft');
    const tree = ui.command('/tree'); await until(() => ui.sessionSelector, value => !!value); terminal.type('stable source user'); terminal.input('\r'); await until(() => ui.ui.hasOverlay(), value => value); terminal.input('\r'); await tree;
    await until(() => ui.contextReady, ready => ready); assert.equal(busyAborted, true); assert.equal(core.queuedMessages('main').length, 0); assert.equal(core.store.getSignal(queued.id)?.status, 'cancelled'); assert.notEqual(core.store.getRun(active.runId!)?.status, 'running'); assert.notEqual(core.store.getRun(active.runId!)?.status, 'succeeded');
    const restored=core.queueEditor().list('main');assert.equal(restored.length,1);const restoredId=restored[0]!.id;assert.deepEqual(core.queueEditor().page('main',restoredId).entries.map(row=>row.content),['queued original to retain','current unsent draft']);assert.equal(ui.editor.getText(),'stable source user'); assert.equal(calls, 2); assert.equal(ui.ui.getFocusedComponent(), ui.editor);
    const view = await core.sessionTree('main'); assert.ok(flatten(view).some(node => content(node) === 'busy source user')); assert.equal((await client.snapshot('main')).conversation.messages.some(message => message.content === 'busy source user'), false);
    const next = await core.submitMessage({ content: 'clone busy source user' }); await until(() => calls, value => value === 3);
    const cloneQueued = await core.submitMessage({ content: 'clone queued original', mode: 'queue' }); assert.equal(cloneQueued.status, 'queued');
    const sourceEditor = ui.editor; await ui.command('/clone Busy clone'); await until(() => ui.contextReady && ui.contextId !== 'main', ready => ready);
    assert.equal(core.runtime.context(ui.contextId)?.name, 'Busy clone'); assert.equal(core.store.getSignal(cloneQueued.id)?.status, 'cancelled'); assert.equal(core.queuedMessages('main').length, 0); assert.notEqual(core.store.getRun(next.runId!)?.status, 'running'); assert.notEqual(core.store.getRun(next.runId!)?.status, 'succeeded');
    assert.equal(core.queueEditor().list('main').length,1);assert.equal(core.queueEditor().list('main')[0]!.id,restoredId);assert.deepEqual(core.queueEditor().page('main',restoredId).entries.filter(row=>row.content).map(row=>row.content),['clone queued original','queued original to retain','current unsent draft','stable source user']);assert.deepEqual(core.queueEditor().page('main',restoredId).entries.flatMap(row=>row.sourceSignalIds),[cloneQueued.id,queued.id]);assert.equal(sourceEditor.getText(),''); assert.equal(ui.editor.getText(), ''); assert.equal(calls, 3);
    const cloned = await core.sessionTree(ui.contextId); assert.ok(flatten(cloned).some(node => content(node) === 'clone busy source user')); assert.ok(flatten(cloned).some(node => content(node) === 'busy source user')); assert.equal(ui.ui.getFocusedComponent(), ui.editor);
  } finally { await app.stop(); await running; if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
}));

test('tree navigation restores source model and thinking state in both the terminal and the next actual provider request', { timeout: 30000 }, () => withTTY(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-tree-model-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const provider = fauxProvider({ provider: 'session-ui', models: [{ id: 'reasoner', reasoning: true, contextWindow: 64000, maxTokens: 2000 }, { id: 'plain', reasoning: false, contextWindow: 64000, maxTokens: 2000 }] });
  const requests: Array<{ model: string; reasoning: string | undefined; messages: string }> = [];
  const response: Parameters<typeof provider.setResponses>[0][number] = (context, options, _state, model) => { requests.push({ model: model.id, reasoning: options?.reasoning, messages: JSON.stringify(context.messages) }); return fauxAssistantMessage('synthetic next answer'); };
  provider.setResponses([response, response]); core.providerRegistry.setProvider(provider.provider);
  core.models.save({ id: 'reasoner.profile', name: 'Reasoner', providerId: 'session-ui', modelId: 'reasoner' }); core.models.save({ id: 'plain.profile', name: 'Plain', providerId: 'session-ui', modelId: 'plain' });
  const timestamp = '2026-01-01T00:00:00.000Z';
  const jsonl = [ { type: 'session', version: 3, id: 'synthetic-model-tree', timestamp, cwd: '/synthetic' },
    { type: 'model_change', id: 'reasoner-model', parentId: null, timestamp, provider: 'session-ui', modelId: 'reasoner' },
    { type: 'thinking_level_change', id: 'minimal', parentId: 'reasoner-model', timestamp, thinkingLevel: 'minimal' },
    { type: 'message', id: 'old-user', parentId: 'minimal', timestamp, message: { role: 'user', content: 'reasoner source user', timestamp: 0 } },
    { type: 'message', id: 'old-answer', parentId: 'old-user', timestamp, message: { ...fauxAssistantMessage('reasoner source answer'), provider: 'session-ui', model: 'reasoner', content: [{ type: 'text', text: 'reasoner source answer' }, { type: 'toolCall', id: 'native-read', name: 'read', arguments: { path: 'synthetic.txt' } }] } },
    { type: 'message', id: 'old-result', parentId: 'old-answer', timestamp, message: { role: 'toolResult', toolCallId: 'native-read', toolName: 'read', isError: false, timestamp: 0, content: [{ type: 'text', text: 'native tool output' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=' }] } },
    { type: 'model_change', id: 'plain-model', parentId: 'old-result', timestamp, provider: 'session-ui', modelId: 'plain' },
    { type: 'thinking_level_change', id: 'off', parentId: 'plain-model', timestamp, thinkingLevel: 'off' },
    { type: 'message', id: 'plain-user', parentId: 'off', timestamp, message: { role: 'user', content: 'plain source user', timestamp: 0 } },
    { type: 'message', id: 'plain-answer', parentId: 'plain-user', timestamp, message: { ...fauxAssistantMessage('plain source answer'), provider: 'session-ui', model: 'plain' } },
  ].map(entry => JSON.stringify(entry)).join('\n');
  const imported = await core.importPiContext({ jsonl, name: 'Model tree' });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new TypingTerminal(), app = new TerminalApp(client, imported.id, terminal), ui = app as unknown as UI, running = app.run();
  async function select(query: string) { const command = ui.command('/tree'); await until(() => ui.sessionSelector, value => !!value); terminal.type(query); terminal.input('\r'); await until(() => ui.ui.hasOverlay(), value => value); terminal.input('\r'); await command; await until(() => ui.contextReady, ready => ready); }
  try {
    assert.equal((await core.modelState(imported.id)).profileId, 'plain.profile');
    await until(() => ui.model?.profileId, id => id === 'plain.profile');
    await until(() => ui.toolCards.size, size => size === 1); const importedTool = [...ui.toolCards.values()][0]!.data; assert.equal(importedTool.toolCallId, 'native-read'); assert.equal(importedTool.resultEntryId, 'old-result'); assert.ok(importedTool.resultContent?.some(part => part.type === 'image')); await until(() => terminal.output.includes('native tool output'), value => value);
    await select('reasoner source user'); await until(() => ui.model?.thinkingLevel, level => level === 'minimal'); assert.equal(ui.model?.profileId, 'reasoner.profile'); assert.equal(ui.editor.getText(), 'reasoner source user');
    assert.equal(ui.toolCards.size, 0); assert.equal(((await client.snapshot(imported.id)).toolActivity ?? []).length, 0);
    ui.editor.setText('actual reasoner continuation'); terminal.input('\r'); await until(() => requests.length, count => count === 1); await until(async () => (await client.snapshot(imported.id)).runs.every(run => run.status === 'succeeded'), value => value);
    assert.equal(requests[0]!.model, 'reasoner'); assert.equal(requests[0]!.reasoning, 'minimal'); assert.equal(requests[0]!.messages.includes('plain source user'), false);
    await select('plain source answer'); await until(() => ui.model?.profileId, id => id === 'plain.profile'); assert.equal(ui.model?.thinkingLevel, 'off');
    assert.equal(ui.toolCards.size, 1); assert.equal([...ui.toolCards.values()][0]!.data.resultEntryId, 'old-result');
    ui.editor.setText('actual plain continuation'); terminal.input('\r');
    const attempted = await until(() => ({ calls: requests.length, failure: core.store.db.prepare("SELECT error_code FROM runs WHERE context_id=? AND status='failed'").get(imported.id) }), value => value.calls === 2 || !!value.failure);
    assert.equal(attempted.calls, 2, `The source tool round trip failed before the provider: ${JSON.stringify(attempted.failure)}`);
    await until(async () => (await client.snapshot(imported.id)).runs.every(run => run.status === 'succeeded'), value => value);
    assert.equal(requests[1]!.model, 'plain'); assert.equal(requests[1]!.reasoning, undefined); assert.ok(requests[1]!.messages.includes('plain source user')); assert.equal(requests[1]!.messages.includes('actual reasoner continuation'), false);
  } finally { await app.stop(); await running; if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
}));

test('Escape cancels a real branch summary without moving the leaf, and a custom summary can then complete from the same selected entry', { timeout: 30000 }, () => withTTY(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-summary-')); let calls = 0, holdSummary = false, summaryAborted = false; const prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const number = ++calls; prompts.push(JSON.stringify(request.prompt));
    if (holdSummary) await new Promise<void>((_resolve, reject) => { assert.ok(request.abortSignal); const abort = () => { summaryAborted = true; reject(new DOMException('Synthetic cancelled summary', 'AbortError')); }; if (request.abortSignal.aborted) abort(); else request.abortSignal.addEventListener('abort', abort, { once: true }); });
    return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: number <= 2 ? `turn-${number}` : 'SYNTHETIC_BRANCH_SUMMARY' }); controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new TypingTerminal(), app = new TerminalApp(client, 'main', terminal), ui = app as unknown as UI;
  let running: Promise<void> | undefined;
  try {
    for (const content of ['summary first', 'summary second']) { const receipt = await core.submitMessage({ content }); assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded'); }
    const original = await core.sessionTree('main'); const target = flatten(original).find(node => content(node) === 'summary first')!; running = app.run(); await until(() => ui.contextReady, ready => ready);
    holdSummary = true;
    let command = ui.command('/tree'); await until(() => ui.sessionSelector, value => !!value); terminal.type('summary first'); terminal.input('\r'); await until(() => ui.ui.hasOverlay(), value => value); terminal.input('\x1b[B'); terminal.input('\r');
    await until(() => calls, number => number === 3); terminal.input('\x1b');
    await until(() => summaryAborted, value => value); await until(() => ui.sessionSelector, value => !!value);
    assert.equal((await core.sessionTree('main')).leafId, original.leafId); assert.equal(ui.sessionSelector!.getTreeList().getSelectedNode()?.entry.id, target.entry.id); assert.equal(flatten(await core.sessionTree('main')).some(node => node.entry.type === 'branch_summary'), false);
    terminal.input('\x1b'); await command;
    holdSummary = false;
    command = ui.command('/tree'); await until(() => ui.sessionSelector, value => !!value); terminal.type('summary first'); terminal.input('\r'); await until(() => ui.ui.hasOverlay(), value => value); terminal.input('\x1b[B'); terminal.input('\x1b[B'); terminal.input('\r');
    await until(() => ui.ui.getFocusedComponent() instanceof Editor, value => value); const customEditor = ui.ui.getFocusedComponent(); terminal.input('\x1b');
    await until(() => ui.ui.hasOverlay() && ui.ui.getFocusedComponent() !== customEditor, value => value); terminal.input('\x1b[B'); terminal.input('\x1b[B'); terminal.input('\r');
    await until(() => ui.ui.getFocusedComponent() instanceof Editor, value => value); terminal.type('custom summary emphasis'); terminal.input('\r'); await command;
    await until(() => ui.contextReady, ready => ready); const tree = await core.sessionTree('main'); const summary = flatten(tree).find(node => node.entry.type === 'branch_summary'); assert.ok(summary); assert.equal(summary.entry.type === 'branch_summary' && summary.entry.summary, 'SYNTHETIC_BRANCH_SUMMARY'); assert.match(prompts.at(-1)!, /custom summary emphasis/); assert.equal(ui.contextId, 'main'); assert.equal(ui.ui.getFocusedComponent(), ui.editor);
  } finally { holdSummary = false; await app.stop(); await running; if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
}));

test('terminal native import, offline HTML, full-tree clone, before-user fork and session rename/archive use the actual Core', { timeout: 30000 }, () => withTTY(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-native-session-'));
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { throw new Error('Session management must not call the model'); } });
  const core = await Core.open({ dataDir: path.join(directory, 'data'), model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new TypingTerminal();
  const app = new TerminalApp(client, 'main', terminal, { completionBase: directory }), ui = app as unknown as UI, running = app.run();
  const timestamp = '2026-01-01T00:00:00.000Z';
  const user = (id: string, parentId: string | null, content: string) => ({ type: 'message', id, parentId, timestamp, message: { role: 'user', content, timestamp: 0 } });
  const raw = [ { type: 'session', version: 3, id: 'synthetic-pi', timestamp, cwd: '/source-only-never-authorize' }, { ...user('first', null, '中文 first source'), timestamp: '2026-01-03T00:00:00.000Z' }, { ...user('left', 'first', 'left sibling'), timestamp: '2026-01-02T00:00:00.000Z' }, user('right', 'first', 'right active user'), { type: 'label', id: 'bookmark', parentId: 'right', timestamp, targetId: 'left', label: 'saved sibling' } ].map(entry => JSON.stringify(entry)).join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(directory, 'native.jsonl'), raw);
  try {
    await until(() => ui.contextReady, ready => ready);
    await until(() => terminal.output.includes(`v${appBuildInfo.version}`), visible => visible);
    await ui.command('/status'); await until(() => terminal.output.includes('核心版本'), visible => visible);
    const oldEditor = ui.editor; oldEditor.setText('source workspace draft');
    const importing = ui.command('/import native.jsonl'); await until(() => ui.ui.hasOverlay(), visible => visible); terminal.input('\x1b[B'); terminal.input('\r'); await importing;
    await until(() => ui.contextReady && ui.contextId !== 'main', ready => ready); const importedId = ui.contextId;
    assert.equal(oldEditor.getText(), 'source workspace draft'); assert.equal(core.capabilities.roots().some(root => root.path === '/source-only-never-authorize'), false);
    const imported = await client.request<SessionTreeView>(`/contexts/${importedId}/tree`); assert.ok(flatten(imported).some(node => node.entry.id === 'left' && node.label === 'saved sibling'));
    const actualMessages = (await client.snapshot(importedId)).conversation.messages;
    assert.deepEqual(actualMessages.map(message => message.content), ['中文 first source', 'right active user']);
    assert.deepEqual([...ui.seen].map(id => actualMessages.find(message => message.id === id)?.content), ['中文 first source', 'right active user']);
    await ui.command('/export session.html');
    const html = fs.readFileSync(path.join(directory, 'session.html'), 'utf8'), payload = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1]; assert.ok(payload);
    const exported = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { entries: Array<{ id: string }> }; assert.ok(exported.entries.some(entry => entry.id === 'left')); assert.ok(exported.entries.some(entry => entry.id === 'right'));
    await ui.command('/export --pi session.jsonl'); const publicJsonl = fs.readFileSync(path.join(directory, 'session.jsonl'), 'utf8'); assert.match(publicJsonl, /saved sibling/);
    await ui.command('/export --pi --backup continuation.jsonl'); assert.ok(fs.statSync(path.join(directory, 'continuation.jsonl')).size > 0);
    await ui.command('/clone Full clone'); await until(() => ui.contextReady && ui.contextId !== importedId, ready => ready); const cloneId = ui.contextId;
    const cloned = await client.request<SessionTreeView>(`/contexts/${cloneId}/tree`); assert.ok(flatten(cloned).some(node => node.label === 'saved sibling')); assert.ok(flatten(cloned).some(node => content(node) === 'left sibling'));
    const cloneEditor = ui.editor; cloneEditor.setText('retain clone draft');
    const forking = ui.command('/fork'); await until(() => ui.sessionSelector, selector => !!selector); terminal.input('\x1b[A'); terminal.input('\r'); await forking;
    await until(() => ui.contextReady && ui.contextId !== cloneId, ready => ready); assert.equal(ui.editor.getText(), 'left sibling'); assert.equal(cloneEditor.getText(), 'retain clone draft');
    const forked = await client.request<SessionTreeView>(`/contexts/${ui.contextId}/tree`); assert.ok(flatten(forked).some(node => content(node) === '中文 first source')); assert.equal(flatten(forked).some(node => content(node) === 'right active user'), false); assert.equal(flatten(forked).some(node => content(node) === 'left sibling'), false);
    const selectedSession = () => (ui.sessionSelector as unknown as { getSessionList(): { getSelectedSessionPath(): string | undefined } } | undefined)?.getSessionList().getSelectedSessionPath();
    const browsing = ui.command('/sessions'); await until(() => ui.sessionSelector, selector => !!selector); terminal.type('re:^Full clone$'); await until(selectedSession, id => id === cloneId);
    terminal.input('\x12'); terminal.input('\x01'); terminal.input('\x0b'); terminal.type('Renamed clone'); terminal.input('\r');
    await until(() => core.runtime.context(cloneId)?.name, name => name === 'Renamed clone');
    await until(selectedSession, id => id === undefined); terminal.input('\x01'); terminal.input('\x0b'); terminal.type('re:^Renamed clone$'); await until(selectedSession, id => id === cloneId); terminal.input('\r'); await browsing;
    await until(() => ui.contextReady && ui.contextId === cloneId, ready => ready); assert.equal(ui.editor, cloneEditor); assert.equal(ui.editor.getText(), 'retain clone draft');
    const deleting = ui.command('/sessions'); await until(() => ui.sessionSelector, selector => !!selector); terminal.type('re:^Imported session$'); await until(selectedSession, id => id === importedId);
    terminal.input('\x04'); terminal.input('\r');
    await until(() => core.runtime.context(importedId)?.archived, archived => archived === true); terminal.input('\x1b'); await deleting;
    assert.equal(ui.ui.getFocusedComponent(), ui.editor); assert.equal(ui.editor.getText(), 'retain clone draft');
  } finally { await app.stop(); await running; if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
}));
