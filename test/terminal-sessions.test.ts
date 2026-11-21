import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { AppError } from '../src/domain.js';
import { coreLocation, writeCoreLocation } from '../src/startup.js';
import { directoryIdentity, type TerminalSessionRequest } from '../src/terminal-sessions.js';
import { openTerminalSession } from '../src/terminal-session-client.js';
import { assertProjectDirectory } from '../src/project-paths.js';
import { finished, removeTemp } from './helpers.js';

function model() {
  return new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'text' });
    controller.enqueue({ type: 'text-delta', id: 'text', delta: 'Synthetic project response.' }); controller.enqueue({ type: 'text-end', id: 'text' });
    controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
  } }) }) });
}
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-project-session-')), dataDir = path.join(directory, 'data'), a = path.join(directory, 'project A'), b = path.join(directory, '项目 B');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.writeFileSync(path.join(a, 'marker.txt'), 'A'); fs.writeFileSync(path.join(b, 'marker.txt'), 'B');
  const core = await Core.open({ dataDir, model: model(), memoryEnabled: false });
  const unpublish = writeCoreLocation(dataDir, 'http://127.0.0.1:12345', { storageId: core.storageId, instanceId: core.instanceId });
  const request = (cwd = a, mode: 'new' | 'continue' = 'new'): TerminalSessionRequest => ({ mode, target: { kind: 'local', directory: directoryIdentity(cwd), owner: coreLocation(dataDir)!.owner!, storageId: core.storageId, instanceId: core.instanceId } });
  return { core, directory, dataDir, a, b, request, close: async () => { unpublish(); await core.close(); await removeTemp(directory); } };
}

test('project opens are independent per client and never replace the shared default workspace', async () => {
  const f = await fixture();
  try {
    const defaultRoot = { ...f.core.capabilities.root('default') }, initial = f.core.runtime.contexts().length;
    const one = f.core.terminalSessions().open(f.request(), 'one'), two = f.core.terminalSessions().open(f.request(), 'two'), other = f.core.terminalSessions().open(f.request(f.b), 'other');
    assert.equal(one.status, 'available'); assert.notEqual(one.receipt.contextId, two.receipt.contextId); assert.notEqual(one.receipt.workspaceId, other.receipt.workspaceId);
    assert.equal(one.receipt.workspaceId, two.receipt.workspaceId); assert.deepEqual(f.core.capabilities.root('default'), defaultRoot);
    assert.deepEqual(f.core.terminalSessions().open(f.request(), 'one'), one); assert.equal(f.core.runtime.contexts().length, initial + 3);
    assert.throws(() => f.core.terminalSessions().open(f.request(f.b), 'one'), /operation_id_conflict/);
    assert.deepEqual((await f.core.browseSessions({ workspaceId: one.receipt.workspaceId })).sessions, []);
    const signal = await f.core.submitMessage({ contextId: one.receipt.contextId, content: 'Project A source.' }); await finished(f.core, signal.runId!);
    assert.deepEqual((await f.core.browseSessions({ workspaceId: one.receipt.workspaceId })).sessions.map(row => row.id), [one.receipt.contextId]);
    const continued = f.core.terminalSessions().open(f.request(f.a, 'continue'), 'continue-a'); assert.equal(continued.receipt.contextId, one.receipt.contextId); assert.equal(continued.receipt.created, false);
    const b = f.core.terminalSessions().open(f.request(f.b, 'continue'), 'continue-b'); assert.notEqual(b.receipt.contextId, one.receipt.contextId); assert.equal(b.receipt.created, true);
  } finally { await f.close(); }
});

