import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import type { QueueEditDocument, QueueEditEntry, QueueEditPage } from '../src/protocol.js';
import { authenticatedApp, finished, removeTemp, until } from './helpers.js';

async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-edit-'));let release!:()=>void;let hold=true;const gate=new Promise<void>(resolve=>{release=resolve;});const prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(hold){hold=false;await gate;}return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'synthetic-answer'});c.enqueue({type:'text-delta',id:'synthetic-answer',delta:'SYNTHETIC_GROUP_RESULT'});c.enqueue({type:'text-end',id:'synthetic-answer'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  let core=await Core.open({dataDir:directory,model,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'https://fixture.invalid/v1',apiKey:'synthetic-only',authHeader:'bearer',modelId:'synthetic-queue-editor',contextWindow:512000,maxTokens:1024}});
  const first=await core.submitMessage({content:'SYNTHETIC_ACTIVE_REQUEST'});await until(()=>prompts.length,n=>n===1);
  return {get core(){return core;},prompts,first,release,async reopen(){await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'https://fixture.invalid/v1',apiKey:'synthetic-only',authHeader:'bearer',modelId:'synthetic-queue-editor',contextWindow:512000,maxTokens:1024}});},async close(){release();await core.close();await removeTemp(directory);}};
}
async function entries(core:Core,draft:QueueEditDocument){let cursor:number|null=0;const rows:QueueEditEntry[]=[];do{const page=core.queueEditor().page(draft.contextId,draft.id,cursor,20);rows.push(...page.entries);cursor=page.nextCursor;}while(cursor!==null);return rows;}
test('one active-run native input group presents all independently sourced segments at the same next request',{timeout:30000},async()=>{
  const f=await fixture();try{
    const texts=Array.from({length:65},(_,i)=>`SYNTHETIC_STEERING_GROUP_${i}`);
    for(const content of texts)await f.core.submitMessage({content,mode:'queue'});
    const draft=f.core.queueEditor().create('main',{},'capture-steer-group');
    const receipt=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision,mode:'steer',expectedRunId:f.first.runId},'steer-group');
    assert.equal(receipt.status,'submitted');assert.equal(receipt.submission!.groupReady,true);assert.ok(receipt.submission!.entries.every(row=>f.core.store.getSignal(row.signalId)!.runId===f.first.runId));
    f.release();await finished(f.core,f.first.runId!);assert.equal(f.prompts.length,2);for(const content of texts)assert.ok(f.prompts[1]!.includes(content));
  }finally{await f.close();}
});
for(const scenario of ['sixty-five','over-single-message-limit','nine-attachments'] as const)test(`native queue document edits and submits all ${scenario} inputs without aggregate loss`,{timeout:30000},async()=>{
  const f=await fixture();try{
    const texts=scenario==='sixty-five'?Array.from({length:65},(_,i)=>`SYNTHETIC_QUEUE_${i}`):scenario==='over-single-message-limit'?['a'.repeat(40000),'b'.repeat(40000)]:Array.from({length:9},(_,i)=>`SYNTHETIC_FILE_REQUEST_${i}`);
    const assets=[];if(scenario==='nine-attachments')for(let i=0;i<9;i++)assets.push(await f.core.assets.put(new Response(`SYNTHETIC_ATTACHMENT_${i}`).body,`fixture-${i}.txt`));
    const originals=[];for(const [i,content] of texts.entries())originals.push(await f.core.submitMessage({content,mode:'queue',...(assets[i]?{attachments:[assets[i]!.id]}:{})}));
    const app=authenticatedApp(f.core),key=randomUUID();
    const response=await app.request('/contexts/main/message-queue/drafts',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify({current:{content:'SYNTHETIC_CURRENT_DRAFT'}})});assert.equal(response.status,200);
    const draft=await response.json() as QueueEditDocument;assert.equal(draft.entryCount,texts.length+1);assert.equal(f.core.queuedMessages('main').length,0);
    const rows=await entries(f.core,draft);assert.deepEqual(rows.map(row=>row.content),[...texts,'SYNTHETIC_CURRENT_DRAFT']);assert.deepEqual(rows.flatMap(row=>row.attachments),assets.map(row=>row.id));assert.deepEqual(rows.flatMap(row=>row.sourceSignalIds),originals.map(row=>row.id));
    const submit=await app.request(`/contexts/main/message-queue/drafts/${draft.id}/submit`,{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'submit-all'},body:JSON.stringify({expectedRevision:draft.revision})});assert.equal(submit.status,202);
    const receipt=await submit.json() as QueueEditDocument;assert.equal(receipt.status,'submitting');assert.equal(receipt.submission!.entries.length,texts.length+1);assert.equal(receipt.submission!.entries[0]!.status,'queued');assert.ok(receipt.submission!.entries.slice(1).every(row=>row.status==='pending'));
    const queued=f.core.queuedMessages('main');assert.equal(queued.length,1,'one native queue entry owns the entire input group');
    const staged=receipt.submission!.entries.map(row=>f.core.store.getSignal(row.signalId)!);assert.deepEqual(staged.map(row=>row.content),[...texts,'SYNTHETIC_CURRENT_DRAFT']);assert.deepEqual(staged.flatMap(row=>row.attachments??[]),assets.map(row=>row.id));
    await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'http:submit-all');assert.equal(f.core.queuedMessages('main').length,1);
    f.release();await finished(f.core,f.first.runId!);const completed=await until(()=>f.core.queueEditor().page('main',draft.id).draft,row=>row.status==='submitted');assert.equal(completed.submission!.groupReady,true);
    const records=completed.submission!.entries.map(row=>f.core.store.getSignal(row.signalId)!);assert.equal(new Set(records.map(row=>row.runId)).size,1);await finished(f.core,records[0]!.runId!);
    assert.equal(f.prompts.length,2,'one Enter produces one native prompt for the complete document');for(const content of [...texts,'SYNTHETIC_CURRENT_DRAFT'])assert.ok(f.prompts[1]!.includes(content),'the first request sees every original segment');for(const [i,asset] of assets.entries())assert.ok(f.prompts[1]!.includes(`SYNTHETIC_ATTACHMENT_${i}`),asset.id);
    const inputPositions=records.map(row=>f.prompts[1]!.indexOf(row.id));assert.ok(inputPositions.every((position,index)=>position>=0&&(index===0||position>inputPositions[index-1]!)),'the first request preserves the original group sequence');
    const conversation=await (await app.request('/conversation?contextId=main&limit=200')).json() as {messages:Array<{role:string;content:string;signalId?:string}>};assert.deepEqual(conversation.messages.filter(row=>row.role==='user').map(row=>row.content),['SYNTHETIC_ACTIVE_REQUEST',...texts,'SYNTHETIC_CURRENT_DRAFT']);
    const delivered=records.map(record=>f.core.store.outputsForSignal(record.id).find(row=>row.kind==='message'));assert.ok(delivered.every(Boolean));assert.equal(new Set(delivered.map(row=>row!.id)).size,1);assert.deepEqual(delivered[0]!.signalIds,records.map(row=>row.id),'the group result keeps every causal source');
    for(const [i,original] of originals.entries()){assert.equal(f.core.store.getSignal(original.id)!.status,'cancelled');assert.equal(f.core.store.getSignal(receipt.submission!.entries[i]!.signalId)!.content,texts[i]);}
  }finally{await f.close();}
});

