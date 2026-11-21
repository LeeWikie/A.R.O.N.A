import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { SelectItem, Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp } from './helpers.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;

test('terminal MCP resources, URI template variables and prompt arguments traverse the real SDK and remain external data', { timeout: 30000 }, async () => {
  const reads: string[] = [], argumentsSeen: unknown[] = [];
  const mcp = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string; uri?: string; arguments?: unknown } };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown = {};
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'synthetic-content', version: '1' } };
    else if (rpc.method === 'tools/list') result = { tools: [] };
    else if (rpc.method === 'resources/list') result = { resources: [{ uri: 'fixture://resource/plain', name: 'Synthetic resource', mimeType: 'text/plain' }] };
    else if (rpc.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'fixture://topics/{topic}{?format}', name: 'Synthetic topic', mimeType: 'text/plain' }] };
    else if (rpc.method === 'resources/read') { reads.push(rpc.params!.uri!); result = { contents: [{ uri: rpc.params!.uri, mimeType: 'text/plain', text: 'MCP_SYNTHETIC_RESOURCE_CONTENT' }] }; }
    else if (rpc.method === 'prompts/list') result = { prompts: [{ name: 'synthetic-prompt', description: 'An external template', arguments: [{ name: 'topic', required: true }] }] };
    else if (rpc.method === 'prompts/get') { argumentsSeen.push(rpc.params?.arguments); result = { description: 'External synthetic prompt', messages: [{ role: 'user', content: { type: 'text', text: 'MCP_EXTERNAL_TEMPLATE_CONTENT' } }] }; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  mcp.listen(0, '127.0.0.1'); await once(mcp, 'listening');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-mcp-content-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false }); await core.capabilities.saveMCP({ id: 'fixture', url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`, protocolVersion: 'legacy' }); await core.capabilities.connect('fixture');
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), app = new TerminalApp(client, 'main', terminal);
  const ui = app as unknown as { capabilities: Set<string>; command(text: string): Promise<void>; choose(title: string, items: SelectItem[]): Promise<string | undefined>; prompt(title: string): Promise<string | undefined>; note(text: string): void };
  const notes: string[] = []; let mode = 'resource';
  try {
    ui.capabilities = new Set((await client.handshake()).capabilities); ui.note = text => { notes.push(text); };
    ui.choose = async (_title, items) => {
      if (items.some(item => item.value === 'server:fixture')) return 'server:fixture';
      if (items.some(item => item.value === 'resources')) return mode === 'prompt' ? 'prompts' : 'resources';
      if (items.some(item => item.value === 'resource:0')) return mode === 'template' ? 'template:0' : 'resource:0';
      throw new Error('unexpected choice');
    };
    ui.prompt = async title => title.includes('format') ? 'txt' : '中文/a & b';
    await ui.command('/mcp'); assert.deepEqual(reads, ['fixture://resource/plain']); assert.ok(notes.some(text => text.includes('MCP_SYNTHETIC_RESOURCE_CONTENT')));
    mode = 'template'; await ui.command('/mcp'); assert.equal(reads.length, 2, notes.join('\n')); assert.match(reads[1]!, /%2F/); assert.match(reads[1]!, /[?]format=txt/); assert.ok(!reads[1]!.includes('{'));
    mode = 'prompt'; await ui.command('/mcp'); assert.deepEqual(argumentsSeen, [{ topic: '中文/a & b' }]); assert.ok(notes.some(text => text.includes('MCP_EXTERNAL_TEMPLATE_CONTENT')));
    assert.equal(Number(core.store.db.prepare('SELECT count(*) AS count FROM signals').get()!.count), 0, 'viewing external templates never fabricates a user message or starts an agent run');
  } finally {
    await app.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); mcp.closeAllConnections(); await new Promise<void>(resolve => mcp.close(() => resolve())); await removeTemp(directory);
  }
});
