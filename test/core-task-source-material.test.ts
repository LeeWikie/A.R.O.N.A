import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {splitQueueText} from '../src/queue-content.js';
import {finished,removeTemp,until} from './helpers.js';

import {syntheticPng} from './fixtures/png.js';
import {hasNativeImage} from './fixtures/model-images.js';
const png=syntheticPng(1,1);
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function response(name?:string,input?:unknown){return{stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(name)controller.enqueue({type:'tool-call',toolCallId:randomUUID(),toolName:name,input:JSON.stringify(input)});controller.enqueue({type:'finish',finishReason:name?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};}

test('delegation retains complete grouped source text and nine attachments through a native question and cold resume',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-task-material-'));let core!:Core,phase=0,workerCalls=0,mainCalls=0,error:unknown;const prompts:string[]=[],sources:string[]=[];
  const raw='SYNTHETIC_LONG_SOURCE_START\n'+'甲'.repeat(63000)+'SYNTHETIC_SOURCE_MIDDLE_A😀'+'乙'.repeat(63000)+'SYNTHETIC_SOURCE_MIDDLE_B😀'+'丙'.repeat(24000)+'\nSYNTHETIC_LONG_SOURCE_END',parts=splitQueueText(raw),assets:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
    const prompt=JSON.stringify(request.prompt);if(!request.tools?.some(tool=>tool.name==='task_report')){mainCalls++;return mainCalls===1?response('task_create',{task:{title:'Inspect original input',content:'Inspect all original text and files, ask once, then report.'}}):response();}
    workerCalls++;prompts.push(prompt);const text=request.prompt.map(message=>typeof message.content==='string'?message.content:message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')).join('\n');for(const part of parts)assert.equal(text.split(part).length-1,1);for(let index=0;index<8;index++)assert.equal(text.split(`SYNTHETIC_ATTACHMENT_${index}`).length-1,1);assert.ok(hasNativeImage(request.prompt,png),'the original image stays in the native image/file lane');
    const task=core.runtime.tasks()[0]!;if(phase===0)return response('ask_user',{question:'Continue the synthetic inspection?',options:[{label:'Continue'},{label:'Stop'}]});
    if(!task.report)return response('task_report',{id:task.id,report:{outcome:'succeeded',summary:'All original data was preserved.',checks:[{description:'Verified complete original text and all nine attachments.',passed:true}],deliveries:[],unresolved:[]}});return response();
  }catch(caught){error=caught;throw caught;}}});
  const options={dataDir:directory,model,memoryEnabled:false,modelConfig:{protocol:'responses' as const,baseURL:'https://synthetic.invalid/v1',apiKey:'synthetic',authHeader:'bearer' as const,modelId:'source-material',contextWindow:512000,maxTokens:1024}};
  try{
    core=await Core.open(options);for(let index=0;index<8;index++)assets.push((await core.assets.put(new Response(`SYNTHETIC_ATTACHMENT_${index}`).body,`source-${index}.txt`)).id);assets.push((await core.assets.put(new Response(new Uint8Array(png)).body,'original.png')).id);
    const draft=core.queueEditor().create('main',{captureQueue:false,localCapture:true,current:{clientDraftId:randomUUID(),content:'placeholder',attachments:[]}},'create'),entry=core.queueEditor().page('main',draft.id).entries[0]!;
    const upload=core.queueEditor().beginEntryEdit('main',draft.id,{entryId:entry.id,expectedRevision:draft.revision,partCount:parts.length,characters:raw.length,hash:hash(raw),attachments:assets},'parts');for(const[index,content]of parts.entries())core.queueEditor().writeEntryPart('main',draft.id,upload.id,index,{content});const committed=core.queueEditor().commitEntryEdit('main',draft.id,upload.id);
    const submitted=await core.queueEditor().submit('main',draft.id,{expectedRevision:committed.revision},'submit');sources.push(...submitted.submission!.entries.map(entry=>entry.signalId));
    const gate=await until(()=>{if(error)throw error;return core.interactions().find(item=>item.status==='pending');},Boolean);const task=await until(()=>core.runtime.tasks()[0],task=>task?.status==='waiting');assert.ok(task);await until(()=>core.runtime.setting(`run-recovery:${gate!.runId}`,null),Boolean);
    const signal=core.store.getSignal(task.signalId)!;assert.ok(signal.content.length<10000,'transport metadata does not duplicate complete user text');assert.deepEqual(task.sourceSignalIds,sources);assert.deepEqual(task.grants,{write:false,execute:false,mcp:false});assert.equal(core.runtime.approvals().length,0);assert.equal(workerCalls,1);
    const originalBodies=sources.map(id=>String(core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(id)!.body));await core.close();phase=1;workerCalls=0;core=await Core.open(options);assert.equal(workerCalls,0,'opening the Core does not execute the suspended task');assert.deepEqual(sources.map(id=>String(core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(id)!.body)),originalBodies);
    assert.equal(core.interactions().find(item=>item.id===gate!.id)?.status,'pending');await core.answerInteraction(gate!.id,gate!.runId,'Continue');await until(()=>{if(error)throw error;return core.runtime.task(task.id);},task=>task.status==='succeeded');assert.equal(core.runtime.task(task.id).runIds.length,1);assert.equal(core.runtime.approvals().length,0);assert.ok(prompts.length>=3);
  }finally{if(core)await core.close();await removeTemp(directory);}
});