test('queue document add/remove/reorder and edited sources survive restart, CAS and an unknown native admission',{timeout:30000},async()=>{
  const f=await fixture();try{
    const root=f.core.capabilities.root('default').path,skill=path.join(root,'skills','synthetic');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: synthetic\ndescription: Synthetic fixture\n---\nSYNTHETIC_SKILL_MATERIAL');
    const plain=await f.core.submitMessage({content:'SYNTHETIC_LOCAL_COMMAND_RESULT\n  raw source  ',sourceText:'  raw source  ',mode:'queue'});
    await f.core.invokeSkill('main','synthetic',{content:'task text',sourceText:'/skill synthetic task text',mode:'queue'},'fixture-skill');
    let draft=f.core.queueEditor().create('main',{},'capture');let rows=await entries(f.core,draft);
    const mutate=(action:unknown)=>{draft=f.core.queueEditor().mutate('main',draft.id,{expectedRevision:draft.revision,action},randomUUID());};
    mutate({kind:'edit',entryId:rows[0]!.id,content:'edited source',attachments:[]});
    assert.throws(()=>f.core.queueEditor().mutate('main',draft.id,{expectedRevision:1,action:{kind:'remove',entryId:rows[0]!.id,removed:true}},'stale'),/revision_conflict/);
    mutate({kind:'add',afterId:null,input:{content:'new first'}});rows=await entries(f.core,draft);
    mutate({kind:'move',entryId:rows[2]!.id,beforeId:rows[1]!.id});
    mutate({kind:'remove',entryId:rows[0]!.id,removed:true});
    f.release();await finished(f.core,f.first.runId!);await f.reopen();rows=await entries(f.core,draft);assert.deepEqual(rows.filter(row=>!row.removed).map(row=>row.content),['/skill synthetic task text','edited source']);
    const state=f.core as unknown as {enqueueMessage:(...args:any[])=>Promise<unknown>};const original=state.enqueueMessage.bind(f.core);let lost=true;
    state.enqueueMessage=async(...args)=>{const result=await original(...args);if(lost){lost=false;throw Error('synthetic response loss after actual native admission');}return result;};
    await assert.rejects(f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'send'),/synthetic response loss/);state.enqueueMessage=original;
    const sent=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'send');assert.equal(sent.status,'submitted');
    for(const item of sent.submission!.entries){const record=await until(()=>f.core.store.getSignal(item.signalId)!,row=>row.status==='accepted');await finished(f.core,record.runId!);}
    const prompt=f.prompts.at(-1)!;for(const marker of ['SYNTHETIC_LOCAL_COMMAND_RESULT','SYNTHETIC_SKILL_MATERIAL','edited source'])assert.match(prompt,new RegExp(marker));
    assert.equal(f.core.store.getSignal(plain.id)!.content,'  raw source  ');assert.equal(sent.submission!.entries.length,2);assert.equal(new Set(sent.submission!.entries.map(row=>row.signalId)).size,2);
  }finally{await f.close();}
});

