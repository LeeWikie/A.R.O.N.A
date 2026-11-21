import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {serve} from '@hono/node-server';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import type {Terminal} from '@earendil-works/pi-tui';
import {Core} from '../src/core.js';
import type {AssetInfo} from '../src/assets.js';
import {Client} from '../src/client.js';
import {createApp} from '../src/http.js';
import {AppError} from '../src/domain.js';
import type {QueueEditDocument,QueueEntryEdit} from '../src/protocol.js';
import {saveQueueEntry,type PendingQueueEntryEdit,type QueueEntryWriter} from '../src/tui/queue-entry-save.js';
import {TerminalApp} from '../src/tui/index.js';
import {QueueEditorComponent,QueueEditingControls} from '../src/tui/queue-editor.js';
import {QueueLocalEdits} from '../src/tui/queue-local-edits.js';
import {removeTemp,until} from './helpers.js';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-attachment-manifest-'));let calls=0;
 const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;throw new Error('saving an input must not execute');}});
 let core=await Core.open({dataDir:directory,memoryEnabled:false,model});
 const server=serve({fetch:request=>createApp(core).fetch(request),hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const client=new Client(`http://127.0.0.1:${(server.address()as AddressInfo).port}`,core.controlToken),sizes:number[]=[],writes:string[]=[];
 const host:QueueEntryWriter={attachmentParts:true,request:route=>client.request(route),write:async(route,body,method='POST',operationId=randomUUID())=>{const encoded=JSON.stringify(body);sizes.push(Buffer.byteLength(encoded));writes.push(route);return client.request(route,{method,headers:{'content-type':'application/json','Idempotency-Key':operationId},body:encoded});}};
 return{get core(){return core;},client,host,sizes,writes,get calls(){return calls;},async reopen(){await core.close();core=await Core.open({dataDir:directory,memoryEnabled:false,model});},async close(){if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);}};
}
function document(core:Core){const captureId=randomUUID(),draft=core.queueEditor().create('main',{captureQueue:false,localCapture:true,current:{content:'ORIGINAL_EDITOR_INPUT',clientDraftId:captureId}},randomUUID()),entry=core.queueEditor().page('main',draft.id).entries[0]!;return{draft,entry,captureId,route:`/contexts/main/message-queue/drafts/${draft.id}`};}

test('an ordered attachment manifest crosses the unchanged HTTP budget and resumes after partial upload, restart and lost commit acknowledgement',async()=>{
 const f=await fixture();try{
  const files:AssetInfo[]=[];for(let index=0;index<3;index++)files.push(await f.core.assets.put(new Response(`ORIGINAL_ATTACHMENT_${index}`).body,`original-${index}.txt`));
  const attachments=Array.from({length:14000},(_,index)=>files[(index*7)%files.length]!.id),d=document(f.core),pending:PendingQueueEntryEdit={operationId:randomUUID(),baseRevision:d.draft.revision,content:'COMPLETE_ORIGINAL_INPUT',attachments,captureDraftId:d.captureId,localContext:'ORIGINAL_LOCAL_OBSERVATION'},write=f.host.write.bind(f.host);let parts=0,loseCommit=true;
  f.host.write=async(...args)=>{const result=await write(...args);if(args[0].includes('/attachment-parts/')&&++parts===3)throw new AppError('connection_failed',502);return result;};
  await assert.rejects(saveQueueEntry(f.host,d.route,d.entry.id,pending),/connection_failed/);assert.equal(f.core.queueEditor().page('main',d.draft.id).entries[0]!.content,'ORIGINAL_EDITOR_INPUT');assert.equal(f.calls,0);await f.reopen();
  f.host.write=async(...args)=>{const result=await write(...args);if(args[0].endsWith('/commit')&&loseCommit){loseCommit=false;throw new AppError('connection_failed',502);}return result;};
  await assert.rejects(saveQueueEntry(f.host,d.route,d.entry.id,pending),/connection_failed/);const saved=f.core.queueEditor().page('main',d.draft.id);assert.deepEqual(saved.entries[0]!.attachments,attachments);assert.equal(saved.entries[0]!.content,pending.content);assert.equal(saved.entries[0]!.localContextHash,digest(pending.localContext!));assert.equal(saved.draft.revision,d.draft.revision+1);await f.reopen();
  const retry=await saveQueueEntry(f.host,d.route,d.entry.id,pending);assert.deepEqual(retry,saved.draft);assert.deepEqual(f.core.queueEditor().page('main',d.draft.id).entries[0]!.attachments,attachments);assert.equal(f.writes.filter(route=>route.includes('/attachment-parts/')).length,Math.ceil(attachments.length/1024),'confirmed attachment parts are not resent');assert.ok(f.sizes.every(bytes=>bytes<=512*1024));assert.equal(f.calls,0,'saving every attachment is separate from model admission');
 }finally{await f.close();}
});

