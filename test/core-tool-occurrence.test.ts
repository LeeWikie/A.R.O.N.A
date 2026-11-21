import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,finished,removeTemp,until} from './helpers.js';

const response=(name?:string,input?:unknown)=>({stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(name)controller.enqueue({type:'tool-call',toolCallId:'repeated-provider-call',toolName:name,input:JSON.stringify(input)});controller.enqueue({type:'finish',finishReason:name?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})});

test('two native write turns reusing a provider call ID retain separate once approvals and both original results',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tool-occurrences-'));let calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(!request.tools?.some(tool=>tool.name==='task_report'))return response();const turn=++calls;return turn<=2?response('mastra_workspace_write_file',{path:turn===1?'first.txt':'second.txt',content:turn===1?'FIRST_WRITE':'SECOND_WRITE'}):response();}});
 let core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{
  const task=await core.submitTask({title:'Write two files',content:'Write both synthetic originals.'},'write-two-originals');
  const first=await until(()=>core.runtime.approvals().filter(row=>row.status==='pending'),rows=>rows.length===1);assert.equal(fs.existsSync(path.join(directory,'workspace/first.txt')),false);await core.approve(first[0]!.id,'approve');
  const second=await until(()=>core.runtime.approvals().filter(row=>row.status==='pending'),rows=>rows.length===1&&rows[0]!.id!==first[0]!.id);assert.equal(calls,2);assert.equal(fs.readFileSync(path.join(directory,'workspace/first.txt'),'utf8'),'FIRST_WRITE');assert.equal(fs.existsSync(path.join(directory,'workspace/second.txt')),false);
  await core.approve(first[0]!.id,'approve');assert.equal(fs.existsSync(path.join(directory,'workspace/second.txt')),false,'repeating the first receipt never approves a later invocation');await until(()=>core.worker.listSuspendedRuns({resourceId:'local'}),state=>state.total===1);await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(calls,2);assert.equal(core.runtime.approvals().find(row=>row.id===second[0]!.id)?.status,'pending');await core.approve(second[0]!.id,'approve');
  await until(()=>core.runtime.task(task.id),row=>['unreported','failed'].includes(row.status));assert.equal(fs.readFileSync(path.join(directory,'workspace/second.txt'),'utf8'),'SECOND_WRITE');assert.equal(calls,3);assert.equal(core.runtime.approvals().length,2);assert.equal(core.runtime.approvals().every(row=>row.status==='approved'),true);
  const raw=await core.history(task.contextId),parts=raw.messages.flatMap(message=>message.content.parts.filter(part=>part.type==='tool-invocation'&&part.toolInvocation.toolCallId==='repeated-provider-call'));assert.equal(parts.length,2);assert.deepEqual(parts.map(part=>part.type==='tool-invocation'?part.toolInvocation.args:null),[{path:'first.txt',content:'FIRST_WRITE'},{path:'second.txt',content:'SECOND_WRITE'}]);assert.equal(parts.every(part=>part.type==='tool-invocation'&&part.toolInvocation.state==='result'),true);
 }finally{await core.close();await removeTemp(directory);}
});

test('later native questions reusing a provider call ID keep independent durable answers across restart',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-answer-occurrences-'));let calls=0;const prompts:unknown[]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(request.prompt);const turn=++calls;return turn<=2?response('ask_user',{question:turn===1?'First synthetic question?':'Second synthetic question?'}):response();}});
 let core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{
  const accepted=await core.submitMessage({content:'Answer both synthetic questions.'}),runId=accepted.runId!;
  const first=await until(()=>core.interactions(),rows=>rows.some(row=>row.status==='pending'));assert.equal((await core.answerInteraction(first[0]!.id,runId,'SAME_EXACT_ANSWER')).status,'answered');
  const second=await until(()=>core.interactions().filter(row=>row.status==='pending'),rows=>rows.length===1&&rows[0]!.id!==first[0]!.id);assert.equal(core.interactionAnswers().length,1);assert.equal(core.interactionAnswers()[0]!.status,'delivered');
  await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(calls,2,'opening the original gate does not replay the model');assert.equal(core.interactions().find(row=>row.id===second[0]!.id)?.status,'pending');
  const app=authenticatedApp(core),body={expectedRunId:runId,answer:'SAME_EXACT_ANSWER'};
  const lookup=await app.request(`/interactions/${second[0]!.id}/answer-receipt`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(lookup.status,404,'the first answer cannot acknowledge an identical later answer');
  assert.equal((await core.answerInteraction(second[0]!.id,runId,'SAME_EXACT_ANSWER')).status,'answered');assert.equal((await finished(core,runId))?.status,'succeeded');assert.equal(calls,3);
  const receipts=core.interactionAnswers();assert.equal(receipts.length,2);assert.notEqual(receipts[0]!.id,receipts[1]!.id);assert.equal(receipts.every(row=>row.status==='delivered'&&row.attempts===1),true);assert.equal(core.interactions().every(row=>row.status==='answered'),true);
  const results=(prompts.at(-1) as {role:string;content:unknown}[]).filter(row=>row.role==='tool');assert.equal(JSON.stringify(results).split('SAME_EXACT_ANSWER').length-1,2);
 }finally{await core.close();await removeTemp(directory);}
});

