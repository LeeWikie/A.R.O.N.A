import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import type {InteractionRecord} from '../src/interactions.js';
import type {RunRecoveryEnvelope,RunRecoveryCleanup} from '../src/run-recovery.js';
import type {TaskRecord} from '../src/runtime-store.js';
import {until,removeTemp} from './helpers.js';
interface State{type:string;workerCalls:number;task?:TaskRecord;question?:InteractionRecord;nativeStatus?:string;seal?:RunRecoveryEnvelope;cleanup?:RunRecoveryCleanup;publicResourceCleanup?:Array<{runId:string;status:string;attempts:number}>;snapshotEvidence?:{dataHash:string;eventHash:string;sequence:number;eventSequence:number};events:Array<{data:{code:string}}>;error?:string;}
async function launch(directory:string,variant:string){const events:State[]=[],child=fork(fileURLToPath(new URL('./image-policy-recovery-fixture.ts',import.meta.url)),[directory,variant],{env:{...process.env,OPENAI_API_KEY:'SYNTHETIC_IMAGE_POLICY_KEY'},stdio:['ignore','pipe','pipe','ipc']});let logs='';child.stdout?.on('data',part=>logs+=part);child.stderr?.on('data',part=>logs+=part);child.on('message',value=>events.push(value as State));await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(logs);return events.find(value=>value.type==='ready');},Boolean);return {child,async command(type:string){const offset=events.length;child.send({type});return await until(()=>{const result=events.slice(offset).find(value=>['state','fixture-error','closed'].includes(value.type));if(result?.type==='fixture-error')throw Error(result.error);return result;},Boolean) as State;}};}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;}
for(const variant of ['eight','two','text','legacy-unproven'] as const)test(`cold native work recovery ${variant==='eight'?'retains the proven image policy':'refuses '+variant+' image policy without replay'}`,{timeout:40000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-image-policy-recovery-')),children:ChildProcess[]=[];
 try{
  const first=await launch(directory,'eight');children.push(first.child);await first.command('submit');const original=await until(()=>first.command('inspect'),state=>state.question?.status==='pending'&&Boolean(state.seal?.imagePolicyHash));assert.equal(original.workerCalls,1);await stop(first.child);
  if(variant==='legacy-unproven'){const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{const key=`run-recovery:${original.question!.runId}`,body=JSON.parse(String(db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(key)!.body)) as RunRecoveryEnvelope;delete body.imagePolicyHash;db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(body),key);}finally{db.close();}}
  const second=await launch(directory,variant==='legacy-unproven'?'eight':variant);children.push(second.child);const recovered=await second.command('inspect');assert.equal(recovered.workerCalls,0);assert.equal(recovered.question?.id,original.question?.id);assert.equal(recovered.question?.runId,original.question?.runId);
  if(variant==='eight'){assert.equal(recovered.question?.status,'pending');assert.equal(original.snapshotEvidence,undefined);assert.equal(recovered.snapshotEvidence,undefined);await second.command('answer');const completed=await until(()=>second.command('inspect'),state=>state.task?.status==='succeeded');assert.equal(completed.task?.runIds.at(-1),original.question?.runId);assert.ok(completed.snapshotEvidence);assert.equal(completed.snapshotEvidence.dataHash,completed.snapshotEvidence.eventHash);assert.equal(completed.snapshotEvidence.sequence,completed.snapshotEvidence.eventSequence);await stop(second.child);const third=await launch(directory,'eight');children.push(third.child);const cold=await third.command('inspect');assert.deepEqual(cold.snapshotEvidence,completed.snapshotEvidence);assert.equal(cold.workerCalls,0);}
  else{assert.equal(recovered.question?.status,'interrupted');assert.equal(recovered.task?.status,'interrupted');assert.ok(recovered.events.some(event=>event.data.code===(variant==='legacy-unproven'?'run_recovery_image_policy_unavailable':'run_recovery_image_policy_changed')));assert.equal(recovered.nativeStatus,'cancelled','an unresumable original worker cannot keep an orphaned native resource');}
 }finally{for(const child of children)await stop(child);await removeTemp(directory);}
});

