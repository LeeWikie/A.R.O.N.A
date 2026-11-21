import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {serve} from '@hono/node-server';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,type TranscriptContext} from '@earendil-works/pi-ai';
import type {Component,Terminal} from '@earendil-works/pi-tui';
import {Core} from '../src/core.js';
import {Client} from '../src/client.js';
import {createApp} from '../src/http.js';
import {TerminalApp} from '../src/tui/index.js';
import {syntheticPng} from './fixtures/png.js';
import {finished,removeTemp,until} from './helpers.js';

class Screen implements Terminal{columns=100;rows=30;kittyProtocolActive=false;start(){}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}}
type Card={data:{toolName:string;state:string;resultEventSeq?:number;resultEntryId?:string;resultContent?:Array<{type:'text';text:string}|{type:'image';data:string;mimeType:string}>};region:Component;setExpanded(value:boolean):void};
type UI={contextReady:boolean;started:boolean;generation:number;toolCards:Map<string,Card>;loadContext(generation:number):Promise<void>};
function objects(input:unknown):Record<string,unknown>[]{const rows:Record<string,unknown>[]=[],seen=new Set<object>();const visit=(value:unknown)=>{if(typeof value==='string'){try{visit(JSON.parse(value));}catch{}return;}if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);if(Array.isArray(value)){for(const item of value)visit(item);return;}rows.push(value as Record<string,unknown>);for(const item of Object.values(value))visit(item);};visit(input);return rows;}

test('an authorized Main attachment image is visible through actual SSE while the next model request remains held, before graph completion',{timeout:30000},async()=>{
 const descriptors=[Object.getOwnPropertyDescriptor(process.stdin,'isTTY'),Object.getOwnPropertyDescriptor(process.stdout,'isTTY')];for(const stream of[process.stdin,process.stdout])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tui-attachment-image-')),core=await Core.open({dataDir:directory,memoryEnabled:false}),original=syntheticPng(32,16),provider=fauxProvider({provider:'synthetic-tui-attachment-image',models:[{id:'vision',input:['text','image'],inputLimits:{images:{resize:{maxWidth:8,maxHeight:8}}}}]});let reviewing=false,phase=0,held=false,imageData='',release!:()=>void,modelError:unknown;const gate=new Promise<void>(resolve=>{release=resolve;});let app:TerminalApp|undefined,running:Promise<void>|undefined;
 provider.setResponses(Array.from({length:10},()=>async(context:TranscriptContext)=>{try{
  if(!reviewing)return fauxAssistantMessage('Original input retained.');const source=core.store.db.prepare("SELECT id FROM signals WHERE status='accepted' AND json_extract(body,'$.contextId')='main' ORDER BY rowid DESC LIMIT 1").get();assert.ok(source);const signalIds=[String(source.id)];
  if(phase++===0)return fauxAssistantMessage(fauxToolCall('list_attachments',{signalIds},{id:'discover-old-image'}),{stopReason:'toolUse'});
  if(phase===2){const catalog=objects(context.messages).find(row=>Array.isArray(row.attachments)&&row.attachments.some(value=>value&&typeof value==='object'&&'mediaType'in value&&value.mediaType==='image/png'));assert.ok(catalog);const image=(catalog.attachments as Array<Record<string,unknown>>).find(row=>row.mediaType==='image/png');assert.ok(image&&typeof image.id==='string');return fauxAssistantMessage(fauxToolCall('read_attachment',{signalIds,id:image.id},{id:'view-old-image'}),{stopReason:'toolUse'});}
  const image=context.messages.flatMap(row=>row.role==='toolResult'?row.content.filter(part=>part.type==='image'):[]).at(-1);assert.ok(image&&image.type==='image');const bytes=Buffer.from(image.data,'base64');assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[8,4]);imageData=image.data;held=true;await gate;return fauxAssistantMessage('Read the original image.');
 }catch(error){modelError=error;throw error;}}));core.providerRegistry.setProvider(provider.provider);core.models.save({id:'default',name:'Vision',providerId:provider.provider.id,modelId:'vision'});const server=serve({hostname:'127.0.0.1',port:0,fetch:createApp(core).fetch});if(!server.listening)await once(server,'listening');
 try{
  const asset=await core.assets.put(new Response(new Uint8Array(original)).body,'original.png'),first=await core.submitMessage({content:'ORIGINAL_IMAGE_BEFORE_COMPACTION',attachments:[asset.id]});await finished(core,first.runId!);const kept=await core.submitMessage({content:'KEEP_RECENT_CONTEXT'});await finished(core,kept.runId!);const entry=core.sessionGraph.records('main').find(row=>row.source?.messageId===kept.nativeSignalId);assert.ok(entry);const manager=core.sessionGraph.manager('main'),id=manager.appendCompaction('An earlier original image was summarized.',entry.entry.id,1000),compaction=manager.getEntry(id);assert.ok(compaction);core.sessionGraph.append('main',[{entry:compaction}],core.sessionGraph.head('main')!.revision);
  const client=new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,core.controlToken);app=new TerminalApp(client,'main',new Screen());const ui=app as unknown as UI;running=app.run();await until(()=>ui.contextReady&&ui.started,Boolean);reviewing=true;const input=await client.request<{runId:string}>('/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'View the retained original image through its attachment directory.'})});await until(()=>{if(modelError)throw modelError;return held;},Boolean);assert.equal(core.store.getRun(input.runId)!.status,'running');
  assert.ok(imageData);assert.notEqual(imageData,original.toString('base64'));const card=await until(()=>[...ui.toolCards.values()].find(card=>card.data.toolName==='read_attachment'&&card.data.resultContent?.some(part=>part.type==='image'&&part.data===imageData)),Boolean);assert.ok(card);assert.equal(card.data.state,'finished');assert.ok(card.data.resultEventSeq);assert.equal(card.data.resultEntryId,undefined,'the durable result is visible before this run has graph entries');assert.match(card.region.render(100).join('\n'),/工具图片/);assert.equal(card.region.render(100).join('\n').includes(imageData),false);assert.equal(card.region.render(100).join('\n').includes(original.toString('base64')),false);card.setExpanded(true);assert.match(card.region.render(100).join('\n'),/工具图片/);
  release();assert.equal((await finished(core,input.runId))!.status,'succeeded');await ui.loadContext(ui.generation);const restored=[...ui.toolCards.values()].find(card=>card.data.toolName==='read_attachment');assert.ok(restored?.data.resultContent?.some(part=>part.type==='image'&&part.data===imageData));assert.equal(core.runtime.approvals().length,0);assert.deepEqual((await core.assets.read(asset.id)).bytes,original);
 }finally{release();await app?.stop();await running;if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);for(const[index,stream]of[process.stdin,process.stdout].entries()){const descriptor=descriptors[index];if(descriptor)Object.defineProperty(stream,'isTTY',descriptor);else delete(stream as {isTTY?:boolean}).isTTY;}}
});
