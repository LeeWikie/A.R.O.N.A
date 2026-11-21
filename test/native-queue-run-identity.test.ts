import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {until} from './helpers.js';

function completed(event:unknown,runId:string){
  return typeof event==='object'&&event!==null&&'type'in event&&event.type==='thread-run-status'
    &&'runId'in event&&event.runId===runId&&'payload'in event&&typeof event.payload==='object'&&event.payload!==null
    &&'status'in event.payload&&event.payload.status==='success';
}
for(const entry of ['esm','cjs'] as const)test(`native ${entry} queue preserves a reserved run identity and rejects conflicting reservations`,{timeout:20000},async()=>{
  const sdk:typeof import('@mastra/core/agent')=entry==='esm'?await import('@mastra/core/agent'):createRequire(import.meta.url)('@mastra/core/agent');
  let calls=0,hold=false,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;if(hold){hold=false;await gate;}return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});controller.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:0,totalTokens:1}});controller.close();}})};}});
  const agent=new sdk.Agent({id:`reserved-${entry}`,name:'Reserved queue fixture',instructions:'Use the synthetic fixture.',model});
  const scope={resourceId:randomUUID(),threadId:randomUUID()},events:unknown[]=[];
  const subscriber=await agent.subscribeToThread({...scope,withInitialHistory:false,withRunStatus:true});
  const observing=(async()=>{for await(const event of subscriber.stream)events.push(event);})();
  try{
    const idleId=randomUUID(),idle=await agent.queueSignal({id:randomUUID(),type:'user',contents:'SYNTHETIC_IDLE'},{...scope,queuedRunId:idleId}).accepted;
    assert.equal(idle.action,'wake');if(idle.action!=='wake')throw Error('fixture_idle_admission_not_wake');assert.equal(idle.runId,idleId);await idle.output.getFullOutput();assert.equal(calls,1);
    hold=true;const active=await agent.sendSignal({id:randomUUID(),type:'user',contents:'SYNTHETIC_ACTIVE'},scope).accepted;
    assert.equal(active.action,'wake');if(active.action!=='wake')throw Error('fixture_active_admission_not_wake');await until(()=>calls,value=>value===2);
    const queuedId=randomUUID(),queued=await agent.queueSignal({id:randomUUID(),type:'user',contents:'SYNTHETIC_FUTURE'},{...scope,queuedRunId:queuedId}).accepted;
    assert.equal(queued.action,'deliver');if(queued.action!=='deliver')throw Error('fixture_future_admission_not_queued');assert.equal(queued.runId,queuedId);
    assert.throws(()=>agent.queueSignal({id:randomUUID(),type:'user',contents:'DUPLICATE'},{...scope,queuedRunId:queuedId}),/already in use/);
    assert.throws(()=>agent.queueSignal({id:randomUUID(),type:'user',contents:'FOREIGN'},{resourceId:randomUUID(),threadId:randomUUID(),queuedRunId:queuedId}),/already in use|another thread/);
    assert.throws(()=>agent.queueSignal({id:randomUUID(),type:'user',contents:'ACTIVE_COLLISION'},{...scope,queuedRunId:active.runId}),/already in use/);
    release();if(active.action==='wake')await active.output.getFullOutput();await until(()=>events,values=>values.some(event=>completed(event,queuedId)));
    assert.equal(calls,3);
  }finally{release();subscriber.unsubscribe();await observing;agent.abortThreadStream(scope);}
});
