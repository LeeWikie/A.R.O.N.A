import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Agent} from '@mastra/core/agent';
import {AgentController} from '@mastra/core/agent-controller';
import {Memory} from '@mastra/memory';
import {LibSQLStore} from '@mastra/libsql';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {until,removeTemp} from './helpers.js';

test('a reserved native queued run stays behind a parked question until its original answer resumes that run',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-parked-')),storage=new LibSQLStore({id:'native-parked-queue',url:'file:'+path.join(directory,'native.sqlite')}),memory=new Memory({storage});let calls=0,suspended=false;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(calls===1)controller.enqueue({type:'tool-call',toolCallId:'native-question',toolName:'ask_user',input:JSON.stringify({question:'SYNTHETIC_NATIVE_QUESTION'})});controller.enqueue({type:'finish',finishReason:calls===1?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:0,totalTokens:1}});controller.close();}})};}});
  const agent=new Agent({id:'native-parked',name:'Native parked queue',instructions:'Use synthetic fixture input.',model,memory}),controller=new AgentController({id:'native-parked-queue',resourceId:'local',storage,memory,agent,modes:[{id:'main',agent}],defaultModeId:'main'}),threadId=randomUUID(),nextId=randomUUID(),ended=new Map<string,string|undefined>();
  try{
    await storage.init();await controller.init();const session=await controller.createSession({id:threadId,threadId,resourceId:'local'});session.subscribe(event=>{if(event.type==='tool_suspended'&&event.toolCallId==='native-question')suspended=true;});session.onBeforeAgentEnd(event=>{const id=session.run.getRunId();if(id)ended.set(id,event.reason);});await session.permissions.setForTool({toolName:'ask_user',policy:'allow'});
    const first=await session.sendSignal({id:randomUUID(),type:'user',contents:'SYNTHETIC_FIRST_INPUT'},{requireDelivery:true,ifActive:{behavior:'deliver'},ifIdle:{behavior:'wake'}}).accepted;
    assert.equal(first.action,'wake');if(first.action!=='wake')throw Error('fixture_first_not_wake');const firstRunId=first.runId;assert.ok(firstRunId);await until(()=>suspended,Boolean);assert.equal(calls,1);
    const native=session.machinery.getAgent(),streamOptions=await session.machinery.buildStreamOptions({abortSignal:new AbortController().signal});
    const queued=await native.queueSignal({id:randomUUID(),type:'user',contents:'SYNTHETIC_NEXT_INPUT'},{resourceId:'local',threadId,queuedRunId:nextId,ifIdle:{streamOptions}}).accepted;
    assert.equal(queued.action,'deliver');if(queued.action!=='deliver')throw Error('fixture_future_not_queued');assert.equal(queued.runId,nextId);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(calls,1);
    await session.respondToToolSuspension({address:{resourceId:'local',threadId,runId:firstRunId,toolCallId:'native-question'},resumeData:'SYNTHETIC_ANSWER'});
    await until(()=>ended.get(nextId),reason=>reason==='complete');await until(()=>session.getCurrentRunId(),id=>id===null);assert.equal(ended.get(firstRunId),'complete');assert.equal(calls,3);
    const workflows=(await storage.getStore('workflows'))!;await until(()=>workflows.getWorkflowRunById({runId:nextId}),row=>row===null);
  }finally{await controller.destroy();await storage.close();await removeTemp(directory);}
});
