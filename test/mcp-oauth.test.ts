import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { until } from './helpers.js';
import { oauthFixture } from './mcp-oauth-fixture.js';
import { Capabilities } from '../src/capabilities.js';

test('MCP OAuth uses native PKCE and state callbacks, persists tokens, reconnects automatically and refreshes', { timeout: 40_000 }, async () => {
  const f = await oauthFixture();
  try {
    const started = await f.capabilities.startMcpAuth('fixture');
    const waiting = await until(() => f.capabilities.mcpAuthJob(started.id), job => job.status === 'awaiting-authorization');
    assert.ok(waiting.authorizationUrl); const authorization = new URL(waiting.authorizationUrl);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorization.searchParams.get('client_id'), 'synthetic-client');
    const spoof = new URL(authorization.searchParams.get('redirect_uri')!); spoof.searchParams.set('code', 'forged'); spoof.searchParams.set('state', 'wrong-state');
    assert.equal((await fetch(spoof)).ok, false); assert.equal(f.capabilities.mcpAuthJob(started.id).status, 'awaiting-authorization');
    assert.equal((await fetch(waiting.authorizationUrl)).ok, true);
    const completed = await until(() => f.capabilities.mcpAuthJob(started.id), job => ['succeeded', 'failed'].includes(job.status));
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
    assert.equal(completed.authorizationUrl, undefined); assert.equal(f.capabilities.mcpStatus()[0]?.connected, true);
    assert.equal(f.capabilities.mcpStatus()[0]?.authState, 'authorized');
    const authorizationScope=f.capabilities.connectionScope('fixture');
    const tool = f.capabilities.tools(true).ext_fixture_read_fixture as { execute: (args: unknown) => Promise<unknown> };
    assert.match(JSON.stringify(await tool.execute({})), /Authenticated synthetic result/);
    f.invalidateAccess();
    assert.match(JSON.stringify(await tool.execute({})), /Authenticated synthetic result/);
    assert.equal(f.refreshCount(), 1); assert.equal(f.toolCalls(), 2);
    assert.equal(f.capabilities.connectionScope('fixture'),authorizationScope,'a proven SDK token refresh keeps the original grant scope');
    assert.ok(f.captured.has('synthetic-access-1')); assert.ok(f.captured.has('synthetic-refresh-1'));
    const publicData = JSON.stringify([completed, f.capabilities.mcpStatus(), f.capabilities.mcpConfigs()]);
    assert.ok(!publicData.includes('synthetic-access-')); assert.ok(!publicData.includes('synthetic-refresh-'));
    const credentialFile = path.join(f.directory, 'credentials.json'); assert.equal(fs.statSync(credentialFile).mode & 0o777, 0o600);
    await f.capabilities.disconnect('fixture'); await f.capabilities.connect('fixture'); assert.equal(f.tokenCount(), 2, 'reconnection uses persisted refreshed credentials');assert.notEqual(f.capabilities.connectionScope('fixture'),authorizationScope,'explicit disconnection revokes grants while preserving the separately bound OAuth token session');
    await f.capabilities.logoutMcp('fixture'); assert.equal(f.capabilities.mcpStatus()[0]?.connected, false);
    await assert.rejects(tool.execute({}), /mcp_connection_changed/);
    assert.ok(!fs.readFileSync(credentialFile, 'utf8').includes('synthetic-access-'));
  } finally { await f.close(); }
});

test('MCP authorization cancellation closes the callback and never reconnects or publishes late credentials', { timeout: 30_000 }, async () => {
  const f = await oauthFixture();
  try {
    const started = await f.capabilities.startMcpAuth('fixture');
    const waiting = await until(() => f.capabilities.mcpAuthJob(started.id), job => job.status === 'awaiting-authorization');
    const callback = new URL(waiting.authorizationUrl!).searchParams.get('redirect_uri')!;
    const cancelled = await f.capabilities.cancelMcpAuth(started.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.authorizationUrl, undefined);
    await assert.rejects(fetch(callback)); assert.equal(f.tokenCount(), 0); assert.deepEqual(f.capabilities.tools(true), {});
    const retry = await f.capabilities.startMcpAuth('fixture'); assert.notEqual(retry.id, started.id);
    const next = await until(() => f.capabilities.mcpAuthJob(retry.id), job => job.status === 'awaiting-authorization');
    assert.ok(next.authorizationUrl); await f.capabilities.cancelMcpAuth(retry.id);
  } finally { await f.close(); }
});