test('whole-document media preflight fails before any native submission and keeps every draft entry',{timeout:30000},async()=>{
  const f=await fixture();try{
    const asset=await f.core.assets.put(new Response('synthetic attachment').body,'fixture.txt');
    await f.core.submitMessage({content:'first',mode:'queue'});await f.core.submitMessage({content:'second',attachments:[asset.id],mode:'queue'});
    const draft=f.core.queueEditor().create('main',{},'capture');const rows=await entries(f.core,draft),source=rows[1]!;
    f.core.queueEditor().mutate('main',draft.id,{expectedRevision:draft.revision,action:{kind:'edit',entryId:source.id,content:source.content,attachments:[randomUUID()]}},'change');
    await assert.rejects(f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision+1},'submit'));
    assert.equal(f.core.queuedMessages('main').length,0);assert.equal(f.prompts.length,1);const retained=f.core.queueEditor().page('main',draft.id);assert.equal(retained.draft.status,'editing');assert.equal(retained.draft.submission,undefined);assert.equal(retained.entries.length,2);
  }finally{await f.close();}
});

test('an obsolete steering address fails whole-document preflight, while current-model revalidation preserves raw sources',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.core.submitMessage({content:'source stays in original words',mode:'queue'});const draft=f.core.queueEditor().create('main',{},'capture');
    await assert.rejects(f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision,mode:'steer',expectedRunId:'stale-run'},'stale'),/run_changed/);
    assert.equal(f.core.queuedMessages('main').length,0);assert.equal(f.core.queueEditor().page('main',draft.id).draft.submission,undefined);
    f.core.credentials.set('QUEUE_MODEL_CREDENTIAL','synthetic-only');f.core.models.save({id:'default',name:'Changed configuration',protocol:'responses',baseURL:'https://fixture.invalid/v1',modelId:'synthetic-changed-model',apiKeyEnv:'QUEUE_MODEL_CREDENTIAL',contextWindow:512000,maxTokens:1024,thinking:{high:{reasoningEffort:'high'}},defaultThinkingLevel:'high'});
    await f.core.switchModel('main','default','high');
    const receipt=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'valid');assert.equal(receipt.status,'submitting');assert.equal(f.core.queuedMessages('main')[0]!.content,'source stays in original words');assert.equal((await f.core.modelState('main')).thinkingLevel,'high');
  }finally{await f.close();}
});

