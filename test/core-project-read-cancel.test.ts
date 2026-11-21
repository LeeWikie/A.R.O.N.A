import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {ProjectResources} from '../src/tools/project-resources.js';
import {authenticatedApp,until,removeTemp} from './helpers.js';

for(const tool of ['read','grep'] as const)for(const action of ['cancel','pause'] as const)test(`real task ${action} waits for an already opened ${tool} descriptor to close and never reports a completed business result`,{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-read-cancel-')),original=ProjectResources.prototype.readChunks;let core!:Core,release!:()=>void,entered!:()=>void,closed=false,started=false,returned=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  ProjectResources.prototype.readChunks=async function*(...args){try{for await(const chunk of original.apply(this,args)){if(args[0]==='source.txt'&&this.root===fs.realpathSync(path.join(directory,'workspace'))&&!started){started=true;entered();await gate;}yield chunk;}}finally{if(started)closed=true;}};
  const model=new MastraLanguageModelV2Mock({doStream:async request=>({stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});const work=request.tools?.some(tool=>tool.name==='task_report');if(work)c.enqueue({type:'tool-call',toolCallId:'synthetic-pending-read',toolName:tool==='read'?'mastra_workspace_read_file':'mastra_workspace_grep',input:JSON.stringify({path:'source.txt',...(tool==='grep'?{pattern:'x'}:{})})});c.enqueue({type:'finish',finishReason:work?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})})});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    fs.writeFileSync(path.join(directory,'workspace/source.txt'),Buffer.alloc(150000,120));const task=await core.submitTask({title:'Cancel a source read',content:'Read source.txt.'},'synthetic-source-read-cancel');await ready;
    const cancelling=core.tasks.control(task.id,action,core.runtime.task(task.id).revision).then(value=>{returned=true;return value;});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(closed,false);assert.equal(returned,false,'The control receipt must not outlive an unclosed owned read.');assert.equal(core.runtime.task(task.id).status,action==='cancel'?'cancelling':'pausing','The shared task state must not report resource closure before its owned source has closed.');
    release();const result=await cancelling;assert.equal(result.status,action==='cancel'?'cancelled':'paused');assert.equal(closed,true);assert.equal(result.report,null);await until(()=>core.store.getRun(result.runIds.at(-1)!),run=>Boolean(run&&run.status!=='running'));
    fs.unlinkSync(path.join(directory,'workspace/source.txt'));assert.equal(fs.existsSync(path.join(directory,'workspace/source.txt')),false);assert.equal(core.runtime.events(task.contextId).filter(event=>event.kind==='task_report').length,0);
  }finally{release();ProjectResources.prototype.readChunks=original;await core.close();await removeTemp(directory);}
});

test('HTTP cannot confirm cancellation when an owned descriptor fails to close before the resource deadline',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-read-unconfirmed-')),original=ProjectResources.prototype.readChunks;let core!:Core,release!:()=>void,entered!:()=>void,started=false,closed=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  ProjectResources.prototype.readChunks=async function*(...args){try{for await(const bytes of original.apply(this,args)){if(!started&&args[0]==='source.txt'&&this.root===fs.realpathSync(path.join(directory,'workspace'))){started=true;entered();await gate;}yield bytes;}}finally{if(started)closed=true;}};
  const model=new MastraLanguageModelV2Mock({doStream:async request=>({stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});const work=request.tools?.some(tool=>tool.name==='task_report');if(work)c.enqueue({type:'tool-call',toolCallId:'synthetic-unconfirmed-read',toolName:'mastra_workspace_grep',input:JSON.stringify({path:'source.txt',pattern:'needle'})});c.enqueue({type:'finish',finishReason:work?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})})});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    fs.writeFileSync(path.join(directory,'workspace/source.txt'),'needle\n'.repeat(20000));const task=await core.submitTask({title:'Cancel a blocked source read',content:'Search source.txt.'},'synthetic-unconfirmed-source-read');await ready;const app=authenticatedApp(core),response=await app.request(`/tasks/${task.id}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:core.runtime.task(task.id).revision})});assert.equal(response.status,504);assert.deepEqual(await response.json(),{error:'workspace_read_cleanup_unconfirmed'});assert.equal(core.runtime.task(task.id).status,'interrupted');assert.equal(closed,false);assert.equal(core.runtime.task(task.id).report,null);assert.ok(core.runtime.events(task.contextId).some(event=>event.kind==='task_resource_cleanup_failed'));
    release();await until(()=>closed,Boolean);fs.unlinkSync(path.join(directory,'workspace/source.txt'));assert.equal(core.runtime.task(task.id).status,'interrupted');assert.equal(core.runtime.events(task.contextId).filter(event=>event.kind==='task_report').length,0);
  }finally{release();ProjectResources.prototype.readChunks=original;await core.close();await removeTemp(directory);}
});
