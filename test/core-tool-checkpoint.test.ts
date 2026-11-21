import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {until,removeTemp} from './helpers.js';

test('a failed native per-step save stops before another model request and never replays the completed file write',{timeout:20000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tool-checkpoint-'));let workerCalls=0,rejected=0;
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{const work=request.tools?.some(tool=>tool.name==='task_report');if(work)workerCalls++;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(work&&workerCalls===1)c.enqueue({type:'tool-call',toolCallId:'checkpoint-write',toolName:'mastra_workspace_write_file',input:JSON.stringify({path:'completed.txt',content:'SYNTHETIC_COMPLETED_WRITE\n'})});c.enqueue({type:'finish',finishReason:work&&workerCalls===1?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
 const core=await Core.open({dataDir:directory,model,memoryEnabled:false}),save=core.memory.saveMessages.bind(core.memory);
 core.memory.saveMessages=async input=>{if(input.messages.some(message=>message.content.parts.some(part=>part.type==='tool-invocation'&&part.toolInvocation.toolCallId==='checkpoint-write'&&part.toolInvocation.state==='result'))){rejected++;throw Error('SYNTHETIC_NATIVE_CHECKPOINT_SAVE_FAILED');}return save(input);};
 try{const task=await core.submitTask({title:'Checkpoint an actual write',content:'Write the synthetic file once.',grants:{write:true,execute:false,mcp:false}},'synthetic-checkpoint-write');const completed=await until(()=>core.runtime.task(task.id),task=>['failed','interrupted','unreported','succeeded'].includes(task.status));
  assert.ok(rejected>0,'the real native save queue must attempt its completed tool result');assert.equal(workerCalls,1,'storage failure must prevent the next provider request');assert.equal(completed.status,'failed');assert.equal(fs.readFileSync(path.join(directory,'workspace/completed.txt'),'utf8'),'SYNTHETIC_COMPLETED_WRITE\n');assert.equal(core.runtime.events(task.contextId,0,1000).filter(event=>event.kind==='tool_start'&&(event.data as {toolCallId?:string}).toolCallId==='checkpoint-write').length,1);assert.equal(completed.report,null);
 }finally{core.memory.saveMessages=save;await core.close();await removeTemp(directory);}
});