test('automatic local registration requires the actual locator identity and an unchanged directory', async () => {
  const f = await fixture();
  try {
    const before = [f.core.capabilities.roots().length, f.core.runtime.contexts().length, f.core.runtime.eventHead()];
    const input = f.request(); assert.equal(input.target.kind, 'local'); if (input.target.kind !== 'local') throw Error();
    for (const field of ['owner', 'storageId', 'instanceId'] as const) {
      const changed = structuredClone(input); if (changed.target.kind !== 'local') throw Error(); changed.target[field] = 'a19cfb15-7c6d-4c77-a0cf-4fb76a4e7aa1';
      assert.throws(() => f.core.terminalSessions().open(changed, field), /local_workspace_identity_required/);
    }
    const changed = structuredClone(input); if (changed.target.kind !== 'local') throw Error(); changed.target.directory.ino += '1';
    assert.throws(() => f.core.terminalSessions().open(changed, 'inode'), /workspace_directory_changed/);
    assert.deepEqual([f.core.capabilities.roots().length, f.core.runtime.contexts().length, f.core.runtime.eventHead()], before);
    const protectedRoot=path.join(f.directory,'.private');fs.mkdirSync(protectedRoot);
    assert.throws(()=>f.core.terminalSessions().open(f.request(protectedRoot),'protected'),/workspace_directory_protected/);
    assert.deepEqual([f.core.capabilities.roots().length, f.core.runtime.contexts().length, f.core.runtime.eventHead()], before);
    const link = path.join(f.directory, 'alias'); fs.symlinkSync(f.a, link, process.platform === 'win32' ? 'junction' : 'dir');
    const one = f.core.terminalSessions().open(f.request(f.a), 'canonical'), alias = f.core.terminalSessions().open(f.request(link), 'alias'); assert.equal(one.receipt.workspaceId, alias.receipt.workspaceId);
  } finally { await f.close(); }
});

