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
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=','base64');

test('authenticated raw uploads retain bytes and reach the native provider as image content',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-assets-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});let seen:TranscriptContext|undefined;
 try{
  const fake=fauxProvider({provider:'image-fixture',models:[{id:'vision',input:['text','image']}]});fake.setResponses([(context)=>{seen=context;return fauxAssistantMessage('image received');}]);core.providerRegistry.setProvider(fake.provider);
  core.models.save({id:'default',name:'Vision',providerId:'image-fixture',modelId:'vision'});
  const app=authenticatedApp(core);
  const upload=await app.request('/assets?name=synthetic.png',{method:'POST',body:png});assert.equal(upload.status,201);
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
