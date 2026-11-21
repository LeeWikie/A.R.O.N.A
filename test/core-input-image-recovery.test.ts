import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {fauxAssistantMessage,fauxProvider} from '@earendil-works/pi-ai';
import {Core} from '../src/core.js';
import {processInputImage} from '../src/input-images.js';
import {syntheticPng} from './fixtures/png.js';
import {hasNativeImage} from './fixtures/model-images.js';
import {finished,removeTemp,until} from './helpers.js';

function response(ask=false){return{stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(ask)controller.enqueue({type:'tool-call',toolCallId:'original-image-question',toolName:'ask_user',input:JSON.stringify({question:'Continue with the original image?',options:[{label:'Continue'}]})});controller.enqueue({type:'finish',finishReason:ask?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};}

for(const mutation of['none','policy','missing']as const)test(`a native image question retains its sealed input across cold recovery (${mutation})`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-image-recovery-')),image=syntheticPng(32,16),prompts:unknown[]=[];let calls=0,core!:Core;
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(request.prompt);calls++;assert.ok(hasNativeImage(request.prompt,image));return response(calls===1);}}),options={dataDir:directory,model,memoryEnabled:false};
 try{
  core=await Core.open(options);const asset=await core.assets.put(new Response(new Uint8Array(image)).body,'original.png'),input=await core.submitMessage({content:'ORIGINAL_IMAGE_RECOVERY_SOURCE',attachments:[asset.id]}),gate=await until(()=>core.interactions().find(row=>row.status==='pending'),Boolean);assert.ok(gate);await until(()=>core.runtime.setting(`run-recovery:${input.runId}`,null),Boolean);
  const key=`input-image-policy:${input.id}`,policy=core.runtime.setting<{value:{policy:unknown};digest:string}|null>(key,null),seal=core.runtime.setting<{imagePolicyHash?:string}>(`run-recovery:${input.runId}`,{}),nativeKey=`session-native-input:${input.runId}:${input.nativeSignalId}`,native=core.runtime.setting(nativeKey,null);assert.ok(policy);assert.match(seal.imagePolicyHash??'',/^[a-f0-9]{64}$/);await core.close();
  if(mutation!=='none'){const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{if(mutation==='missing')db.prepare('DELETE FROM runtime_settings WHERE id=?').run(key);else{const row=db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(key);assert.ok(row);const saved=JSON.parse(String(row.body))as typeof policy;assert.ok(saved);saved.value.policy={supportsImages:false};db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(saved),key);}}finally{db.close();}}
  core=await Core.open(options);assert.equal(calls,1,'opening never replays the image input');assert.deepEqual(core.runtime.setting(nativeKey,null),native,'the original native source proof is unchanged');
  if(mutation==='none'){assert.equal(core.interactions().find(row=>row.id===gate.id)?.status,'pending');assert.deepEqual(core.runtime.setting(key,null),policy);await core.answerInteraction(gate.id,gate.runId,'Continue');assert.equal((await finished(core,input.runId!))!.status,'succeeded');assert.equal(calls,2);assert.deepEqual((await core.assets.read(asset.id)).bytes,image);}
  else{assert.notEqual(core.interactions().find(row=>row.id===gate.id)?.status,'pending');const failures=core.store.db.prepare("SELECT data FROM runtime_events WHERE run_id=? AND kind='run_recovery_unavailable' ORDER BY seq DESC").all(input.runId!);assert.ok(failures.some(row=>JSON.parse(String(row.data)).code===(mutation==='policy'?'session_recovery_image_source_changed':'run_recovery_image_policy_changed')));assert.equal(prompts.length,1);}
 }finally{if(core)await core.close();await removeTemp(directory);}
});

test('a recovery projection uses the original sealed resize policy after the selected model changes',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-image-projection-')),provider=fauxProvider({provider:'synthetic-recovered-image',models:[{id:'vision',input:['text','image'],inputLimits:{images:{resize:{maxWidth:8,maxHeight:8}}}},{id:'text',input:['text']}]}),core=await Core.open({dataDir:directory,memoryEnabled:false}),original=syntheticPng(32,16);provider.setResponses([fauxAssistantMessage('Observed original image.')]);core.providerRegistry.setProvider(provider.provider);core.models.save({id:'default',name:'Vision',providerId:provider.provider.id,modelId:'vision'});
 try{const asset=await core.assets.put(new Response(new Uint8Array(original)).body,'original.png'),receipt=await core.submitMessage({content:'ORIGINAL_RESIZED_SOURCE',attachments:[asset.id]});await finished(core,receipt.runId!);const source=core.store.getSignal(receipt.id);assert.ok(source);const before=core.runtime.setting(`input-image-policy:${source.id}`,null);assert.ok(before);const expected=await processInputImage(original,'image/png',{resizeOptions:{maxWidth:8,maxHeight:8}});assert.ok(expected.ok);const expectedBytes=Buffer.from(expected.data,'base64');provider.getModel('vision')!.inputLimits!.images!.resize!.maxWidth=2;provider.getModel('vision')!.inputLimits!.images!.resize!.maxHeight=2;core.models.save({id:'default',name:'Text',providerId:provider.provider.id,modelId:'text'});
  const recovered=await Reflect.get(core,'recoveredSignalMessage').call(core,source,'derived-recovered-source',true);assert.ok(hasNativeImage([recovered],expectedBytes),'the recovered native file is the sealed 8x4 input, not a current profile guess');assert.deepEqual(core.runtime.setting(`input-image-policy:${source.id}`,null),before);assert.deepEqual((await core.assets.read(asset.id)).bytes,original);core.runtime.setSetting(`message-context:${source.id}`,{contextId:source.contextId,content:'CHANGED_HOST_MATERIAL'});await assert.rejects(Reflect.get(core,'recoveredSignalMessage').call(core,source,'derived-invalid-source',true),/session_recovery_image_source_changed/);
 }finally{await core.close();await removeTemp(directory);}
});
