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

interface Inspection{resources:Array<{taskId:string;status:string|null}>;calls:number;workerCalls:number;interactions:InteractionRecord[];workerRecovery:unknown[];recovery:unknown[];workerNative?:{total:number};native:{total:number};tasks:TaskRecord[]}
interface Worker{child:ChildProcess;request<T>(route:string,body?:unknown,method?:string):Promise<{status:number;body:T}>;dropResponse(route:string,body:unknown):Promise<void>;inspect():Promise<Inspection>;boundary():Promise<{id:string;point:string}>;closeResult():Promise<{type:string;error?:string}>}
async function launch(directory:string,url:string,mode='mcp',env:Record<string,string>={}):Promise<Worker>{
  const child=fork(fileURLToPath(new URL(env.SYNTHETIC_ANSWER_BOUNDARY?'./interaction-outbox-boundary-fixture.ts':'./control-recovery-fixture.ts',import.meta.url)),[directory,mode],{execArgv:['--import','tsx'],env:{...process.env,SYNTHETIC_MCP_RECOVERY_URL:url,...env},stdio:['ignore','pipe','pipe','ipc']});const messages:unknown[]=[];let output='';
  child.on('message',value=>messages.push(value));child.stdout?.on('data',value=>{output=(output+String(value)).slice(-6000);});child.stderr?.on('data',value=>{output=(output+String(value)).slice(-6000);});
  const ready=await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(output);return messages.find(value=>value&&typeof value==='object'&&'type'in value&&value.type==='ready') as {port:number;token:string}|undefined;},Boolean);
  const base=`http://127.0.0.1:${ready!.port}`,headers={authorization:'Bearer '+ready!.token,'content-type':'application/json'};
  return {child,async closeResult(){return await until(()=>messages.find(value=>value&&typeof value==='object'&&'type'in value&&['closed','fixture-error'].includes(String(value.type))) as {type:string;error?:string}|undefined,Boolean) as {type:string;error?:string};},async request<T>(route:string,body?:unknown,method?:string){const response=await fetch(base+route,{method:method??(body===undefined?'GET':'POST'),headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as T};},async dropResponse(route,body){const response=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,202);await response.body?.cancel();},async inspect(){const start=messages.length;child.send({type:'inspect'});return await until(()=>messages.slice(start).find(value=>value&&typeof value==='object'&&'type'in value&&value.type==='inspection') as Inspection|undefined,Boolean) as Inspection;},async boundary(){return await until(()=>messages.find(value=>value&&typeof value==='object'&&'type'in value&&value.type==='answer-boundary') as {id:string;point:string}|undefined,Boolean) as {id:string;point:string};}};
}
async function stop(worker:Worker,hard=true){if(worker.child.exitCode!==null||worker.child.signalCode!==null)return;const exited=once(worker.child,'exit');worker.child.kill(hard?'SIGKILL':'SIGTERM');await exited;}
async function transport(){const remote=await mcpResourcesFixture();let online=true;const server=createServer(async(request,response)=>{if(!online){response.writeHead(503).end('Synthetic network unavailable');return;}const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));try{const result=await fetch(remote.url,{method:request.method,headers:request.headers as Record<string,string>,...(request.method==='POST'?{body:Buffer.concat(chunks)}:{})});response.writeHead(result.status,Object.fromEntries([...result.headers].filter(([key])=>!['content-length','content-encoding','transfer-encoding'].includes(key))));if(result.body)for await(const chunk of result.body)response.write(chunk);response.end();}catch{response.writeHead(502).end();}});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');return {remote,url:`http://127.0.0.1:${address.port}`,offline(){online=false;server.closeAllConnections();},online(){online=true;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await remote.close();}};}
async function pending(worker:Worker){const task=await worker.request<TaskRecord>('/tasks',{title:'Synthetic durable answer',content:'Ask then read the original remote notes.',grants:{write:false,execute:false,mcp:true}});assert.equal(task.status,202);const state=await until(()=>worker.inspect(),value=>Boolean(value.workerRecovery?.[0])&&value.interactions.some(item=>item.status==='pending'));return {task:task.body,interaction:state.interactions.find(item=>item.status==='pending')!};}
const answer='SYNTHETIC_RECOVERY_ANSWER';

