import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {fauxAssistantMessage,fauxProvider,fauxToolCall,type TranscriptContext} from '@earendil-works/pi-ai';
import {getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {Core} from '../src/core.js';
import {syntheticPng} from './fixtures/png.js';
import {finished,removeTemp,until} from './helpers.js';

function pageResult(value:unknown):{next:{index:number;offset:number}|null}|undefined{
 if(typeof value==='string'){try{return pageResult(JSON.parse(value));}catch{return;}}
 if(!value||typeof value!=='object')return;
 if('source'in value&&'parts'in value&&Array.isArray(value.parts)&&'next'in value)return value as {next:{index:number;offset:number}|null};
 for(const child of Object.values(value)){const result=pageResult(child);if(result)return result;}
}
const imageDimensions=(context:TranscriptContext)=>context.messages.flatMap(row=>{
 if(row.role==='toolResult')return row.content.filter(part=>part.type==='image');
 if(row.role==='user'&&Array.isArray(row.content))return row.content.filter(part=>part.type==='image');
 return[];
}).map(part=>{const bytes=Buffer.from(part.data,'base64');return[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];});

for(const mode of ['inline','paged-cold','text-only']as const)test(`the actual memory organizer uses its frozen image policy for ${mode} evidence without changing source assets`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-memory-image-policy-'));
 let core=await Core.open({dataDir:directory,memoryEnabled:false}),release!:()=>void,entered=false;
 const gate=new Promise<void>(resolve=>{release=resolve;}),provider=fauxProvider({provider:'synthetic-memory-image-policy',models:[
  {id:'vision',input:['text','image'],inputLimits:{images:{resize:{maxWidth:8,maxHeight:8}}}},
  {id:'narrow',input:['text','image'],inputLimits:{images:{resize:{maxWidth:2,maxHeight:2}}}},
  {id:'text',input:['text']},
 ]}),requests:Array<{runId:string;model:string;dimensions:number[][];text:string}>=[],committed=new Set<string>(),listed=new Set<string>();
 provider.setResponses(Array.from({length:50},()=>async(context:TranscriptContext,_options:unknown,_state:unknown,model:{id:string})=>{
  if(!getCurrentTools(context.messages).some(tool=>tool.name==='memory_commit'))return fauxAssistantMessage('The source image is retained.');
  const serialized=JSON.stringify(context.messages),runId=/来源运行是 ([0-9a-f-]{36})/.exec(serialized)?.[1];assert.ok(runId);
  requests.push({runId,model:model.id,dimensions:imageDimensions(context),text:serialized});
  if(!entered){entered=true;await gate;}
  if(serialized.includes('business-evidence-directory')){
   const result=[...context.messages].reverse().flatMap(row=>row.role==='toolResult'&&row.toolName==='memory_source_page'?[pageResult(row.content)]:[]).find(Boolean);
   if(!result||result.next!==null)return fauxAssistantMessage(fauxToolCall('memory_source_page',result?.next??{index:0,offset:0},{id:`page-${requests.length}`}),{stopReason:'toolUse'});
  }
  else if(!listed.has(runId)){listed.add(runId);return fauxAssistantMessage(fauxToolCall('memory_list',{}, {id:`list-${runId}`}),{stopReason:'toolUse'});}
  if(!committed.has(runId)){committed.add(runId);return fauxAssistantMessage(fauxToolCall('memory_commit',{sourceRunId:runId,note:'Checked the original source images.'},{id:`commit-${runId}`}),{stopReason:'toolUse'});}
  return fauxAssistantMessage('The source evidence was checked.');
 }));
 const register=()=>{core.providerRegistry.setProvider(provider.provider);core.models.save({id:'default',name:'Source',providerId:provider.provider.id,modelId:'vision'});core.models.save({id:'memory',name:'Organizer',providerId:provider.provider.id,modelId:mode==='text-only'?'text':'vision'});core.configure('runtime',{memoryModel:'memory'});};
 register();
 try{
  const originals=[syntheticPng(32,16),syntheticPng(16,32,160)],assets=[];
  for(const[index,bytes]of originals.entries())assets.push(await core.assets.put(new Response(new Uint8Array(bytes)).body,`original-${index}.png`));
  const source=await core.submitMessage({content:'ORIGINAL_IMAGE_BUSINESS_EVIDENCE\n'+(mode==='paged-cold'?'原始经历及事实条件。\n'.repeat(2500):'The user supplied these images.'),attachments:mode==='paged-cold'?[assets[0]!.id,assets[1]!.id,assets[0]!.id]:[assets[0]!.id]});
  assert.equal((await finished(core,source.runId!))!.status,'succeeded');
  const snapshot=core.projectMemory.snapshot(source.runId!),snapshotHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if(mode==='paged-cold'){await core.close();core=await Core.open({dataDir:directory,memoryEnabled:false});register();}
  const job=await core.queueMemory(source.runId!);await until(()=>entered,Boolean);
  core.models.save({id:'memory',name:'Organizer',providerId:provider.provider.id,modelId:'narrow'});release();
  const settled=await until(()=>core.projectMemory.jobs().find(row=>row.id===job.id)!,row=>!['pending','running'].includes(row.status));
  assert.equal(settled.status,'succeeded',settled.error??undefined);assert.ok(requests.length>=2);
  assert.ok(requests.every(row=>row.model===(mode==='text-only'?'text':'vision')),'changing configuration during organization cannot change its admitted model');
  if(mode==='text-only'){assert.ok(requests.every(row=>row.dimensions.length===0));assert.ok(requests.some(row=>row.text.includes('selected model does not support images')));}
  else{const withImages=requests.filter(row=>row.dimensions.length),expected=mode==='paged-cold'?[[8,4],[4,8],[8,4]]:[[8,4]];assert.ok(withImages.length);for(const row of withImages)assert.deepEqual(row.dimensions,expected.slice(0,row.dimensions.length));assert.deepEqual(withImages.at(-1)!.dimensions,expected);}
  if(mode==='inline')assert.ok(requests.every(row=>!row.text.includes('business-evidence-directory')),'the small source exercises the actual inline branch');
  if(mode==='paged-cold')assert.ok(requests.some(row=>row.text.includes('business-evidence-directory')));
  assert.equal(createHash('sha256').update(JSON.stringify(core.projectMemory.snapshot(source.runId!))).digest('hex'),snapshotHash);
  for(const[index,asset]of assets.entries()){const original=await core.assets.read(asset.id);assert.deepEqual(original.bytes,originals[index]);assert.equal(original.metadata.sha256,createHash('sha256').update(originals[index]!).digest('hex'));}
 }finally{release();await core.close();await removeTemp(directory);}
});
