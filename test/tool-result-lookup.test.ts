import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {toolActivity} from '../src/tool-activity.js';
import {JSON_CONTENT_MEDIA_TYPE,decodeJsonContent} from '../src/json-content-stream.js';
import {toolResultViewSchema} from '../src/protocol.js';
import {finished,removeTemp} from './helpers.js';
import {syntheticPng} from './fixtures/png.js';

function model(){return new MastraLanguageModelV2Mock({doStream:async()=>({stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:0,totalTokens:1}});c.close();}})})});}
async function fixture(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tool-result-lookup-')),core=await Core.open({dataDir:directory,model:model(),memoryEnabled:false});const receipt=await core.submitMessage({content:'Synthetic local source.'});await finished(core,receipt.runId!);return{core,runId:receipt.runId!,directory,close:async()=>{await core.close();await removeTemp(directory);}};}
function append(core:Core,runId:string,nativeMessageId:string,callId:string,text:string,error=false,image=false){
 const timestamp=new Date().toISOString(),parent=core.sessionGraph.head('main')!.leafId,call=`${nativeMessageId}.call`,result=`${nativeMessageId}.result`;
 const records=[{entry:{type:'message',id:call,parentId:parent,timestamp,message:fauxAssistantMessage(fauxToolCall('synthetic_source',{}, {id:callId}),{stopReason:'toolUse'})} as SessionEntry,source:{messageId:nativeMessageId,runId}},{entry:{type:'message',id:result,parentId:call,timestamp,message:{role:'toolResult',toolCallId:callId,toolName:'synthetic_source',content:[{type:'text',text},...(image?[{type:'image',mimeType:'image/png',data:syntheticPng(1,1).toString('base64')}]:[])],isError:error,timestamp:Date.now()}} as SessionEntry,source:{messageId:nativeMessageId,runId}}];
 core.sessionGraph.append('main',records);return{call,result};
}

test('one native occurrence preserves canonical typed content/error without loading unrelated history',async()=>{
 const f=await fixture();try{
  for(let i=0;i<96;i++)append(f.core,f.runId,`unrelated-${i}`,`other-call-${i}`,'UNRELATED_LARGE_TOOL_BODY_'+('中🙂'.repeat(5000)));
  const target=append(f.core,f.runId,'target-native','same-call','Exact original business result',true,true);
  const expected=toolActivity(f.core,'main',true).find(row=>row.nativeMessageId==='target-native')!;assert.ok(expected);
  const records=f.core.sessionGraph.records,manager=f.core.sessionGraph.manager;
  f.core.sessionGraph.records=()=>{throw Error('a single native lookup must not load every history body');};
  f.core.sessionGraph.manager=()=>{throw Error('a single native lookup must not rebuild the entire session manager');};
  try{
   const actual=toolResultViewSchema.parse(f.core.contextToolResult('main',{runId:f.runId,toolCallId:'same-call',nativeMessageId:'target-native',entryId:target.call}));
   assert.equal(actual.availability,'available');assert.equal(actual.tool!.state,'failed');assert.equal(actual.tool!.resultEntryId,target.result);
   assert.deepEqual(actual.tool!.resultContent,expected.resultContent);assert.ok(Buffer.byteLength(JSON.stringify(actual))<5000);
   assert.ok(!JSON.stringify(actual).includes('UNRELATED_LARGE_TOOL_BODY'));
  }finally{f.core.sessionGraph.records=records;f.core.sessionGraph.manager=manager;}
 }finally{await f.close();}
});

test('reused call IDs require an unambiguous selected occurrence and never borrow another result',async()=>{
 const f=await fixture();try{
  const a=append(f.core,f.runId,'native-a','reused-call','Original A'),b=append(f.core,f.runId,'native-b','reused-call','Original B',true);
  assert.throws(()=>f.core.contextToolResult('main',{runId:f.runId,toolCallId:'reused-call'}),/tool_result_occurrence_ambiguous/);
  for(const[nativeMessageId,entryId,expected]of[['native-a',a.call,'Original A'],['native-b',b.call,'Original B']] as const){
   const value=f.core.contextToolResult('main',{runId:f.runId,toolCallId:'reused-call',nativeMessageId,entryId});assert.equal(value.availability,'available');assert.ok(JSON.stringify(value.tool!.resultContent).includes(expected));
  }
  assert.equal(f.core.contextToolResult('main',{runId:f.runId,toolCallId:'reused-call',nativeMessageId:'native-a',entryId:b.call}).availability,'unavailable');
  assert.equal(f.core.contextToolResult('main',{runId:'another-run',toolCallId:'reused-call',nativeMessageId:'native-a'}).availability,'unavailable');
  f.core.sessionGraph.select('main',a.result);
  assert.equal(f.core.contextToolResult('main',{runId:f.runId,toolCallId:'reused-call',nativeMessageId:'native-b'}).availability,'unavailable');
  assert.equal(f.core.contextToolResult('main',{runId:f.runId,toolCallId:'reused-call',nativeMessageId:'native-a'}).availability,'available');
 }finally{await f.close();}
});

test('data-only imported tool results preserve the original pairing with separate source IDs',async()=>{
 const f=await fixture();try{
  const id='imported-tools',timestamp=new Date().toISOString(),entries=[{type:'session',version:3,id:'synthetic-import-source',timestamp,cwd:f.directory},{type:'message',id:'call-entry',parentId:null,timestamp,message:fauxAssistantMessage(fauxToolCall('imported_tool',{}, {id:'imported-call'}),{stopReason:'toolUse'})},{type:'message',id:'result-entry',parentId:'call-entry',timestamp,message:{role:'toolResult',toolCallId:'imported-call',toolName:'imported_tool',content:[{type:'text',text:'Exact imported business content'}],isError:false,timestamp:0}}];
  await f.core.importPiContext({id,name:'Imported tools',modelProfile:'default',jsonl:entries.map(row=>JSON.stringify(row)).join('\n')+'\n'});
  const value=f.core.contextToolResult(id,{runId:null,toolCallId:'imported-call',nativeMessageId:'pi-entry:call-entry',entryId:'call-entry'});
  assert.equal(value.availability,'available');assert.equal(value.tool!.resultEntryId,'result-entry');assert.ok(JSON.stringify(value.tool!.resultContent).includes('Exact imported business content'));
 }finally{await f.close();}
});

test('the read-only HTTP lookup enforces storage/instance/origin and streams the exact same DTO',async()=>{
 const f=await fixture();try{
  const target=append(f.core,f.runId,'http-native','http-call','Exact HTTP business content',false,true),app=createApp(f.core),route=`/contexts/main/tool-result?runId=${f.runId}&toolCallId=http-call&nativeMessageId=http-native&entryId=${target.call}`;
  const headers={authorization:`Bearer ${f.core.controlToken}`,'X-ShittimChest-Storage-Id':f.core.storageId,'X-ShittimChest-Instance-Id':f.core.instanceId};
  assert.equal((await app.request(route)).status,401);
  assert.equal((await app.request(route,{headers:{authorization:headers.authorization}})).status,409);
  assert.equal((await app.request(route,{headers:{...headers,'X-ShittimChest-Storage-Id':'other'}})).status,409);
  assert.equal((await app.request(route,{headers:{...headers,'X-ShittimChest-Instance-Id':'other'}})).status,409);
  assert.equal((await app.request(route,{headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
  const plain=await app.request(route,{headers});assert.equal(plain.status,200);const expected=toolResultViewSchema.parse(await plain.json());assert.equal(expected.availability,'available');
  const streamed=await app.request(route,{headers:{...headers,Accept:JSON_CONTENT_MEDIA_TYPE}});assert.equal(streamed.status,200);assert.deepEqual(toolResultViewSchema.parse(await decodeJsonContent(streamed.body!)),expected);
  assert.equal((await app.request('/contexts/missing/tool-result?toolCallId=missing',{headers})).status,404);
 }finally{await f.close();}
});
