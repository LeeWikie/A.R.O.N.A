import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {finished,removeTemp,until} from './helpers.js';

test('a genuinely suspended native run archives one matching original snapshot after cold continuation',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-recovered-snapshot-evidence-'));let calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls++;const answered=request.prompt.some(message=>message.role==='tool');return{stream:new ReadableStream({start(controller){
  controller.enqueue({type:'stream-start',warnings:[]});if(!answered)controller.enqueue({type:'tool-call',toolCallId:'snapshot-native-question',toolName:'ask_user',input:JSON.stringify({question:'Choose the retained snapshot format.',options:[{label:'Original'}]})});controller.enqueue({type:'finish',finishReason:answered?'stop':'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();
 }})};}});
 let core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{
  const input=await core.submitMessage({content:'Retain the original snapshot evidence.'}),question=await until(()=>core.interactions().find(row=>row.status==='pending'),Boolean);assert.ok(question);
  await until(()=>core.agent.listSuspendedRuns({threadId:'main',resourceId:'local'}),value=>value.total===1);
  assert.equal(core.runtime.getSnapshot(input.runId!),undefined,'a parked native run has no terminal input-only recovery archive');
  await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(calls,1);assert.equal(core.runtime.getSnapshot(input.runId!),undefined,'cold native recovery remains suspended rather than being reclassified as interrupted input');
  await core.answerInteraction(question.id,input.runId!,'Original');assert.equal((await finished(core,input.runId!))?.status,'succeeded');assert.equal(calls,2);
  const snapshot=core.runtime.getSnapshot(input.runId!)!,body=snapshot.body as{format:string;data:string};assert.equal(body.format,'v8');const evidence=core.store.db.prepare("SELECT data FROM runtime_events WHERE event_key=? AND kind='context_snapshot'").get(`snapshot:${input.runId}`);assert.ok(evidence);assert.equal(JSON.parse(String(evidence.data)).sha256,createHash('sha256').update(body.data).digest('hex'));assert.match(JSON.stringify(core.projectMemory.snapshot(input.runId!)),/snapshot-native-question/);
  await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.deepEqual(core.runtime.getSnapshot(input.runId!),snapshot);assert.equal(calls,2);assert.equal(core.store.db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE event_key=? AND kind='context_snapshot'").get(`snapshot:${input.runId}`)!.count,1);
 }finally{await core.close();await removeTemp(directory);}
});
