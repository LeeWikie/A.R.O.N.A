import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import type {CompanionClock,CompanionRhythmView} from '../src/companion-rhythm.js';
import {authenticatedApp,finished,removeTemp,until} from './helpers.js';

class Clock implements CompanionClock {
  time=Date.now();private timers=new Map<ReturnType<typeof setTimeout>,{at:number;run:()=>void}>();
  now=()=>this.time;
  setTimeout(run:()=>void,milliseconds:number){const timer=setTimeout(()=>{},2_147_483_647);timer.unref();this.timers.set(timer,{at:this.time+milliseconds,run});return timer;}
  clearTimeout(timer:ReturnType<typeof setTimeout>){clearTimeout(timer);this.timers.delete(timer);}
  advance(milliseconds:number){const end=this.time+milliseconds;let count=0;for(;;){const next=[...this.timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;if(++count>10000)throw Error('fixture_timer_did_not_yield');this.time=next[1].at;this.clearTimeout(next[0]);next[1].run();}this.time=end;}
}
type StreamPart=Awaited<ReturnType<MastraLanguageModelV2Mock['doStream']>>['stream'] extends ReadableStream<infer Part>?Part:never;
function response(tool?:{signalIds:string[];text:string}){return toolResponse(tool?{name:'emit_message',input:tool}:undefined);}
function toolResponse(tool?:{name:string;input:unknown}){return {stream:new ReadableStream<StreamPart>({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(tool)controller.enqueue({type:'tool-call',toolCallId:randomUUID(),toolName:tool.name,input:JSON.stringify(tool.input)});controller.enqueue({type:'finish',finishReason:tool?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:0,totalTokens:1}});controller.close();}})};}
function notices(core:Core){return core.store.db.prepare("SELECT * FROM task_notifications WHERE json_extract(body,'$.kind')='companion-wake' ORDER BY rowid").all();}
function ticks(core:Core){return core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.source')='companion-rhythm' ORDER BY rowid").all().map(row=>core.store.getSignal(String(row.id))!);}
async function configure(core:Core,configuration:unknown){const app=authenticatedApp(core),result=await app.request('/companion',{method:'PUT',headers:{'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({expectedRevision:core.companionRhythm.view().revision,configuration})});assert.equal(result.status,200);return await result.json() as CompanionRhythmView;}
async function settleTicks(core:Core,count:number){await until(()=>ticks(core),rows=>rows.length===count&&rows.every(row=>!!row.runId&&core.store.getRun(row.runId)?.status!=='running'));}

test('Core companion defaults to passive, consumes a real silent wake once and rejects a forged wake source',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-')),clock=new Clock(),prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));return response();}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    clock.advance(86400000);assert.equal(core.companionRhythm.view().status,'disabled');assert.equal(notices(core).length,0);assert.equal(prompts.length,0);
    const forged=await authenticatedApp(core).request('/signals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),type:'external-event',source:'companion-rhythm',contextId:'main',content:'FORGED_WAKE',output:{kind:'message',contextId:'main'}})});assert.equal(forged.status,403);assert.equal(prompts.length,0);
    await configure(core,{intervalMinutes:1});clock.advance(60000);await settleTicks(core,1);
    assert.equal(prompts.length,1);assert.match(prompts[0]!,/已安静 1441 分钟/);const tick=ticks(core)[0]!;assert.equal(core.store.getRun(tick.runId!)?.status,'succeeded');assert.equal(core.store.outputsForSignal(tick.id).length,0);
    assert.equal(Number(notices(core)[0]!.delivered),1);assert.equal(Number(notices(core)[0]!.cancelled),0);
    assert.equal(core.companionRhythm.view().lastExternalAt,new Date(clock.time-86460000).toISOString());
  }finally{await core.close();await removeTemp(directory);}
});

test('a wake waits for any busy Main and renders quiet time at delivery without entering the user run',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-busy-')),clock=new Clock(),prompts:string[]=[];let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(prompts.length===1)await gate;return response();}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    await configure(core,{target:'fixed',contextId:'main',intervalMinutes:1});const other=core.createConversationContext({name:'Second main'});
    const user=await core.submitMessage({contextId:other.id,content:'SYNTHETIC_BUSY_MAIN'});await until(()=>prompts.length,count=>count===1);
    clock.advance(120000);await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(prompts.length,1);assert.equal(ticks(core).length,0);assert.equal(notices(core).length,2);
    release();await finished(core,user.runId!);await settleTicks(core,1);assert.equal(prompts.length,2);assert.match(prompts[1]!,/已安静 2 分钟/);
    const tick=ticks(core)[0]!;assert.equal(tick.contextId,'main');assert.notEqual(tick.runId,user.runId);assert.equal(core.store.outputsForSignal(tick.id).length,0);assert.equal(tick.content,'[system] 已安静 2 分钟。\n[system] 已安静 2 分钟。');assert.equal(notices(core).filter(row=>Number(row.delivered)===1).length,2);
  }finally{release();await core.close();await removeTemp(directory);}
});

test('latest companion follows actual user conversations while fixed routing remains explicit',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-target-')),clock=new Clock();let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return response();}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    await configure(core,{intervalMinutes:1});const other=core.createConversationContext({name:'Latest main'}),user=await core.submitMessage({contextId:other.id,content:'SYNTHETIC_LATEST_USER'});await finished(core,user.runId!);
    assert.equal(core.companionRhythm.view().effectiveContextId,other.id);clock.advance(60000);await settleTicks(core,1);assert.equal(ticks(core)[0]!.contextId,other.id);
    await configure(core,{target:'fixed',contextId:'main',intervalMinutes:1});const next=await core.submitMessage({contextId:other.id,content:'SYNTHETIC_STILL_OTHER'});await finished(core,next.runId!);
    clock.advance(60000);await settleTicks(core,2);assert.equal(ticks(core)[1]!.contextId,'main');assert.equal(calls,4);
  }finally{await core.close();await removeTemp(directory);}
});

