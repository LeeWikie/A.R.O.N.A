import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {finished,until,removeTemp} from './helpers.js';

test('two normal conversations can complete their native memory work while the first organizer is busy without a user retry',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-memory-concurrency-'));let release!:()=>void,entered=false,heldRun='';const gate=new Promise<void>(resolve=>{release=resolve;}),steps=new Map<string,number>();
 const model=new MastraLanguageModelV2Mock({doStream:async()=>({stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'reply'});c.enqueue({type:'text-delta',id:'reply',delta:'The experience remains recorded.'});c.enqueue({type:'text-end',id:'reply'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})}),doGenerate:async request=>{
  assert.ok(request.tools?.some(tool=>tool.name==='memory_commit'));const runId=/来源运行是 ([0-9a-f-]{36})/.exec(JSON.stringify(request.prompt))?.[1];assert.ok(runId);const step=steps.get(runId)??0;steps.set(runId,step+1);
  if(!entered){entered=true;heldRun=runId;await gate;}
  const call=step===0?{toolName:'memory_write',toolCallId:`remember-${runId}`,input:JSON.stringify({path:`facts/${runId}.md`,content:`The original conversation ${runId} was checked.`})}:{toolName:'memory_commit',toolCallId:`commit-${runId}`,input:JSON.stringify({sourceRunId:runId,note:'Checked the complete original conversation.'})};
  return{content:[{type:'tool-call',...call}],finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2},warnings:[]};
 }}),core=await Core.open({dataDir:directory,model,memoryEnabled:true,concurrency:4});
 try{
  const first=await core.submitMessage({content:'FIRST_NORMAL_USER_MESSAGE'});assert.equal((await finished(core,first.runId!))!.status,'succeeded');await until(()=>entered,Boolean);assert.equal(heldRun,first.runId);
  const second=await core.submitMessage({content:'SECOND_NORMAL_USER_MESSAGE'});assert.equal((await finished(core,second.runId!))!.status,'succeeded');await until(()=>core.projectMemory.jobs(),rows=>rows.some(row=>row.runId===second.runId));
  await new Promise(resolve=>setTimeout(resolve,200));const held=core.projectMemory.jobs();assert.equal(held.find(row=>row.runId===first.runId)!.status,'running');assert.equal(held.find(row=>row.runId===second.runId)!.status,'pending');assert.equal(steps.size,1,'the native manager queues the second writer until the first returns');release();
  const jobs=await until(()=>core.projectMemory.jobs(),rows=>[first.runId,second.runId].every(id=>rows.some(row=>row.runId===id&&['succeeded','superseded','failed','interrupted'].includes(row.status))));
  for(const runId of[first.runId,second.runId]){const job=jobs.find(row=>row.runId===runId)!;assert.equal(job.status,'succeeded',`${runId}: ${job.error??job.status}`);assert.ok(fs.existsSync(path.join(core.projectMemory.version().filesDirectory,`facts/${runId}.md`)));}
  assert.equal(core.projectMemory.unresolvedJobs().length,0);assert.equal(core.projectMemory.version().generation,2);
 }finally{release();await core.close();await removeTemp(directory);}
});
