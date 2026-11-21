import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getEncoding} from 'js-tiktoken';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,type TranscriptContext} from '@earendil-works/pi-ai';
import {getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {Core} from '../src/core.js';
import type {AssetInfo} from '../src/assets.js';
import {syntheticPng} from './fixtures/png.js';
import {finished,until,removeTemp} from './helpers.js';

function sourcePage(value:unknown):{parts:unknown[];next:{index:number;offset:number}|null}|undefined{
 if(typeof value==='string'){try{return sourcePage(JSON.parse(value));}catch{return;}}
 if(!value||typeof value!=='object')return;if('source'in value&&'parts'in value&&Array.isArray(value.parts)&&'next'in value)return value as {parts:unknown[];next:{index:number;offset:number}|null};
 for(const child of Object.values(value)){const result=sourcePage(child);if(result)return result;}
}
test('the native memory worker reads every ordered original image across bounded pages and compaction without a growing media prefix',{timeout:60000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-memory-media-continuous-')),core=await Core.open({dataDir:directory,memoryEnabled:false}),encoding=getEncoding('o200k_base'),provider=fauxProvider({provider:'synthetic-memory-media-continuous',models:[{id:'source',input:['text','image'],contextWindow:1000000,maxTokens:8192,inputLimits:{images:{resize:{maxWidth:8,maxHeight:8}}}},{id:'organizer',input:['text','image'],contextWindow:40000,maxTokens:8192,inputLimits:{images:{resize:{maxWidth:8,maxHeight:8}}}}]});
 let sourceRunId='',calls=0,summaries=0,initialized=false,written=false,maxInput=0,providerError:unknown;const received:number[][]=[],seen=new Set<string>(),tail='<!-- next observed image -->';
 provider.setResponses(Array.from({length:150},()=>async(context:TranscriptContext,_options:unknown,_state:unknown,model:{id:string})=>{
  try{
  if(model.id==='source')return fauxAssistantMessage('The original image sequence is retained.');
  calls++;const media=context.messages.flatMap(row=>{if(row.role==='user'&&Array.isArray(row.content))return row.content.filter(part=>part.type==='image');if(row.role==='toolResult')return row.content.filter(part=>part.type==='image');return[];}),tokens=encoding.encode(JSON.stringify(context.messages)).length+media.length*4096;maxInput=Math.max(maxInput,tokens);assert.ok(tokens<40000,`the selected provider enforces its actual media and text budget: ${tokens} tokens, ${media.length} images`);
  if(!getCurrentTools(context.messages).some(tool=>tool.name==='memory_commit')){summaries++;return fauxAssistantMessage('Continue reading the complete original image sequence with the current source-page cursor. Preserve duplicates and original order.');}
  if(!initialized){initialized=true;return fauxAssistantMessage(fauxToolCall('memory_write',{path:'images.md',content:'# Original user images\n'+tail},{id:'initialize-image-observations'}),{stopReason:'toolUse'});}
  for(const row of context.messages){if(row.role!=='toolResult'||row.toolName!=='memory_source_page'||seen.has(row.toolCallId))continue;seen.add(row.toolCallId);for(const part of row.content)if(part.type==='image'){const bytes=Buffer.from(part.data,'base64');received.push([bytes.readUInt32BE(16),bytes.readUInt32BE(20)]);}}
  const latestTool=context.messages.findLast(row=>row.role==='toolResult');
  if(latestTool?.role==='toolResult'&&latestTool.toolName==='memory_source_page'){
   const observations=latestTool.content.flatMap(part=>{if(part.type!=='image')return[];const bytes=Buffer.from(part.data,'base64');return[`Observed original image ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}.\n`];});
   if(observations.length)return fauxAssistantMessage(fauxToolCall('memory_edit',{path:'images.md',oldText:tail,newText:observations.join('')+tail},{id:`retain-image-observations-${calls}`}),{stopReason:'toolUse'});
  }
  const latest=[...context.messages].reverse().flatMap(row=>row.role==='toolResult'&&row.toolName==='memory_source_page'?[sourcePage(row.content)]:[]).find(Boolean);
  if(!latest||latest.next!==null)return fauxAssistantMessage(fauxToolCall('memory_source_page',latest?.next??{index:0,offset:0},{id:`media-page-${calls}`}),{stopReason:'toolUse'});
  if(!written){assert.equal(received.length,20);written=true;return fauxAssistantMessage(fauxToolCall('memory_edit',{path:'images.md',oldText:tail,newText:'Checked every one of the 20 user images, including original repeated references and their order.'},{id:'finish-image-facts'}),{stopReason:'toolUse'});}
  return fauxAssistantMessage(fauxToolCall('memory_commit',{sourceRunId,note:'Checked the complete original image sequence.'},{id:'commit-image-source'}),{stopReason:'toolUse'});
  }catch(error){providerError=error;throw error;}
 }));
 core.providerRegistry.setProvider(provider.provider);core.models.save({id:'default',name:'Source',providerId:provider.provider.id,modelId:'source'});core.models.save({id:'memory-images',name:'Organizer',providerId:provider.provider.id,modelId:'organizer'});core.configure('runtime',{memoryModel:'memory-images'});
 try{
  const originals=[syntheticPng(32,16),syntheticPng(16,32,160),syntheticPng(32,32,220)],assets:AssetInfo[]=[];for(const[index,bytes]of originals.entries())assets.push(await core.assets.put(new Response(new Uint8Array(bytes)).body,`original-${index}.png`));
  const ids=Array.from({length:20},(_,index)=>assets[index%3]!.id);
  for(let offset=0;offset<ids.length;offset+=8){const receipt=await core.submitMessage({content:`Inspect this next original user image group in its supplied order: ${offset}.`,attachments:ids.slice(offset,offset+8)});sourceRunId=receipt.runId!;assert.equal((await finished(core,sourceRunId))!.status,'succeeded');}
  const before=createHash('sha256').update(JSON.stringify(core.projectMemory.snapshot(sourceRunId))).digest('hex'),job=await core.queueMemory(sourceRunId),done=await until(()=>{if(providerError)throw providerError;return core.projectMemory.jobs().find(row=>row.id===job.id)!;},row=>!['pending','running'].includes(row.status));
  assert.equal(done.status,'succeeded',done.error??undefined);assert.deepEqual(received,Array.from({length:20},(_,index)=>[[8,4],[4,8],[8,8]][index%3]));assert.ok(summaries>=2);assert.ok(maxInput<40000);assert.equal(createHash('sha256').update(JSON.stringify(core.projectMemory.snapshot(sourceRunId))).digest('hex'),before);
  for(const[index,asset]of assets.entries())assert.deepEqual((await core.assets.read(asset.id)).bytes,originals[index]);const saved=fs.readFileSync(path.join(core.projectMemory.version().filesDirectory,'images.md'),'utf8');assert.match(saved,/20 user images/);assert.deepEqual([...saved.matchAll(/Observed original image (\d+)x(\d+)\./g)].map(match=>[Number(match[1]),Number(match[2])]),Array.from({length:20},(_,index)=>[[8,4],[4,8],[8,8]][index%3]));
 }finally{await core.close();await removeTemp(directory);}
});
