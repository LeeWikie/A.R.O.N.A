import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { taskLifecyclePageSchema } from '../src/protocol.js';
import { removeTemp } from './helpers.js';

test('task lifecycle pages traverse associated runs without exposing native payloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-task-events-'));
  const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    const task = core.runtime.createTask({title:'Fixture',content:'Fixture',contextId:'worker',returnContextId:'main',sourceSignalIds:[],runIds:['run-a','run-b']});
    for (let i = 0; i < 120; i++) core.runtime.event({contextId:'worker',kind:'message_update',data:{reasoning:'fixture-secret'}});
    core.runtime.event({contextId:'worker',taskId:task.id,runId:'run-a',kind:'agent_start',data:{type:'agent_start',secret:'fixture-secret'}});
    core.runtime.event({contextId:'worker',runId:'run-a',kind:'message_update',data:{reasoning:'fixture-secret'}});
    core.runtime.event({contextId:'worker',runId:'run-a',kind:'agent_end',data:{type:'agent_end',reason:'complete',secret:'fixture-secret'}});
    core.runtime.event({contextId:'worker',runId:'run-b',kind:'agent_start',data:{}});
    core.runtime.event({contextId:'other',runId:'run-b',kind:'agent_end',data:{reason:'error'}});
    core.runtime.event({contextId:'worker',runId:'other-run',kind:'agent_end',data:{reason:'error'}});
    const app = createApp(core); const headers = {authorization:`Bearer ${core.controlToken}`};
    assert.equal((await app.request(`/tasks/${task.id}/events`)).status,401);
    const seen: string[] = []; let after = 0;
    for (;;) {
      const response = await app.request(`/tasks/${task.id}/events?limit=1&after=${after}`, {headers});
      assert.equal(response.status,200); const text = await response.text(); assert.ok(!text.includes('fixture-secret'));
      const page = taskLifecyclePageSchema.parse(JSON.parse(text));
      seen.push(...page.events.map(event => `${event.runId}:${event.kind}`));
      if (!page.hasMore) break;
      assert.ok(page.nextCursor > after); after = page.nextCursor;
    }
    assert.deepEqual(seen,['run-a:agent_start','run-a:agent_end','run-b:agent_start']);
    assert.equal((await app.request(`/tasks/${task.id}/events?limit=0`,{headers})).status,400);
    assert.equal((await app.request('/tasks/missing/events',{headers})).status,404);
    assert.equal(core.runtime.taskEvents(task.id).filter(event=>event.kind==='agent_start').length,2);
    assert.deepEqual(core.taskDetails(task.id).events.map(event=>event.kind),['task_state','agent_start']);
  } finally { await core.close(); await removeTemp(dir); }
});

test('protocol handshake identifies a storage across restarts without leaking through health', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-protocol-'));
  let first = await Core.open({dataDir:dir,memoryEnabled:false});
  try {
    const app = createApp(first);
    assert.equal((await app.request('/protocol')).status, 401);
    assert.deepEqual(await (await app.request('/health')).json(), {status:'ok'});
    const firstId = first.instanceId, storageId = first.storageId;
    const response = await app.request('/protocol', {headers:{authorization:`Bearer ${first.controlToken}`}});
    assert.deepEqual(await response.json(), {protocolVersion:1,instanceId:firstId,storageId,capabilities:['task-lifecycle-pagination','snapshot','event-stream','conversation-history','provider-auth','foreground-interrupt','reply-stream','message-queue','context-branch','web-tools','attachments','file-deliveries','context-capacity']});
    await first.close();
    first = await Core.open({dataDir:dir,memoryEnabled:false});
    assert.notEqual(first.instanceId,firstId);
    assert.equal(first.storageId,storageId);
  } finally { await first.close(); await removeTemp(dir); }
});