test('cancelling while the token response is in flight does not publish late credentials', { timeout: 30_000 }, async () => {
  const f = await oauthFixture(); const gate = f.holdNextTokenResponse();
  try {
    const started = await f.capabilities.startMcpAuth('fixture');
    const waiting = await until(() => f.capabilities.mcpAuthJob(started.id), job => job.status === 'awaiting-authorization');
    await fetch(waiting.authorizationUrl!); await gate.entered;
    const cancellation = f.capabilities.cancelMcpAuth(started.id);
    await until(() => f.capabilities.mcpAuthJob(started.id), job => job.status === 'cancelled');
    gate.release(); assert.equal((await cancellation).status, 'cancelled');
    const file = path.join(f.directory, 'credentials.json');
    if (fs.existsSync(file)) { const stored = fs.readFileSync(file, 'utf8'); assert.ok(!stored.includes('synthetic-access-')); assert.ok(!stored.includes('synthetic-refresh-')); }
    assert.equal(f.capabilities.mcpStatus()[0]?.connected, false); assert.deepEqual(f.capabilities.tools(true), {});
  } finally { gate.release(); await f.close(); }
});

test('changing an MCP definition cancels its pending authorization and invalidates the old callback', { timeout: 30_000 }, async () => {
  const f = await oauthFixture();
  try {
    const started = await f.capabilities.startMcpAuth('fixture');
    const waiting = await until(() => f.capabilities.mcpAuthJob(started.id), job => job.status === 'awaiting-authorization');
    const previous = f.capabilities.mcpConfigs()[0]!;
    await f.capabilities.saveMCP({ ...previous, oauth: { ...previous.oauth!, clientId: 'different-client' } });
    assert.equal(f.capabilities.mcpAuthJob(started.id).status, 'cancelled');
    await assert.rejects(fetch(waiting.authorizationUrl!)); assert.equal(f.tokenCount(), 0);
    assert.deepEqual(f.capabilities.tools(true), {});
    const retried = await f.capabilities.startMcpAuth('fixture');
    const next = await until(() => f.capabilities.mcpAuthJob(retried.id), job => job.status === 'awaiting-authorization');
    assert.equal(new URL(next.authorizationUrl!).searchParams.get('client_id'), 'different-client');
    await f.capabilities.cancelMcpAuth(retried.id);
  } finally { await f.close(); }
});

test('a restarted connection uses persisted issuer-bound OAuth tokens without another browser flow', { timeout: 30_000 }, async () => {
  const f = await oauthFixture(); let restarted: Capabilities | undefined;
  try {
    const started = await f.capabilities.startMcpAuth('fixture');
    const waiting = await until(() => f.capabilities.mcpAuthJob(started.id), job => job.status === 'awaiting-authorization');
    await fetch(waiting.authorizationUrl!);
    assert.equal((await until(() => f.capabilities.mcpAuthJob(started.id), job => ['succeeded', 'failed'].includes(job.status))).status, 'succeeded');
    const authorizationScope=f.capabilities.connectionScope('fixture');
    await f.capabilities.close();
    restarted = new Capabilities(f.runtime, f.directory, () => undefined, 'synthetic-stable-control-token');
    await restarted.connect('fixture'); assert.equal(restarted.mcpStatus()[0]?.connected, true); assert.equal(f.tokenCount(), 1);
    assert.equal(restarted.connectionScope('fixture'),authorizationScope);
    await restarted.removeMCP('fixture');
    assert.ok(!fs.readFileSync(path.join(f.directory, 'credentials.json'), 'utf8').includes('synthetic-access-'));
  } finally { await restarted?.close(); await f.close(); }
});

test('a new browser grant and an unproven token edit cannot inherit an earlier MCP authorization scope',{timeout:30000},async()=>{
  const f=await oauthFixture();
  const authorize=async()=>{const job=await f.capabilities.startMcpAuth('fixture');const waiting=await until(()=>f.capabilities.mcpAuthJob(job.id),row=>row.status==='awaiting-authorization');await fetch(waiting.authorizationUrl!);assert.equal((await until(()=>f.capabilities.mcpAuthJob(job.id),row=>['succeeded','failed'].includes(row.status))).status,'succeeded');};
  try{
    await authorize();const original=f.capabilities.connectionScope('fixture'),old=f.capabilities.tools(true).ext_fixture_read_fixture as {execute:(input:unknown)=>Promise<unknown>};
    await f.capabilities.logoutMcp('fixture');await authorize();const renewed=f.capabilities.connectionScope('fixture');assert.notEqual(renewed,original);await assert.rejects(old.execute({}),/mcp_connection_changed/);
    const file=path.join(f.directory,'credentials.json'),credentials=JSON.parse(fs.readFileSync(file,'utf8')) as Record<string,string>;const key=Object.keys(credentials).find(name=>name.startsWith('MCP_OAUTH_')&&name.endsWith('_STATE'))!;
    const state=JSON.parse(credentials[key]!) as Record<string,string>;const tokenKey=Object.keys(state).find(name=>name==='tokens'||name.startsWith('tokens:'))!;const token=JSON.parse(state[tokenKey]!);token.access_token='synthetic-unproven-token';state[tokenKey]=JSON.stringify(token);credentials[key]=JSON.stringify(state);fs.writeFileSync(file,JSON.stringify(credentials));
    assert.notEqual(f.capabilities.connectionScope('fixture'),renewed);assert.deepEqual(f.capabilities.tools(true),{});assert.equal(f.toolCalls(),0);
  }finally{await f.close();}
});