test('disabling a wake during its model request revokes publication without aborting or claiming delivery',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-revoke-')),clock=new Clock();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls++;if(calls===1){await gate;const id=/signal_id=\\?"([a-f0-9-]{36})/.exec(JSON.stringify(request.prompt))?.[1];assert.ok(id);return response({signalIds:[id],text:'SYNTHETIC_REVOKED_WAKE'});}return response();}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    await configure(core,{intervalMinutes:1});clock.advance(60000);await until(()=>calls,count=>count===1);const tick=ticks(core)[0]!;assert.ok(tick.runId);
    await configure(core,{intervalMinutes:null});release();await finished(core,tick.runId!);assert.equal(core.store.outputsForSignal(tick.id).length,0);
    const notice=notices(core)[0]!;assert.equal(Number(notice.cancelled),1);assert.equal(Number(notice.delivered),2);assert.notEqual(core.store.getRun(tick.runId!)?.status,'interrupted');
  }finally{release();await core.close();await removeTemp(directory);}
});

test('a failed auxiliary activity commit preserves accepted input and cold reconciliation uses its original timestamp',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-activity-')),clock=new Clock();let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return response();}});let core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    await configure(core,{intervalMinutes:1});const original=core.runtime.setSetting.bind(core.runtime);let fail=true;
    core.runtime.setSetting=(key,value)=>{if(key==='companion-rhythm'&&fail){fail=false;throw Error('synthetic_activity_storage_failure');}return original(key,value);};
    const user=await core.submitMessage({content:'SYNTHETIC_ACCEPTED_ACTIVITY'});await finished(core,user.runId!);assert.equal(core.store.getSignal(user.id)?.status,'accepted');assert.equal(core.companionRhythm.view().status,'blocked');assert.equal(core.companionRhythm.view().errorCode,'companion_activity_unavailable');
    const firstEvent=core.store.db.prepare('SELECT seq,created_at FROM runtime_events WHERE event_key=?').get(`input:${user.id}`)!;
    await configure(core,{intervalMinutes:1});assert.equal(core.companionRhythm.view().status,'running');assert.equal(core.companionRhythm.view().lastExternalAt,new Date(String(firstEvent.created_at)).toISOString());
    fail=true;const next=await core.submitMessage({content:'SYNTHETIC_ACCEPTED_BEFORE_COLD_RECONCILIATION'});await finished(core,next.runId!);assert.equal(core.companionRhythm.view().status,'blocked');
    const event=core.store.db.prepare('SELECT seq,created_at FROM runtime_events WHERE event_key=?').get(`input:${next.id}`)!;
    await core.close();clock.advance(30000);core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
    assert.equal(core.companionRhythm.view().status,'running');assert.equal(core.companionRhythm.view().lastExternalAt,new Date(String(event.created_at)).toISOString());assert.equal(calls,2);
    const state=core.runtime.setting<{lastExternalSeq:number}>('companion-rhythm',{lastExternalSeq:0});assert.equal(state.lastExternalSeq,Number(event.seq));
  }finally{await core.close();await removeTemp(directory);}
});

