import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { Core } from '../src/core.js';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { until, finished, removeTemp } from './helpers.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arona-acceptance-'));
type Action = { toolName: string; input: unknown };
function model(choose: (request: LanguageModelV2CallOptions) => Action | undefined | Promise<Action | undefined>) {
  let call = 0;
  return new MastraLanguageModelV2Mock({ doStream: async request => {
    const action = await choose(request);
    const id = `acceptance-${++call}`;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (action) controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: action.toolName, input: JSON.stringify(action.input) });
      else { controller.enqueue({ type: 'text-start', id }); controller.enqueue({ type: 'text-delta', id, delta: 'final-native-answer' }); controller.enqueue({ type: 'text-end', id }); }
      controller.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
}
function taskIn(request: LanguageModelV2CallOptions) {
  if (!request.tools?.some(tool => tool.name === 'task_report')) return;
  const texts = request.prompt.filter(message => message.role === 'user').flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []));
  const text = texts.at(-1) ?? '';
  return { id: /"taskId":"([0-9a-f-]{36})/.exec(text)?.[1], signalId: /signal_id="([0-9a-f-]{36})/.exec(text)?.[1], text };
}
const report = (summary = 'Actual synthetic work completed.') => ({ outcome: 'succeeded', summary, checks: [{ description: 'Checked the observable fixture', passed: true }], deliveries: [], unresolved: [] });

test('full context passes every history page, survives restart and separates request from terminal snapshot', { timeout: 40_000 }, async () => {
  const dir = temp(); const prompts: string[] = [];
  const fixtureModel = model(request => { prompts.push(JSON.stringify(request.prompt)); return undefined; });
  const ids = Array.from({ length: 245 }, () => randomUUID());
  const storage = new LibSQLStore({ id: 'arona-storage', url: 'file:' + path.join(dir, 'history.sqlite').replaceAll('\\', '/') });
  await storage.init();
  const memory = new Memory({ storage, options: { lastMessages: false, generateTitle: false, semanticRecall: false, workingMemory: { enabled: false } } });
  try {
    await memory.createThread({ threadId: 'main', resourceId: 'local' });
    await memory.saveMessages({ messages: ids.map((id, index) => ({ id, resourceId: 'local', threadId: 'main', role: 'user', createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)), content: { format: 2, parts: [{ type: 'text', text: `original-line-${index}-exact` }] } })) });
  } finally { await storage.close(); }
  let core = await Core.open({ dataDir: dir, model: fixtureModel, memoryEnabled: false });
  try {
    const first = await core.submitSignal({ version: 2, source: 'fixture', type: 'user-message', content: 'first appended input' });
    await finished(core, first.runId!);
    assert.ok(ids.every((_, index) => prompts[0]!.includes(`original-line-${index}-exact`)));
    const snapshot = core.projectMemory.snapshot(first.runId!);
    assert.ok(!JSON.stringify(snapshot.lastRequestPrompt).includes('final-native-answer'));
    assert.ok(JSON.stringify(snapshot.prompt).includes('final-native-answer'));
    await core.close();
    core = await Core.open({ dataDir: dir, model: fixtureModel, memoryEnabled: false });
    const second = await core.submitSignal({ version: 2, source: 'fixture', type: 'user-message', content: 'second appended input' });
    await finished(core, second.runId!);
    const prompt = prompts.at(-1)!;
    assert.ok(ids.every((_, index) => prompt.includes(`original-line-${index}-exact`)));
    assert.ok(prompt.includes('first appended input') && prompt.includes('second appended input'));
    const seen: string[] = [];
    for (let page = 0; ; page++) { const result = await core.memory.recall({ threadId: 'main', page, perPage: 100, hideSignals: false }); seen.push(...result.messages.map(message => message.id)); if (!result.hasMore) break; }
    for (const id of ids) assert.equal(seen.filter(value => value === id).length, 1);
  } finally { await core.close(); await removeTemp(dir); }
});

