import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import type {QueueWithdrawalResult} from '../src/protocol.js';
import { authenticatedApp,finished,until,removeTemp } from './helpers.js';

async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-withdraw-'));let release!:()=>void;let blocked=true;const gate=new Promise<void>(resolve=>{release=resolve;});const prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(blocked){blocked=false;await gate;}return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'complete'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  let core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  const first=await core.submitMessage({content:'Keep the first request active'});await until(()=>prompts.length,n=>n===1);
  return {get core(){return core;},prompts,first,release,async reopen(){await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});},async close(){release();await core.close();await removeTemp(directory);}};
}

test('persistent batch withdrawal restores original text, attachments, Shell results and selected Skills after a client/Core restart',{timeout:30000},async()=>{
  const f=await fixture();try{
    const skillDir=path.join(f.core.capabilities.root('default').path,'skills','synthetic');fs.mkdirSync(skillDir,{recursive:true});fs.writeFileSync(path.join(skillDir,'SKILL.md'),'---\nname: synthetic\ndescription: Synthetic fixture\n---\nSYNTHETIC_SKILL_RESTORE_MATERIAL');
    const bytes=Buffer.from('SYNTHETIC_ATTACHMENT_RESTORE_MATERIAL');const asset=await f.core.assets.put(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),'fixture.txt');
    const plain=await f.core.submitMessage({content:'SYNTHETIC_SHELL_RESTORE_MATERIAL\nqueued original',sourceText:'queued original',attachments:[asset.id],mode:'queue'});
    const skill=await f.core.invokeSkill('main','synthetic',{content:'SYNTHETIC_SKILL_SHELL_RESTORE_MATERIAL\nsecond request',sourceText:'/skill synthetic second request',mode:'queue'},'synthetic-restore-skill');
    assert.equal(plain.status,'queued');assert.equal(skill.status,'queued');const entries=f.core.queuedMessages('main').map(({id,revision})=>({id,revision}));
    let app=authenticatedApp(f.core);const headers={'content-type':'application/json','Idempotency-Key':'restore-batch'};
    let response=await app.request('/contexts/main/message-queue/withdraw',{method:'POST',headers,body:JSON.stringify({entries})});assert.equal(response.status,200);const receipt=await response.json() as QueueWithdrawalResult;
    assert.deepEqual(receipt.withdrawn.map(item=>item.id),[plain.id,skill.id]);assert.deepEqual(receipt.withdrawn[0]!.attachments,[asset.id]);assert.equal(receipt.withdrawn[0]!.content,'queued original');assert.equal(f.core.queuedMessages('main').length,0);
    assert.doesNotMatch(JSON.stringify(receipt),/SYNTHETIC_SHELL_RESTORE_MATERIAL|SYNTHETIC_SKILL_RESTORE_MATERIAL|SYNTHETIC_SKILL_SHELL_RESTORE_MATERIAL/);
    response=await app.request('/contexts/main/message-queue/withdraw',{method:'POST',headers,body:JSON.stringify({entries})});assert.deepEqual(await response.json(),receipt);
    assert.equal((await app.request('/contexts/main/message-queue/withdraw',{method:'POST',headers,body:JSON.stringify({entries:entries.slice(0,1)})})).status,409);
    f.release();assert.equal((await finished(f.core,f.first.runId!))!.status,'succeeded');await f.reopen();app=authenticatedApp(f.core);
    const discovery=await (await app.request('/contexts/main/message-queue/withdrawals')).json() as {operations:QueueWithdrawalResult[]};assert.deepEqual(discovery.operations,[receipt]);
    const other=f.core.createConversationContext({name:'Other',id:'chat.other'});await assert.rejects(f.core.submitMessage({contextId:other.id,content:'invalid cross-context restoration',restoredFromSignalIds:[plain.id]}),/message_restoration_not_authorized/);
    const id=randomUUID(),content='edited restored text\n/skill synthetic second request';const input={id,content,attachments:[asset.id],restoredFromSignalIds:[plain.id,skill.id]};
    const submissions=await Promise.allSettled([f.core.submitMessage(input),f.core.submitMessage({...input,id:randomUUID()})]);assert.equal(submissions[0]!.status,'fulfilled');assert.equal(submissions[1]!.status,'rejected');
    const restored=(submissions[0] as PromiseFulfilledResult<Awaited<ReturnType<Core['submitMessage']>>>).value;assert.match(String((submissions[1] as PromiseRejectedResult).reason),/message_restoration_(?:in_progress|already_used)/);assert.equal((await finished(f.core,restored.runId!))!.status,'succeeded');
    assert.equal(restored.content,content);const prompt=f.prompts.at(-1)!;for(const marker of ['SYNTHETIC_SHELL_RESTORE_MATERIAL','SYNTHETIC_SKILL_SHELL_RESTORE_MATERIAL','SYNTHETIC_SKILL_RESTORE_MATERIAL','SYNTHETIC_ATTACHMENT_RESTORE_MATERIAL'])assert.match(prompt,new RegExp(marker));
    assert.deepEqual(f.core.queueWithdrawalReceipts('main'),[]);const calls=f.prompts.length;assert.equal((await f.core.submitMessage(input)).nativeSignalId,restored.nativeSignalId);assert.equal(f.prompts.length,calls);
    await assert.rejects(f.core.submitMessage({...input,id:randomUUID()}),/message_restoration_already_used/);
  }finally{await f.close();}
});

