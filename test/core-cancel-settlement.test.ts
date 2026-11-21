import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { finished, removeTemp, until } from './helpers.js';

async function waitingQuestion() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-cancel-settlement-'));
  const model=new MastraLanguageModelV2Mock({doStream:async()=>({stream:new ReadableStream({start(controller){
    controller.enqueue({type:'stream-start',warnings:[]});controller.enqueue({type:'tool-call',toolCallId:'synthetic-cancel-question',toolName:'ask_user',input:JSON.stringify({question:'Synthetic choice?',options:[{label:'One'},{label:'Two'}]})});
    controller.enqueue({type:'finish',finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();
  }})})});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false});const input=await core.submitMessage({content:'SYNTHETIC_CANCELLATION_REQUEST'});
  const pending=await until(()=>core.interactions().find(item=>item.status==='pending'),Boolean);
  await until(()=>core.agent.listSuspendedRuns({resourceId:'local',threadId:'main'}),value=>value.total===1);
  return {core,directory,input,pending:pending!};
}

test('native cancellation persists the denied tool against its actual resource owner without a storage error',{timeout:30000},async()=>{
  const f=await waitingQuestion();
  try{
    await f.core.cancelInteraction(f.pending.id,f.pending.runId);assert.equal((await finished(f.core,f.pending.runId))?.status,'interrupted');
    const history=await f.core.memory.recall({threadId:'main',resourceId:'local',page:0,perPage:100,hideSignals:false});
    assert.ok(JSON.stringify(history.messages).includes('output-denied'));
    assert.ok(!f.core.runtime.events('main',0,1000).some(event=>event.kind==='model_error_observed'&&JSON.stringify(event.data).includes('SAVE_MESSAGES_FAILED')));
  }finally{await f.core.close();await removeTemp(f.directory);}
});

test('missing resource metadata is filled from the actual local thread and cannot relabel a foreign owner',{timeout:30000},async()=>{
  const f=await waitingQuestion();
  try{
    const createdAt=new Date();await f.core.memory.saveThread({thread:{id:'synthetic-foreign',resourceId:'synthetic-other-owner',title:'Synthetic foreign owner',createdAt,updatedAt:createdAt}});
    const content={format:2 as const,parts:[{type:'text' as const,text:'SYNTHETIC_OWNER_BOUNDARY'}]};
    await assert.rejects(f.core.memory.saveMessages({messages:[{id:randomUUID(),threadId:'synthetic-foreign',role:'user',content,createdAt}]}),/memory_resource_mismatch/);
    const message={id:randomUUID(),threadId:'main',role:'user' as const,content,createdAt};const stored=await f.core.memory.saveMessages({messages:[message]});assert.equal(stored.messages[0]?.resourceId,'local');assert.ok(!('resourceId' in message));
  }finally{await f.core.close();await removeTemp(f.directory);}
});

for(const failure of ['history','graph'] as const)test(`accepted cancellation remains interrupted when ${failure} persistence fails, with the actual failure retained`,{timeout:30000},async()=>{
  const f=await waitingQuestion(),save=f.core.memory.saveMessages.bind(f.core.memory),append=f.core.sessionGraph.append.bind(f.core.sessionGraph);
  try{
    if(failure==='history')f.core.memory.saveMessages=async()=>{throw Error('SYNTHETIC_HISTORY_UNAVAILABLE');};
    else f.core.sessionGraph.append=()=>{throw Error('SYNTHETIC_GRAPH_UNAVAILABLE');};
    await f.core.cancelInteraction(f.pending.id,f.pending.runId);const run=await finished(f.core,f.pending.runId);
    assert.equal(run?.status,'interrupted');assert.equal(run?.errorCode,failure==='history'?'context_snapshot_failed':'session_graph_commit_failed');
    assert.equal(f.core.interactions()[0]?.status,'cancelled');assert.equal(f.core.store.outputsForSignal(f.input.id).length,0);
    const events=f.core.runtime.events('main',0,1000);assert.ok(events.some(event=>event.kind==='run_abort_requested'));assert.ok(events.some(event=>event.kind==='snapshot_failed'));assert.ok(events.some(event=>event.kind==='error'));
    if(failure==='history')assert.ok(events.some(event=>event.kind==='model_error_observed'&&JSON.stringify(event.data).includes('SYNTHETIC_HISTORY_UNAVAILABLE')));
  }finally{f.core.memory.saveMessages=save;f.core.sessionGraph.append=append;await f.core.close();await removeTemp(f.directory);}
});

test('concurrent native terminal notifications settle a cancelled run once and cannot overwrite its successor',{timeout:30000},async()=>{
  const f=await waitingQuestion(),save=f.core.memory.saveMessages.bind(f.core.memory),finish=f.core.store.finishRun.bind(f.core.store);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),arrived=new Promise<void>(resolve=>{entered=resolve;});let blocked=true,settlements=0;
  try{
    f.core.memory.saveMessages=async args=>{if(blocked){entered();await gate;}return save(args);};
    f.core.store.finishRun=(...args)=>{if(args[0]===f.pending.runId)settlements++;return finish(...args);};
    await f.core.cancelInteraction(f.pending.id,f.pending.runId);await arrived;
    const session=f.core.sessions.peek('main')!;const duplicate=session.finishAgentRun('error');blocked=false;release();await duplicate;
    assert.equal((await finished(f.core,f.pending.runId))?.status,'interrupted');assert.equal(settlements,1);
    await until(()=>f.core.agent.listSuspendedRuns({resourceId:'local',threadId:'main'}),value=>value.total===0);
    await until(()=>session.getCurrentRunId(),value=>value===null);
    const successor=await f.core.submitMessage({content:'SYNTHETIC_SUCCESSOR_REQUEST'});assert.notEqual(successor.runId,f.pending.runId);
    const next=await until(()=>f.core.interactions().find(item=>item.runId===successor.runId&&item.status==='pending'),Boolean);
    await assert.rejects(f.core.abortExecution('main',f.pending.runId),/run_changed/);
    assert.equal(f.core.store.getRun(successor.runId!)?.status,'running');await f.core.cancelInteraction(next!.id,successor.runId!);await finished(f.core,successor.runId!);
  }finally{blocked=false;release();f.core.memory.saveMessages=save;f.core.store.finishRun=finish;await f.core.close();await removeTemp(f.directory);}
});
