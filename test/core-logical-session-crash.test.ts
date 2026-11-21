import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,finished,removeTemp,until} from './helpers.js';

test('a multi-part logical input recovers its full original text and all media from the native user-save gap without automatic replay',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-logical-crash-')),child=fork(fileURLToPath(new URL('./group-input-order-fixture.ts',import.meta.url)),[directory,'logical'],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});let ready=false,output='',calls=0,core:Core|undefined;const prompts:string[]=[];
  child.stdout?.on('data',value=>output+=String(value));child.stderr?.on('data',value=>output+=String(value));child.on('message',value=>{if(value&&typeof value==='object'&&'type'in value&&value.type==='group-request')ready=true;});
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls++;prompts.push(JSON.stringify(request.prompt));return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  try{
    await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(output||'fixture_exited');return ready;},Boolean);const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
    core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(calls,0);const content='原始逻辑'.repeat(20000)+'ORDER_LOGICAL_END';const page=await (await authenticatedApp(core).request('/conversation?contextId=main&limit=200')).json() as {messages:Array<{content:string;attachments?:string[]}>};const original=page.messages.filter(row=>row.content===content);assert.equal(original.length,1);assert.equal(original[0]!.attachments?.length,9);
    const logical=core.sessionGraph.records('main').filter(row=>row.source?.logicalInputId);assert.equal(logical.length,1);assert.equal(logical[0]!.source!.messageIds?.length,2);
    const next=await core.submitMessage({content:'Explicitly continue the retained logical input.'});assert.equal((await finished(core,next.runId!))?.status,'succeeded');assert.equal(calls,1);assert.match(prompts[0]!,/ORDER_LOGICAL_END/);for(let i=0;i<9;i++)assert.match(prompts[0]!,new RegExp(`ORDER_ASSET_${i}`));
    await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(calls,1);const reopened=await (await authenticatedApp(core).request('/conversation?contextId=main&limit=200')).json() as typeof page;assert.equal(reopened.messages.filter(row=>row.content===content).length,1);
  }finally{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;}await core?.close();await removeTemp(directory);}
});