test('a changed workspace cannot reuse selected Skill authority and rejects every draft entry before native admission',{timeout:30000},async()=>{
  const f=await fixture();try{
    const oldRoot=f.core.capabilities.root('default').path,skill=path.join(oldRoot,'skills','synthetic');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: synthetic\ndescription: Synthetic fixture\n---\nSYNTHETIC_SKILL_MATERIAL');
    await f.core.submitMessage({content:'first unprivileged source',mode:'queue'});await f.core.invokeSkill('main','synthetic',{content:'task',sourceText:'/skill synthetic task',mode:'queue'},'skill');const draft=f.core.queueEditor().create('main',{},'capture');
    f.release();await finished(f.core,f.first.runId!);await until(()=>f.core.sessions.peek('main')?.run.getRunId(),id=>!id);
    const replacement=path.join(path.dirname(oldRoot),'replacement');fs.mkdirSync(replacement);await f.core.updateWorkspace('default',{expectedPath:oldRoot,path:replacement});
    const calls=f.prompts.length;await assert.rejects(f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'submit'),/skill_workspace_changed/);
    assert.equal(f.core.queuedMessages('main').length,0);assert.equal(f.prompts.length,calls);assert.equal(f.core.queueEditor().page('main',draft.id).draft.submission,undefined);assert.equal((await entries(f.core,draft)).length,2);
  }finally{await f.close();}
});

test('a Shell observation with no separate current request follows the restored text without inventing a user utterance',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.core.submitMessage({content:'only original user request',mode:'queue'});const draft=f.core.queueEditor().create('main',{current:{content:'',localContext:'SYNTHETIC_CURRENT_SHELL_OBSERVATION'}},'capture');
    const receipt=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'submit');assert.equal(receipt.submission!.entries.length,1);
    f.release();await finished(f.core,f.first.runId!);const signalId=receipt.submission!.entries[0]!.signalId;const signal=await until(()=>f.core.store.getSignal(signalId)!,row=>row.status==='accepted');await finished(f.core,signal.runId!);
    assert.equal(signal.content,'only original user request');assert.match(f.prompts.at(-1)!,/SYNTHETIC_CURRENT_SHELL_OBSERVATION/);
  }finally{await f.close();}
});

