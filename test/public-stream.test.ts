import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {scriptedModel,finished,removeTemp,until} from './helpers.js';

function request(core:Core,route:string,signal?:AbortSignal){return createApp(core).request(route,{headers:{Authorization:`Bearer ${core.controlToken}`},signal});}

test('snapshot and public history contain only durable user-facing records',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-public-stream-'));const core=await Core.open({dataDir:dir,model:scriptedModel().model,memoryEnabled:false});
 try{
  core.credentials.set('FAKE_SECRET','synthetic-credential-not-for-rendering');
  core.runtime.event({contextId:'main',kind:'message_update',data:{system:'INTERNAL_SYSTEM_MUST_NOT_RENDER',reasoning:'HIDDEN_REASONING_MUST_NOT_RENDER'}});
  core.runtime.event({contextId:'main',kind:'tool_start',data:{toolName:'fixture_tool',toolCallId:'fixture-call',args:{password:'synthetic-credential-not-for-rendering'}}});
  core.runtime.addApproval({id:'fixture-approval',contextId:'main',taskId:null,runId:'fake-run',toolCallId:'fake-call',toolName:'fixture',args:{password:'synthetic-credential-not-for-rendering'},status:'pending',createdAt:new Date().toISOString()});
  const input=await core.submitSignal({version:2,type:'user-message',source:'fixture',content:'Visible synthetic message'});await finished(core,input.runId!);
  const snapshot=await(await request(core,'/snapshot')).json() as {watermark:number;conversation:{messages:{id:string;role:string;content:string}[]};approvals:unknown[]};
  const raw=JSON.stringify(snapshot);assert.ok(!raw.includes('synthetic-credential-not-for-rendering'));assert.ok(!raw.includes('INTERNAL_SYSTEM_MUST_NOT_RENDER'));assert.ok(!raw.includes('HIDDEN_REASONING_MUST_NOT_RENDER'));
  assert.ok(snapshot.conversation.messages.some(row=>row.id===`signal:${input.id}`&&row.role==='user'));
  assert.ok(snapshot.conversation.messages.some(row=>row.role==='assistant'));
  const page=await(await request(core,'/event-page?after=0')).text();assert.ok(page.includes('fixture_tool'));assert.ok(!page.includes('HIDDEN_REASONING_MUST_NOT_RENDER'));assert.ok(!page.includes('synthetic-credential-not-for-rendering'));
  assert.equal((await createApp(core).request('/snapshot')).status,401);assert.equal((await request(core,'/event-page?after=9999999')).status,409);
 }finally{await core.close();await removeTemp(dir);}
});

test('authenticated SSE replays, checkpoints filtered gaps and cleans up on disconnect',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-sse-'));const core=await Core.open({dataDir:dir,memoryEnabled:false});
 try{
  core.runtime.event({contextId:'other',kind:'private-fixture',data:{secret:'DO_NOT_RENDER'}});
  core.runtime.event({contextId:'main',kind:'tool_start',data:{toolName:'visible_fixture',toolCallId:randomUUID()}});
  const abort=new AbortController();const response=await request(core,'/event-stream?after=0&contextId=main',abort.signal);assert.match(response.headers.get('content-type')??'',/text\/event-stream/);
  const reader=response.body!.getReader();const decode=new TextDecoder();let text='';
  for(let i=0;i<5&&!text.includes('event: checkpoint');i++){const value=await reader.read();if(value.done)break;text+=decode.decode(value.value,{stream:true});}
  assert.ok(text.includes('visible_fixture'));assert.ok(text.includes('checkpoint'));assert.ok(!text.includes('DO_NOT_RENDER'));
  abort.abort();await reader.cancel();
 }finally{await core.close();await removeTemp(dir);}
});

test('canonical reply deliveries identify only their own draft, including history replay',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-reply-projection-'));let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});const fixture=scriptedModel({gate});
 const core=await Core.open({dataDir:dir,memoryEnabled:false,model:fixture.model});
 try{
  const {signalSchema}=await import('../src/domain.js');
  const input=signalSchema.parse({id:randomUUID(),contextId:'main',source:'tui-message',type:'user-message',content:'synthetic user input'});
  const receipt=await core.submitMessage({id:input.id,contextId:input.contextId,content:input.content});
  const runId=receipt.runId!;await until(()=>fixture.calls(),count=>count>0);
  assert.ok(core.runtime.setting(`session-run-anchor:${runId}`,null));
  const reply=core.store.publish({kind:'message',runId,signalIds:[input.id],toolCallId:'reply:fixture-draft',content:'canonical reply'});
  const other=core.store.publish({kind:'message',runId,signalIds:[input.id],toolCallId:'ordinary-tool',content:'separate delivery'});
  for(const output of [reply,other])core.runtime.event({contextId:'main',runId,kind:'delivery',data:{...output,replyDraftId:'untrusted-event-claim'}});
  const page=await(await request(core,'/event-page?after=0')).json() as {events:{kind:string;data:{id:string;replyDraftId?:string}}[]};
  assert.equal(page.events.find(e=>e.data.id===`output:${reply.id}`)?.data.replyDraftId,'fixture-draft');
  assert.equal(page.events.find(e=>e.data.id===`output:${other.id}`)?.data.replyDraftId,undefined);
  const history=await(await request(core,'/conversation')).json() as {messages:{id:string;replyDraftId?:string}[]};
  assert.equal(history.messages.find(e=>e.id===`output:${reply.id}`)?.replyDraftId,'fixture-draft');
  assert.equal(history.messages.find(e=>e.id===`output:${other.id}`)?.replyDraftId,undefined);
  release();assert.equal((await finished(core,runId))?.status,'succeeded');
 }finally{release();await core.close();await removeTemp(dir);}
});
