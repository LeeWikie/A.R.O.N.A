import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { conversationPage } from '../src/event-stream.js';
import { authenticatedApp, finished, removeTemp, until } from './helpers.js';

async function fixture(multi=false,optionCount=2) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-interactions-'));const prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    const prompt=JSON.stringify(request.prompt);prompts.push(prompt);
    const answered=request.prompt.some(message=>message.role==='tool');
    return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});
      if(!answered)c.enqueue({type:'tool-call',toolCallId:'choose-format',toolName:'ask_user',input:JSON.stringify({question:'Which format?',options:optionCount===2?[{label:'Markdown'},{label:'Plain text'}]:Array.from({length:optionCount},(_,index)=>({label:`Choice ${index}`})),...(multi?{selectionMode:'multi_select'}:{})})});
      else {c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'Answer accepted'});c.enqueue({type:'text-end',id:'t'});}
      c.enqueue({type:'finish',finishReason:answered?'stop':'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};
  }});
  let core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  return {get core(){return core;},prompts,async ask(){const r=await core.submitMessage({content:'Make a document'});const items=await until(()=>core.interactions(),items=>items.some(item=>item.status==='pending'));return {runId:r.runId!,question:items.find(item=>item.status==='pending')!};},async reopen(){await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});},async close(){await core.close();await removeTemp(directory);}};
}

test('native ask_user suspends, appears through HTTP, resumes with the exact answer and rejects stale/conflicting replies',{timeout:30000},async()=>{
  const f=await fixture();try{
    const {question,runId}=await f.ask();assert.equal(question.kind,'question');assert.equal(f.core.store.getRun(runId)!.status,'running');
    const app=authenticatedApp(f.core);const response=await app.request('/interactions');assert.equal(response.status,200);assert.equal((await response.json() as {interactions:unknown[]}).interactions.length,1);
    await assert.rejects(f.core.answerInteraction(question.id,'wrong-run','Markdown'),/run_changed/);
    await assert.rejects(f.core.answerInteraction(question.id,runId,{}),/invalid_interaction_answer/);
    const answered=await f.core.answerInteraction(question.id,runId,'Markdown');assert.equal((answered as {status:string}).status,'answered');
    assert.equal((await finished(f.core,runId))!.status,'succeeded');assert.match(f.prompts.at(-1)!,/Markdown/);
    assert.equal((await f.core.answerInteraction(question.id,runId,'Markdown') as {status:string}).status,'answered');
    await assert.rejects(f.core.answerInteraction(question.id,runId,'Plain text'),/interaction_already_answered/);
    assert.equal(f.core.interactions()[0]!.status,'answered');assert.ok(!('answerHash' in f.core.interactions()[0]!));
  }finally{await f.close();}
});

test('multi-select answers preserve selected labels and cancel cannot target a successor run',{timeout:30000},async()=>{
  const f=await fixture(true);try{
    const {question,runId}=await f.ask();await assert.rejects(f.core.answerInteraction(question.id,runId,'Markdown'),/invalid_interaction_answer/);
    await assert.rejects(f.core.answerInteraction(question.id,runId,['Markdown','Markdown']),/invalid_interaction_answer/);
    await f.core.answerInteraction(question.id,runId,['Markdown','Plain text']);assert.equal((await finished(f.core,runId))!.status,'succeeded');assert.match(f.prompts.at(-1)!,/Markdown, Plain text/);
    await assert.rejects(f.core.cancelInteraction(question.id,runId),/interaction_not_active/);
  }finally{await f.close();}
});

test('all hundred native choices and an additional answer reach the next model request without truncation',{timeout:30000},async()=>{
  const f=await fixture(true,100);try{const {question,runId}=await f.ask();const answers=[...Array.from({length:100},(_,index)=>`Choice ${index}`),'Additional synthetic response'];await f.core.answerInteraction(question.id,runId,answers);assert.equal((await finished(f.core,runId))?.status,'succeeded');for(const answer of answers)assert.ok(f.prompts.at(-1)!.includes(answer));assert.equal(f.core.interactionAnswers()[0]?.status,'delivered');}finally{await f.close();}
});

