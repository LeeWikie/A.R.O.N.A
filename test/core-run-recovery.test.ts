import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { removeTemp, until } from './helpers.js';
import type { InteractionRecord } from '../src/interactions.js';
import type { ApprovalRecord, TaskRecord } from '../src/runtime-store.js';
import { mcpResourcesFixture } from './mcp-resources-fixture.js';

interface Ready { type: 'ready'; port: number; token: string }
interface Inspection { type: 'inspection'; calls: number; native: { total: number }; workerNative?: { total: number }; recovery: unknown[]; workerRecovery?: unknown[]; interactions: InteractionRecord[]; approvals: ApprovalRecord[]; tasks: TaskRecord[]; resources:Array<{taskId:string;nativeTaskId:string|null;status:string|null}>; events: Array<{kind:string;data:unknown}> }
interface Worker { child: ChildProcess; messages: Array<Record<string, unknown>>; ready: Ready; inspect(): Promise<Inspection>; request<T>(route:string,body?:unknown):Promise<{status:number;body:T}> }
async function launch(directory:string, mode='question', environment:Record<string,string>={}):Promise<Worker> {
  const child=fork(fileURLToPath(new URL('./control-recovery-fixture.ts',import.meta.url)),[directory,mode],{execArgv:['--import','tsx'],env:{...process.env,...environment},stdio:['ignore','pipe','pipe','ipc']});
  const messages:Array<Record<string,unknown>>=[];let output='';child.on('message',value=>{if(value&&typeof value==='object')messages.push(value as Record<string,unknown>);});
  child.stdout?.on('data',data=>{output=(output+String(data)).slice(-8000);});child.stderr?.on('data',data=>{output=(output+String(data)).slice(-8000);});
  const ready=await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(`fixture_ended: ${output}`);return messages.find(value=>value.type==='ready') as unknown as Ready|undefined;},Boolean);
  return {child,messages,ready:ready!,async inspect(){const index=messages.length;child.send({type:'inspect'});return await until(()=>messages.slice(index).find(value=>value.type==='inspection') as unknown as Inspection|undefined,Boolean) as Inspection;},
    async request<T>(route:string,body?:unknown){const response=await fetch(`http://127.0.0.1:${ready!.port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${ready!.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as T};}};
}
async function stop(worker:Worker,hard=false){if(worker.child.exitCode!==null||worker.child.signalCode!==null)return;const exited=once(worker.child,'exit');worker.child.kill(hard?'SIGKILL':'SIGTERM');let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([exited,new Promise<void>(resolve=>{timeout=setTimeout(()=>{worker.child.kill('SIGKILL');resolve();},8000);})]);}finally{clearTimeout(timeout);}}
async function question(worker:Worker){const submitted=await worker.request<{runId:string;id:string}>('/messages',{content:'SYNTHETIC_RECOVERY_REQUEST'});assert.equal(submitted.status,202);const record=await until(async()=>{const value=await worker.request<{interactions:InteractionRecord[]}>('/interactions');return value.body.interactions.find(item=>item.status==='pending');},Boolean);await until(()=>worker.inspect(),value=>Boolean(value.recovery[0]));return {record:record!,submitted:submitted.body};}

test('a hard restart restores the exact question and continues the original run once, including its durable visible reply',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const first=await launch(directory);workers.push(first);const original=await question(first);await stop(first,true);
    const second=await launch(directory);workers.push(second);const restored=await second.inspect();assert.equal(restored.calls,0);assert.equal(restored.native.total,1);assert.deepEqual(restored.interactions.map(item=>({id:item.id,runId:item.runId,status:item.status})),[{id:original.record.id,runId:original.submitted.runId,status:'pending'}]);
    const answer={expectedRunId:original.record.runId,answer:'SYNTHETIC_RECOVERY_ANSWER'};const response=await second.request<{status:string}>(`/interactions/${original.record.id}/answer`,answer);assert.equal(response.status,202);assert.equal(response.body.status,'answered');
    const run=await until(async()=>(await second.request<{status:string}>(`/runs/${original.record.runId}`)).body,value=>value.status!=='running');assert.equal(run.status,'succeeded');
    const replay=await second.request<{status:string}>(`/interactions/${original.record.id}/answer`,answer);assert.equal(replay.body.status,'answered');assert.equal((await second.inspect()).calls,1);
    const snapshot=await second.request<unknown>('/snapshot?contextId=main');assert.ok(JSON.stringify(snapshot.body).includes('SYNTHETIC_RECOVERY_COMPLETE'));
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

test('a pending native approval survives restart and approval resumes the original worker through a verified task report',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const first=await launch(directory,'approval');workers.push(first);const admitted=await first.request<TaskRecord>('/tasks',{title:'Synthetic native approval',content:'Change the synthetic fixture setting and report.',returnContextId:'main'});assert.equal(admitted.status,202);
    const before=await until(()=>first.inspect(),value=>value.approvals.some(item=>item.status==='pending')&&Boolean(value.workerRecovery?.[0]));const approval=before.approvals[0]!;assert.equal(before.workerNative?.total,1);await stop(first,true);
    const second=await launch(directory,'approval');workers.push(second);const restored=await second.inspect();assert.equal(restored.calls,0);assert.equal(restored.approvals[0]?.status,'pending');assert.equal(restored.tasks.find(item=>item.id===admitted.body.id)?.status,'waiting');
    const approved=await second.request<{status:string}>(`/approvals/${encodeURIComponent(approval.id)}`,{decision:'approve'});assert.equal(approved.status,200);assert.equal(approved.body.status,'approved');
    const completed=await until(async()=>(await second.inspect()).tasks.find(item=>item.id===admitted.body.id),value=>Boolean(value)&&!['pending','running','waiting'].includes(value!.status));assert.equal(completed!.status,'succeeded');assert.deepEqual(completed!.runIds,[approval.runId]);assert.equal(completed!.report?.deliveries[0]?.value,'SYNTHETIC_RECOVERY_COMPLETE');
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

for(const change of ['branch','source','configuration','credential'] as const)test(`restart does not restore a native gate after its ${change} identity changes`,{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const environment:Record<string,string>=change==='credential'?{SHITTIMCHEST_STARTUP_MODEL_KEY:'SYNTHETIC_RECOVERY_KEY_A'}:{};const first=await launch(directory,'question',environment);workers.push(first);const original=await question(first);await stop(first,true);
    const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{
      if(change==='branch')db.prepare('UPDATE session_graph_heads SET revision=revision+1 WHERE context_id=?').run('main');
      if(change==='source'){const row=db.prepare('SELECT body FROM signals WHERE id=?').get(original.submitted.id)!;db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.body)),content:'SYNTHETIC_CHANGED_SOURCE'}),original.submitted.id);}
      if(change==='configuration')db.prepare('INSERT OR REPLACE INTO runtime_settings(id,body) VALUES(?,?)').run('max-steps','63');
    }finally{db.close();}
    const second=await launch(directory,'question',change==='credential'?{SHITTIMCHEST_STARTUP_MODEL_KEY:'SYNTHETIC_RECOVERY_KEY_B'}:environment);workers.push(second);const state=await second.inspect();assert.equal(state.calls,0);assert.equal(state.interactions[0]?.status,'interrupted');assert.equal(state.native.total,1,'an unsafe resume never destroys its source snapshot');
    const response=await second.request<{error:string}>(`/interactions/${original.record.id}/answer`,{expectedRunId:original.record.runId,answer:'SYNTHETIC_RECOVERY_ANSWER'});assert.equal(response.status,409);assert.ok(state.events.some(event=>event.kind==='run_recovery_unavailable'));
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

test('an executing run without a durable native suspension is interrupted without replay',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const first=await launch(directory,'running');workers.push(first);const accepted=await first.request<{runId:string}>('/messages',{content:'SYNTHETIC_IN_FLIGHT'});await until(()=>first.messages.some(message=>message.type==='model-call'),Boolean);await stop(first,true);
    const second=await launch(directory,'running');workers.push(second);assert.equal((await second.inspect()).calls,0);const run=await second.request<{status:string}>(`/runs/${accepted.body.runId}`);assert.equal(run.body.status,'interrupted');
    const snapshot=await second.request<unknown>('/snapshot?contextId=main'),tree=await second.request<unknown>('/contexts/main/tree');assert.equal(snapshot.status,200);assert.equal(tree.status,200);assert.ok(JSON.stringify(snapshot.body).includes('SYNTHETIC_IN_FLIGHT'));assert.ok(JSON.stringify(tree.body).includes('SYNTHETIC_IN_FLIGHT'));assert.equal((await second.inspect()).calls,0);
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

test('a recovered pending question can be cancelled, and cannot later answer or leak a resumed reply',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const first=await launch(directory);workers.push(first);const original=await question(first);await stop(first,true);
    const second=await launch(directory);workers.push(second);const cancelled=await second.request<{status:string}>(`/interactions/${original.record.id}/cancel`,{expectedRunId:original.record.runId});assert.equal(cancelled.status,202);assert.equal(cancelled.body.status,'cancelled');
    const run=await until(async()=>(await second.request<{status:string}>(`/runs/${original.record.runId}`)).body,value=>value.status!=='running');assert.equal(run.status,'interrupted');
    assert.equal((await second.request(`/interactions/${original.record.id}/answer`,{expectedRunId:original.record.runId,answer:'SYNTHETIC_RECOVERY_ANSWER'})).status,409);
    assert.ok(!JSON.stringify((await second.request('/snapshot?contextId=main')).body).includes('SYNTHETIC_RECOVERY_COMPLETE'));
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

test('parallel identical cold approval replies execute once and retain a replay receipt after another restart',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const first=await launch(directory,'approval');workers.push(first);await first.request('/tasks',{title:'Synthetic repeated approval',content:'Apply the synthetic setting once.'});const before=await until(()=>first.inspect(),value=>Boolean(value.workerRecovery?.[0]));const approval=before.approvals[0]!;await stop(first,true);
    const second=await launch(directory,'approval');workers.push(second);const route=`/approvals/${encodeURIComponent(approval.id)}`;
    const [one,two]=await Promise.all([second.request<{status:string}>(route,{decision:'approve'}),second.request<{status:string}>(route,{decision:'approve'})]);assert.equal(one.status,200);assert.deepEqual(one,two);
    assert.equal((await second.request(route,{decision:'decline'})).status,409);await until(()=>second.inspect(),value=>value.tasks[0]?.status==='succeeded');await stop(second,true);
    const third=await launch(directory,'approval');workers.push(third);assert.equal((await third.request<{status:string}>(route,{decision:'approve'})).body.status,'approved');assert.equal((await third.inspect()).calls,0);
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

test('restart reconnects only a previously connected MCP source before restoring its original waiting run',{timeout:40000},async()=>{
  const remote=await mcpResourcesFixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const first=await launch(directory,'question',{SYNTHETIC_MCP_RECOVERY_URL:remote.url});workers.push(first);const original=await question(first);assert.equal(remote.calls.filter(call=>call.method==='initialize').length,1);await stop(first,true);
    const second=await launch(directory,'question',{SYNTHETIC_MCP_RECOVERY_URL:remote.url});workers.push(second);assert.equal((await second.inspect()).interactions[0]?.status,'pending');assert.equal(remote.calls.filter(call=>call.method==='initialize').length,2);
    const config=await second.request<{mcp:Array<{id:string;connected:boolean}>}>('/configuration');assert.equal(config.body.mcp.find(server=>server.id==='recovery-fixture')?.connected,true);
    assert.equal((await second.request(`/interactions/${original.record.id}/answer`,{expectedRunId:original.record.runId,answer:'SYNTHETIC_RECOVERY_ANSWER'})).status,202);
    assert.equal((await until(async()=>(await second.request<{status:string}>(`/runs/${original.record.runId}`)).body,value=>value.status!=='running')).status,'succeeded');
  }finally{for(const worker of workers)await stop(worker);await remote.close();await removeTemp(directory);}
});

test('a recovered worker retains its original native resource slot and releases it for queued work after completion',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[],environment={SYNTHETIC_RECOVERY_CONCURRENCY:'1'};
  try{
    const first=await launch(directory,'approval',environment);workers.push(first);const admitted=await first.request<TaskRecord>('/tasks',{title:'Synthetic resource owner',content:'Apply the fixture setting once.'});const before=await until(()=>first.inspect(),value=>Boolean(value.workerRecovery?.[0]));const approval=before.approvals[0]!;await stop(first,true);
    const second=await launch(directory,'approval',environment);workers.push(second);const restored=await second.inspect();const originalResource=before.resources.find(resource=>resource.taskId===admitted.body.id)!.nativeTaskId;assert.ok(originalResource);assert.equal(restored.resources.find(resource=>resource.taskId===admitted.body.id)?.nativeTaskId,originalResource);assert.equal(restored.resources.find(resource=>resource.taskId===admitted.body.id)?.status,'running');
    const queued=await second.request<TaskRecord>('/tasks',{title:'Synthetic queued follower',content:'Run after the original resource owner.'});assert.equal(queued.status,202);assert.equal((await second.inspect()).tasks.find(task=>task.id===queued.body.id)?.status,'pending');assert.equal((await second.inspect()).calls,0);
    assert.equal((await second.request(`/approvals/${encodeURIComponent(approval.id)}`,{decision:'approve'})).status,200);
    const next=await until(()=>second.inspect(),value=>value.tasks.find(task=>task.id===queued.body.id)?.status==='waiting');assert.equal(next.tasks.find(task=>task.id===admitted.body.id)?.status,'succeeded');assert.equal(next.resources.find(resource=>resource.taskId===admitted.body.id)?.status,'completed');assert.ok(next.approvals.some(item=>item.taskId===queued.body.id&&item.status==='pending'));
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

test('a restored worker can be cancelled through task control without leaving a live native run or background resource',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const first=await launch(directory,'approval');workers.push(first);const admitted=await first.request<TaskRecord>('/tasks',{title:'Synthetic cancellation owner',content:'Wait for a fixture decision.'});const before=await until(()=>first.inspect(),value=>Boolean(value.workerRecovery?.[0]));const runId=before.approvals[0]!.runId;await stop(first,true);
    const second=await launch(directory,'approval');workers.push(second);const restored=await second.inspect(),task=restored.tasks.find(item=>item.id===admitted.body.id)!;
    const cancelled=await second.request<TaskRecord>(`/tasks/${task.id}/cancel`,{revision:task.revision});assert.equal(cancelled.status,202);assert.equal(cancelled.body.status,'cancelled');
    const final=await until(()=>second.inspect(),value=>value.resources.find(item=>item.taskId===task.id)?.status==='cancelled');assert.equal(final.workerNative?.total,0);assert.equal((await second.request<{status:string}>(`/runs/${runId}`)).body.status,'interrupted');
  }finally{for(const worker of workers)await stop(worker);await removeTemp(directory);}
});

for(const granted of [true,false])test(`a recovered worker ${granted?'uses its original MCP grant':'still needs approval for an ungranted MCP source'}`,{timeout:40000},async()=>{
  const remote=await mcpResourcesFixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovery-'));const workers:Worker[]=[];
  try{
    const environment={SYNTHETIC_MCP_RECOVERY_URL:remote.url};const first=await launch(directory,'mcp',environment);workers.push(first);
    const admitted=await first.request<TaskRecord>('/tasks',{title:'Synthetic MCP continuation',content:'Ask before reading the connected resource, then report.',grants:{write:false,execute:false,mcp:granted}});assert.equal(admitted.status,202);
    const before=await until(()=>first.inspect(),value=>Boolean(value.workerRecovery?.[0])&&value.interactions.some(item=>item.status==='pending'));const pending=before.interactions[0]!;await stop(first,true);
    const second=await launch(directory,'mcp',environment);workers.push(second);assert.equal((await second.inspect()).calls,0);assert.equal(remote.calls.filter(call=>call.method==='initialize').length,2);
    assert.equal((await second.request(`/interactions/${pending.id}/answer`,{expectedRunId:pending.runId,answer:'SYNTHETIC_RECOVERY_ANSWER'})).status,202);
    if(granted){const done=await until(()=>second.inspect(),value=>{const task=value.tasks.find(task=>task.id===admitted.body.id);return Boolean(task)&&(!['pending','running','waiting'].includes(task!.status)||value.approvals.some(item=>item.status==='pending'&&item.toolName==='read_mcp_resource'));});assert.equal(done.tasks.find(task=>task.id===admitted.body.id)?.status,'succeeded',JSON.stringify({tasks:done.tasks,approvals:done.approvals,calls:remote.calls}));assert.deepEqual(done.tasks.find(task=>task.id===admitted.body.id)!.runIds,[pending.runId]);assert.equal(remote.calls.filter(call=>call.method==='resources/read').length,1);}
    else{const waiting=await until(()=>second.inspect(),value=>value.approvals.some(item=>item.status==='pending'&&item.toolName==='read_mcp_resource'));assert.equal(waiting.tasks.find(task=>task.id===admitted.body.id)?.status,'waiting');assert.equal(remote.calls.filter(call=>call.method==='resources/read').length,0);}
  }finally{for(const worker of workers)await stop(worker);await remote.close();await removeTemp(directory);}
});
