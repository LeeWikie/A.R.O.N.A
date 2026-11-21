import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import type {InteractionRecord,InteractionAnswerReceipt} from '../src/interactions.js';
import type {TaskRecord} from '../src/runtime-store.js';
import {mcpResourcesFixture} from './mcp-resources-fixture.js';
import {until,removeTemp} from './helpers.js';

interface Inspection{calls:number;workerCalls:number;interactions:InteractionRecord[];workerRecovery:unknown[];workerNative?:{total:number};native:{total:number};tasks:TaskRecord[]}
interface Worker{child:ChildProcess;request<T>(route:string,body?:unknown):Promise<{status:number;body:T}>;dropResponse(route:string,body:unknown):Promise<void>;inspect():Promise<Inspection>;boundary():Promise<{id:string;point:string}>}
async function launch(directory:string,url:string,mode='mcp',env:Record<string,string>={}):Promise<Worker>{
  const child=fork(fileURLToPath(new URL(env.SYNTHETIC_ANSWER_BOUNDARY?'./interaction-outbox-boundary-fixture.ts':'./control-recovery-fixture.ts',import.meta.url)),[directory,mode],{execArgv:['--import','tsx'],env:{...process.env,SYNTHETIC_MCP_RECOVERY_URL:url,...env},stdio:['ignore','pipe','pipe','ipc']});const messages:unknown[]=[];let output='';
  child.on('message',value=>messages.push(value));child.stdout?.on('data',value=>{output=(output+String(value)).slice(-6000);});child.stderr?.on('data',value=>{output=(output+String(value)).slice(-6000);});
  const ready=await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(output);return messages.find(value=>value&&typeof value==='object'&&'type'in value&&value.type==='ready') as {port:number;token:string}|undefined;},Boolean);
  const base=`http://127.0.0.1:${ready!.port}`,headers={authorization:'Bearer '+ready!.token,'content-type':'application/json'};
  return {child,async request<T>(route:string,body?:unknown){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as T};},async dropResponse(route,body){const response=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,202);await response.body?.cancel();},async inspect(){const start=messages.length;child.send({type:'inspect'});return await until(()=>messages.slice(start).find(value=>value&&typeof value==='object'&&'type'in value&&value.type==='inspection') as Inspection|undefined,Boolean) as Inspection;},async boundary(){return await until(()=>messages.find(value=>value&&typeof value==='object'&&'type'in value&&value.type==='answer-boundary') as {id:string;point:string}|undefined,Boolean) as {id:string;point:string};}};
}
async function stop(worker:Worker,hard=true){if(worker.child.exitCode!==null||worker.child.signalCode!==null)return;const exited=once(worker.child,'exit');worker.child.kill(hard?'SIGKILL':'SIGTERM');await exited;}
async function transport(){const remote=await mcpResourcesFixture();let online=true;const server=createServer(async(request,response)=>{if(!online){response.writeHead(503).end('Synthetic network unavailable');return;}const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));try{const result=await fetch(remote.url,{method:request.method,headers:request.headers as Record<string,string>,...(request.method==='POST'?{body:Buffer.concat(chunks)}:{})});response.writeHead(result.status,Object.fromEntries([...result.headers].filter(([key])=>!['content-length','content-encoding','transfer-encoding'].includes(key))));if(result.body)for await(const chunk of result.body)response.write(chunk);response.end();}catch{response.writeHead(502).end();}});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');return {remote,url:`http://127.0.0.1:${address.port}`,offline(){online=false;server.closeAllConnections();},online(){online=true;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await remote.close();}};}
async function pending(worker:Worker){const task=await worker.request<TaskRecord>('/tasks',{title:'Synthetic durable answer',content:'Ask then read the original remote notes.',grants:{write:false,execute:false,mcp:true}});assert.equal(task.status,202);const state=await until(()=>worker.inspect(),value=>Boolean(value.workerRecovery?.[0])&&value.interactions.some(item=>item.status==='pending'));return {task:task.body,interaction:state.interactions.find(item=>item.status==='pending')!};}
const answer='SYNTHETIC_RECOVERY_ANSWER';