test('incomplete, changed or stale attachment uploads never partially replace the editor document',async()=>{
 const f=await fixture();try{
  const d=document(f.core),attachments=[randomUUID(),randomUUID(),randomUUID()],content='NEW_INPUT',input={entryId:d.entry.id,expectedRevision:d.draft.revision,partCount:1,characters:content.length,hash:digest(content),attachments:[],captureDraftId:d.captureId,attachmentParts:{partCount:2,items:attachments.length,hash:digest(JSON.stringify(attachments))}},upload=await f.host.write(`${d.route}/entry-edits`,input,'POST','manifest-cas')as QueueEntryEdit,route=`${d.route}/entry-edits/${upload.id}`;
  await f.host.write(`${route}/parts/0`,{content},'PUT');await f.host.write(`${route}/attachment-parts/0`,{content:JSON.stringify(attachments.slice(0,2))},'PUT');await assert.rejects(f.host.write(`${route}/commit`,{}),/queue_entry_parts_missing/);assert.deepEqual(f.core.queueEditor().page('main',d.draft.id).entries[0]!.attachments,[]);
  await assert.rejects(f.host.write(`${route}/attachment-parts/0`,{content:JSON.stringify([...attachments.slice(0,2)].reverse())},'PUT'),/operation_id_conflict/);await assert.rejects(f.host.write(`${route}/attachment-parts/1`,{content:'["not-an-asset-id"]'},'PUT'));
  await f.host.write(`${route}/attachment-parts/1`,{content:JSON.stringify(attachments.slice(2))},'PUT');const other=f.core.queueEditor().mutate('main',d.draft.id,{expectedRevision:d.draft.revision,action:{kind:'edit',entryId:d.entry.id,content:'OTHER_CLIENT_VERSION',attachments:[]}},'other-client');await f.reopen();await assert.rejects(f.host.write(`${route}/commit`,{}),/revision_conflict/);assert.equal(f.core.queueEditor().page('main',d.draft.id).draft.revision,other.revision);assert.equal(f.core.queueEditor().page('main',d.draft.id).entries[0]!.content,'OTHER_CLIENT_VERSION');assert.deepEqual(f.core.queueEditor().entryEdit('main',d.draft.id,upload.id).receivedAttachmentParts,[0,1]);assert.equal(f.calls,0);
 }finally{await f.close();}
});

test('whole-document admission validates the last transported attachment before creating any native input and retains every original reference',{timeout:30000},async()=>{
 const f=await fixture();try{
  const file=await f.core.assets.put(new Response('ORIGINAL_BOUNDED_FILE').body,'original.txt'),d=document(f.core),attachments=[...Array.from({length:13999},()=>file.id),randomUUID()],saved=await saveQueueEntry(f.host,d.route,d.entry.id,{operationId:randomUUID(),baseRevision:d.draft.revision,content:'ORIGINAL_INPUT_WITH_MISSING_FINAL_FILE',attachments,captureDraftId:d.captureId}),describe=f.core.assets.describe.bind(f.core.assets),observed:string[]=[];
  f.core.assets.describe=(id)=>{observed.push(id);return describe(id);};await assert.rejects(f.core.queueEditor().submit('main',d.draft.id,{expectedRevision:saved.revision},'explicit-admission'),/asset_not_found/);assert.deepEqual(observed,attachments);assert.equal(f.calls,0);assert.equal(f.core.queuedMessages('main').length,0);const retained=f.core.queueEditor().page('main',d.draft.id);assert.equal(retained.draft.status,'editing');assert.equal(retained.draft.submission,undefined);assert.deepEqual(retained.entries[0]!.attachments,attachments);await f.reopen();assert.deepEqual(f.core.queueEditor().page('main',d.draft.id).entries[0]!.attachments,attachments);assert.equal(f.calls,0);
 }finally{await f.close();}
});