test('queued supplements wait for native capacity and cancellation/resume does not replay the earlier attempt', { timeout: 40_000 }, async () => {
  const dir = temp(); let core!: Core; let firstTask: string | undefined; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const turns = new Map<string, number>(); const prompts: string[] = [];
  const fixtureModel = model(async request => {
    const source = taskIn(request); if (!source?.id) return;
    const task = core.runtime.task(source.id); const key = `${task.id}:${task.attempt}`; const phase = turns.get(key) ?? 0; turns.set(key, phase + 1);
    prompts.push(JSON.stringify(request.prompt));
    if (!firstTask) firstTask = task.id;
    if (task.id === firstTask && task.attempt === 1) await gate;
    if (phase === 0) return { toolName: 'task_report', input: { id: task.id, report: report() } };
  });
  core = await Core.open({ dataDir: dir, model: fixtureModel, memoryEnabled: false, concurrency: 1 });
  try {
    const first = await core.submitTask({ title: 'First', content: 'First fixture' }, 'first');
    await until(() => firstTask, Boolean);
    const second = await core.submitTask({ title: 'Second', content: 'Second fixture' }, 'second');
    assert.equal(core.runtime.task(second.id).status, 'pending');
    const supplement = await core.taskMessage(second.id, 'queued-color-green', []);
    assert.equal(supplement.status, 'queued');
    assert.equal(core.runtime.task(second.id).runIds.length, 0);
    const paused = await core.tasks.control(first.id, 'pause', core.runtime.task(first.id).revision);
    await until(() => core.runtime.task(first.id), task => task.status === 'paused');
    release();
    const done = await until(() => core.runtime.task(second.id), task => task.status === 'succeeded');
    assert.ok(prompts.some(prompt => prompt.includes('queued-color-green')));
    const resumed = await core.tasks.control(first.id, 'resume', core.runtime.task(first.id).revision);
    assert.equal(resumed.attempt, 2);
    await until(() => core.runtime.task(first.id), task => task.status === 'succeeded');
    assert.notEqual(core.runtime.task(first.id).signalId, first.signalId);
    assert.equal(done.runIds.length, 1);
    assert.ok(['pausing', 'paused'].includes(paused.status));
  } finally { release(); await core.close(); await removeTemp(dir); }
});

test('child work and parent continuation share native capacity without waking unmanaged work runs', { timeout: 40_000 }, async () => {
  const dir = temp(); let core!: Core; const turns = new Map<string, number>(); const violations: string[] = [];
  const fixtureModel = model(async request => {
    const source = taskIn(request); if (!source?.id) return;
    const task = core.runtime.task(source.id);
    const native = await core.sessions.controller.getMastra()!.backgroundTaskManager!.listTasks({ agentId: 'work-execution', status: 'running' });
    if (!native.tasks.some(job => job.args.taskId === task.id)) violations.push(task.id);
    const key = `${task.id}:${task.attempt}`; const phase = turns.get(key) ?? 0; turns.set(key, phase + 1);
    if (phase !== 0) return;
    if (task.title === 'Parent' && task.attempt === 1) return { toolName: 'task_create', input: { signalIds: [source.signalId], task: { title: 'Child', content: 'Child fixture' } } };
    if (task.title === 'Parent') assert.ok(JSON.stringify(request.prompt).includes('Child completed with evidence'));
    return { toolName: 'task_report', input: { id: task.id, report: report(task.title === 'Child' ? 'Child completed with evidence' : 'Parent inspected the child result') } };
  });
  core = await Core.open({ dataDir: dir, model: fixtureModel, memoryEnabled: false, concurrency: 1 });
  try {
    const parent = await core.submitTask({ title: 'Parent', content: 'Delegate a bounded child then finish' }, 'parent');
    const result = await until(() => core.runtime.task(parent.id), task => task.status === 'succeeded');
    assert.equal(result.attempt, 2);
    const children = core.runtime.tasks().filter(task => task.parentId === parent.id);
    assert.equal(children.length, 1); assert.equal(children[0]?.status, 'succeeded');
    assert.notEqual(children[0]?.contextId, parent.contextId);
    assert.deepEqual(violations, []);
  } finally { await core.close(); await removeTemp(dir); }
});

test('only definitely unadmitted pending tasks restart automatically', { timeout: 40_000 }, async () => {
  const dir = temp(); const database = new Store(path.join(dir, 'records.sqlite')); const runtime = new RuntimeStore(database.db);
  runtime.createContext({ id: 'main', name: 'Main', role: 'main' }); runtime.createContext({ id: 'pending-work', name: 'Pending', role: 'work' }); runtime.createContext({ id: 'uncertain-work', name: 'Uncertain', role: 'work' });
  const pending = runtime.createTask({ title: 'Safe pending', content: 'Never admitted fixture', contextId: 'pending-work', returnContextId: 'main', sourceSignalIds: [] });
  const uncertain = runtime.createTask({ title: 'Uncertain', content: 'Could have side effects', contextId: 'uncertain-work', returnContextId: 'main', sourceSignalIds: [] });
  runtime.updateTask(uncertain.id, { status: 'running' }); database.close();
  let core!: Core; const called: string[] = []; const reported = new Set<string>();
  core = await Core.open({ dataDir: dir, memoryEnabled: false, model: model(request => { const source = taskIn(request); if (!source?.id) return; called.push(source.id); if (!reported.has(source.id)) { reported.add(source.id); return { toolName: 'task_report', input: { id: source.id, report: report() } }; } }) });
  try {
    await until(() => core.runtime.task(pending.id), task => task.status === 'succeeded');
    assert.equal(core.runtime.task(uncertain.id).status, 'interrupted');
    assert.ok(!called.includes(uncertain.id));
  } finally { await core.close(); await removeTemp(dir); }
});