for(const changed of ['source-body','native-event','proof'] as const)test(`delegation rejects a changed ${changed} before any worker model request`,{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-task-material-proof-'));let core!:Core,workerCalls=0,mainCalls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    if(request.tools?.some(tool=>tool.name==='task_report')){workerCalls++;return response();}
    if(mainCalls++>0)return response();
    const row=core.store.db.prepare("SELECT id,body,run_id,native_id FROM signals WHERE json_extract(body,'$.contextId')='main' ORDER BY rowid DESC LIMIT 1").get()!;
    if(changed==='source-body'){const body=JSON.parse(String(row.body));body.content+='SYNTHETIC_CHANGED_SOURCE';core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(body),String(row.id));}
    else if(changed==='native-event'){const event=core.store.db.prepare("SELECT seq,data FROM runtime_events WHERE kind='message_start' AND json_extract(data,'$.message.id')=?").get(String(row.id))!;const data=JSON.parse(String(event.data));data.message.content.parts[0].data.contents+='SYNTHETIC_CHANGED_NATIVE_INPUT';core.store.db.prepare('UPDATE runtime_events SET data=? WHERE seq=?').run(JSON.stringify(data),Number(event.seq));}
    else{const key=`session-native-input:${row.run_id}:${row.native_id}`,proof=core.runtime.setting<Record<string,unknown>>(key,{});core.runtime.setSetting(key,{...proof,digest:'0'.repeat(64)});}
    return response('task_create',{task:{title:'Inspect a source',content:'Read the actual original source data.'}});
  }});
  try{core=await Core.open({dataDir:directory,model,memoryEnabled:false});await core.submitMessage({content:'SYNTHETIC_ORIGINAL_SOURCE'});const task=await until(()=>core.runtime.tasks()[0],task=>task?.status==='failed');assert.ok(task);assert.equal(workerCalls,0);assert.equal(task.report,null);assert.equal(core.runtime.approvals().length,0);assert.equal(core.taskDetails(task.id).status,'failed');assert.ok(core.store.getSignal(task.sourceSignalIds[0]!));}finally{if(core)await core.close();await removeTemp(directory);}
});

