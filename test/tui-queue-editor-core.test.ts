import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { QueueEditorComponent } from '../src/tui/queue-editor.js';
import { AppError } from '../src/domain.js';
import type { QueueEditDocument } from '../src/protocol.js';
import { finished, removeTemp, until } from './helpers.js';

class TestTerminal implements Terminal {
  columns=100;rows=30;kittyProtocolActive=false;input: (data:string)=>void=()=>{};output='';
  start(input:(data:string)=>void){this.input=input;} stop(){} async drainInput(){} write(data:string){this.output+=data;}
  moveBy(){} hideCursor(){} showCursor(){} clearLine(){} clearFromCursor(){} clearScreen(){} setTitle(){} setProgress(){} setProgramStatus(){}
}
for(const scenario of ['sixty-five','over-single-message-limit','nine-attachments'] as const)test(`real TUI and HTTP restore/edit/send the complete ${scenario} queue with one submit`,{timeout:30000},async()=>{
  const descriptors=[Object.getOwnPropertyDescriptor(process.stdin,'isTTY'),Object.getOwnPropertyDescriptor(process.stdout,'isTTY')];
  Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tui-queue-document-'));let release!:()=>void;let calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});const prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(++calls===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'https://fixture.invalid/v1',apiKey:'synthetic-only',authHeader:'bearer',modelId:'synthetic-queue',contextWindow:512000,maxTokens:1024}});
  const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
  const client=new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,core.controlToken),terminal=new TestTerminal(),app=new TerminalApp(client,'main',terminal),ui=app as any;
  const notices:string[]=[];const note=ui.note.bind(ui);ui.note=(text:string)=>{notices.push(text);note(text);};
  let activeSummaryReads=0,maxSummaryReads=0,loseCaptureReceipt=scenario==='sixty-five';
  const failures:unknown[]=[],request=client.request.bind(client);client.request=async<T>(route:string,init?:Parameters<Client['request']>[1]):Promise<T>=>{const summary=route.endsWith('/message-queue?view=summary');if(summary){activeSummaryReads++;maxSummaryReads=Math.max(maxSummaryReads,activeSummaryReads);}try{const value=await request<T>(route,init);if(loseCaptureReceipt&&init?.method==='POST'&&route.endsWith('/message-queue/drafts')){loseCaptureReceipt=false;throw new AppError('connection_failed',502);}return value;}catch(error){failures.push({route,aborted:init?.signal?.aborted,error:error instanceof AppError?error.code:'request_failed'});throw error;}finally{if(summary)activeSummaryReads--;}};
  let running:Promise<void>|undefined;
  try{
    const first=await core.submitMessage({content:'SYNTHETIC_ACTIVE_REQUEST'});await until(()=>calls,n=>n===1);
    const texts=scenario==='sixty-five'?Array.from({length:65},(_,i)=>`SYNTHETIC_QUEUE_${i}`):scenario==='over-single-message-limit'?['a'.repeat(40000),'b'.repeat(40000)]:Array.from({length:9},(_,i)=>`SYNTHETIC_FILE_REQUEST_${i}`);
    const assets=[];if(scenario==='nine-attachments')for(let i=0;i<9;i++)assets.push(await core.assets.put(new Response(`SYNTHETIC_ATTACHMENT_${i}`).body,`fixture-${i}.txt`));
    const originals=[];for(const [index,content] of texts.entries())originals.push(await core.submitMessage({content,mode:'queue',...(assets[index]?{attachments:[assets[index]!.id]}:{})}));
    running=app.run();await until(()=>ui.contextReady&&ui.started&&ui.capabilities.has('message-queue-editor'),Boolean);ui.editor.setText('SYNTHETIC_CURRENT_DRAFT');
    terminal.input('\x1b[1;3A');await until(()=>ui.sessionSelector,(component:unknown)=>component instanceof QueueEditorComponent).catch(()=>assert.fail(JSON.stringify({notices,failures,modal:Boolean(ui.modalFlow),pendingModal:Boolean(ui.pendingModal),overlay:ui.ui.hasOverlay(),capability:ui.capabilities.has('message-queue-editor'),drafts:core.queueEditor().list('main').map(row=>({status:row.status,count:row.entryCount})),queued:core.queuedMessages('main').length,ready:ui.contextReady,stopped:ui.stopped})));
    assert.equal(core.queuedMessages('main').length,0);const draft=core.queueEditor().list('main')[0]!;assert.equal(draft.entryCount,texts.length+1);assert.equal(calls,1);
    const firstEntry=core.queueEditor().page('main',draft.id).entries[0]!;terminal.input('\x1b[F');terminal.input(' edited');
    terminal.input('\r');
    if(assets.length){await until(()=>ui.ui.hasOverlay(),Boolean);terminal.input('\x1b[B');terminal.input('\r');}
    await until(()=>notices,rows=>rows.some(text=>text.includes('等待原生运行统一受理'))).catch(()=>assert.fail(JSON.stringify({notices,modal:Boolean(ui.modalFlow),selector:Boolean(ui.sessionSelector)})));
    assert.equal(ui.sessionSelector,undefined);const receipt=core.queueEditor().page('main',draft.id).draft;assert.equal(receipt.status,'submitting');const queued=core.queuedMessages('main');assert.equal(queued.length,1);const staged=receipt.submission!.entries.map(row=>core.store.getSignal(row.signalId)!);assert.equal(staged[0]!.content,firstEntry.content+' edited');assert.deepEqual(staged.slice(1).map(row=>row.content),[...texts.slice(1),'SYNTHETIC_CURRENT_DRAFT']);assert.deepEqual(staged.flatMap(row=>row.attachments??[]),assets.map(row=>row.id));
    assert.ok(ui.transcript.children.some((child:{text?:string})=>child.text?.includes('等待原生运行统一受理')));assert.equal(calls,1,'saving never claims that the held work already executed');
    assert.ok(maxSummaryReads<=2,'queue events coalesce into one view request beside the explicit user operation');
    release();await finished(core,first.runId!);await until(()=>core.queueEditor().page('main',draft.id).draft.status,status=>status==='submitted');await finished(core,core.store.getSignal(queued[0]!.id)!.runId!);
    assert.equal(calls,2);for(const content of [firstEntry.content+' edited',...texts.slice(1),'SYNTHETIC_CURRENT_DRAFT'])assert.ok(prompts[1]!.includes(content));assert.equal(new Set(staged.map(row=>core.store.getSignal(row.id)!.runId)).size,1);for(const source of originals)assert.equal(core.store.getSignal(source.id)!.status,'cancelled');
  }finally{
    release();await app.stop();await running;if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);
    for(const [index,stream] of [process.stdin,process.stdout].entries()){const descriptor=descriptors[index];if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else delete(stream as{isTTY?:boolean}).isTTY;}
  }
});

