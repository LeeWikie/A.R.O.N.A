import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {noopObserve} from '@mastra/core/tools';
import { Capabilities } from '../src/capabilities.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { removeTemp } from './helpers.js';
import { mcpResourcesFixture } from './mcp-resources-fixture.js';

async function fixture() {
  const remote = await mcpResourcesFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-resources-')); const db = new DatabaseSync(':memory:'); const runtime = new RuntimeStore(db); const credentials = new Map([['FIXTURE_AUTH', 'synthetic-A']]);
  const capabilities = new Capabilities(runtime, directory, key => credentials.get(key));
  await capabilities.saveMCP({ ...remote.configuration, headersEnv: { 'x-fixture-auth': 'FIXTURE_AUTH' } }); await capabilities.connect('source');
  const context = runtime.createContext({ id: 'worker', name: 'Worker', role: 'work' });
  return { capabilities, credentials, context, remote, async close() { await capabilities.close(); await remote.close(); db.close(); await removeTemp(directory); } };
}

test('native MCP resources, URI templates and prompts preserve their source and typed contents', async () => {
  const f = await fixture();
  try {
    const resources = await f.capabilities.mcpResources('source'); assert.equal(resources.resources[0]?.uri, 'fixture://notes/main');
    assert.deepEqual(resources.templates[0]?.variables, ['name', 'q']); assert.equal(resources.source.external, true);
    const text = await f.capabilities.readMcpResource('source', 'fixture://notes/main'); const textPart = text.contents[0]; assert.ok(textPart && 'text' in textPart); assert.equal(textPart.text, 'Synthetic external notes: fixture://notes/main');
    const binary = await f.capabilities.readMcpResource('source', 'fixture://notes/binary'); const binaryPart = binary.contents[0]; assert.ok(binaryPart && 'blob' in binaryPart); assert.equal(binaryPart.blob, 'AAEC');
    const expanded = await f.capabilities.readMcpResourceTemplate('source', 'fixture://notes/{name}{?q}', { name: '中文 notes', q: 'a&b' });
    assert.equal(expanded.uri, 'fixture://notes/%E4%B8%AD%E6%96%87%20notes?q=a%26b'); assert.equal(expanded.contents[0]?.uri, expanded.uri);
    const reserved = await f.capabilities.readMcpResourceTemplate('source', 'fixture://notes/{+path}', { path: 'a/b' }); assert.equal(reserved.uri, 'fixture://notes/a/b');
    await assert.rejects(f.capabilities.readMcpResourceTemplate('source', 'fixture://unknown/{name}', { name: 'x' }), /mcp_resource_template_not_found/);
    const prompts = await f.capabilities.mcpPrompts('source'); assert.equal(prompts[0]?.arguments?.[0]?.required, true);
    const prompt = await f.capabilities.getMcpPrompt('source', 'review', { topic: 'fixture' }); assert.equal(prompt.authority, 'external-template-data'); assert.equal(prompt.source.external, true);
    assert.ok(prompt.messages[0]?.content.type === 'text' && prompt.messages[0].content.text.includes('Review fixture'));
  } finally { await f.close(); }
});

test('resource tool approvals bind the selected server and all frozen tool handles expire after identity changes', async () => {
  const f = await fixture();
  try {
    assert.equal(f.capabilities.approvalCapability(f.context,'read_mcp_resource',{serverId:'source',uri:'fixture://notes/main'}),null,'admin connection does not grant workspace execution');await f.capabilities.prepareMcp(f.context);
    const tools = f.capabilities.tools(true,f.context); const input = { serverId: 'source', uri: 'fixture://notes/main' };
    const key = f.capabilities.connectionScope('source',f.context); assert.equal(f.capabilities.approvalKey(f.context, 'read_mcp_resource', input), key);
    assert.equal(f.capabilities.approvalCapability(f.context, 'read_mcp_resource', input), 'mcp');
    const tool = tools.read_mcp_resource as { execute: (args: typeof input) => Promise<unknown> };
    assert.match(JSON.stringify(await tool.execute(input)), /Synthetic external notes/);
    f.credentials.set('FIXTURE_AUTH', 'synthetic-B');
    await assert.rejects(tool.execute(input), /mcp_connection_changed/);
    assert.deepEqual(f.capabilities.tools(true,f.context), {});
    await f.capabilities.connect('source',f.context); await assert.rejects(tool.execute(input), /mcp_connection_changed/);
    assert.equal((await f.capabilities.readMcpResource('source', input.uri,f.context)).source.serverId, 'source');
    await f.capabilities.disconnect('source'); await assert.rejects(f.capabilities.mcpResources('source',f.context), /mcp_not_connected/);
  } finally { await f.close(); }
});

test('a resource response cannot be published for a replaced connection', async () => {
  const f = await fixture(); const held = f.remote.holdNextRead();
  try {
    const pending = f.capabilities.readMcpResource('source', 'fixture://notes/main'); const checked = assert.rejects(pending, /mcp_connection_changed/);
    await held.entered;
    await f.capabilities.saveMCP({ ...f.remote.configuration, headersEnv: { 'x-fixture-auth': 'FIXTURE_AUTH' } });
    held.release(); await checked; assert.deepEqual(f.capabilities.tools(true), {});
  } finally { held.release(); await f.close(); }
});

test('all-server catalog snapshots bind the complete workspace member set and invalidate captured aggregate handles without expanding old keys',async()=>{
 const f=await fixture();try{
  await f.capabilities.prepareMcp(f.context);const before=f.capabilities.mcpCatalogScope(f.context,'list_mcp_resources'),oldKeys=f.capabilities.mcpKeys(f.context),frozen=[...oldKeys];assert.deepEqual(before.members,[{serverId:'source',connectionKey:f.capabilities.connectionScope('source',f.context)}]);assert.ok(oldKeys.includes(before.capabilityKey));assert.equal(f.capabilities.approvalKey(f.context,'list_mcp_resources',{}),before.capabilityKey);assert.equal(f.capabilities.approvalKey(f.context,'list_mcp_resources',{serverId:'source'}),before.members[0]!.connectionKey);assert.equal(f.capabilities.normalizeMcpToolArgs(f.context,'list_mcp_resources',{cursor:'cursor-without-source'}).error,true);
  const raw=f.capabilities.tools(true,f.context).list_mcp_resources;assert.ok(raw&&'execute'in raw&&typeof raw.execute==='function');const old=()=>Promise.resolve(Reflect.apply(raw.execute!,raw,[{},{observe:noopObserve}]));assert.match(JSON.stringify(await old()),/fixture:\/\/notes\/main/);
  await f.capabilities.saveMCP({...f.remote.configuration,id:'second',headersEnv:{'x-fixture-auth':'FIXTURE_AUTH'}});await f.capabilities.connect('second',f.context);const after=f.capabilities.mcpCatalogScope(f.context,'list_mcp_resources');assert.deepEqual(after.members.map(member=>member.serverId),['second','source']);assert.notEqual(after.capabilityKey,before.capabilityKey);assert.equal(oldKeys.includes(after.capabilityKey),false);assert.deepEqual(oldKeys,frozen,'new catalogs do not mutate the saved task snapshot');await assert.rejects(old(),/mcp_connection_changed/);
 }finally{await f.close();}
});
