import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fauxProvider,fauxAssistantMessage,type TranscriptContext} from '@earendil-works/pi-ai';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {authenticatedApp,finished,removeTemp} from './helpers.js';
import type {AssetInfo} from '../src/assets.js';
import {documentFixture,pdfFixture,workbookFixture} from './document-fixture.js';
import {syntheticPng} from './fixtures/png.js';
const png=syntheticPng(1,1);

test('authenticated raw uploads retain bytes and reach the native provider as image content',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-assets-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});let seen:TranscriptContext|undefined;
 try{
  const fake=fauxProvider({provider:'image-fixture',models:[{id:'vision',input:['text','image']}]});fake.setResponses([(context)=>{seen=context;return fauxAssistantMessage('image received');}]);core.providerRegistry.setProvider(fake.provider);
  core.models.save({id:'default',name:'Vision',providerId:'image-fixture',modelId:'vision'});
  const app=authenticatedApp(core);
  const upload=await app.request('/assets?name=synthetic.png',{method:'POST',body:new Uint8Array(png)});assert.equal(upload.status,201);
  const metadata=await upload.json() as AssetInfo;assert.equal(metadata.mediaType,'image/png');assert.equal(metadata.sha256,createHash('sha256').update(png).digest('hex'));
  const downloaded=await app.request(`/assets/${metadata.id}`);assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),png);
  const response=await app.request('/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attachments:[metadata.id]})});assert.equal(response.status,202);
  const receipt=await response.json() as {id:string;runId:string};const ended=await finished(core,receipt.runId);assert.equal(ended?.status,'succeeded',JSON.stringify(core.runtime.events('main').filter(e=>['error','agent_end'].includes(e.kind))));
  assert.equal(core.store.outputsForSignal(receipt.id)[0]?.content,'image received');
  const images=seen?.messages.flatMap(message=>message.role==='user'&&Array.isArray(message.content)?message.content.filter(part=>part.type==='image'):[])??[];
  assert.ok(images.some(image=>image.type==='image'&&image.data===png.toString('base64')),'actual Pi provider must receive original image bytes');
  const history=await(await app.request('/conversation')).json() as {messages:{attachments?:string[]}[]};assert.ok(history.messages.some(message=>message.attachments?.includes(metadata.id)));
 }finally{await core.close();await removeTemp(directory);}
});

test('asset boundaries reject unauthorized uploads, redirected blobs, invalid names and unsupported bytes',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-assets-boundary-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  assert.equal((await createApp(core).request('/assets?name=a.txt',{method:'POST',body:'fixture'})).status,401);
  const app=authenticatedApp(core);assert.equal((await app.request('/assets?name=..%2Fescape',{method:'POST',body:'text'})).status,400);
  assert.equal((await app.request('/assets?name=b.bin',{method:'POST',body:new Uint8Array([0,255,128,0])})).status,415);
  const uploaded=await(await app.request('/assets?name=note.txt',{method:'POST',body:'编号007\n'})).json() as AssetInfo;
  const stored=path.join(directory,'assets',uploaded.id);fs.writeFileSync(stored,'tampered');await assert.rejects(core.assets.read(uploaded.id),/asset_changed/);
 }finally{await core.close();await removeTemp(directory);}
});

test('upload body limit is independent of JSON requests and core shutdown cancels unfinished uploads',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-assets-limits-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  const app=authenticatedApp(core);const largerThanJSON='t'.repeat(256*1024);
  const uploaded=await app.request('/assets?name=large.txt',{method:'POST',body:largerThanJSON});assert.equal(uploaded.status,201);assert.equal((await uploaded.json() as AssetInfo).bytes,largerThanJSON.length);
  const oversized=new Uint8Array(16*1024*1024+1);assert.equal((await app.request('/assets?name=too-large.txt',{method:'POST',body:oversized})).status,413);
  let cancelSeen=false;
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('unfinished'));},cancel(){cancelSeen=true;}});
  const pending=core.assets.put(stream,'unfinished.txt');const stopped=assert.rejects(pending,/core_stopping/);await core.close();await stopped;assert.equal(cancelSeen,true);
 }finally{await core.close();await removeTemp(directory);}
});

