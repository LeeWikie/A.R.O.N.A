import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {serve} from '@hono/node-server';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import type {Terminal} from '@earendil-works/pi-tui';
import {Core} from '../src/core.js';
import {Client} from '../src/client.js';
import {createApp} from '../src/http.js';
import {AppError} from '../src/domain.js';
import type {QueueEditDocument} from '../src/protocol.js';
import {TerminalApp} from '../src/tui/index.js';
import {QueueLocalEdits} from '../src/tui/queue-local-edits.js';
import {ShellOutputCaptures} from '../src/tui/shell-output.js';
import {QueueEditorComponent} from '../src/tui/queue-editor.js';
import {finished,removeTemp,until} from './helpers.js';
class TestTerminal implements Terminal{columns=100;rows=30;kittyProtocolActive=false;input:(data:string)=>void=()=>{};start(input:(data:string)=>void){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}}

for(const failure of ['asset-response','native-submit-response','source-response','project-change']as const)test(`reopened real App reviews the complete local input after ${failure} without replay or disturbing the newer draft`,{timeout:30000},async()=>{
  const descriptors=[Object.getOwnPropertyDescriptor(process.stdin,'isTTY'),Object.getOwnPropertyDescriptor(process.stdout,'isTTY')];Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-input-reopen-')),localDirectory=path.join(directory,'client'),prompts:string[]=[];let losses=failure==='native-submit-response'?2:1;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  const core=await Core.open({dataDir:path.join(directory,'core'),model,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'https://fixture.invalid/v1',apiKey:'synthetic-only',authHeader:'bearer',modelId:'reopen-input-fixture',contextWindow:512000,maxTokens:1024}}),server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');const base=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;
  const make=()=>{const client=new Client(base,core.controlToken);const terminal=new TestTerminal(),local=new QueueLocalEdits(localDirectory,'stable-control'),captures=new ShellOutputCaptures(localDirectory,'stable-control'),app=new TerminalApp(client,'main',terminal,{completionBase:directory,queueEdits:local,shellOutputs:captures});return {client,terminal,local,captures,app,ui:app as any};};
  const first=make(),request=first.client.request.bind(first.client);first.client.request=async<T>(route:string,init?:Parameters<Client['request']>[1]):Promise<T>=>{const result=await request<T>(route,init);if(losses&&(failure==='asset-response'?route.startsWith('/assets?')&&route.includes('purpose=client-shell-output'):failure==='source-response'?route.endsWith('/project-directory'):failure==='project-change'?route.startsWith('/assets?')&&route.includes('purpose=client-shell-output'):route.endsWith('/submit'))){losses--;if(failure==='project-change'){const replacement=path.join(directory,'replacement');fs.mkdirSync(replacement);await core.updateWorkspace('default',{path:replacement,expectedPath:core.capabilities.root('default').path});}else throw new AppError('synthetic_response_lost',502);}return result;};
  let second:ReturnType<typeof make>|undefined,running:Promise<void>|undefined;const notes:string[]=[],trace:string[]=[];
  try{
    Object.assign(first.ui,{storageId:core.storageId,instanceId:core.instanceId,contextRole:'main',contextReady:true,isMainContext:true,capabilities:new Set((await first.client.handshake()).capabilities)});first.ui.note=(text:string)=>notes.push(text);first.ui.choose=async(_title:string,items:Array<{value:string}>)=>items.some(row=>row.value==='yes')?'yes':items[0]?.value;
    await first.ui.submit('!echo SYNTHETIC_ORIGINAL_CLIENT_OUTPUT');const asset=await core.assets.put(new Response('SYNTHETIC_ORIGINAL_INPUT_ASSET').body,'original.txt');first.ui.pendingAttachments.set('main',[asset]);
    const content=Array.from({length:7000},(_,i)=>`原输入🙂${i.toString(16).padStart(6,'0')};`).join('');await first.ui.submit(content);assert.equal(losses,0);assert.ok(first.local.captures(core.storageId,'main').some(row=>row.content===content));if(failure!=='native-submit-response')assert.equal(prompts.length,0);
    if(failure==='native-submit-response'){await until(()=>core.runtime.queueEditDocuments<QueueEditDocument>().at(-1)?.submission?.runId,Boolean);await finished(core,core.runtime.queueEditDocuments<QueueEditDocument>().at(-1)!.submission!.runId!);assert.equal(prompts.length,1);}
    await first.app.stop();second=make();running=second.app.run();await until(()=>second!.ui.contextReady&&second!.ui.started,Boolean);assert.ok(second.ui.capabilities.has('logical-input'),'the reopened App uses the actual Core capability');second.ui.note=(text:string)=>notes.push(text);second.ui.choose=async(title:string,items:Array<{value:string}>)=>{trace.push('choose '+title+' '+JSON.stringify(items.map(row=>row.value)));if(title.startsWith('恢复草稿'))trace.push(JSON.stringify([...second!.ui.recoverableDrafts.values()].map((row:any)=>({key:row.key,prefix:row.text.slice(0,20),local:!!row.localOnly,direct:!!row.localOnly?.directInput,context:row.context,storage:row.storageId===core.storageId}))));return items.some(row=>row.value==='yes')?'yes':items.some(row=>row.value==='current')?'current':items[0]?.value;};second.ui.editor.setText('B newer visible draft');
    const originalReview=second.ui.reviewDirectInput.bind(second.ui);second.ui.reviewDirectInput=async(...args:unknown[])=>{trace.push('review start');try{return await originalReview(...args);}finally{trace.push('review end');}};
    const review=second.ui.recoverDraft();
    if(failure!=='native-submit-response'){
      await until(()=>second!.ui.sessionSelector,(value:unknown)=>value instanceof QueueEditorComponent);assert.equal(second.ui.editor.getExpandedText(),'B newer visible draft');assert.equal(prompts.length,0,'opening the recovered editor never starts the input');second.terminal.input('\x1b');await review;assert.equal(second.ui.editor.getExpandedText(),'B newer visible draft');
      const again=second.ui.recoverDraft().finally(()=>trace.push('second recovery end'));await until(()=>second!.ui.sessionSelector,(value:unknown)=>value instanceof QueueEditorComponent).catch(()=>assert.fail(JSON.stringify({notes,trace,ready:second!.ui.contextReady,context:second!.ui.contextId,stopped:second!.ui.stopped,overlay:second!.ui.ui.hasOverlay(),modal:!!second!.ui.pendingModal,flow:!!second!.ui.modalFlow,drafts:core.runtime.queueEditDocuments<QueueEditDocument>().map(row=>({id:row.id,status:row.status,revision:row.revision})),locals:second!.local.captures(core.storageId,'main').map(row=>({id:row.entryId,localId:row.localId,pending:row.publicationPending}))})));second.terminal.input('\r');await again;
      await until(()=>core.runtime.queueEditDocuments<QueueEditDocument>().at(-1)?.status,status=>status==='submitted');await finished(core,core.runtime.queueEditDocuments<QueueEditDocument>().at(-1)!.submission!.runId!);
    }else await review;
    assert.equal(prompts.length,1);assert.match(prompts[0]!,/SYNTHETIC_ORIGINAL_CLIENT_OUTPUT/);assert.match(prompts[0]!,/SYNTHETIC_ORIGINAL_INPUT_ASSET/);assert.equal(second.ui.editor.getExpandedText(),'B newer visible draft');assert.equal(second.captures.list(core.storageId,'main',true).length,0);assert.equal(second.local.captures(core.storageId,'main').length,0);assert.ok(!prompts[0]!.includes('B newer visible draft'));
  }finally{await first.app.stop();await second?.app.stop();await running;if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);for(const[index,stream]of[process.stdin,process.stdout].entries()){const descriptor=descriptors[index];if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else delete(stream as {isTTY?:boolean}).isTTY;}}
});