test('after one real steering delivery and its run ending, restart reopens only the unsent entries in the same document',{timeout:30000},async()=>{
  const f=await fixture();try{
    const first=await f.core.submitMessage({content:'FIRST_STEERING_SOURCE',mode:'queue'}),second=await f.core.submitMessage({content:'SECOND_STEERING_SOURCE',mode:'queue'});
    const draft=f.core.queueEditor().create('main',{},'capture');const internal=f.core as unknown as {steerMessages:(...args:any[])=>Promise<any>};const steer=internal.steerMessages.bind(f.core);let stopAfterFirst=true;
    internal.steerMessages=async(contextId,rows,runId)=>{if(!stopAfterFirst)return steer(contextId,rows,runId);stopAfterFirst=false;await steer(contextId,rows.slice(0,1),runId);f.release();await finished(f.core,f.first.runId!);return steer(contextId,rows.slice(1),runId);};
    await assert.rejects(f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision,mode:'steer',expectedRunId:f.first.runId},'steer-document'),/run_changed|reply_not_available/);internal.steerMessages=steer;
    const blocked=f.core.queueEditor().page('main',draft.id).draft;assert.equal(blocked.status,'blocked');assert.equal(blocked.submission!.entries[0]!.status,'accepted');assert.equal(blocked.submission!.entries[1]!.status,'pending');
    const originalFirstId=blocked.submission!.entries[0]!.signalId,calls=f.prompts.length;await f.reopen();assert.equal(f.prompts.length,calls,'restart cannot replay an already delivered steering source');
    const reopened=f.core.queueEditor().reopen('main',draft.id,{expectedRevision:draft.revision},'reopen-remaining');assert.equal(reopened.id,draft.id);assert.equal(reopened.entryCount,1);assert.equal(reopened.previousSubmissions!.length,1);
    const rows=await entries(f.core,reopened);assert.equal(rows[0]!.admittedSignalId,originalFirstId);assert.equal(rows[1]!.admittedSignalId,undefined);assert.deepEqual(rows[1]!.sourceSignalIds,[second.id]);
    assert.throws(()=>f.core.queueEditor().mutate('main',draft.id,{expectedRevision:reopened.revision,action:{kind:'edit',entryId:rows[0]!.id,content:'cannot replay',attachments:[]}},'invalid-edit'),/queue_entry_already_admitted/);
    const sent=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:reopened.revision,mode:'queue'},'send-remaining');assert.equal(sent.submission!.entries.length,1);const remaining=await until(()=>f.core.store.getSignal(sent.submission!.entries[0]!.signalId)!,row=>row.status==='accepted');await finished(f.core,remaining.runId!);
    assert.equal(remaining.content,'SECOND_STEERING_SOURCE');assert.equal(f.core.runtime.setting<{bySignalId:string}>(`queue-restoration-consumed:${first.id}`,{bySignalId:''}).bySignalId,originalFirstId);
  }finally{await f.close();}
});

test('a persistence fault after native queue admission cannot execute a rejected staged source or trap its editor',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.core.submitMessage({content:'FAULTED_SOURCE',mode:'queue'});const draft=f.core.queueEditor().create('main',{},'capture');const queue=f.core.store.queue.bind(f.core.store);let fail=true;
    f.core.store.queue=(...args)=>{if(fail){fail=false;throw Error('synthetic queue receipt persistence loss');}return queue(...args);};
    await assert.rejects(f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'send'),/message_queue_failed/);f.core.store.queue=queue;
    const reopened=f.core.queueEditor().reopen('main',draft.id,{expectedRevision:draft.revision},'recover');assert.equal(reopened.entryCount,1);assert.equal(reopened.previousSubmissions![0]!.entries[0]!.status,'pending');
    const receipt=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:reopened.revision},'send-again');assert.equal(receipt.submission!.entries.length,1);f.release();await finished(f.core,f.first.runId!);
    const signal=await until(()=>f.core.store.getSignal(receipt.submission!.entries[0]!.signalId)!,row=>row.status==='accepted');await finished(f.core,signal.runId!);assert.equal(f.prompts.length,2,'the rejected native signal was cancelled before provider execution');
  }finally{await f.close();}
});

test('a queued input group can be withdrawn and edited as one document without duplicating its native leader or host materials',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.core.submitMessage({content:'SYNTHETIC_SHELL_MATERIAL\nSOURCE_A',sourceText:'SOURCE_A',mode:'queue'});await f.core.submitMessage({content:'SOURCE_B',mode:'queue'});
    const draft=f.core.queueEditor().create('main',{},'capture-group');const first=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'send-group');const oldLeader=first.submission!.leaderSignalId!;
    const reopened=f.core.queueEditor().reopen('main',draft.id,{expectedRevision:draft.revision},'reopen-group');assert.equal(reopened.entryCount,2);assert.equal(f.core.queuedMessages('main').length,0);assert.equal(f.core.store.getSignal(oldLeader)!.status,'cancelled');
    const rows=await entries(f.core,reopened);assert.ok(rows.every(row=>!row.admittedSignalId));assert.deepEqual(rows[0]!.sourceSignalIds,[oldLeader]);
    const changed=f.core.queueEditor().mutate('main',draft.id,{expectedRevision:reopened.revision,action:{kind:'edit',entryId:rows[0]!.id,content:'SOURCE_A_EDITED',attachments:[]}},'edit-group');const submitted=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:changed.revision},'send-edited-group');
    f.release();await finished(f.core,f.first.runId!);await until(()=>f.core.queueEditor().page('main',draft.id).draft.status,status=>status==='submitted');await finished(f.core,f.core.store.getSignal(submitted.submission!.leaderSignalId!)!.runId!);assert.equal(f.prompts.length,2);assert.equal(f.prompts[1]!.split('SYNTHETIC_SHELL_MATERIAL').length-1,1);assert.match(f.prompts[1]!,/SOURCE_A_EDITED/);assert.match(f.prompts[1]!,/SOURCE_B/);assert.equal(f.core.store.getSignal(oldLeader)!.action,null);
  }finally{await f.close();}
});