test('actual document uploads retain original bytes and reach the native provider as attributed document text after restart',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-assets-documents-'));let core=await Core.open({dataDir:directory,memoryEnabled:false});let seen:TranscriptContext|undefined;
 const fake=fauxProvider({provider:'document-fixture',models:[{id:'reader',input:['text']}]});
 const configure=()=>{fake.setResponses([(context)=>{seen=context;return fauxAssistantMessage('document received');}]);core.providerRegistry.setProvider(fake.provider);core.models.save({id:'default',name:'Document reader',providerId:'document-fixture',modelId:'reader'});};
 try{
  configure();let app=authenticatedApp(core);const inputs=[['source.docx',documentFixture()],['source.xlsx',await workbookFixture()],['source.pdf',pdfFixture()]] as const;const uploads:AssetInfo[]=[];
  for(const [name,bytes] of inputs){const response=await app.request('/assets?name='+name,{method:'POST',body:new Uint8Array(bytes)});assert.equal(response.status,201,await response.clone().text());const metadata=await response.json() as AssetInfo;uploads.push(metadata);assert.equal(metadata.sha256,createHash('sha256').update(bytes).digest('hex'));}
  await core.close();core=await Core.open({dataDir:directory,memoryEnabled:false});configure();app=authenticatedApp(core);
  for(let index=0;index<inputs.length;index++){const downloaded=await app.request('/assets/'+uploads[index]!.id);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),inputs[index]![1]);}
  const response=await app.request('/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'Read these documents.',attachments:uploads.map(item=>item.id)})});assert.equal(response.status,202);const receipt=await response.json() as {id:string;runId:string};assert.equal((await finished(core,receipt.runId))?.status,'succeeded');
  const text=JSON.stringify(seen?.messages);assert.match(text,/external-attachment-data/);assert.match(text,/Synthetic 中文 document/);assert.match(text,/Synthetic PDF violet-17/);assert.doesNotMatch(text,/HIDDEN_CANARY/);
  for(const upload of uploads)assert.ok(text.includes(upload.id)&&text.includes(upload.sha256));
 }finally{await core.close();await removeTemp(directory);}
});

test('document attachment paging and extraction failure preserve accessible source bytes',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-assets-document-pages-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  const app=authenticatedApp(core);const notebook=JSON.stringify({nbformat:4,cells:[{cell_type:'markdown',source:Array.from({length:2500},(_,index)=>`Line ${index+1}\n`)}]});
  const upload=await(await app.request('/assets?name=large.ipynb',{method:'POST',body:notebook})).json() as AssetInfo;
  const first=await core.assets.readAttachment(upload.id,{limit:2000});assert.equal(first.complete,false);assert.ok('nextOffset'in first&&typeof first.nextOffset==='number');
  const second=await core.assets.readAttachment(upload.id,{offset:first.nextOffset,limit:2000});assert.match(second.content,/Line 2500/);
  const malformed=Buffer.from('%PDF-1.7\nnot a valid document\n');const response=await app.request('/assets?name=malformed.pdf',{method:'POST',body:malformed});assert.equal(response.status,201);const metadata=await response.json() as AssetInfo;
  const failed=await core.assets.readAttachment(metadata.id);assert.ok('status'in failed);assert.equal(failed.status,'extraction-failed');assert.equal(failed.complete,false);
  const raw=await core.assets.readAttachment(metadata.id,{encoding:'base64'});assert.equal(raw.representation,'base64');assert.deepEqual(Buffer.from(raw.content,'base64'),malformed);assert.equal(raw.source.sha256,metadata.sha256);
  const content=await core.assets.contents('Read supplied file.',[metadata.id]);assert.match(JSON.stringify(content),/extraction-failed/);
 }finally{await core.close();await removeTemp(directory);}
});