test('failed native cleanup remains pending and the same management action can retry without replay',{timeout:40000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-image-policy-cleanup-')),children:ChildProcess[]=[];
 try{const first=await launch(directory,'eight');children.push(first.child);await first.command('submit');const original=await until(()=>first.command('inspect'),state=>state.question?.status==='pending'&&Boolean(state.seal?.imagePolicyHash));await stop(first.child);
  const second=await launch(directory,'two-cancel-unavailable');children.push(second.child);const pending=await second.command('inspect');assert.equal(pending.nativeStatus,'running');assert.equal(pending.task?.status,'interrupted');assert.equal(pending.cleanup?.status,'pending');assert.equal(pending.cleanup?.resources[0]?.code,'run_recovery_resource_cleanup_failed');assert.equal(pending.question?.id,original.question?.id);assert.equal(pending.workerCalls,0);
  const retried=await second.command('retry-cleanup');assert.equal(retried.nativeStatus,'cancelled');assert.equal(retried.cleanup?.status,'complete');assert.equal(retried.task?.status,'interrupted');assert.equal(retried.question?.id,original.question?.id);assert.equal(retried.workerCalls,0);
 }finally{for(const child of children)await stop(child);await removeTemp(directory);}
});

test('a changed resource proof cannot authorize cancellation of a native task',{timeout:40000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-image-policy-invalid-resource-')),children:ChildProcess[]=[];
 try{const first=await launch(directory,'eight');children.push(first.child);await first.command('submit');const original=await until(()=>first.command('inspect'),state=>state.question?.status==='pending'&&Boolean(state.seal?.imagePolicyHash));await stop(first.child);
  const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{const id=`run-recovery:${original.question!.runId}`,body=JSON.parse(String(db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(id)!.body)) as RunRecoveryEnvelope;body.resources![0]!.digest='0'.repeat(64);db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(body),id);}finally{db.close();}
  const second=await launch(directory,'eight');children.push(second.child);const blocked=await second.command('inspect');assert.equal(blocked.workerCalls,0);assert.equal(blocked.nativeStatus,'running');assert.equal(blocked.task?.status,'interrupted');assert.equal(blocked.cleanup?.status,'blocked');assert.equal(blocked.cleanup?.resources[0]?.code,'run_recovery_resource_changed');
 }finally{for(const child of children)await stop(child);await removeTemp(directory);}
});

test('temporary native cleanup failure heals on the existing core tick without a client retry or restart',{timeout:40000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-image-policy-cleanup-auto-')),children:ChildProcess[]=[];
 try{const first=await launch(directory,'eight');children.push(first.child);await first.command('submit');const original=await until(()=>first.command('inspect'),state=>state.question?.status==='pending'&&Boolean(state.seal?.imagePolicyHash));await stop(first.child);
  const second=await launch(directory,'two-cancel-unavailable');children.push(second.child);const before=await second.command('inspect');assert.equal(before.nativeStatus,'running');assert.equal(before.cleanup?.status,'pending');assert.equal(before.publicResourceCleanup?.[0]?.status,'pending');assert.equal(before.cleanup?.attempts,1);
  await second.command('network-restored');const after=await until(()=>second.command('inspect'),state=>state.cleanup?.status==='complete');assert.equal(after.nativeStatus,'cancelled');assert.equal(after.cleanup?.attempts,2);assert.equal(after.publicResourceCleanup?.[0]?.status,'complete');assert.equal(after.question?.id,original.question?.id);assert.equal(after.task?.status,'interrupted');assert.equal(after.workerCalls,0);assert.equal(JSON.stringify(after.publicResourceCleanup).includes('nativeTaskId'),false);
 }finally{for(const child of children)await stop(child);await removeTemp(directory);}
});