test('stale native approvals never mutate task grants', async () => {
  const dir = temp(); const core = await Core.open({ dataDir: dir, memoryEnabled: false });
  try {
    const context = core.createWorkContext({ name: 'Approval fixture' });
    const task = core.runtime.createTask({ title: 'Fixture', content: 'Fixture', contextId: context.id, returnContextId: 'main', sourceSignalIds: [] });
    core.runtime.addApproval({ id: 'stale', contextId: context.id, taskId: task.id, runId: 'past-run', toolCallId: 'past-call', toolName: 'configuration_update', args: {}, status: 'pending', createdAt: new Date().toISOString() });
    await assert.rejects(core.approve('stale', 'approve', 'task'), /approval_not_active/);
    assert.deepEqual(core.runtime.task(task.id).grants, { write: false, execute: false, mcp: false });
    assert.equal(core.runtime.approval('stale').status, 'pending');
  } finally { await core.close(); await removeTemp(dir); }
});


test('model and thinking configuration are frozen inside a run and change on the next run', {timeout:40_000}, async()=>{
  const dir=temp();const received:{model:string;reasoning_effort?:string}[]=[];let signalSeen!:()=>void;let release!:()=>void;
  const seen=new Promise<void>(resolve=>{signalSeen=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);received.push(body);const call=received.length;
    if(call===1){signalSeen();await gate;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const delta=call===1?{role:'assistant',tool_calls:[{index:0,id:'catalog-call',type:'function',function:{name:'model_list',arguments:'{}'}}]}:{role:'assistant',content:'fixture answer'};
    res.end([{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:call===1?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}].map(data=>'data: '+JSON.stringify({id:'fixture-'+call,object:'chat.completion.chunk',created:1,model:body.model,...data})+'\n\n').join('')+'data: [DONE]\n\n');
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const baseURL=`http://127.0.0.1:${address.port}/v1`;
  const core=await Core.open({dataDir:dir,memoryEnabled:false,modelConfig:{protocol:'chat-completions',baseURL,modelId:'initial-model',apiKey:'fixture-only',authHeader:'bearer',reasoningEffort:'low'}});
  try{
    const first=await core.submitSignal({version:2,source:'fixture',type:'user-message',content:'Read the catalog'});await seen;
    core.credentials.set('FIXTURE_NEXT','fixture-only-next');core.models.save({id:'default',name:'Next',protocol:'chat-completions',baseURL,modelId:'next-model',apiKeyEnv:'FIXTURE_NEXT',thinking:{high:{reasoningEffort:'high'}}});
    await core.switchModel('main','default','high');release();await finished(core,first.runId!);
    assert.deepEqual(received.slice(0,2).map(body=>[body.model,body.reasoning_effort]),[['initial-model','low'],['initial-model','low']]);
    const second=await core.submitSignal({version:2,source:'fixture',type:'user-message',content:'Now use the new configuration'});await finished(core,second.runId!);
    assert.equal(received.at(-1)?.model,'next-model');assert.equal(received.at(-1)?.reasoning_effort,'high');
    core.models.save({id:'plain',name:'No thinking override',protocol:'chat-completions',baseURL,modelId:'plain-model',apiKeyEnv:'FIXTURE_NEXT'});
    await core.switchModel('main','plain');
    const third=await core.submitSignal({version:2,source:'fixture',type:'user-message',content:'Use plain defaults'});await finished(core,third.runId!);
    assert.equal(received.at(-1)?.model,'plain-model');assert.equal(received.at(-1)?.reasoning_effort,undefined);
    assert.throws(()=>core.configure('runtime',{defaultWorkModel:'same'}),/model_profile_not_found/);
  }finally{release();await core.close();server.closeAllConnections();server.close();await removeTemp(dir);}
});

test('V2 duties keep one context, report overlapping tasks individually and skip downtime', {timeout:40_000}, async()=>{
  const dir=temp();let now=Date.parse('2026-11-02T00:00:00Z');let core!:Core;let release!:()=>void;let gated=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});const clock={now:()=>now,setTimeout:()=>0 as unknown as ReturnType<typeof setTimeout>,clearTimeout:()=>{}};
  const fixtureModel=model(async request=>{
    const source=taskIn(request);if(!source?.id)return;
    if(!gated){gated=true;await gate;}
    const current=core.runtime.task(source.id);
    const task=core.runtime.tasks({contextId:current.contextId}).find(task=>['running','waiting'].includes(task.status)&&!task.report);
    if(task)return {toolName:'task_report',input:{id:task.id,report:report('One independently checked duty occurrence')}};
  });
  core=await Core.open({dataDir:dir,model:fixtureModel,memoryEnabled:false,clock,concurrency:2});
  try{
    const duty=core.scheduleCreate({version:2,name:'Duty fixture',task:'Inspect synthetic duty data',timing:{kind:'interval',anchorAt:new Date(now+1000).toISOString(),everyMs:1000}},'duty-fixture','main');
    assert.notEqual(duty.contextId,'main');
    now+=1000;core.schedules.tick();await core.schedules.drain();await until(()=>gated,Boolean);
    now+=1000;core.schedules.tick();await core.schedules.drain();
    await until(()=>core.runtime.tasks({contextId:duty.contextId}),tasks=>tasks.length===2&&tasks.every(task=>task.runIds.length>0));
    assert.ok(core.schedules.occurrences(duty.id).every(item=>item.report.status==='pending'));
    release();await until(()=>core.runtime.tasks({contextId:duty.contextId}),tasks=>tasks.length===2&&tasks.every(task=>task.status==='succeeded'));
    assert.ok(core.schedules.occurrences(duty.id).every(item=>item.report.status==='succeeded'));
    assert.equal(new Set(core.runtime.tasks({contextId:duty.contextId}).flatMap(task=>task.runIds)).size,1);
    await core.close();now+=10_000;core=await Core.open({dataDir:dir,model:fixtureModel,memoryEnabled:false,clock});
    assert.equal(core.schedules.occurrences(duty.id).length,2);
    now+=1000;core.schedules.tick();await core.schedules.drain();
    await until(()=>core.runtime.tasks({contextId:duty.contextId}),tasks=>tasks.length===3&&tasks.every(task=>task.status==='succeeded'));
    assert.equal(core.schedules.get(duty.id).contextId,duty.contextId);
  }finally{release();await core.close();await removeTemp(dir);}
});

