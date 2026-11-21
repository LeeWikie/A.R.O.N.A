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
import type {QueueEditDocument} from '../src/protocol.js';
import {finished,removeTemp,until} from './helpers.js';

for(const phase of['during-part','part-committed','upload-committed']as const)test(`attachment manifest ${phase} SIGKILL preserves original resources and requires one explicit native submission`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-manifest-crash-')),child=fork(fileURLToPath(new URL('./queue-attachment-crash-fixture.ts',import.meta.url)),[directory,phase],{stdio:['ignore','ignore','ignore','ipc']});let core:Core|undefined;const prompts:string[]=[];
 try{
  const[code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');const original=JSON.parse(fs.readFileSync(path.join(directory,'attachment-boundary.json'),'utf8'))as{draftId:string;entryId:string;operation:string;input:unknown;uploadId:string;content:string;parts:string[];attachments:string[];saved?:QueueEditDocument};
  core=await Core.open({dataDir:directory,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'https://fixture.invalid/v1',apiKey:'synthetic-only',authHeader:'bearer',modelId:'manifest-crash',contextWindow:512000,maxTokens:1024},model:new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}})});
  assert.equal(prompts.length,0);const upload=core.queueEditor().beginEntryEdit('main',original.draftId,original.input,original.operation);assert.equal(upload.id,original.uploadId);assert.deepEqual(upload.receivedAttachmentParts,phase==='during-part'?[]:phase==='part-committed'?[0]:[0,1]);if(phase==='during-part')assert.equal(core.runtime.setting(`queue-entry-part:${upload.id}:attachments:0`,null),null);
  for(const[index,content]of original.parts.entries())core.queueEditor().writeEntryPart('main',original.draftId,upload.id,index,{content},'attachments');const saved=core.queueEditor().commitEntryEdit('main',original.draftId,upload.id);if(original.saved)assert.deepEqual(saved,original.saved);const entry=core.queueEditor().page('main',original.draftId).entries[0]!;assert.equal(entry.content,original.content);assert.deepEqual(entry.attachments,original.attachments);assert.equal(prompts.length,0);
  await core.queueEditor().submit('main',original.draftId,{expectedRevision:saved.revision},'explicit-send');const active=core,submitted=await until(()=>active.queueEditor().page('main',original.draftId).draft,row=>row.status==='submitted');assert.equal((await finished(core,submitted.submission!.runId!))!.status,'succeeded');assert.equal(prompts.length,1);for(let index=0;index<9;index++)assert.equal(prompts[0]!.split(`ATTACHMENT_CRASH_ORIGINAL_${index}_END`).length-1,1);assert.equal(prompts[0]!.split('ORIGINAL_CLIENT_OBSERVATION').length-1,1);await core.queueEditor().submit('main',original.draftId,{expectedRevision:submitted.revision},'confirmed-repeat');assert.equal(prompts.length,1);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await core?.close();await removeTemp(directory);}
});
