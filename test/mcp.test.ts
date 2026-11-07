import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { until, removeTemp } from './helpers.js';

test('official MCP discovery, scoped approval, actual invocation and disconnect', { timeout: 40_000 }, async () => {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { id?: string | number; method: string; params?: { protocolVersion?: string } };
    calls.push(request.method);
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-fixture', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'read_fixture', description: 'Read synthetic fixture data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
    else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'synthetic mcp result' }] };
    else if (request.method === 'ping') result = {};
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-')); const turns = new Map<string, number>();
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt); const names = (request.tools ?? []).map(t => t.name);
    const tool = names.find(name => name === 'ext_fixture_read_fixture');
    const id = /\\?"taskId\\?":\\?"([0-9a-f-]{36})/.exec(prompt)?.[1]; let action: { toolName: string; input: unknown } | undefined;
    if (tool && id) {
      const turn = turns.get(id) ?? 0; turns.set(id, turn + 1);
      if (turn === 0) action = { toolName: tool, input: {} };
      if (turn === 1) action = { toolName: 'task_report', input: { id, report: { outcome: 'succeeded', summary: 'Obtained actual MCP fixture response.', checks: [{ description: 'MCP callback contains fixture result', passed: prompt.includes('synthetic mcp result') }], deliveries: [], unresolved: [] } } };
    }
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); if (action) c.enqueue({ type: 'tool-call', toolCallId: `mcp-${id}-${turns.get(id ?? '')}`, toolName: action.toolName, input: JSON.stringify(action.input) });
      c.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }); c.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: false });
  try {
    await core.capabilities.saveMCP({ id: 'fixture', url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: 'legacy' });
    await core.capabilities.connect('fixture'); assert.equal(core.capabilities.mcpStatus()[0]?.connected, true);
    assert.ok(core.capabilities.mcpStatus()[0]?.tools.includes('ext_fixture_read_fixture'));
    const task = await core.submitTask({ title: 'Read MCP', content: 'Read the synthetic fixture using its MCP tool.' }, 'mcp-task');
    const approval = await until(() => core.runtime.approvals(), approvals => approvals.some(x => x.taskId === task.id && x.status === 'pending'));
    assert.equal(calls.filter(x => x === 'tools/call').length, 0, 'no external action before approval');
    await core.approve(approval.find(x => x.taskId === task.id)!.id, 'approve');
    const result = await until(() => core.runtime.task(task.id), task => !['pending', 'running', 'waiting'].includes(task.status));
    assert.equal(result.status, 'succeeded', JSON.stringify(core.runtime.events(result.contextId).filter(x => x.kind === 'tool_end')));
    assert.equal(calls.filter(x => x === 'tools/call').length, 1);
    const context=core.runtime.context(task.contextId)!;const oldTools=core.capabilities.tools(true);const key=core.capabilities.approvalKey(context,'ext_fixture_read_fixture');
    core.credentials.set('NEXT_FIXTURE_AUTH','synthetic-new-identity');
    await core.capabilities.saveMCP({id:'fixture',url:`http://127.0.0.1:${address.port}/mcp`,protocolVersion:'legacy',headersEnv:{'x-fixture-auth':'NEXT_FIXTURE_AUTH'}});
    await core.capabilities.connect('fixture');
    assert.notEqual(core.capabilities.approvalKey(context,'ext_fixture_read_fixture'),key);
    const oldExecute=(oldTools.ext_fixture_read_fixture as unknown as {execute:(...args:unknown[])=>Promise<unknown>}).execute;
    await assert.rejects(oldExecute({}),/mcp_connection_changed/);
    assert.equal(calls.filter(x=>x==='tools/call').length,1,'an obsolete connection cannot execute again');
    await core.capabilities.disconnect('fixture'); assert.equal(core.capabilities.mcpStatus()[0]?.connected, false);
  } finally { await core.close(); server.closeAllConnections(); server.close(); await removeTemp(dir); }
});