test('failed notification processing stays durable until a successful later context observes it', {timeout:40_000},async()=>{
  const dir=temp();let core!:Core;let failMain=true;
  const fixtureModel=model(request=>{
    const source=taskIn(request);
    if(source?.id){const task=core.runtime.task(source.id);if(!task.report)return {toolName:'task_report',input:{id:task.id,report:report()}};return;}
    if(failMain)throw new Error('synthetic receiver unavailable');
  });
  core=await Core.open({dataDir:dir,model:fixtureModel,memoryEnabled:false});
  try{
    const task=await core.submitTask({title:'Result fixture',content:'Produce a result'},'notification-fixture');
    await until(()=>core.runtime.task(task.id),task=>task.status==='succeeded');
    const item=(await until(()=>core.runtime.pendingNotifications(),items=>items.length>0))[0]!;
    const id=await until(()=>core.runtime.setting<string|null>(`notification-signal:${item.id}`,null),Boolean);
    await until(()=>{const signal=core.store.getSignal(id!);return signal?.runId?core.store.getRun(signal.runId):undefined;},run=>run?.status==='failed');
    assert.ok(core.runtime.pendingNotifications().some(row=>row.id===item.id));
    failMain=false;const next=await core.submitSignal({version:2,source:'fixture',type:'user-message',content:'Review the pending result'});await finished(core,next.runId!);
    assert.ok(!core.runtime.pendingNotifications().some(row=>row.id===item.id));
  }finally{await core.close();await removeTemp(dir);}
});

