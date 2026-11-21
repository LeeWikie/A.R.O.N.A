import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import type {TaskRecord} from '../src/runtime-store.js';
import {until,removeTemp} from './helpers.js';

async function launch(directory:string,mode='resume'){
  const child=fork(fileURLToPath(new URL('./terminal-core-recovery-fixture.ts',import.meta.url)),[directory,mode],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  const messages:Array<Record<string,unknown>>=[];let output='';child.stdout?.on('data',value=>output+=String(value));child.stderr?.on('data',value=>output+=String(value));child.on('message',value=>{if(value&&typeof value==='object')messages.push(value as Record<string,unknown>);});
  const ready=await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(`fixture_ended:${output}`);return messages.find(row=>row.type==='ready');},Boolean);
  return {child,messages,output:()=>output,async request<T>(route:string,body?:unknown){const response=await fetch(`http://127.0.0.1:${ready!.port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${ready!.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as T};},async inspect(){const before=messages.length;child.send({type:'inspect'});return until(()=>messages.slice(before).find(row=>row.type==='inspection'),Boolean);}};
}
async function stop(child:ChildProcess,hard=false){if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,'exit');child.kill(hard?'SIGKILL':'SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([ended,new Promise<void>(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);})]);}finally{clearTimeout(timer);}}

function originalToolParts(value:unknown,id:unknown):unknown[]{
  if(Array.isArray(value))return value.flatMap(part=>originalToolParts(part,id));if(!value||typeof value!=='object')return [];const object=value as Record<string,unknown>;
  if((object.type==='tool-call'||object.type==='tool-result')&&object.toolCallId===id)return [object];return Object.values(object).flatMap(part=>originalToolParts(part,id));
}

test('a completed native command is durable before the next model call and remains natural history after SIGKILL without replay',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-complete-checkpoint-')),workers:Array<Awaited<ReturnType<typeof launch>>>=[];
  try{
    const first=await launch(directory,'checkpoint');workers.push(first);const submitted=await first.request<TaskRecord>('/tasks',{title:'Synthetic complete command checkpoint',content:'Verify the complete original command after recovery.'});assert.equal(submitted.status,202);
    const checkpoint=await until(async()=>{const approvals=await first.request<{approvals:Array<{id:string;status:string}>}>('/approvals');for(const row of approvals.body.approvals.filter(row=>row.status==='pending'))assert.equal((await first.request(`/approvals/${row.id}`,{decision:'approve'})).status,200);return first.messages.find(row=>row.type==='terminal-checkpoint');},Boolean);
    const original=originalToolParts(checkpoint!.prompt,checkpoint!.toolCallId);assert.equal(original.length,2,'the actual next model prompt contains the original native call and its completed result');assert.match(JSON.stringify(original),/Full output: process\./);assert.match(JSON.stringify(original),/CHECKPOINT_ROW_1199/);await stop(first.child,true);
    const second=await launch(directory,'checkpoint');workers.push(second);const interrupted=(await second.request<TaskRecord>(`/tasks/${submitted.body.id}`)).body;assert.equal(interrupted.status,'interrupted');assert.equal((await second.request(`/tasks/${submitted.body.id}/retry`,{revision:interrupted.revision})).status,202);
    const completed=await until(async()=>(await second.request<TaskRecord>(`/tasks/${submitted.body.id}`)).body,task=>['succeeded','failed','blocked','unreported'].includes(task.status),20000).catch(async error=>{throw Error(`${error}; ${JSON.stringify({inspection:await second.inspect(),models:second.messages.filter(row=>row.type==='checkpoint-resume-model'),output:second.output()})}`);});
    assert.equal(completed.status,'succeeded',JSON.stringify({task:completed,inspection:await second.inspect(),models:second.messages.filter(row=>row.type==='checkpoint-resume-model').slice(0,2),output:second.output()}));const resumed=second.messages.find(row=>row.type==='checkpoint-resume-model');assert.ok(resumed);assert.deepEqual(originalToolParts(resumed.prompt,checkpoint!.toolCallId),original,'original call and result reach the resumed model unchanged');
    assert.equal((await second.request<{status:string}>(`/runs/${checkpoint!.runId}`)).body.status,'interrupted');assert.equal(fs.readFileSync(path.join(directory,'workspace','executions'),'utf8'),'start\n');assert.equal((await second.request<{approvals:Array<{status:string}>}>('/approvals')).body.approvals.filter(row=>row.status==='pending').length,0);
    const inspection=await second.inspect(),events=inspection!.events as Array<{kind:string;data:{toolName?:string;toolCallId?:string}}>;
    assert.equal(events.filter(row=>row.kind==='tool_end'&&row.data?.toolCallId===checkpoint!.toolCallId).length,1,'the original completed tool call has exactly one completion');
  }finally{for(const worker of workers)await stop(worker.child);await removeTemp(directory);}
});

test('actual Core resumes the same task by discovering and controlling its original background process after SIGKILL',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-native-recovery-')),workers:Array<Awaited<ReturnType<typeof launch>>>=[];
  try{
    const first=await launch(directory);workers.push(first);const task=await first.request<TaskRecord>('/tasks',{title:'Synthetic terminal recovery',content:'Continue the original process after a host restart.'});assert.equal(task.status,202);
    await until(async()=>{const approvals=await first.request<{approvals:Array<{id:string;status:string}>}>('/approvals');for(const approval of approvals.body.approvals.filter(row=>row.status==='pending'))assert.equal((await first.request(`/approvals/${approval.id}`,{decision:'approve'})).status,200);return first.messages.find(row=>row.type==='process-started');},Boolean);
    const original=first.messages.find(row=>row.type==='process-started')!;assert.equal(typeof original.processId,'string');await stop(first.child,true);
    const second=await launch(directory);workers.push(second);const interrupted=await second.request<TaskRecord>(`/tasks/${task.body.id}`);assert.equal(interrupted.body.status,'interrupted');
    const retried=await second.request(`/tasks/${task.body.id}/retry`,{revision:interrupted.body.revision});assert.equal(retried.status,202);
    const approved=new Set<string>();const completed=await until(async()=>{const approvals=await second.request<{approvals:Array<{id:string;status:string}>}>('/approvals');for(const approval of approvals.body.approvals.filter(row=>row.status==='pending')){approved.add(approval.id);assert.equal((await second.request(`/approvals/${approval.id}`,{decision:'approve'})).status,200);}return (await second.request<TaskRecord>(`/tasks/${task.body.id}`)).body;},value=>['succeeded','failed','blocked','unreported'].includes(value.status),20000).catch(async error=>{throw new Error(`${error}; ${JSON.stringify({inspection:await second.inspect(),models:second.messages.filter(row=>row.type==='resume-model'),output:second.output()})}`);});
    assert.equal(completed.status,'succeeded',second.output());assert.equal(completed.attempt,2);assert.equal(completed.runIds.length,2);assert.equal((await second.request<{status:string}>(`/runs/${original.runId}`)).body.status,'interrupted');assert.equal(approved.size,1,'resumed control still uses its current native approval');
    const inspection=await second.inspect();assert.equal((inspection!.processes as unknown[]).length,1);assert.equal(fs.readFileSync(path.join(directory,'workspace','executions'),'utf8'),'start\n');
    const events=inspection!.events as Array<{kind:string;data:{id?:string}}>;
    assert.equal(events.filter(row=>row.kind==='terminal_process_adopted'&&row.data.id===original.processId).length,1);
  }finally{for(const worker of workers)await stop(worker.child);await removeTemp(directory);}
});

test('an original background process can finish while its task is interrupted and returns its actual failure output to main after restart',{timeout:25000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-native-notice-')),workers:Array<Awaited<ReturnType<typeof launch>>>=[];
  try{
    const first=await launch(directory,'natural');workers.push(first);const submitted=await first.request<TaskRecord>('/tasks',{title:'Synthetic natural terminal exit',content:'Keep the original process result distinct from task completion.',grants:{write:false,execute:true,mcp:false}});assert.equal(submitted.status,202);
    const original=await until(()=>first.messages.find(row=>row.type==='process-started'),Boolean);await stop(first.child,true);
    const second=await launch(directory,'natural');workers.push(second);
    const result=await until(()=>second.inspect(),row=>JSON.stringify(row?.outputs).includes('Verified NATURAL_TERMINAL_RESULT'),15000).catch(async error=>{throw new Error(`${error}; ${JSON.stringify({inspection:await second.inspect(),output:second.output()})}`);});
    const task=(result!.tasks as TaskRecord[]).find(row=>row.id===submitted.body.id)!;assert.equal(task.status,'interrupted');assert.equal(task.report,null);assert.equal(task.attempt,1);
    const exits=(result!.events as Array<{kind:string;data:{id:string;status:string;exitCode:number}}>).filter(row=>row.kind==='terminal_process_exit');assert.equal(exits.length,1);assert.equal(exits[0]!.data.id,original!.processId);assert.equal(exits[0]!.data.status,'failed');assert.equal(exits[0]!.data.exitCode,7);
    await until(()=>second.inspect(),row=>!(row?.notifications as Array<{id:string}>).some(item=>item.id===`terminal:${original!.processId}`));
    assert.equal(fs.readFileSync(path.join(directory,'workspace','executions'),'utf8'),'start\n');
  }finally{for(const worker of workers)await stop(worker.child);await removeTemp(directory);}
});

test('explicit cancellation after task adoption stops the original process and its side effects',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-adopt-cancel-')),workers:Array<Awaited<ReturnType<typeof launch>>>=[];
  const approve=async(worker:Awaited<ReturnType<typeof launch>>)=>{const approvals=await worker.request<{approvals:Array<{id:string;status:string}>}>('/approvals');for(const row of approvals.body.approvals.filter(row=>row.status==='pending'))assert.equal((await worker.request(`/approvals/${row.id}`,{decision:'approve'})).status,200);};
  try{
    const first=await launch(directory,'resume-cancel');workers.push(first);const task=await first.request<TaskRecord>('/tasks',{title:'Synthetic adopted cancellation',content:'Cancel the original process after recovering it.'});
    const original=await until(async()=>{await approve(first);return first.messages.find(row=>row.type==='process-started');},Boolean);await stop(first.child,true);
    const second=await launch(directory,'resume-cancel');workers.push(second);const interrupted=(await second.request<TaskRecord>(`/tasks/${task.body.id}`)).body;assert.equal((await second.request(`/tasks/${task.body.id}/retry`,{revision:interrupted.revision})).status,202);
    const waiting=await until(async()=>{await approve(second);const inspection=await second.inspect();const current=(inspection!.tasks as TaskRecord[]).find(row=>row.id===task.body.id)!;return {current,inspection};},row=>row.current.status==='waiting'&&(row.inspection!.events as Array<{kind:string}>).some(event=>event.kind==='terminal_process_adopted'),20000).catch(async error=>{const inspection=await second.inspect();throw new Error(`${error}; ${JSON.stringify({tasks:inspection!.tasks,events:(inspection!.events as Array<{kind:string}>).filter(row=>['terminal_process_adopted','tool_end','agent_end'].includes(row.kind)),models:second.messages.filter(row=>row.type==='resume-model'),output:second.output()})}`);});
    assert.equal((await second.request(`/tasks/${task.body.id}/cancel`,{revision:waiting.current.revision})).status,202);
    const cancelled=await until(async()=>(await second.request<TaskRecord>(`/tasks/${task.body.id}`)).body,row=>row.status==='cancelled');assert.equal(cancelled.report,null);
    const state=JSON.parse(fs.readFileSync(path.join(directory,'process-output',String(original!.processId),'state.json'),'utf8')) as {status:string};assert.equal(state.status,'cancelled');
    const heartbeat=path.join(directory,'workspace','heartbeat'),before=fs.statSync(heartbeat).size;await new Promise(resolve=>setTimeout(resolve,150));assert.equal(fs.statSync(heartbeat).size,before);
    assert.equal(fs.readFileSync(path.join(directory,'workspace','executions'),'utf8'),'start\n');
    const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM runtime_settings WHERE id LIKE 'terminal-adoption:%'").get()!.n),1);}finally{db.close();}
  }finally{for(const worker of workers)await stop(worker.child);await removeTemp(directory);}
});