for(const point of ['claim','ack'] as const)test(`a real process crash at the native answer ${point} boundary uses durable evidence without duplicating tools`,{timeout:45000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-answer-boundary-')),network=await transport(),workers:Worker[]=[];
  try{
    const first=await launch(directory,network.url,'mcp',{SYNTHETIC_ANSWER_BOUNDARY:point});workers.push(first);const original=await pending(first);
    const request=first.request(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer}).catch(()=>undefined);const boundary=await first.boundary();assert.equal(boundary.point,point);
    const db=new DatabaseSync(path.join(directory,'records.sqlite'),{readOnly:true});let nativeEnds:number;
    try{const saved=JSON.parse(String(db.prepare('SELECT body FROM interaction_answer_outbox WHERE id=?').get(boundary.id)!.body));assert.equal(saved.status,'delivering');nativeEnds=Number(db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE kind='tool_end' AND run_id=? AND json_extract(data,'$.toolCallId')=?").get(original.interaction.runId,original.interaction.toolCallId)!.count);assert.equal(nativeEnds,point==='claim'?0:1);}finally{db.close();}
    await stop(first);await request;const second=await launch(directory,network.url);workers.push(second);
    const receipt=await until(async()=>(await second.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${boundary.id}`)).body.answer,value=>value.status==='delivered');assert.ok(receipt.acknowledgementSeq);
    if(point==='claim'){const completed=await until(()=>second.inspect(),value=>value.tasks.find(task=>task.id===original.task.id)?.status==='succeeded');assert.equal(completed.tasks.find(task=>task.id===original.task.id)?.runIds.at(-1),original.interaction.runId);assert.equal(receipt.attempts,2);assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,1);}
    else {assert.equal((await second.inspect()).workerCalls,0,'an already ended tool is acknowledged from its original durable event, never replayed');assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,0);assert.equal(receipt.attempts,1);}
  }finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});

test('an offline MCP source does not discard the native gate or an answer whose acknowledgement was lost across two process restarts',{timeout:60000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-durable-answer-')),network=await transport(),workers:Worker[]=[];
  try{
    const first=await launch(directory,network.url);workers.push(first);const original=await pending(first);network.offline();await stop(first);
    const second=await launch(directory,network.url);workers.push(second);const restored=await second.inspect();assert.equal(restored.calls,0);assert.equal(restored.workerNative?.total,1);assert.equal(restored.interactions.find(item=>item.id===original.interaction.id)?.status,'pending');
    await second.dropResponse(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer});
    const saved=(await second.request<{answers:InteractionAnswerReceipt[]}>('/interaction-answers')).body.answers[0]!;assert.ok(saved);assert.notEqual(saved.status,'delivered');assert.doesNotMatch(JSON.stringify(saved),/SYNTHETIC_RECOVERY_ANSWER|answerHash|recoveryHash/);await stop(second);
    const third=await launch(directory,network.url);workers.push(third);assert.equal((await third.inspect()).calls,0);const persisted=(await third.request<{answers:InteractionAnswerReceipt[]}>('/interaction-answers')).body.answers[0]!;assert.equal(persisted.id,saved.id);assert.equal(persisted.savedAt,saved.savedAt);
    const same=await third.request<{answer:InteractionAnswerReceipt}>(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer});assert.equal(same.status,202);assert.equal(same.body.answer.id,saved.id);
    assert.equal((await third.request(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer:'another answer'})).status,409);assert.equal((await third.inspect()).calls,0);
    network.online();assert.equal((await third.request(`/interaction-answers/${saved.id}/retry`,{expectedRunId:original.interaction.runId})).status,202);
    await until(async()=>(await third.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${saved.id}`)).body.answer,value=>value.status==='delivered');
    const complete=await until(()=>third.inspect(),value=>value.tasks.find(task=>task.id===original.task.id)?.status==='succeeded');assert.equal(complete.tasks.find(task=>task.id===original.task.id)?.runIds.at(-1),original.interaction.runId);assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,1);
    const receipt=(await third.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${saved.id}`)).body.answer;assert.ok(receipt.acknowledgementSeq);assert.equal(receipt.attempts,1);
    const duplicate=await third.request<{answer:InteractionAnswerReceipt}>(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer});assert.equal(duplicate.body.answer.status,'delivered');assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,1);
  }finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});

test('cancelling an unsent offline answer cancels the original native run and cannot dispatch it after connectivity returns',{timeout:45000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-durable-answer-')),network=await transport(),workers:Worker[]=[];
  try{const first=await launch(directory,network.url);workers.push(first);const original=await pending(first);network.offline();await stop(first);const second=await launch(directory,network.url);workers.push(second);
    const response=await second.request<{answer:InteractionAnswerReceipt}>(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer});assert.equal(response.status,202);
    assert.equal((await second.request(`/interactions/${original.interaction.id}/cancel`,{expectedRunId:original.interaction.runId})).status,202);assert.equal((await second.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${response.body.answer.id}`)).body.answer.status,'cancelled');network.online();await stop(second);
    const third=await launch(directory,network.url);workers.push(third);assert.equal((await third.inspect()).calls,0);assert.equal((await third.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${response.body.answer.id}/retry`,{expectedRunId:original.interaction.runId})).body.answer.status,'cancelled');assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,0);
  }finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});

test('reconnection delivers a persisted offline answer automatically after an outage longer than the native request timeout',{timeout:70000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-answer-auto-')),network=await transport(),workers:Worker[]=[];
  try{
    const first=await launch(directory,network.url);workers.push(first);const original=await pending(first);network.offline();await stop(first);
    const second=await launch(directory,network.url);workers.push(second);await second.dropResponse(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer});
    const saved=(await second.request<{answers:InteractionAnswerReceipt[]}>('/interaction-answers')).body.answers[0]!;assert.ok(saved);await stop(second);
    const third=await launch(directory,network.url);workers.push(third);assert.equal((await third.inspect()).workerCalls,0);
    await new Promise(resolve=>setTimeout(resolve,25000));assert.equal((await third.inspect()).workerCalls,0);assert.equal((await third.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${saved.id}`)).body.answer.attempts,0);network.online();
    const complete=await until(()=>third.inspect(),state=>state.tasks[0]?.status==='succeeded',20000);assert.deepEqual(complete.tasks[0]!.runIds,[original.interaction.runId]);
    const delivered=(await third.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${saved.id}`)).body.answer;assert.equal(delivered.status,'delivered');assert.equal(delivered.attempts,1);assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,1);
  }finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});

for(const change of ['configuration','credential','source','permissions'] as const)test(`a saved answer remains blocked after its original ${change} authority changes during an outage`,{timeout:45000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-durable-answer-')),network=await transport(),workers:Worker[]=[];const env={SHITTIMCHEST_STARTUP_MODEL_KEY:'SYNTHETIC_OUTBOX_KEY_A'};
  try{const first=await launch(directory,network.url,'mcp',env);workers.push(first);const original=await pending(first);network.offline();await stop(first);const second=await launch(directory,network.url,'mcp',env);workers.push(second);const saved=await second.request<{answer:InteractionAnswerReceipt}>(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer});assert.equal(saved.status,202);await stop(second);
    const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{
      if(change==='configuration')db.prepare('INSERT OR REPLACE INTO runtime_settings(id,body) VALUES(?,?)').run('max-steps','63');
      if(change==='source'){const row=db.prepare('SELECT body FROM signals WHERE id=?').get(original.task.signalId)!;db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.body)),content:'SYNTHETIC_CHANGED_SOURCE'}),original.task.signalId);}
      if(change==='permissions'){const row=db.prepare('SELECT body FROM tasks WHERE id=?').get(original.task.id)!;db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.body)),grants:{write:false,execute:false,mcp:false}}),original.task.id);}
    }finally{db.close();}
    network.online();const third=await launch(directory,network.url,'mcp',change==='credential'?{SHITTIMCHEST_STARTUP_MODEL_KEY:'SYNTHETIC_OUTBOX_KEY_B'}:env);workers.push(third);const state=await third.inspect();assert.equal(state.workerCalls,0,'the original worker is never replayed; an interrupted-task notification may use the main model');assert.equal(state.workerNative?.total,1);const receipt=(await third.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${saved.body.answer.id}`)).body.answer;assert.equal(receipt.status,'blocked');assert.equal(receipt.retryable,false);assert.match(receipt.errorCode!,/run_recovery_/);assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,0);assert.doesNotMatch(JSON.stringify(receipt),/SYNTHETIC_RECOVERY_ANSWER|SYNTHETIC_OUTBOX_KEY/);
  }finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});