test('a real main user request can manage companion policy through native tools but an external wake cannot grant itself that control',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-tools-')),clock=new Clock(),prompts:string[]=[];let userId='',mode:'user'|'wake'='user',step=0;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    prompts.push(JSON.stringify(request.prompt));step++;
    if(mode==='user'){
      if(step===1)return toolResponse({name:'companion_status',input:{}});
      if(step===2)return toolResponse({name:'companion_configure',input:{signalIds:[userId],expectedRevision:0,configuration:{target:'latest',contextId:'main',intervalMinutes:1}}});
    }else if(step===1){const id=ticks(core).at(-1)?.id;assert.ok(id);assert.ok(JSON.stringify(request.prompt).includes(id));return toolResponse({name:'companion_configure',input:{signalIds:[id],expectedRevision:1,configuration:{target:'latest',contextId:'main',intervalMinutes:null}}});}
    return response();
  }}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    userId=randomUUID();const user=await core.submitMessage({id:userId,content:'SYNTHETIC_USER_REQUEST_ENABLE_PROACTIVE_CONVERSATION'});await finished(core,user.runId!);
    assert.equal(core.store.getRun(user.runId!)?.status,'succeeded');assert.equal(core.companionRhythm.view().revision,1);assert.equal(core.companionRhythm.view().status,'running');assert.match(prompts[1]!,/disabled/);assert.match(prompts[2]!,/running/);
    mode='wake';step=0;clock.advance(60000);await settleTicks(core,1);
    assert.equal(core.companionRhythm.view().revision,1);assert.equal(core.companionRhythm.view().configuration.intervalMinutes,1);assert.match(prompts.at(-1)!,/schedule_authorization_required/);assert.equal(core.runtime.approvals().filter(row=>row.status==='pending').length,0);
  }finally{await core.close();await removeTemp(directory);}
});

test('busy deferred wakes survive a Core restart as one complete native batch with all original notices',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-batch-restart-')),clock=new Clock();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let started=false;
  const blocked=new MastraLanguageModelV2Mock({doStream:async()=>{started=true;await gate;return response();}});let core=await Core.open({dataDir:directory,model:blocked,memoryEnabled:false,companionClock:clock});const prompts:string[]=[];
  try{
    await configure(core,{intervalMinutes:1});const user=await core.submitMessage({content:'SYNTHETIC_USER_BUSY_DURING_TICKS'});await until(()=>started,Boolean);
    clock.advance(240000);assert.equal(notices(core).length,3);assert.equal(ticks(core).length,0);const original=notices(core).map(row=>({id:row.id,body:row.body}));
    const stopping=core.close();release();await stopping;
    const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));return response();}});
    core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});await settleTicks(core,1);assert.equal(core.store.getRun(user.runId!)?.status,'interrupted');
    assert.equal(prompts.length,1);assert.equal(ticks(core)[0]!.content,Array(3).fill('[system] 已安静 4 分钟。').join('\n'));assert.deepEqual(notices(core).map(row=>({id:row.id,body:row.body})),original);assert.equal(notices(core).filter(row=>Number(row.delivered)===1).length,3);
  }finally{release();await core.close();await removeTemp(directory);}
});

test('revoking a tick in a mixed native run preserves the real user reply and does not abort that run',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-mixed-')),clock=new Clock();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0,userId='',tickId='';const prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{calls++;prompts.push(JSON.stringify(request.prompt));if(calls===1){await gate;return response();}if(calls===2){assert.ok(JSON.stringify(request.prompt).includes(userId));return response({signalIds:[tickId,userId],text:'SYNTHETIC_MIXED_USER_REPLY'});}return response();}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    await configure(core,{intervalMinutes:1});clock.advance(60000);await until(()=>calls,count=>count===1);const tick=ticks(core)[0]!;tickId=tick.id;
    userId=randomUUID();const user=await core.submitSignal({id:userId,type:'user-message',source:'synthetic-user',contextId:'main',content:'SYNTHETIC_REAL_USER_AFTER_TICK',output:{kind:'message',contextId:'main'}});assert.equal(user.runId,tick.runId);assert.equal(user.action,'deliver');
    await configure(core,{intervalMinutes:null});release();await finished(core,user.runId!);
    assert.equal(core.store.getRun(user.runId!)?.status,'succeeded');assert.equal(core.store.outputsForSignal(tickId).length,0);assert.equal(core.store.outputsForSignal(userId).length,1);assert.deepEqual(core.store.outputsForSignal(userId)[0]!.signalIds,[userId]);assert.equal(calls,3);assert.equal(Number(notices(core)[0]!.cancelled),1);assert.equal(Number(notices(core)[0]!.delivered),2);
  }finally{release();await core.close();await removeTemp(directory);}
});

