import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import type {InteractionRecord} from '../src/interactions.js';
import type {InteractionAnswerReceipt} from '../src/interactions.js';
import {removeTemp,until} from './helpers.js';
interface State{type:string;calls:number;refreshes:number;interactions:InteractionRecord[];answers:InteractionAnswerReceipt[];sealed:boolean;identity:unknown;runs:Array<{status:string}>;events:Array<{data:{code:string}}>}
async function launch(directory:string,env:Record<string,string>={}){const messages:Array<State&{error?:string}>=[];let logs='';const child=fork(fileURLToPath(new URL('./interaction-auth-recovery-fixture.ts',import.meta.url)),[directory],{execArgv:['--import','tsx'],env:{...process.env,...env},stdio:['ignore','pipe','pipe','ipc']});child.on('message',value=>messages.push(value as State));child.stdout?.on('data',value=>logs+=String(value));child.stderr?.on('data',value=>logs+=String(value));await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(logs);return messages.find(row=>row.type==='ready');},Boolean,20000);return {child,async command(type:string,variant?:string){const start=messages.length;child.send({type,variant});return await until(()=>{const result=messages.slice(start).find(row=>['state','fixture-error','closed'].includes(row.type));if(result?.type==='fixture-error')throw Error(result.error);return result;},Boolean,20000) as State;}};}
async function kill(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
for(const variant of ['same','account','scope']as const)test(`an original native question ${variant==='same'?'survives a proven native refresh':'rejects a refreshed '+variant+' change'} across restart`,{timeout:45000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-auth-question-')),children:ChildProcess[]=[];
  try{
    const first=await launch(directory);children.push(first.child);await first.command('submit');const before=await until(()=>first.command('inspect'),state=>state.interactions.some(row=>row.status==='pending')&&state.sealed);
    const question=before.interactions[0]!,refreshed=await first.command('refresh',variant);assert.equal(refreshed.refreshes,1);assert.equal(refreshed.calls,1);
    if(variant==='same')assert.deepEqual(refreshed.identity,before.identity);else assert.notDeepEqual(refreshed.identity,before.identity);
    await kill(first.child);const second=await launch(directory);children.push(second.child);const restored=await second.command('inspect');assert.equal(restored.calls,0,'cold restoration never replays the worker or model');
    assert.equal(restored.interactions[0]!.id,question.id);assert.equal(restored.interactions[0]!.runId,question.runId);
    if(variant==='same'){assert.equal(restored.interactions[0]!.status,'pending');await second.command('answer');const complete=await until(()=>second.command('inspect'),state=>state.runs[0]?.status==='succeeded');assert.equal(complete.interactions[0]!.status,'answered');assert.equal(complete.calls,1);}
    else{assert.equal(restored.interactions[0]!.status,'interrupted');assert.equal(restored.runs[0]!.status,'interrupted');assert.ok(restored.events.some(event=>event.data.code==='run_recovery_credentials_changed'));}
  }finally{for(const child of children)await kill(child);await removeTemp(directory);}
});
for(const status of ['503','400'])test(`a cold native question retains its saved answer while OAuth refresh returns ${status}`,{timeout:45000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-auth-outage-')),children:ChildProcess[]=[];
  try{
    const first=await launch(directory,{SYNTHETIC_AUTH_VALIDITY_MS:'10000'});children.push(first.child);await first.command('submit');const original=await until(()=>first.command('inspect'),state=>state.interactions.some(row=>row.status==='pending')&&state.sealed);await kill(first.child);
    const second=await launch(directory,{SYNTHETIC_AUTH_FAILURE:status});children.push(second.child);const restored=await second.command('inspect');assert.equal(restored.calls,0);assert.equal(restored.interactions[0]!.status,'pending');await second.command('save-answer');
    const blocked=await until(()=>second.command('inspect'),state=>state.answers[0]?.status==='blocked');assert.equal(blocked.answers[0]!.retryable,status==='503');assert.equal(blocked.answers[0]!.errorCode,status==='503'?'run_recovery_authentication_unavailable':'run_recovery_authentication_required');assert.equal(blocked.calls,0);assert.equal(blocked.interactions[0]!.runId,original.interactions[0]!.runId);
    await kill(second.child);const third=await launch(directory,{SYNTHETIC_AUTH_FAILURE:status});children.push(third.child);const saved=await third.command('inspect');assert.equal(saved.calls,0);assert.equal(saved.answers[0]!.id,blocked.answers[0]!.id);assert.equal(saved.interactions[0]!.status,'pending');
    if(status==='503'){await third.command('network-online');const complete=await until(()=>third.command('inspect'),state=>state.runs[0]?.status==='succeeded',15000);assert.equal(complete.interactions[0]!.status,'answered');assert.equal(complete.answers[0]!.status,'delivered');assert.equal(complete.answers[0]!.attempts,1);assert.equal(complete.calls,1);assert.deepEqual(complete.identity,original.identity);}
  }finally{for(const child of children)await kill(child);await removeTemp(directory);}
});