test('withdrawal reports stale, absent and already-started inputs individually without cancelling successors',{timeout:30000},async()=>{
  const f=await fixture();try{
    const q=await f.core.submitMessage({content:'will be stale',mode:'queue'});const valid=await f.core.submitMessage({content:'withdraw this one',mode:'queue'});const rows=f.core.queuedMessages('main');
    const entries=[{id:q.id,revision:rows.find(row=>row.id===q.id)!.revision+1},{id:randomUUID(),revision:1},{id:valid.id,revision:rows.find(row=>row.id===valid.id)!.revision}];
    const result=f.core.withdrawQueuedMessages('main',entries,'mixed');assert.deepEqual(result.withdrawn.map(row=>row.id),[valid.id]);assert.deepEqual(result.skipped.map(row=>row.reason),['revision_conflict','queued_message_not_found']);
    assert.equal(f.core.store.getSignal(q.id)!.status,'queued');f.release();await finished(f.core,f.first.runId!);await until(()=>f.core.store.getSignal(q.id)!,record=>record.status==='accepted');const qRun=f.core.store.getSignal(q.id)!.runId!;await finished(f.core,qRun);
    const started=f.core.withdrawQueuedMessages('main',[{id:q.id,revision:rows.find(row=>row.id===q.id)!.revision}],'started');assert.equal(started.skipped[0]!.reason,'message_already_started');assert.equal(f.core.store.getSignal(q.id)!.status,'accepted');
  }finally{await f.close();}
});

test('a lost final receipt remains discoverable and replayable after restart',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.core.submitMessage({content:'original receipt must survive',mode:'queue'});const entries=f.core.queuedMessages('main').map(({id,revision})=>({id,revision}));const set=f.core.runtime.setSetting.bind(f.core.runtime);let failed=false;
    f.core.runtime.setSetting=(key,value)=>{set(key,value);if(key.startsWith('queue-withdraw:')&&(value as {complete?:boolean}).complete&&!failed){failed=true;throw Error('synthetic final response loss');}};
    assert.throws(()=>f.core.withdrawQueuedMessages('main',entries,'lost-receipt'),/synthetic final response loss/);f.core.runtime.setSetting=set;
    f.release();await finished(f.core,f.first.runId!);await f.reopen();const found=f.core.queueWithdrawalReceipts('main');assert.equal(found.length,1);assert.deepEqual(f.core.withdrawQueuedMessages('main',entries,'lost-receipt'),found[0]);assert.equal(found[0]!.withdrawn[0]!.content,'original receipt must survive');
  }finally{await f.close();}
});

test('native cancellation confirmed before a persistence fault resumes its pending withdrawal after restart',{timeout:30000},async()=>{
  const f=await fixture();try{
    const queued=await f.core.submitMessage({content:'pending journal source',mode:'queue'});const entries=f.core.queuedMessages('main').map(({id,revision})=>({id,revision}));const set=f.core.runtime.setSetting.bind(f.core.runtime);let failed=false;
    f.core.runtime.setSetting=(key,value)=>{if(key.startsWith('queue-withdraw:')&&(value as {pending?:{nativeConfirmed?:boolean}}).pending?.nativeConfirmed&&!failed){failed=true;throw Error('synthetic progress persistence loss');}set(key,value);};
    assert.throws(()=>f.core.withdrawQueuedMessages('main',entries,'pending-recovery'),/synthetic progress persistence loss/);f.core.runtime.setSetting=set;assert.equal(f.core.store.getSignal(queued.id)!.status,'queued');
    f.release();await finished(f.core,f.first.runId!);await f.reopen();const receipts=f.core.queueWithdrawalReceipts('main');assert.equal(receipts.length,1);assert.equal(receipts[0]!.withdrawn[0]!.id,queued.id);assert.equal(f.core.store.getSignal(queued.id)!.status,'cancelled');
    assert.equal(f.prompts.length,1,'the withdrawn input never executes while restoring its receipt');
  }finally{await f.close();}
});