test('a hard restart keeps complete delegated source data and resumes its exact native run without automatic execution',{timeout:40000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-task-material-crash-'));const children:ChildProcess[]=[];
  type Inspection={type:string;workerCalls:number;task:{id:string;status:string;runIds:string[];grants:unknown};sourceBodies:string[];proof:boolean;message?:string};
  async function launch(mode:string){const child=fork(fileURLToPath(new URL('./task-source-material-fixture.ts',import.meta.url)),[directory,mode],{execArgv:['--expose-gc','--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});children.push(child);const messages:Inspection[]=[];let output='';child.stdout?.on('data',data=>{output=(output+String(data)).slice(-4000);});child.stderr?.on('data',data=>{output=(output+String(data)).slice(-4000);});child.on('message',value=>{messages.push(value as Inspection);});const ready=await until(()=>{const error=messages.find(message=>message.type==='error');if(error)throw Error(error.message);if(child.exitCode!==null||child.signalCode!==null)throw Error(output);return messages.find(message=>message.type==='ready');},Boolean);return{child,messages,ready:ready!};}
  try{const first=await launch('park');assert.equal(first.ready.workerCalls,1);assert.equal(first.ready.task.status,'waiting');const exit=once(first.child,'exit');first.child.kill('SIGKILL');await exit;
    const second=await launch('continue');assert.equal(second.ready.workerCalls,0);assert.equal(second.ready.task.id,first.ready.task.id);assert.deepEqual(second.ready.task.runIds,first.ready.task.runIds);assert.deepEqual(second.ready.sourceBodies,first.ready.sourceBodies);second.child.send({type:'answer'});const complete=await until(()=>{const error=second.messages.find(message=>message.type==='error');if(error)throw Error(error.message);return second.messages.find(message=>message.type==='complete');},Boolean);assert.equal(complete!.task.status,'succeeded');assert.deepEqual(complete!.task.runIds,first.ready.task.runIds);assert.deepEqual(complete!.sourceBodies,first.ready.sourceBodies);assert.deepEqual(complete!.task.grants,{write:false,execute:false,mcp:false});assert.equal(complete!.workerCalls,2);second.child.send({type:'close'});await once(second.child,'exit');
  }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await removeTemp(directory);}
});

for(const delivery of ['pending','active'] as const)test(`a ${delivery} task receives full supplementary input material and can read its original binary attachment`,{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-task-note-'));let core!:Core,release!:()=>void,created=0,noteSent=false,error:unknown,targetId='',binaryId='',read=false,resumed=false;const held=new Promise<void>(resolve=>{release=resolve;}),steps=new Map<string,number>(),bytes=Buffer.from([0,1,2,255,254,83]);
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
    const text=request.prompt.map(message=>typeof message.content==='string'?message.content:message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')).join('\n');
    if(!request.tools?.some(tool=>tool.name==='task_report')){
      if(text.includes('SYNTHETIC_NOTE_CURRENT_INPUT')){if(noteSent)return response();noteSent=true;const row=core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.source')='tui-message' AND json_extract(body,'$.content')='SYNTHETIC_NOTE_CURRENT_INPUT' ORDER BY rowid DESC LIMIT 1").get()!;return response('task_message',{id:targetId,signalIds:[String(row.id)],content:'Inspect the supplementary source material and original binary.'});}
      if(created<(delivery==='pending'?2:1)){created++;return response('task_create',{task:{title:created===1&&delivery==='pending'?'Hold the first task':'Inspect the supplement',content:'Inspect the actual source material.'}});}return response();
    }
    const id=text.match(/task_id="([^"]+)"/)?.[1];assert.ok(id);const task=core.runtime.task(id),step=steps.get(id)??0;steps.set(id,step+1);
    if(task.title==='Hold the first task'||delivery==='active'&&step===0){await held;return response();}
    assert.equal(text.split('SYNTHETIC_NOTE_CURRENT_INPUT').length-1,1);assert.equal(text.split('SYNTHETIC_NOTE_HOST_REFERENCE').length-1,1);assert.equal(text.split('SYNTHETIC_NOTE_TEXT_ATTACHMENT').length-1,1);
    if(!read){read=true;const note=core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.source')=? ORDER BY rowid DESC LIMIT 1").get(`task-supplement:${task.id}`);return response('read_attachment',{id:binaryId,signalIds:[note?String(note.id):task.signalId],encoding:'base64',byteOffset:0,maxBytes:32});}
    assert.ok(JSON.stringify(request.prompt).includes(bytes.toString('base64')));if(!resumed)return response('ask_user',{question:'Continue with the verified supplementary material?',options:[{label:'Continue'}]});if(!task.report)return response('task_report',{id:task.id,report:{outcome:'succeeded',summary:'Verified supplementary original material.',checks:[{description:'Read the exact original binary.',passed:true}],deliveries:[],unresolved:[]}});return response();
  }catch(caught){error=caught;throw caught;}}});
  const options={dataDir:directory,model,memoryEnabled:false,concurrency:1};
  try{core=await Core.open(options);const first=await core.submitMessage({content:'SYNTHETIC_INITIAL_TASK_SOURCE'});await finished(core,first.runId!);const target=await until(()=>core.runtime.tasks().find(task=>task.title==='Inspect the supplement'),Boolean);assert.ok(target);targetId=target.id;await until(()=>core.runtime.task(targetId).status,status=>status===(delivery==='pending'?'pending':'running'));
    const binary=await core.assets.put(new Response(bytes).body,'observation.bin',undefined,{purpose:'client-shell-output'});binaryId=binary.id;const text=await core.assets.put(new Response('SYNTHETIC_NOTE_TEXT_ATTACHMENT').body,'note.txt');const note=await core.submitMessage({content:'SYNTHETIC_NOTE_HOST_REFERENCE\nSYNTHETIC_NOTE_CURRENT_INPUT',sourceText:'SYNTHETIC_NOTE_CURRENT_INPUT',attachments:[binary.id,text.id]});await finished(core,note.runId!);if(error)throw error;release();const gate=await until(()=>{if(error)throw error;return core.interactions().find(item=>item.status==='pending'&&item.contextId===target.contextId);},Boolean);assert.ok(gate);await until(()=>core.runtime.setting(`run-recovery:${gate.runId}`,null),Boolean);const calls=steps.get(targetId);await core.close();resumed=true;core=await Core.open(options);assert.equal(steps.get(targetId),calls,'restart does not replay the attachment read or task');await core.answerInteraction(gate.id,gate.runId,'Continue');await until(()=>{if(error)throw error;return core.runtime.task(targetId);},task=>task.status==='succeeded');assert.equal(read,true);assert.equal(core.runtime.approvals().length,0);assert.deepEqual(core.runtime.task(targetId).grants,{write:false,execute:false,mcp:false});
  }finally{release();if(core)await core.close();await removeTemp(directory);}
});