async function graceful(worker:Worker){const ended=once(worker.child,'exit');worker.child.send({type:'graceful-close'});const result=await Promise.race([ended,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('native_process_did_not_exit')),15000);ended.finally(()=>clearTimeout(timer));})]);assert.equal(result[0],0);assert.equal(result[1],null);}
for(const saved of [false,true])test(`graceful worker shutdown retains the same parked run ${saved?'with an offline saved answer':'before an answer is saved'}`,{timeout:60000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-answer-stop-')),network=await transport(),workers:Worker[]=[];
 try{
  const first=await launch(directory,network.url);workers.push(first);const original=await pending(first);network.offline();
  if(saved){await stop(first);const writer=await launch(directory,network.url);workers.push(writer);await writer.request(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer});await graceful(writer);}
  else await graceful(first);
  const second=await launch(directory,network.url);workers.push(second);const restored=await second.inspect();assert.equal(restored.workerCalls,0);assert.equal(restored.workerNative?.total,1);assert.equal(restored.interactions.find(row=>row.id===original.interaction.id)?.status,'pending');assert.deepEqual(restored.tasks[0]!.runIds,[original.interaction.runId]);assert.ok(['pending','running'].includes(restored.resources[0]!.status!));
  network.online();const receipt=saved?(await second.request<{answers:InteractionAnswerReceipt[]}>('/interaction-answers')).body.answers[0]!:(await second.request<{answer:InteractionAnswerReceipt}>(`/interactions/${original.interaction.id}/answer-outbox`,{expectedRunId:original.interaction.runId,answer})).body.answer;
  await second.request(`/interaction-answers/${receipt.id}/retry`,{expectedRunId:original.interaction.runId});const complete=await until(()=>second.inspect(),state=>state.tasks[0]?.status==='succeeded');assert.equal(complete.tasks[0]!.runIds.at(-1),original.interaction.runId);assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,1);assert.equal((await second.request<{answer:InteractionAnswerReceipt}>(`/interaction-answers/${receipt.id}`)).body.answer.status,'delivered');
 }finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});
test('a main question remains pending across two natural Core shutdowns and resumes its original run',{timeout:45000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-main-stop-')),network=await transport(),workers:Worker[]=[];
 try{
  const first=await launch(directory,network.url,'question');workers.push(first);const submitted=await first.request<{runId:string}>('/messages',{content:'Ask the synthetic question.'});assert.equal(submitted.status,202);const original=await until(()=>first.inspect(),state=>Boolean(state.recovery[0])&&state.interactions.some(row=>row.status==='pending'));const question=original.interactions[0]!;await graceful(first);
  const second=await launch(directory,network.url,'question');workers.push(second);assert.equal((await second.inspect()).calls,0);await graceful(second);
  const third=await launch(directory,network.url,'question');workers.push(third);const restored=await third.inspect();assert.equal(restored.calls,0);assert.equal(restored.interactions[0]!.id,question.id);assert.equal(restored.interactions[0]!.status,'pending');assert.equal((await third.request(`/interactions/${question.id}/answer`,{expectedRunId:question.runId,answer})).status,202);await until(()=>third.inspect(),state=>state.interactions[0]?.status==='answered');
 }finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});

test('a cleanup failure is reported while the lock and parked run are safely released for reopening',{timeout:45000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-stop-failure-')),network=await transport(),workers:Worker[]=[];
 try{const first=await launch(directory,network.url,'question',{SYNTHETIC_CLEANUP_FAILURE:'1'});workers.push(first);await first.request('/messages',{content:'Ask the synthetic question.'});const original=await until(()=>first.inspect(),state=>Boolean(state.recovery[0])&&state.interactions.some(row=>row.status==='pending'));await graceful(first);assert.match((await first.closeResult()).error!,/synthetic_cleanup_failure/);const next=await launch(directory,network.url,'question');workers.push(next);const restored=await next.inspect();assert.equal(restored.calls,0);assert.equal(restored.interactions[0]!.id,original.interactions[0]!.id);assert.equal(restored.interactions[0]!.status,'pending');}
 finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});
test('shutdown cannot preserve an old gate after its credential authority was replaced',{timeout:45000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-stop-identity-')),network=await transport(),workers:Worker[]=[];
 try{const first=await launch(directory,network.url,'mcp',{SHITTIMCHEST_STARTUP_MODEL_KEY:'SYNTHETIC_STOP_CREDENTIAL_A'});workers.push(first);const original=await pending(first);assert.equal((await first.request('/credentials/SHITTIMCHEST_STARTUP_MODEL_KEY',{value:'SYNTHETIC_STOP_CREDENTIAL_B'},'PUT')).status,200);await graceful(first);const next=await launch(directory,network.url,'mcp',{SHITTIMCHEST_STARTUP_MODEL_KEY:'SYNTHETIC_STOP_CREDENTIAL_A'});workers.push(next);const restored=await next.inspect();assert.equal(restored.workerCalls,0);assert.equal(restored.workerNative?.total,0);assert.notEqual(restored.interactions.find(row=>row.id===original.interaction.id)?.status,'pending');assert.notEqual(restored.tasks[0]!.status,'succeeded');assert.equal(network.remote.calls.filter(call=>call.method==='resources/read').length,0);}
 finally{for(const worker of workers)await stop(worker);await network.close();await removeTemp(directory);}
});