test('MCP calls reusing an ID across tools keep their own source approval and result',{timeout:30000},async()=>{
 const {mcpResourcesFixture}=await import('./mcp-resources-fixture.js');const remote=await mcpResourcesFixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-mcp-occurrences-'));let core!:Core,calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(!request.tools?.some(tool=>tool.name==='task_report'))return response();const turn=++calls;if(turn===1)return response('read_mcp_resource',{serverId:'source',uri:'fixture://notes/main'});if(turn===2){assert.match(JSON.stringify(request.prompt),/Synthetic external notes/);return response('get_mcp_prompt',{serverId:'source',name:'review',args:{topic:'second source operation'}});}assert.match(JSON.stringify(request.prompt),/Review second source operation/);return response();}});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{
  await core.capabilities.saveMCP(remote.configuration);await core.capabilities.connect('source');const task=await core.submitTask({title:'Read two MCP sources',content:'Read the notes and original review prompt.',grants:{write:false,execute:false,mcp:false}},'mcp-two-occurrences');
  const first=await until(()=>core.runtime.approvals().filter(row=>row.status==='pending'),rows=>rows.length===1);assert.equal(remote.calls.filter(row=>row.method==='resources/read').length,0);await core.approve(first[0]!.id,'approve');
  const second=await until(()=>core.runtime.approvals().filter(row=>row.status==='pending'),rows=>rows.length===1&&rows[0]!.id!==first[0]!.id);assert.equal(remote.calls.filter(row=>row.method==='resources/read').length,1);assert.equal(remote.calls.filter(row=>row.method==='prompts/get').length,0);await core.approve(first[0]!.id,'approve');assert.equal(remote.calls.filter(row=>row.method==='prompts/get').length,0);await core.approve(second[0]!.id,'approve');
  await until(()=>core.runtime.task(task.id),row=>['unreported','failed'].includes(row.status));assert.equal(calls,3);assert.equal(remote.calls.filter(row=>row.method==='resources/read').length,1);assert.equal(remote.calls.filter(row=>row.method==='prompts/get').length,1);assert.deepEqual(core.runtime.approvals().map(row=>row.toolName),['read_mcp_resource','get_mcp_prompt']);assert.equal(core.runtime.approvals().every(row=>row.status==='approved'),true);
 }finally{await core.close();await remote.close();await removeTemp(directory);}
});

test('a failed occurrence cannot replace a later successful occurrence in history or tool views',{timeout:30000},async()=>{
 const {toolActivity}=await import('../src/tool-activity.js');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tool-status-occurrences-'));let calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(!request.tools?.some(tool=>tool.name==='task_report'))return response();const turn=++calls;return turn<=2?response('mastra_workspace_read_file',{path:turn===1?'missing.txt':'available.txt'}):response();}});
 const core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{
  fs.writeFileSync(path.join(directory,'workspace/available.txt'),'SECOND_OCCURRENCE_BYTES');const task=await core.submitTask({title:'Read both files',content:'Read the missing and available synthetic files.'},'read-failed-then-success');await until(()=>core.runtime.task(task.id),row=>['unreported','failed'].includes(row.status));assert.equal(calls,3);
  const tools=toolActivity(core,task.contextId,true).filter(row=>row.toolCallId==='repeated-provider-call');assert.equal(tools.length,2);assert.deepEqual(tools.map(row=>row.state),['failed','finished']);assert.deepEqual(tools.map(row=>(row.args as {path:string}).path),['missing.txt','available.txt']);assert.notEqual(tools[0]!.nativeMessageId,tools[1]!.nativeMessageId);
  const history=await core.history(task.contextId),parts=history.messages.flatMap(message=>message.content.parts.filter(part=>part.type==='tool-invocation'&&part.toolInvocation.toolCallId==='repeated-provider-call'));assert.equal(parts.length,2);assert.equal(parts[0]!.type,'tool-invocation');assert.equal(parts[1]!.type,'tool-invocation');if(parts[0]!.type==='tool-invocation'&&parts[1]!.type==='tool-invocation'){assert.equal(parts[0]!.toolInvocation.state,'output-error');assert.equal(parts[1]!.toolInvocation.state,'result');assert.match(JSON.stringify(parts[1]!.toolInvocation.result),/SECOND_OCCURRENCE_BYTES/);}
 }finally{await core.close();await removeTemp(directory);}
});

test('separate native emit calls reusing a provider ID publish both original messages once',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-emit-occurrences-'));let core!:Core,calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async()=>{const turn=++calls;if(turn>2)return response();const source=core.store.db.prepare("SELECT id FROM signals WHERE status='accepted' AND json_extract(body,'$.contextId')='main' ORDER BY created_at LIMIT 1").get();assert.ok(source);return response('emit_message',{signalIds:[String(source.id)],text:turn===1?'FIRST_VISIBLE_MESSAGE':'SECOND_VISIBLE_MESSAGE'});}});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{
  const accepted=await core.submitSignal({source:'synthetic-emission',type:'user-message',content:'Send both synthetic messages.'});await finished(core,accepted.runId!);assert.equal(calls,3);const outputs=core.store.outputsForSignal(accepted.id);assert.deepEqual(outputs.map(row=>row.content),['FIRST_VISIBLE_MESSAGE','SECOND_VISIBLE_MESSAGE']);assert.equal(new Set(outputs.map(row=>row.id)).size,2);
  const {conversationPage}=await import('../src/event-stream.js');assert.deepEqual(conversationPage(core,'main').messages.filter(row=>row.role==='assistant').map(row=>row.content),['FIRST_VISIBLE_MESSAGE','SECOND_VISIBLE_MESSAGE']);
 }finally{await core.close();await removeTemp(directory);}
});
