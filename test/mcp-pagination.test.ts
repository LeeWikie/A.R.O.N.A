import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { MCPClient } from '@mastra/mcp';
import { Capabilities } from '../src/capabilities.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { mcpPaginationFixture } from './mcp-pagination-fixture.js';
import { removeTemp } from './helpers.js';

test('native MCP discovery drains tools, resources, templates and prompts and can use a final-page tool', async () => {
  const remote = await mcpPaginationFixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-pages-')), db = new DatabaseSync(':memory:'); const capabilities = new Capabilities(new RuntimeStore(db), directory);
  try {
    await capabilities.saveMCP(remote.configuration); await capabilities.connect('pages');
    const tools = capabilities.tools(true); assert.ok(Object.keys(tools).some(name => name.endsWith('tool_2')), 'final-page tool must be discoverable');
    const resources = await capabilities.mcpResources('pages'); assert.equal(resources.resources.length, 3); assert.equal(resources.templates.length, 3);
    assert.deepEqual((await capabilities.mcpPrompts('pages')).map(prompt => prompt.name), ['prompt_0', 'prompt_1', 'prompt_2']);
    const tool = Object.entries(tools).find(([name]) => name.endsWith('tool_2'))?.[1]; assert.ok(tool && 'execute' in tool && typeof tool.execute === 'function'); assert.match(JSON.stringify(await tool.execute({}, {})), /Executed tool_2/);
    assert.equal((await capabilities.readMcpResourceTemplate('pages', 'fixture://template/2/{name}', { name: '中文' })).uri, 'fixture://template/2/%E4%B8%AD%E6%96%87');
    for (const method of ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']) assert.ok(remote.calls.some(call => call.method === method && call.cursor === 'page-2'), method + ' follows opaque cursor');
    const sdk = new MCPClient({ id: 'definitions', registerProcessHooks: false, servers: { pages: { url: new URL(remote.configuration.url), protocolVersion: 'legacy' } } });
    try { const result = await sdk.listToolDefinitionsWithErrors(); assert.equal(Object.keys(result.errors).length, 0); assert.match(JSON.stringify(result), /tool_2/); } finally { await sdk.disconnect(); }
  } finally { await capabilities.close(); db.close(); await remote.close(); await removeTemp(directory); }
});

test('repeating MCP list cursors and later-page failures fail discovery instead of publishing a partial catalog', async () => {
  const remote = await mcpPaginationFixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-pages-failure-')), db = new DatabaseSync(':memory:'); const capabilities = new Capabilities(new RuntimeStore(db), directory);
  try {
    remote.state.repeatCursor = true; await capabilities.saveMCP(remote.configuration);
    await assert.rejects(capabilities.connect('pages'), /mcp_connection_failed/); assert.deepEqual(capabilities.tools(true), {}); assert.ok(remote.calls.filter(call => call.method === 'tools/list').length <= 3);
    remote.state.repeatCursor = false; await capabilities.connect('pages');
    remote.state.failMethod = 'resources/list'; await assert.rejects(capabilities.mcpResources('pages'), /mcp_resource_discovery_failed/);
    remote.state.failMethod = 'prompts/list'; await assert.rejects(capabilities.mcpPrompts('pages'), /mcp_prompt_discovery_failed/);
    remote.state.failMethod = ''; assert.equal((await capabilities.mcpResources('pages')).resources.length, 3);
    await capabilities.disconnect('pages'); await capabilities.connect('pages'); assert.equal((await capabilities.mcpPrompts('pages')).length, 3);
  } finally { await capabilities.close(); db.close(); await remote.close(); await removeTemp(directory); }
});

test('native CommonJS consumers reject repeated cursors and treat an empty cursor as a completed list', async () => {
  const remote = await mcpPaginationFixture(); const require = createRequire(import.meta.url), { MCPClient: CommonJSClient } = require('@mastra/mcp');
  const client = new CommonJSClient({ id: 'commonjs-pages', registerProcessHooks: false, servers: { fixture: { url: new URL(remote.configuration.url), protocolVersion: 'legacy' } } });
  try {
    remote.state.emptyCursor = true; const single = await client.listToolsWithErrors(); assert.equal(Object.keys(single.errors).length, 0); assert.equal(Object.keys(single.tools).length, 1);
    remote.state.emptyCursor = false; remote.state.repeatCursor = true;
    const broken = await client.resources.listWithErrors(); assert.deepEqual(broken.resources, {}); assert.ok(broken.errors.fixture);
    remote.state.repeatCursor = false; const complete = await client.resources.listWithErrors(); assert.equal(complete.resources.fixture.length, 3);
  } finally { await client.disconnect(); await remote.close(); }
});

test('credential rotation revokes a tool response that was already in flight', async () => {
  const remote = await mcpPaginationFixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-tool-rotation-')), db = new DatabaseSync(':memory:'); let credential = 'synthetic-credential-A';
  const capabilities = new Capabilities(new RuntimeStore(db), directory, () => credential); const held = remote.holdNextTool();
  try {
    await capabilities.saveMCP({ ...remote.configuration, headersEnv: { authorization: 'FIXTURE_CREDENTIAL' } }); await capabilities.connect('pages');
    const tool = Object.values(capabilities.tools(true)).find(tool => 'id' in tool && typeof tool.id === 'string' && tool.id.endsWith('tool_0'));
    assert.ok(tool && 'execute' in tool && typeof tool.execute === 'function');
    const pending = tool.execute({}, {}); const checked = assert.rejects(pending, /mcp_connection_changed/);
    await held.entered; credential = 'synthetic-credential-B'; held.release(); await checked;
  } finally { held.release(); await capabilities.close(); db.close(); await remote.close(); await removeTemp(directory); }
});