test('background work does not prevent a quiet Main from receiving its companion batch',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-background-')),clock=new Clock();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let workerCalls=0,mainCalls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{if(request.tools?.some(tool=>tool.name==='task_report')){workerCalls++;await gate;}else mainCalls++;return response();}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    await configure(core,{intervalMinutes:1});const task=await core.submitTask({title:'Synthetic background work',content:'SYNTHETIC_LONG_BACKGROUND_WORK'},'synthetic-companion-background');await until(()=>workerCalls,count=>count===1);
    clock.advance(60000);await settleTicks(core,1);assert.equal(mainCalls,1);assert.equal(core.runtime.task(task.id).status,'running');assert.equal(core.store.getRun(ticks(core)[0]!.runId!)?.status,'succeeded');
  }finally{release();await core.close();await removeTemp(directory);}
});

test('an older failed tick present in history cannot be acknowledged by a later unrelated successful user run',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-ack-')),clock=new Clock();let calls=0;const prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(++calls===1)throw Error('synthetic_provider_failure');return response();}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    await configure(core,{intervalMinutes:1});clock.advance(60000);await settleTicks(core,1);const tick=ticks(core)[0]!;assert.equal(core.store.getRun(tick.runId!)?.status,'failed');
    const user=await core.submitMessage({content:'SYNTHETIC_SUBSEQUENT_USER'});await finished(core,user.runId!);assert.equal(core.store.getRun(user.runId!)?.status,'succeeded');assert.ok(prompts[1]!.includes(tick.id));assert.equal(Number(notices(core)[0]!.delivered),2);assert.equal(core.store.outputsForSignal(tick.id).length,0);
  }finally{await core.close();await removeTemp(directory);}
});

for(const cancelled of [false,true])test(`persisted legacy single-wake delivery remains ${cancelled?'cancelled without execution':'deliverable once with its original identity'}`,{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-companion-legacy-')),clock=new Clock();let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return response();}});let core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
  try{
    const submit=core.submitSignal.bind(core);core.submitSignal=async(body,internal)=>{if(body&&typeof body==='object'&&'source'in body&&body.source==='companion-rhythm')throw Error('synthetic_before_delivery');return submit(body,internal);};
    await configure(core,{intervalMinutes:1});clock.advance(60000);await until(()=>notices(core),rows=>rows.length===1&&Boolean(core.runtime.setting(`companion-delivery:${String(rows[0]!.id)}`,null)));
    const id=String(notices(core)[0]!.id),frozen=core.runtime.setting<{signalId:string;wake:unknown;content:string;wakes?:unknown[]}>(`companion-delivery:${id}`,{signalId:'',wake:null,content:''});
    const legacy={signalId:frozen.signalId,wake:frozen.wake,content:frozen.content};core.runtime.setSetting(`companion-delivery:${id}`,legacy);if(cancelled)await configure(core,{intervalMinutes:null});await core.close();
    core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});
    if(cancelled){await new Promise(resolve=>setTimeout(resolve,50));assert.equal(calls,0);assert.equal(Number(notices(core)[0]!.cancelled),1);assert.equal(Number(notices(core)[0]!.delivered),2);assert.equal(core.store.getSignal(legacy.signalId),undefined);}
    else{await settleTicks(core,1);assert.equal(calls,1);assert.equal(ticks(core)[0]!.id,legacy.signalId);assert.equal(ticks(core)[0]!.content,legacy.content);assert.equal(Number(notices(core)[0]!.delivered),1);}
    assert.deepEqual(core.runtime.setting(`companion-delivery:${id}`,null),legacy);await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false,companionClock:clock});await new Promise(resolve=>setTimeout(resolve,50));assert.equal(calls,cancelled?0:1);
  }finally{await core.close();await removeTemp(directory);}
});