test('a lost capture receipt reconciles the same current draft and later typing without duplicate inputs',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-capture-receipt-'));let release!:()=>void;let calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{if(++calls===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false});const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
  const client=new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,core.controlToken),request=client.request.bind(client),app=new TerminalApp(client,'main',new TestTerminal()),ui=app as any;let lose=true;
  client.request=async<T>(route:string,init?:Parameters<Client['request']>[1]):Promise<T>=>{const value=await request<T>(route,init);if(lose&&init?.method==='POST'&&route.endsWith('/message-queue/drafts')){lose=false;ui.editor.setText('original current draft plus later typing');throw new AppError('connection_failed',502);}return value;};
  try{
    const active=await core.submitMessage({content:'SYNTHETIC_ACTIVE_REQUEST'});await until(()=>calls,n=>n===1);await core.submitMessage({content:'original queued source',mode:'queue'});
    Object.assign(ui,{storageId:core.storageId,instanceId:core.instanceId,contextReady:true,contextRole:'main',isMainContext:true,currentRunId:active.runId,capabilities:new Set([...(await client.handshake()).capabilities,'message-queue-editor'])});
    ui.editor.setText('original current draft');await ui.restoreQueue(true);assert.equal(core.queueEditor().list('main').length,1);assert.equal(ui.editor.getExpandedText(),'');
    const draft=core.queueEditor().list('main')[0]!,rows=core.queueEditor().page('main',draft.id).entries;assert.deepEqual(rows.map(row=>row.content),['original queued source','original current draft plus later typing']);
    const receipt=await core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision},'send');assert.equal(receipt.submission!.entries.length,2);assert.equal(core.queuedMessages('main').length,1);
  }finally{release();await app.stop();if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);}
});

