import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {conversationPage} from '../src/event-stream.js';
import {authenticatedApp,finished,removeTemp} from './helpers.js';

test('native branch copies a completed prefix with visible provenance but no execution or approvals',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-context-branch-'));const prompts:string[]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async(request)=>{prompts.push(JSON.stringify(request.prompt));return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'text'});c.enqueue({type:'text-delta',id:'text',delta:'completed synthetic reply'});c.enqueue({type:'text-end',id:'text'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
 const core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{
  const first=await core.submitMessage({content:'source-first-marker'});await finished(core,first.runId!);
  const second=await core.submitMessage({content:'source-second-marker'});await finished(core,second.runId!);
  const branch=await core.branchContext('main',first.runId!,'Branch','branch.fixture');
  assert.equal(branch.parentContextId,'main');assert.equal(branch.parentRunId,first.runId);
  assert.equal(core.runtime.tasks({contextId:branch.id}).length,0);assert.equal(core.runtime.approvals().filter(a=>a.contextId===branch.id).length,0);
  const history=conversationPage(core,branch.id).messages;assert.ok(history.some(m=>m.content==='source-first-marker'&&m.originContextId==='main'));assert.ok(!history.some(m=>m.content==='source-second-marker'));
  assert.equal(core.store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE context_id=?').get(branch.id)?.n,0);
  const reply=await core.submitMessage({contextId:branch.id,content:'independent-branch-marker'});await finished(core,reply.runId!);
  assert.ok(prompts.at(-1)?.includes('source-first-marker'));assert.ok(prompts.at(-1)?.includes('independent-branch-marker'));assert.ok(!prompts.at(-1)?.includes('source-second-marker'));
  assert.equal(core.store.outputsForSignal(reply.id).length,1);
  const untouched=conversationPage(core,'main').messages;assert.ok(!untouched.some(m=>m.content==='independent-branch-marker'));
  await assert.rejects(core.branchContext('main',first.runId!,'collision',branch.id),/context_exists/);
 }finally{await core.close();await removeTemp(directory);}
});

test('owner can create a main conversation while work contexts remain task-only',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-context-owner-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  const app=authenticatedApp(core);
  const response=await app.request('/contexts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'New conversation',role:'main'})});assert.equal(response.status,201);
  const context=await response.json() as {id:string;role:string};assert.equal(context.role,'main');
  const work=core.createWorkContext({name:'background only'});await assert.rejects(core.submitMessage({contextId:work.id,content:'no bypass'}),/work_context_requires_task/);
 }finally{await core.close();await removeTemp(directory);}
});

test('explicit selected-turn working set loads its chosen range without reloading excluded raw history',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-working-set-'));const prompts:string[]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async(request)=>{prompts.push(JSON.stringify(request.prompt));return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'text'});c.enqueue({type:'text-delta',id:'text',delta:'synthetic reply'});c.enqueue({type:'text-end',id:'text'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
 const core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{
  const first=await core.submitMessage({content:'excluded-raw-prefix-marker'});await finished(core,first.runId!);const second=await core.submitMessage({content:'retained-working-set-marker'});await finished(core,second.runId!);
  const selected=await core.branchContext('main',second.runId!,'Selected range','working.fixture',second.runId!);assert.equal(selected.workingSet?.kind,'selected-turn-range');
  const input=await core.submitMessage({contextId:selected.id,content:'new working set input'});await finished(core,input.runId!);assert.ok(prompts.at(-1)?.includes('retained-working-set-marker'));assert.ok(!prompts.at(-1)?.includes('excluded-raw-prefix-marker'));
  assert.ok(conversationPage(core,'main').messages.some(m=>m.content==='excluded-raw-prefix-marker'));assert.ok(!conversationPage(core,selected.id).messages.some(m=>m.content==='excluded-raw-prefix-marker'));
 }finally{await core.close();await removeTemp(directory);}
});