test('a compare-only receipt lookup recovers a delivered answer after a lost save acknowledgement and a late cancellation',{timeout:30000},async()=>{
  const f=await fixture();try{
    const {question,runId}=await f.ask(),body={expectedRunId:runId,answer:'Markdown'};let app=authenticatedApp(f.core);
    const request=(suffix:string,value:unknown)=>app.request(`/interactions/${question.id}/${suffix}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
    assert.equal((await request('answer-receipt',body)).status,404);assert.equal(f.core.interactionAnswers().length,0);assert.equal(f.core.interactions()[0]?.status,'pending');
    const saved=await request('answer-outbox',body);assert.equal(saved.status,202);await saved.body?.cancel();assert.equal((await finished(f.core,runId))?.status,'succeeded');assert.equal(f.prompts.length,2);
    assert.equal((await request('cancel',{expectedRunId:runId})).status,409);
    const receipt=await request('answer-receipt',body);assert.equal(receipt.status,200);const result=await receipt.json() as {answer:{id:string;status:string;attempts:number}};assert.equal(result.answer.status,'delivered');assert.equal(result.answer.attempts,1);
    assert.equal((await request('answer-receipt',{...body,answer:'Plain text'})).status,409);assert.equal(f.prompts.length,2,'read-only comparison never resumes native execution');
    await f.reopen();app=authenticatedApp(f.core);const reopened=await request('answer-receipt',body);assert.equal(reopened.status,200);assert.equal((await reopened.json() as typeof result).answer.id,result.answer.id);assert.equal(f.prompts.length,2);
  }finally{await f.close();}
});

test('cancellation during answer persistence preparation cannot create or deliver a late answer',{timeout:30000},async()=>{
  const f=await fixture();let release=()=>{};
  try{
    const {question,runId}=await f.ask();const seals=Reflect.get(f.core,'recoverySeals') as Map<string,Promise<void>>;await seals.get(runId);seals.set(runId,new Promise<void>(resolve=>release=resolve));
    const app=authenticatedApp(f.core),pending=app.request(`/interactions/${question.id}/answer-outbox`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRunId:runId,answer:'Markdown'})});
    await new Promise<void>(resolve=>setImmediate(resolve));const cancelled=await app.request(`/interactions/${question.id}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRunId:runId})});assert.equal(cancelled.status,202);release();
    assert.equal((await pending).status,409);assert.equal((await finished(f.core,runId))?.status,'interrupted');assert.equal(f.core.interactionAnswers().length,0);assert.equal(f.core.interactions()[0]?.status,'cancelled');assert.equal(f.prompts.length,1);
  }finally{release();await f.close();}
});

test('pending native questions cancel their own run and remain visible after restart without being replayed',{timeout:30000},async()=>{
  const f=await fixture();try{
    const {question,runId}=await f.ask();await f.core.cancelInteraction(question.id,runId);assert.equal((await finished(f.core,runId))!.status,'interrupted');
    assert.equal(f.core.interactions()[0]!.status,'cancelled');await assert.rejects(f.core.answerInteraction(question.id,runId,'Markdown'),/interaction_not_active/);
    await f.reopen();assert.equal(f.core.interactions()[0]!.status,'cancelled');
    const message=conversationPage(f.core,'main').messages.find(item=>item.role==='user'&&item.content==='Make a document')!;
    assert.ok(message);assert.equal(message.status,'interrupted');
    const fork=await f.core.forkContext('main',message.id,{id:'chat.cancelled-draft'});
    assert.equal(fork.draft,'Make a document');assert.equal((await f.core.history(fork.context.id)).messages.length,0);
    assert.equal(f.core.interactions().length,1,'forking before a cancelled tool call never replays its pending question');
  }finally{await f.close();}
});