test('the actual TUI exposes partial steering receipts and reopens only unsent content for a new queue submission',{timeout:20000},async()=>{
  const descriptors=[Object.getOwnPropertyDescriptor(process.stdin,'isTTY'),Object.getOwnPropertyDescriptor(process.stdout,'isTTY')];Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tui-partial-steer-'));let release!:()=>void;let calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{if(++calls===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false});const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
  const client=new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,core.controlToken),terminal=new TestTerminal(),app=new TerminalApp(client,'main',terminal),ui=app as any;let running:Promise<void>|undefined;
  const titles:string[]=[],choose=ui.choose.bind(ui);ui.choose=(title:string,...args:unknown[])=>{titles.push(title);return choose(title,...args);};
  try{
    const active=await core.submitMessage({content:'SYNTHETIC_ACTIVE_REQUEST'});await until(()=>calls,n=>n===1);await core.submitMessage({content:'FIRST_PARTIAL_SOURCE',mode:'queue'});await core.submitMessage({content:'SECOND_PARTIAL_SOURCE',mode:'queue'});
    const internal=core as unknown as {steerMessages:(...args:any[])=>Promise<any>},steer=internal.steerMessages.bind(core);let endFirst=true;internal.steerMessages=async(contextId,rows,runId)=>{if(!endFirst)return steer(contextId,rows,runId);endFirst=false;await steer(contextId,rows.slice(0,1),runId);release();await finished(core,active.runId!);return steer(contextId,rows.slice(1),runId);};
    running=app.run();await until(()=>ui.contextReady&&ui.started&&ui.currentRunId===active.runId,Boolean);terminal.input('\x1b[1;3A');await until(()=>ui.sessionSelector,component=>component instanceof QueueEditorComponent);
    const draft=core.queueEditor().list('main')[0]!;terminal.input('\x1bOP');await until(()=>ui.ui.hasOverlay(),Boolean);for(let i=0;i<3;i++)terminal.input('\x1b[B');terminal.input('\r');
    await until(()=>core.queueEditor().page('main',draft.id).draft.status,status=>status==='blocked');await until(()=>!ui.modalFlow,Boolean);internal.steerMessages=steer;
    terminal.input('\x1b[1;3A');await until(()=>ui.ui.hasOverlay(),Boolean);assert.ok(titles.some(title=>title.includes('已确认受理 1/2')&&title.includes('待核对 1')));terminal.input('\x1b[B');terminal.input('\r');
    await until(()=>ui.sessionSelector,component=>component instanceof QueueEditorComponent);const reopened=core.queueEditor().page('main',draft.id);assert.equal(reopened.draft.id,draft.id);assert.equal(reopened.draft.entryCount,1);assert.ok(reopened.entries[0]!.admittedSignalId);
    terminal.input('\x1b[F');terminal.input(' edited');terminal.input('\r');await until(()=>core.queueEditor().page('main',draft.id).draft.status,status=>status==='submitted');
    const final=core.queueEditor().page('main',draft.id).draft;assert.equal(final.previousSubmissions![0]!.entries[0]!.status,'accepted');assert.equal(final.submission!.entries.length,1);const signal=await until(()=>core.store.getSignal(final.submission!.entries[0]!.signalId)!,row=>row.status==='accepted');assert.equal(signal.content,'SECOND_PARTIAL_SOURCE edited');await finished(core,signal.runId!);
  }finally{release();await app.stop();await running;if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);for(const [i,stream]of[process.stdin,process.stdout].entries()){const descriptor=descriptors[i];if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else delete(stream as{isTTY?:boolean}).isTTY;}}
});

for(const changedLocally of [false,true])test(`unknown capture acknowledgement preserves another client's edit${changedLocally?' and the newer local version':''}`,{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-concurrent-capture-'));let release!:()=>void;let calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{if(++calls===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false});const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
  const client=new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,core.controlToken),request=client.request.bind(client),app=new TerminalApp(client,'main',new TestTerminal()),ui=app as any;let intercepted=false;
  client.request=async<T>(route:string,init?:Parameters<Client['request']>[1]):Promise<T>=>{const result=await request<T>(route,init);if(!intercepted&&init?.method==='POST'&&route.endsWith('/message-queue/drafts')){intercepted=true;const draft=result as QueueEditDocument;await request(route+'/'+draft.id,{method:'PATCH',headers:{'content-type':'application/json','Idempotency-Key':'other-client-edit'},body:JSON.stringify({expectedRevision:draft.revision,action:{kind:'edit',entryId:draft.capturedEntryId,content:'REMOTE_EDITED_VERSION',attachments:[]}})});if(changedLocally)ui.editor.setText('LOCAL_NEWER_VERSION');throw new AppError('connection_failed',502);}return result;};
  try{
    const active=await core.submitMessage({content:'SYNTHETIC_ACTIVE_REQUEST'});await until(()=>calls,n=>n===1);await core.submitMessage({content:'queued source',mode:'queue'});
    Object.assign(ui,{storageId:core.storageId,instanceId:core.instanceId,contextReady:true,contextRole:'main',isMainContext:true,currentRunId:active.runId,capabilities:new Set((await client.handshake()).capabilities)});ui.choose=async()=> 'both';ui.editor.setText('INITIAL_LOCAL_VERSION');
    await ui.restoreQueue(true);assert.equal(ui.editor.getExpandedText(),'');const drafts=core.queueEditor().list('main');assert.equal(drafts.length,1);assert.deepEqual(core.queueEditor().page('main',drafts[0]!.id).entries.map(row=>row.content),['queued source','REMOTE_EDITED_VERSION',changedLocally?'LOCAL_NEWER_VERSION':'INITIAL_LOCAL_VERSION']);assert.equal(calls,1);
  }finally{release();await app.stop();if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);}
});
