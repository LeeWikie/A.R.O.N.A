import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fauxAssistantMessage,fauxProvider,type TranscriptContext} from '@earendil-works/pi-ai';
import {Core} from '../src/core.js';
import {processInputImage} from '../src/input-images.js';
import {syntheticPng} from './fixtures/png.js';
import {hasNativeImage} from './fixtures/model-images.js';
import {authenticatedApp,finished,removeTemp} from './helpers.js';

for(const mode of['active','omitted','compacted']as const)test(`a missing historical image original respects the effective model branch after ${mode} history without reviving its source`,async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-image-effective-')),provider=fauxProvider({provider:'synthetic-effective-image',models:[{id:'vision',input:['text','image'],inputLimits:{images:{resize:{maxWidth:8,maxHeight:8}}}}]}),prompts:TranscriptContext[]=[];
 provider.setResponses(Array.from({length:15},()=>async(context:TranscriptContext)=>{prompts.push(context);return fauxAssistantMessage('Image history acknowledged.');}));let core=await Core.open({dataDir:directory,memoryEnabled:false});const register=()=>{core.providerRegistry.setProvider(provider.provider);core.models.save({id:'default',name:'Vision',providerId:provider.provider.id,modelId:'vision'});};register();
 try{
  const original=syntheticPng(32,16),asset=await core.assets.put(new Response(new Uint8Array(original)).body,'original.png'),source=await core.submitMessage({content:'ORIGINAL_IMAGE_INPUT_MARKER',attachments:[asset.id]});await finished(core,source.runId!);const kept=await core.submitMessage({content:'KEPT_RECENT_INPUT'});await finished(core,kept.runId!);const records=core.sessionGraph.records('main'),originalEntry=records.find(row=>row.source?.messageId===source.nativeSignalId),keptEntry=records.find(row=>row.source?.messageId===kept.nativeSignalId);assert.ok(originalEntry&&keptEntry);const processed=await processInputImage(original,'image/png',{resizeOptions:{maxWidth:8,maxHeight:8}});assert.ok(processed.ok);assert.ok(hasNativeImage(core.sessionGraph.sources('main'),Buffer.from(processed.data,'base64')),'the actual normalized native image is still sealed in its original source');
  if(mode!=='active'){const manager=core.sessionGraph.manager('main'),entryId=mode==='omitted'?manager.appendContextEdit(originalEntry.entry.id,null):manager.appendCompaction('Earlier context was summarized.',keptEntry.entry.id,500),entry=manager.getEntry(entryId);assert.ok(entry);core.sessionGraph.append('main',[{entry}],core.sessionGraph.head('main')!.revision);}
  fs.unlinkSync(path.join(directory,'assets',asset.id));await core.close();const before=prompts.length;core=await Core.open({dataDir:directory,memoryEnabled:false});register();assert.equal(prompts.length,before,'opening the Core does not re-execute a historical input');const app=authenticatedApp(core),state=await(await app.request('/contexts/main/model')).json()as{unavailable?:string};const response=await app.request('/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contextId:'main',content:'CONTINUE_CURRENT_EFFECTIVE_HISTORY'})});
  if(mode==='active'){assert.equal(state.unavailable,'session_recovery_attachment_unavailable');assert.equal(response.status,409);assert.equal(prompts.length,before);}
  else{assert.equal(state.unavailable,null,'omitted or compaction-covered data is not required by the effective model input');assert.equal(response.status,202,await response.clone().text());const signal=await response.json()as{runId:string};assert.equal((await finished(core,signal.runId))!.status,'succeeded');assert.equal(prompts.length,before+1);assert.equal(JSON.stringify(prompts.at(-1)).includes('ORIGINAL_IMAGE_INPUT_MARKER'),false);assert.equal(prompts.at(-1)!.messages.some(row=>row.role==='user'&&Array.isArray(row.content)&&row.content.some(part=>part.type==='image')),false);}
  assert.ok(hasNativeImage(core.sessionGraph.sources('main'),Buffer.from(processed.data,'base64')),'no old raw/source image is deleted to change visibility');
 }finally{await core.close();await removeTemp(directory);}
});