test('a model change before grouped execution applies to the original group without an extra retry',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.core.submitMessage({content:'CONFIG_SOURCE_A',mode:'queue'});await f.core.submitMessage({content:'CONFIG_SOURCE_B',mode:'queue'});const draft=f.core.queueEditor().create('main',{},'capture-before-config');const sent=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'submit-before-config');
    f.core.credentials.set('QUEUE_MODEL_CREDENTIAL','synthetic-only');f.core.models.save({id:'default',name:'Changed queued configuration',protocol:'responses',baseURL:'https://fixture.invalid/v1',modelId:'synthetic-changed-model',apiKeyEnv:'QUEUE_MODEL_CREDENTIAL',contextWindow:512000,maxTokens:1024});
    f.release();await finished(f.core,f.first.runId!);await until(()=>f.core.queueEditor().page('main',draft.id).draft.status,status=>status==='submitted');const leader=await until(()=>f.core.store.getSignal(sent.submission!.leaderSignalId!)!,row=>row.status==='accepted');await finished(f.core,leader.runId!);assert.equal(f.prompts.length,2);assert.match(f.prompts[1]!,/CONFIG_SOURCE_A/);assert.match(f.prompts[1]!,/CONFIG_SOURCE_B/);assert.equal(f.core.store.getRun(leader.runId!)!.status,'succeeded');assert.deepEqual(f.core.queueEditor().page('main',draft.id).draft.submission!.entries.map(row=>row.signalId),sent.submission!.entries.map(row=>row.signalId),'the queued original sources are retained');
  }finally{await f.close();}
});

for(const changed of[false,true])test(`a legacy editing document ${changed?'keeps unprovable source bindings and raw text':'migrates only after the complete old configuration matches'}`,{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.core.submitMessage({content:'LEGACY_SOURCE',mode:'queue'});const draft=f.core.queueEditor().create('main',{},'capture-legacy');const key=`queue-edit:${draft.id}`,stored=f.core.runtime.setting<any>(key,null);stored.signature=(f.core.queueEditor() as any).host.legacySignature('main');f.core.runtime.setSetting(key,stored);const original=JSON.stringify(stored.body);
  if(changed){f.core.credentials.set('QUEUE_MODEL_CREDENTIAL','synthetic-only');f.core.models.save({id:'default',name:'Changed model',protocol:'responses',baseURL:'https://fixture.invalid/v1',modelId:'another-model',apiKeyEnv:'QUEUE_MODEL_CREDENTIAL',contextWindow:512000,maxTokens:1024});await assert.rejects(f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'legacy-unverified'),/queue_source_unverified/);assert.equal(f.core.runtime.setting<any>(key,null).signature,stored.signature);assert.equal(JSON.stringify(f.core.runtime.setting<any>(key,null).body),original);assert.equal(f.core.queueEditor().page('main',draft.id).draft.submission,undefined);assert.equal(f.prompts.length,1);}
  else{const sent=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'legacy-verified');assert.match(f.core.runtime.setting<any>(key,null).signature,/^queue-source-v2:/);assert.equal(JSON.stringify(f.core.runtime.setting<any>(key,null).body),original);f.release();await finished(f.core,f.first.runId!);const record=await until(()=>f.core.store.getSignal(sent.submission!.leaderSignalId!)!,row=>row.status==='accepted');await finished(f.core,record.runId!);assert.equal(f.prompts.length,2);assert.equal(f.prompts[1]!.split('LEGACY_SOURCE').length-1,1);}
 }finally{await f.close();}
});

