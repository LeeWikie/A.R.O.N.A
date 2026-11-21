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
import type {RunRecord} from '../src/domain.js';
import type {RunRecoveryEnvelope} from '../src/run-recovery.js';
import {removeTemp,until} from './helpers.js';

interface State{type:string;calls:number;imageReads:number;omissions:number;question?:InteractionRecord;run?:RunRecord;sourceBody?:string;seal?:RunRecoveryEnvelope;proofs:Array<{id:string;body:string}>;events:Array<{data:{code:string}}>;error?:string;}
async function launch(directory:string,policy:string,plain=false){
 const child=fork(fileURLToPath(new URL('./attachment-image-recovery-fixture.ts',import.meta.url)),[directory,policy,...(plain?['plain']:[])],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']}),events:Array<Record<string,unknown>>=[];let logs='';child.on('message',value=>{if(value&&typeof value==='object')events.push(value as Record<string,unknown>);});child.stdout?.on('data',part=>{logs=(logs+part).slice(-10000);});child.stderr?.on('data',part=>{logs=(logs+part).slice(-10000);});
 const next=async(offset:number,types:string[])=>await until(()=>{const result=events.slice(offset).find(value=>typeof value.type==='string'&&types.includes(value.type));if(result?.type==='fixture-error')throw Error(String(result.error));if(child.exitCode!==null||child.signalCode!==null)throw Error('fixture_ended '+logs);return result;},Boolean);
 await next(0,['ready','fixture-error']);return{child,async command(type:string){const offset=events.length;child.send({type});return await next(offset,['state','fixture-error']) as unknown as State;}};
}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,'exit');child.kill('SIGKILL');await ended;}

for(const mode of['same','changed','tampered','text-only','plain']as const)test(`a genuine Main retained-image read and pending native question survive or refuse cold recovery by their exact consumed policy (${mode})`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-attachment-image-recovery-')),children:ChildProcess[]=[];
 try{
  const initialPolicy=mode==='text-only'?'text':'eight',first=await launch(directory,initialPolicy,mode==='plain');children.push(first.child);await first.command('seed');const original=await until(()=>first.command('inspect'),state=>state.question?.status==='pending'&&Boolean(state.seal));assert.ok(original.question);assert.equal(original.run?.status,'running');assert.equal(original.calls,mode==='plain'?3:5);assert.equal(original.imageReads,mode==='plain'?0:1);assert.equal(original.omissions,mode==='text-only'?1:0);
  if(mode==='plain'){assert.equal(original.proofs.length,0);assert.equal(original.seal?.imagePolicyHash,undefined);}else{assert.equal(original.proofs.length,1);assert.match(original.seal?.imagePolicyHash??'',/^[a-f0-9]{64}$/);}
  await stop(first.child);
  if(mode==='tampered'){const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{const saved=JSON.parse(original.proofs[0]!.body) as{value:{policyHash:string};digest:string};saved.value.policyHash='0'.repeat(64);db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(saved),original.proofs[0]!.id);}finally{db.close();}}
  const second=await launch(directory,mode==='changed'||mode==='plain'?'two':initialPolicy,mode==='plain');children.push(second.child);const recovered=await second.command('inspect');assert.equal(recovered.calls,0,'opening must not replay any original model or image read');assert.equal(recovered.question?.id,original.question.id);assert.equal(recovered.question?.runId,original.question.runId);assert.equal(recovered.sourceBody,original.sourceBody,'the original accepted source is not rewritten');
  if(mode==='changed'||mode==='tampered'){assert.equal(recovered.question?.status,'interrupted');assert.equal(recovered.run?.status,'interrupted');assert.ok(recovered.events.some(row=>row.data.code===(mode==='changed'?'run_recovery_image_policy_changed':'session_recovery_image_source_changed')));assert.equal(recovered.calls,0);}
  else{assert.equal(recovered.question?.status,'pending');assert.equal(recovered.run?.status,'running');assert.deepEqual(recovered.proofs,original.proofs);const completed=await second.command('answer');assert.equal(completed.run?.status,'succeeded');assert.equal(completed.question?.status,'answered');assert.equal(completed.calls,1);assert.equal(completed.imageReads,0,'resume consumes the original result rather than reading or normalizing again');assert.deepEqual(completed.proofs,original.proofs);}
 }finally{for(const child of children)await stop(child);await removeTemp(directory);}
});
