import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import type {SignalRecord} from '../src/domain.js';
import {authenticatedApp,removeTemp,until} from './helpers.js';

test('a group whose native message creation finishes backwards keeps its submitted source order after SIGKILL',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-group-input-order-'));const child=fork(fileURLToPath(new URL('./group-input-order-fixture.ts',import.meta.url)),[directory],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});let ready=false,output='',calls=0,core:Core|undefined;
  child.stdout?.on('data',data=>output+=String(data));child.stderr?.on('data',data=>output+=String(data));child.on('message',value=>{if(value&&typeof value==='object'&&'type'in value&&value.type==='group-request')ready=true;});
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  try{
    await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(output||'fixture_exited');return ready;},Boolean);const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
    const prompt=JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory,'ordered-group-boundary.json'),'utf8')).prompt);let previous=-1;for(let i=0;i<9;i++){const position=prompt.indexOf(`ORDER_MEMBER_${i}`);assert.ok(position>previous,'the actual first provider prompt preserves initial native input order');previous=position;}
    core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(calls,0,'recovery cannot replay the group automatically');
    const app=authenticatedApp(core),response=await app.request('/conversation?contextId=main&limit=200');assert.equal(response.status,200);const page=await response.json() as {messages:Array<{role:string;content:string}>};assert.deepEqual(page.messages.filter(row=>row.role==='user').map(row=>row.content),['ORDER_ACTIVE',...Array.from({length:9},(_,i)=>`ORDER_MEMBER_${i}`)]);
    const interrupted=core.store.db.prepare("SELECT id FROM runs WHERE status='interrupted'").all();assert.equal(interrupted.length,1);const binding=core.runtime.setting<{signalIds:string[]}>(`session-input-order:${interrupted[0]!.id}`,{signalIds:[]});assert.equal(binding.signalIds.length,9);
    for(const id of binding.signalIds){const signal:SignalRecord=core.store.getSignal(id)!;assert.equal(signal.runId,interrupted[0]!.id);assert.equal(signal.attachments?.length,1);}
    await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(calls,0);const reopened=await (await authenticatedApp(core).request('/conversation?contextId=main&limit=200')).json();assert.deepEqual(reopened,page);
  }finally{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;}await core?.close();await removeTemp(directory);}
});
