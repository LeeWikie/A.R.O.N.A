import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Capabilities } from '../src/capabilities.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { removeTemp } from './helpers.js';

async function fixture() {
  let entered!: () => void; let release!: () => void; let gated = true;
  const discovery = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const credentials = new Map([['FIXTURE_AUTH', 'synthetic-A']]); const auth: string[] = []; let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion: string } };
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    if (request.method === 'initialize') auth.push(String(req.headers['x-fixture-auth']));
    if (request.method === 'tools/list' && gated) { gated = false; entered(); await gate; }
    if (request.method === 'tools/call') calls++;
    const result = request.method === 'initialize' ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }] }
      : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'Fixture result' }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-identity-')); const db = new DatabaseSync(':memory:'); const runtime = new RuntimeStore(db);
  const capabilities = new Capabilities(runtime, dir, name => credentials.get(name), 'synthetic-salt');
  await capabilities.saveMCP({ id: 'fixture', url: `http://127.0.0.1:${address.port}`, protocolVersion: 'legacy', headersEnv: { 'x-fixture-auth': 'FIXTURE_AUTH' } });
  const context = runtime.createContext({ id: 'worker', name: 'Worker', role: 'work' });
  return { capabilities, runtime, credentials, discovery, release, context, auth, calls: () => calls, close: async () => { release(); await capabilities.close(); server.closeAllConnections(); server.close(); db.close(); await removeTemp(dir); } };
}

for (const rotation of ['credentials', 'configuration'] as const) {
  test(`MCP discovery rejects a client whose ${rotation} changed in flight`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    try {
      const pending = f.capabilities.connect('fixture',f.context); const checked = assert.rejects(pending, /mcp_connection_changed/);
      await f.discovery;
      if (rotation === 'credentials') f.credentials.set('FIXTURE_AUTH', 'synthetic-B');
      else f.runtime.setSetting('mcp', f.capabilities.mcpConfigs().map(config => ({ ...config, headersEnv: { 'x-next-auth': 'FIXTURE_AUTH' } })));
      f.release(); await checked;
      assert.deepEqual(f.capabilities.tools(true,f.context), {}); assert.equal(f.capabilities.mcpStatus(f.context)[0]?.connected, false); assert.equal(f.calls(), 0);
    } finally { await f.close(); }
  });
}

test('approval identity remains bound to the connected credentials and connect refreshes a stale client', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.release(); await f.capabilities.connect('fixture',f.context);
    const oldKey = f.capabilities.approvalKey(f.context, 'ext_fixture_read'); const oldConnection = f.capabilities.connectionScope('fixture',f.context); const oldTool = f.capabilities.tools(true,f.context).ext_fixture_read as { execute: (...args: unknown[]) => Promise<unknown> };
    f.credentials.set('FIXTURE_AUTH', 'synthetic-B');
    assert.notEqual(f.capabilities.connectionScope('fixture',f.context), oldConnection);
    assert.equal(f.capabilities.approvalKey(f.context, 'ext_fixture_read'), oldKey);
    assert.deepEqual(f.capabilities.mcpKeys(f.context), [], 'stale credentials cannot be inherited as live MCP authority');
    assert.equal(f.capabilities.mcpStatus(f.context)[0]?.connected, false);
    assert.equal(f.capabilities.mcpStatus(f.context)[0]?.requiresReconnect, true);
    assert.equal(f.capabilities.mcpStatus(f.context)[0]?.error, 'mcp_connection_changed');
    assert.deepEqual(f.capabilities.tools(true,f.context), {}, 'a new run must not discover tools whose connection identity is obsolete');
    await assert.rejects(oldTool.execute({}), /mcp_connection_changed/); assert.equal(f.calls(), 0);
    await f.capabilities.connect('fixture',f.context);
    assert.equal(f.capabilities.mcpStatus(f.context)[0]?.connected, true);
    assert.deepEqual(f.auth, ['synthetic-A', 'synthetic-B']);
    const newKey=f.capabilities.approvalKey(f.context, 'ext_fixture_read'); assert.notEqual(newKey,oldKey); assert.notEqual(newKey,f.capabilities.connectionScope('fixture',f.context)); assert.ok(f.capabilities.mcpKeys(f.context).includes(newKey)); assert.ok(f.capabilities.mcpKeys(f.context).includes(f.capabilities.connectionScope('fixture',f.context)));
    await assert.rejects(oldTool.execute({}), /mcp_connection_changed/); assert.equal(f.calls(), 0);
    await f.capabilities.disconnect('fixture'); assert.deepEqual(f.capabilities.mcpKeys(f.context), []);
  } finally { await f.close(); }
});

test('removing and recreating an MCP connection revokes saved scopes and old tool handles', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.release(); await f.capabilities.connect('fixture',f.context);
    const configuration = f.capabilities.mcpConfigs()[0]!;
    const previousKey = f.capabilities.connectionScope('fixture',f.context);
    const oldTool = f.capabilities.tools(true,f.context).ext_fixture_read as { execute: (...args: unknown[]) => Promise<unknown> };
    assert.deepEqual(await f.capabilities.removeMCP('fixture'), { removed: true });
    assert.deepEqual(f.capabilities.mcpConfigs(), []); assert.deepEqual(f.capabilities.tools(true,f.context), {}); assert.deepEqual(f.capabilities.mcpKeys(f.context), []);
    await assert.rejects(oldTool.execute({}), /mcp_connection_changed/);
    await f.capabilities.saveMCP(configuration); await f.capabilities.connect('fixture',f.context);
    assert.notEqual(f.capabilities.connectionScope('fixture',f.context), previousKey);
    assert.equal(f.capabilities.mcpKeys(f.context).includes(previousKey), false);
    await assert.rejects(oldTool.execute({}), /mcp_connection_changed/); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test('MCP missing credential diagnostics remain visible after connection setup fails', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.credentials.clear();
    await assert.rejects(f.capabilities.connect('fixture',f.context), /mcp_credentials_unavailable/);
    assert.equal(f.capabilities.mcpStatus(f.context)[0]?.error, 'mcp_credentials_unavailable');
    assert.equal(f.capabilities.mcpStatus(f.context)[0]?.connected, false);
    assert.deepEqual(f.capabilities.tools(true,f.context), {});
  } finally { await f.close(); }
});