test('workspace/context creation, its receipt and visible events roll back as one operation', async () => {
  const f = await fixture();
  try {
    const roots = f.core.capabilities.roots(), contexts = f.core.runtime.contexts(), head = f.core.runtime.eventHead();
    f.core.store.db.exec("CREATE TRIGGER fail_terminal_receipt BEFORE INSERT ON runtime_operations WHEN NEW.id='terminal-session:atomic' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    assert.throws(() => f.core.terminalSessions().open(f.request(), 'atomic'), /synthetic receipt failure/);
    assert.deepEqual(f.core.capabilities.roots(), roots); assert.deepEqual(f.core.runtime.contexts(), contexts); assert.equal(f.core.runtime.eventHead(), head);
    f.core.store.db.exec('DROP TRIGGER fail_terminal_receipt'); const result = f.core.terminalSessions().open(f.request(), 'atomic'); assert.equal(result.status, 'available');
    assert.deepEqual(f.core.terminalSessions().get('atomic'), result);
    f.core.runtime.updateContext(result.receipt.contextId, { archived: true }); assert.equal(f.core.terminalSessions().get('atomic').status, 'context_unavailable');
  } finally { await f.close(); }
});

class EmbeddedClient extends Client {
  drop = false;
  constructor(private readonly current: () => Core) { super('http://127.0.0.1:12345', current().controlToken); }
  override async request<T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> {
    const core = this.current(), headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${core.controlToken}`);
    const response = await createApp(core).request(route, { ...init, headers }); const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new AppError(value.error ?? 'request_failed', response.status);
    if (route === '/terminal/sessions' && this.drop) { this.drop = false; throw new AppError('connection_failed', 502); }
    return value;
  }
}

test('the client recovers a lost creation response and Core restart from the same durable receipt', async () => {
  const f = await fixture(); let current = f.core, cleanup: (() => void) | undefined;
  try {
    const client = new EmbeddedClient(() => current), env = { SHITTIMCHEST_DATA_DIR: f.dataDir };
    client.drop = true;
    const one = await openTerminalSession(client, { env, cwd: f.a, operationId: 'same-local-launch' }); const count = current.runtime.contexts().length;
    assert.deepEqual(await openTerminalSession(client, { env, cwd: f.a, operationId: 'same-local-launch' }), one); assert.equal(current.runtime.contexts().length, count);
    await current.close(); current = await Core.open({ dataDir: f.dataDir, model: model(), memoryEnabled: false });
    cleanup = writeCoreLocation(f.dataDir, 'http://127.0.0.1:12345', { storageId: current.storageId, instanceId: current.instanceId });
    assert.deepEqual(await openTerminalSession(client, { env, cwd: f.a, operationId: 'same-local-launch' }), one); assert.equal(current.runtime.contexts().length, count);
    await assert.rejects(openTerminalSession(client, { env, cwd: f.b, operationId: 'same-local-launch' }), /operation_id_conflict/);
    const explicit = await openTerminalSession(client, { env, contextId: one.contextId, cwd: f.b }); assert.equal(explicit.contextId, one.contextId);
  } finally { cleanup?.(); if (current !== f.core) await current.close(); await f.close(); }
});

test('explicit remote connections select only configured server workspaces and ignore local cwd', async () => {
  const f = await fixture();
  try {
    const client = new EmbeddedClient(() => f.core), original = f.core.capabilities.roots();
    const result = await openTerminalSession(client, { env: { SHITTIMCHEST_CORE_URL: client.baseURL }, cwd: path.join(f.directory, 'does-not-exist'), workspaceId: 'default', operationId: 'remote' });
    assert.equal(f.core.runtime.context(result.contextId)!.workspaceId, 'default'); assert.deepEqual(f.core.capabilities.roots(), original);
    await assert.rejects(openTerminalSession(client, { env: { SHITTIMCHEST_CORE_URL: client.baseURL }, workspaceId: 'missing', operationId: 'unknown' }), /workspace_not_found/);
  } finally { await f.close(); }
});

test('a replaced project directory cannot revive an old receipt or its implicit workspace identity', async () => {
  const f=await fixture();
  try{
    const original=f.core.terminalSessions().open(f.request(),'original');
    fs.renameSync(f.a,f.a+'.original');fs.mkdirSync(f.a);fs.writeFileSync(path.join(f.a,'marker.txt'),'REPLACEMENT');
    const unavailable=f.core.terminalSessions().get('original');assert.equal(unavailable.status,'directory_changed');assert.deepEqual(unavailable.receipt,original.receipt);
    const fresh=f.core.terminalSessions().open(f.request(),'replacement');assert.equal(fresh.status,'available');assert.notEqual(fresh.receipt.contextId,original.receipt.contextId);assert.notEqual(fresh.receipt.workspaceId,original.receipt.workspaceId);
    assert.equal(f.core.runtime.context(original.receipt.contextId)!.workspaceId,original.receipt.workspaceId);
    assert.equal(fs.readFileSync(path.join(f.a+'.original','marker.txt'),'utf8'),'A');
  }finally{await f.close();}
});

test('a source rolled back by SQLite cannot publish an empty editor as a persisted session', async () => {
  const f=await fixture();
  try{
    const contextId=f.core.terminalSessions().open(f.request(),'empty').receipt.contextId;
    assert.equal(f.core.terminalSessions().visible(contextId),false);
    f.core.store.db.exec('BEGIN IMMEDIATE');
    try{
      f.core.store.db.prepare('INSERT INTO signals(id,body,status,created_at) VALUES(?,?,?,?)').run('synthetic-rollback-source',JSON.stringify({contextId}),'received',new Date().toISOString());
      assert.equal(f.core.terminalSessions().visible(contextId),true);
    }finally{f.core.store.db.exec('ROLLBACK');}
    assert.equal(f.core.terminalSessions().visible(contextId),false);
    const source=await f.core.submitMessage({contextId,content:'This accepted source is durable.'});await finished(f.core,source.runId!);
    assert.equal(f.core.terminalSessions().visible(contextId),true);
  }finally{await f.close();}
});

test('project discovery binds the actual context and physical directory across aliases and configuration changes',async()=>{
  const f=await fixture();
  try{
    const opened=f.core.terminalSessions().open(f.request(),'project-discovery'),id=opened.receipt.contextId,project=f.core.projectDirectory(id);
    assert.equal(project.contextId,id);assert.equal(project.workspaceId,opened.receipt.workspaceId);assert.deepEqual(project.directory,directoryIdentity(f.a));
    const app=createApp(f.core),route=`/contexts/${id}/project-directory`;
    assert.equal((await app.request(route)).status,401);
    assert.equal((await app.request(route,{headers:{Authorization:`Bearer ${f.core.controlToken}`}})).status,409);
    assert.deepEqual(await(await app.request(route,{headers:{Authorization:`Bearer ${f.core.controlToken}`,'X-ShittimChest-Storage-Id':f.core.storageId,'X-ShittimChest-Instance-Id':f.core.instanceId}})).json(),project);
    f.core.runtime.updateContext(id,{name:'Renamed conversation'});assert.equal(f.core.projectDirectory(id).revision,project.revision);
    const root=f.core.capabilities.root(project.workspaceId);await f.core.updateWorkspace(root.id,{expectedPath:root.path,path:f.b});
    assert.throws(()=>assertProjectDirectory(f.core,id,project),/project_directory_changed/);
    assert.equal(f.core.terminalSessions().get('project-discovery').status,'workspace_changed');
    assert.deepEqual(f.core.projectDirectory(id).directory,directoryIdentity(f.b));
  }finally{await f.close();}
});