test('an older Core capability preserves the complete unsent intent without sending an over-budget request',async()=>{
 const f=await fixture();try{
  const d=document(f.core),pending:PendingQueueEntryEdit={operationId:randomUUID(),baseRevision:d.draft.revision,content:'ORIGINAL_UNSENT_INPUT',attachments:Array.from({length:14000},()=>randomUUID()),captureDraftId:d.captureId,localContext:'ORIGINAL_LOCAL_RESULT'},original=structuredClone(pending);f.host.attachmentParts=false;
  await assert.rejects(saveQueueEntry(f.host,d.route,d.entry.id,pending),/queue_attachment_transfer_unsupported/);assert.deepEqual(pending,original);assert.equal(f.writes.length,0);assert.equal(f.core.queueEditor().page('main',d.draft.id).entries[0]!.content,'ORIGINAL_EDITOR_INPUT');assert.equal(f.calls,0);
 }finally{await f.close();}
});

test('JSON escaping cannot bypass the small-edit budget; ordinary text and host material use their existing bounded parts',async()=>{
 const f=await fixture();try{
  const d=document(f.core),pending:PendingQueueEntryEdit={operationId:randomUUID(),baseRevision:d.draft.revision,content:'\u0001'.repeat(64000),attachments:[],captureDraftId:d.captureId,localContext:'\u0002'.repeat(64000)},result:QueueEditDocument=await saveQueueEntry(f.host,d.route,d.entry.id,pending);assert.equal(result.revision,d.draft.revision+1);assert.equal(f.core.queueEditor().page('main',d.draft.id).entries[0]!.content,pending.content);assert.ok(f.writes.every(route=>route!==d.route));assert.ok(f.sizes.every(size=>size<=512*1024));assert.equal(f.calls,0);
 }finally{await f.close();}
});

class LocalTerminal implements Terminal{
 columns=100;rows=30;kittyProtocolActive=false;input:(data:string)=>void=()=>{};
 start(input:(data:string)=>void){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
test('the actual App preserves an unsupported large local version and adopts newly discovered transport capabilities without losing its editor resources',async()=>{
 const f=await fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-manifest-local-')),descriptors=[Object.getOwnPropertyDescriptor(process.stdin,'isTTY'),Object.getOwnPropertyDescriptor(process.stdout,'isTTY')];for(const stream of[process.stdin,process.stdout])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
 const terminal=new LocalTerminal(),cache=new QueueLocalEdits(directory,f.client.localStateScope),app=new TerminalApp(f.client,'main',terminal,{queueEdits:cache}),ui=app as unknown as{contextReady:boolean;started:boolean;capabilities:Set<string>;queueEditingControls():QueueEditingControls;sessionSelector?:unknown};let running:Promise<void>|undefined,opening:Promise<void>|undefined;
 try{
  const file=await f.core.assets.put(new Response('ORIGINAL_LOCAL_FILE').body,'original.txt'),d=document(f.core),attachments=Array.from({length:14000},()=>file.id),pending:PendingQueueEntryEdit={operationId:randomUUID(),baseRevision:d.draft.revision,content:'UNCONFIRMED_COMPLETE_INPUT',attachments,captureDraftId:d.captureId,localContext:'ORIGINAL_LOCAL_SHELL_OBSERVATION'},address={storageId:f.core.storageId,contextId:'main',draftId:d.draft.id},original=cache.save({...address,entryId:d.entry.id,baseRevision:d.draft.revision,base:d.entry,content:pending.content,attachments,updatedAt:new Date().toISOString(),pending,localContext:pending.localContext});
  running=app.run();await until(()=>ui.contextReady&&ui.started,Boolean);ui.capabilities.delete('queue-entry-attachment-parts');const previous=ui.queueEditingControls();await previous.open('main',d.draft.id);assert.equal(f.core.queueEditor().page('main',d.draft.id).entries[0]!.content,'ORIGINAL_EDITOR_INPUT');assert.deepEqual(cache.current(address,d.entry.id),original);
  ui.capabilities.add('queue-entry-attachment-parts');const current=ui.queueEditingControls();assert.notEqual(current,previous);opening=current.open('main',d.draft.id);await until(()=>ui.sessionSelector,component=>component instanceof QueueEditorComponent);const saved=f.core.queueEditor().page('main',d.draft.id).entries[0]!;assert.equal(saved.content,pending.content);assert.deepEqual(saved.attachments,attachments);assert.equal(saved.localContextHash,digest(pending.localContext!));terminal.input('\x1b');await opening;assert.equal(f.calls,0);assert.equal(cache.current(address,d.entry.id),undefined,'only the exact version confirmed by the Core is cleared');
 }finally{await app.stop();await opening;await running;await f.close();await removeTemp(directory);for(const[index,stream]of[process.stdin,process.stdout].entries()){const descriptor=descriptors[index];if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else delete(stream as{isTTY?:boolean}).isTTY;}}
});