test('legacy databases are backed up before recovery mutates state',async()=>{
  const dir=temp();const {DatabaseSync}=await import('node:sqlite');
  const legacy=new Store(path.join(dir,'records.sqlite'));
  const input={id:randomUUID(),contextId:'main',source:'fixture',type:'user-message' as const,content:'legacy original text',output:{kind:'message' as const,contextId:'main'}};
  legacy.receive(input);legacy.close();
  const oldHistory=new DatabaseSync(path.join(dir,'history.sqlite'));oldHistory.exec("CREATE TABLE legacy_fixture(value TEXT); INSERT INTO legacy_fixture VALUES('original fixture')");oldHistory.close();
  const core=await Core.open({dataDir:dir,memoryEnabled:false});
  try{
    const allBackups=fs.readdirSync(path.join(dir,'migration-backups'));
    const graphBackups=allBackups.filter(name=>name.startsWith('session-graph-'));
    const backups=allBackups.filter(name=>!name.startsWith('session-graph-'));
    assert.equal(allBackups.length,2);assert.equal(graphBackups.length,1);assert.equal(backups.length,1);
    const legacyDirectory=path.join(dir,'migration-backups',backups[0]!);
    assert.deepEqual(fs.readdirSync(legacyDirectory).sort(),['history.sqlite','records.sqlite']);
    const graphDirectory=path.join(dir,'migration-backups',graphBackups[0]!);
    const manifest=JSON.parse(fs.readFileSync(path.join(graphDirectory,'manifest.json'),'utf8')) as {format:string;version:number;files:Array<{name:string;sha256:string;integrity:string}>};
    assert.equal(manifest.format,'session-graph-migration-backup');assert.equal(manifest.version,1);
    assert.deepEqual(manifest.files.map(file=>file.name).sort(),['history.sqlite','records.sqlite']);
    for(const file of manifest.files){
      const target=path.join(graphDirectory,file.name);
      assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'),file.sha256);
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(legacyDirectory,file.name))).digest('hex'),file.sha256);
      assert.equal(file.integrity,'ok');
      const check=new DatabaseSync(target,{readOnly:true});
      try{
        assert.equal(check.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
        if(file.name==='records.sqlite'){
          assert.equal(check.prepare('SELECT status FROM signals WHERE id=?').get(input.id)?.status,'received');
          assert.equal(check.prepare('SELECT body FROM signals WHERE id=?').get(input.id)?.body,JSON.stringify(input));
        }else assert.equal(check.prepare('SELECT value FROM legacy_fixture').get()?.value,'original fixture');
      }finally{check.close();}
    }
    const backup=new DatabaseSync(path.join(dir,'migration-backups',backups[0]!,'records.sqlite'),{readOnly:true});
    try{assert.equal(backup.prepare('SELECT status FROM signals WHERE id=?').get(input.id)?.status,'received');assert.equal(backup.prepare('SELECT body FROM signals WHERE id=?').get(input.id)?.body,JSON.stringify(input));}finally{backup.close();}
    const history=new DatabaseSync(path.join(dir,'migration-backups',backups[0]!,'history.sqlite'),{readOnly:true});
    try{assert.equal(history.prepare('SELECT value FROM legacy_fixture').get()?.value,'original fixture');}finally{history.close();}
    assert.equal(core.store.getSignal(input.id)?.status,'interrupted');
  }finally{await core.close();await removeTemp(dir);}
});

test('public signals cannot bypass native task capacity by selecting a work context',async()=>{
  const dir=temp();let calls=0;const core=await Core.open({dataDir:dir,memoryEnabled:false,model:model(()=>{calls++;return undefined;})});
  try{
    const context=core.createWorkContext({name:'Managed work'});
    await assert.rejects(core.submitSignal({version:2,type:'user-message',source:'fixture',contextId:context.id,content:'Do work outside admission'}),/work_context_requires_task/);
    assert.equal(calls,0);
  }finally{await core.close();await removeTemp(dir);}
});

test('graceful shutdown leaves never-started native queue entries recoverable', {timeout:40_000},async()=>{
  const dir=temp();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let firstId:string|undefined;
  const calls:string[]=[];const reported=new Set<string>();
  const fixtureModel=model(async request=>{const source=taskIn(request);if(!source?.id)return;calls.push(source.id);if(!firstId){firstId=source.id;await gate;}if(!reported.has(source.id)){reported.add(source.id);return {toolName:'task_report',input:{id:source.id,report:report()}};}});
  let core=await Core.open({dataDir:dir,model:fixtureModel,memoryEnabled:false,concurrency:1});
  try{
    const first=await core.submitTask({title:'Active fixture',content:'Active synthetic work'},'active-before-shutdown');await until(()=>firstId,Boolean);
    const queued=await core.submitTask({title:'Queued fixture',content:'Not started'},'queued-before-shutdown');assert.equal(core.runtime.task(queued.id).status,'pending');
    const closing=core.close();release();await closing;
    assert.ok(!calls.includes(queued.id));
    core=await Core.open({dataDir:dir,model:fixtureModel,memoryEnabled:false,concurrency:1});
    await until(()=>core.runtime.task(queued.id),task=>task.status==='succeeded');
    assert.equal(core.runtime.task(first.id).status,'interrupted');
    assert.equal(calls.filter(id=>id===queued.id).length,2,'one reporting step and one terminal step, not repeated execution');
  }finally{release();await core.close();await removeTemp(dir);}
});
