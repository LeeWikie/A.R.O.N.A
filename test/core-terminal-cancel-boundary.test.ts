import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import type {TaskRecord} from '../src/runtime-store.js';
import {authenticatedApp,finished,removeTemp,until} from './helpers.js';

test('late terminal resource cleanup cannot abort a successor native run in the same work context',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-cancel-boundary-'));let workerCalls=0,cleanupStarted=false,releaseCleanup!:()=>void;const releases:Array<()=>void>=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(request.tools?.some(tool=>tool.name==='task_report')){workerCalls++;await new Promise<void>(resolve=>releases.push(resolve));}return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false});const original=core.capabilities.stopTerminalProcesses.bind(core.capabilities);
  const gate=new Promise<void>(resolve=>{releaseCleanup=resolve;});core.capabilities.stopTerminalProcesses=async id=>{cleanupStarted=true;await gate;await original(id);};
  try{
    const app=authenticatedApp(core),create=async(contextId?:string)=>{const response=await app.request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Synthetic cancellation boundary',content:'Complete the current synthetic operation.',...(contextId?{contextId}:{})})});assert.equal(response.status,202);return await response.json() as TaskRecord;};
    const first=await create();await until(()=>workerCalls,count=>count===1);const firstRun=core.runtime.task(first.id).runIds.at(-1)!;
    const abort=core.abortExecution(first.contextId,firstRun);await until(()=>cleanupStarted,Boolean);releases[0]!();assert.equal((await finished(core,firstRun))?.status,'interrupted');await until(()=>core.runtime.task(first.id).status,status=>status==='interrupted');
    const next=await create(first.contextId);await until(()=>workerCalls,count=>count===2);const nextRun=core.runtime.task(next.id).runIds.at(-1)!;assert.notEqual(nextRun,firstRun);releaseCleanup();await abort;
    assert.equal(core.store.getRun(nextRun)?.status,'running');assert.equal(core.sessions.peek(first.contextId)?.getCurrentRunId(),nextRun);
    releases[1]!();assert.equal((await finished(core,nextRun))?.status,'succeeded');
  }finally{releaseCleanup();for(const release of releases)release();await core.close();await removeTemp(directory);}
});