test('legacy single-message cancellation cancels a native group without stranding or losing its editable sources',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.core.submitMessage({content:'SYNTHETIC_LEGACY_CANCEL_SHELL\nSOURCE_A',sourceText:'SOURCE_A',mode:'queue'});await f.core.submitMessage({content:'SOURCE_B',mode:'queue'});const draft=f.core.queueEditor().create('main',{},'capture-legacy-cancel');await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'submit-legacy-cancel');
    const leader=f.core.queuedMessages('main')[0]!;const response=await authenticatedApp(f.core).request(`/messages/${leader.id}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({revision:leader.revision})});assert.equal(response.status,200);assert.equal(f.core.queuedMessages('main').length,0);assert.equal(f.core.queueEditor().page('main',draft.id).draft.errorCode,'queue_group_cancelled');
    const reopened=f.core.queueEditor().reopen('main',draft.id,{expectedRevision:draft.revision},'reopen-legacy-cancel');assert.equal(reopened.entryCount,2);const retried=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:reopened.revision},'retry-after-legacy-cancel');f.release();await finished(f.core,f.first.runId!);const actual=await until(()=>f.core.store.getSignal(retried.submission!.leaderSignalId!)!,row=>row.status==='accepted');await finished(f.core,actual.runId!);assert.equal(f.prompts.length,2);assert.match(f.prompts[1]!,/SYNTHETIC_LEGACY_CANCEL_SHELL/);assert.match(f.prompts[1]!,/SOURCE_A/);assert.match(f.prompts[1]!,/SOURCE_B/);
  }finally{await f.close();}
});

test('cancelling an admitted group before the first request cannot wake it again on restart',{timeout:30000},async()=>{
 const f=await fixture();let releaseBarrier!:()=>void;const barrier=new Promise<void>(resolve=>{releaseBarrier=resolve;});let entered!: (runId:string)=>void;const entering=new Promise<string>(resolve=>{entered=resolve;});
 try{
  await f.core.submitMessage({content:'CANCEL_BEFORE_REQUEST_A',mode:'queue'});await f.core.submitMessage({content:'CANCEL_BEFORE_REQUEST_B',mode:'queue'});const draft=f.core.queueEditor().create('main',{},'capture-cancel-before-request'),editor=f.core.queueEditor() as any,initial=editor.host.initialGroup;editor.host.initialGroup=async(...args:any[])=>{entered(args[2]);await barrier;return initial(...args);};const sent=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'send-cancel-before-request');f.release();await finished(f.core,f.first.runId!);const runId=await entering;await f.core.abortExecution('main',runId);releaseBarrier();await until(()=>f.core.store.getRun(runId)!,run=>run.status!=='running');const calls=f.prompts.length;assert.equal(calls,1);await f.reopen();assert.equal(f.prompts.length,calls,'explicit cancellation is not crash retry authorization');const saved=f.core.queueEditor().page('main',draft.id).draft;assert.equal(saved.status,'blocked');assert.equal(saved.errorCode,'queue_group_cancelled');const reopened=f.core.queueEditor().reopen('main',draft.id,{expectedRevision:draft.revision},'explicit-reopen-cancelled');assert.equal(reopened.entryCount,2);const retried=await f.core.queueEditor().submit('main',draft.id,{expectedRevision:reopened.revision},'explicit-resubmit-cancelled'),record=await until(()=>f.core.store.getSignal(retried.submission!.leaderSignalId!)!,row=>row.status==='accepted');await finished(f.core,record.runId!);assert.equal(f.prompts.length,2);assert.match(f.prompts[1]!,/CANCEL_BEFORE_REQUEST_A/);assert.match(f.prompts[1]!,/CANCEL_BEFORE_REQUEST_B/);assert.equal(f.core.store.getSignal(sent.submission!.leaderSignalId!)!.status,'cancelled');
 }finally{releaseBarrier();await f.close();}
});