test('MCP connect and disconnect serialize while discovery is in flight', { timeout: 40_000 }, async () => {
  let release!: () => void; let seen!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const initialized = new Promise<void>(resolve => { seen = resolve; });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    if (request.method === 'initialize') { seen(); await gate; }
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'read_fixture', inputSchema: { type: 'object', properties: {} } }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-race-')); const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    await core.capabilities.saveMCP({ id: 'race', url: `http://127.0.0.1:${address.port}`, protocolVersion: 'legacy' });
    const connecting = core.capabilities.connect('race'); await initialized;
    const disconnecting = core.capabilities.disconnect('race'); release();
    await Promise.all([connecting, disconnecting]);
    assert.equal(core.capabilities.mcpStatus()[0]?.connected, false);
    assert.deepEqual(core.capabilities.tools(true), {});
    assert.deepEqual(core.capabilities.tools(false), {});
  } finally { release(); await core.close(); server.closeAllConnections(); server.close(); await removeTemp(dir); }
});

test('stdio MCP receives credential references, not persisted secret values', { timeout: 40_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-env-')); const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  const secret = 'synthetic-stdio-secret-7788';
  const script = `const readline = require('node:readline'); readline.createInterface({input:process.stdin}).on('line', line => { const q=JSON.parse(line); if(q.id===undefined)return; let result; if(q.method==='initialize') result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}; else if(q.method==='tools/list') result={tools:[{name:process.env.FIXTURE_TOKEN === ['synthetic','stdio','secret','7788'].join('-') ? 'credential_present' : 'credential_missing',inputSchema:{type:'object',properties:{}}}]}; else result={}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+String.fromCharCode(10)); });`;
  try {
    core.credentials.set('FIXTURE_MCP_SECRET', secret);
    await core.capabilities.saveMCP({ id: 'stdio', command: process.execPath, args: ['-e', script], env: { FIXTURE_TOKEN: 'FIXTURE_MCP_SECRET' } });
    assert.equal(JSON.stringify(core.capabilities.mcpConfigs()).includes(secret), false);
    await core.capabilities.connect('stdio');
    assert.ok(core.capabilities.mcpStatus()[0]?.tools.includes('ext_stdio_credential_present'));
    assert.ok(!JSON.stringify(core.capabilities.mcpStatus()).includes(secret));
    assert.deepEqual(core.capabilities.tools(false), {});
    await core.capabilities.disconnect('stdio');
  } finally { await core.close(); await removeTemp(dir); }
});

test('MCP connection operations serialize against configuration replacement', { timeout: 40_000 }, async () => {
  let release!: () => void; let initialized!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { initialized = resolve; });
  let initializations = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body) as { id?: string | number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    let result: unknown = {};
    if (message.method === 'initialize') { initializations++; initialized(); await gate; result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; }
    if (message.method === 'tools/list') result = { tools: [{ name: 'synthetic', description: 'fixture', inputSchema: { type: 'object', properties: {} } }] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-race-')); const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    const config = { id: 'fixture', url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: 'legacy' as const };
    await core.capabilities.saveMCP(config);
    const first = core.capabilities.connect('fixture'); await started;
    const second = core.capabilities.connect('fixture');
    const replacement = core.capabilities.saveMCP({ ...config, enabled: false });
    release(); await Promise.all([first, second, replacement]);
    assert.equal(initializations, 1); assert.equal(core.capabilities.mcpStatus()[0]?.connected, false);
    assert.equal(core.capabilities.mcpStatus()[0]?.enabled, false);
    assert.deepEqual(core.capabilities.tools(false), {});
    assert.throws(() => core.models.save({ id: 'x', name: 'x', protocol: 'responses', baseURL: 'http://example.invalid', modelId: 'x', apiKeyEnv: 'X', unexpected: 1 }));
    await assert.rejects(core.capabilities.saveMCP({ id: 'bad', command: 'x', env: { TOKEN: 'not a credential name!' } }), /invalid_mcp_configuration/);
  } finally { release(); await core.close(); server.closeAllConnections(); server.close(); await removeTemp(dir); }
});
