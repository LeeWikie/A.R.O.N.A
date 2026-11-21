import fs from 'node:fs';
import path from 'node:path';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { until } from './helpers.js';

const [directory,phase]=process.argv.slice(2);if(!directory||!phase)throw Error('fixture_arguments');
const crashPhase=phase.replace(/^v1-/,'');
let started=false;let release!:()=>void;let calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
const model=new MastraLanguageModelV2Mock({doStream:async()=>{started=true;if(++calls===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
const core=await Core.open({dataDir:directory,model,memoryEnabled:false,...(phase.startsWith('v1-')?{memoryContextMode:'v1' as const}:{})});
const boundary=(id:string)=>{const draft=core.runtime.setting<{submission?:{entries:Array<{signalId:string}>}}>(`queue-edit:${id}`,{});const bindings=draft.submission?.entries.flatMap(row=>{const signal=core.store.getSignal(row.signalId)!;return signal.nativeSignalId&&signal.runId?[{id:signal.id,nativeSignalId:signal.nativeSignalId,runId:signal.runId,action:signal.action,status:signal.status}]:[];})??[];fs.writeFileSync(path.join(directory,'crash-boundary.json'),JSON.stringify({id,phase,bindings}));process.kill(process.pid,'SIGKILL');};
const active=await core.submitMessage({content:'SYNTHETIC_ACTIVE_REQUEST'});await until(()=>started,Boolean);
for(let i=0;i<65;i++)await core.submitMessage({content:`SYNTHETIC_CRASH_SOURCE_${i}`,mode:'queue'});
const set=core.runtime.setSetting.bind(core.runtime);
core.runtime.setSetting=(key,value)=>{
  set(key,value);
  const draft=value as {id?:string;status?:string;body?:unknown[];submission?:{inputPrepared?:boolean;groupReady?:boolean;entries:Array<{status:string}>}};
  const atBoundary=key.startsWith('queue-edit:')&&(crashPhase==='capture'?draft.status==='capturing'&&draft.body?.length===64:crashPhase==='first-admission'?draft.status==='submitting'&&draft.submission?.entries.filter(row=>row.status==='queued').length===1:['prepared','legacy-prepared'].includes(crashPhase)?draft.submission?.inputPrepared&&!draft.submission.groupReady:false);
  if(atBoundary){if(phase==='legacy-prepared')set(key,{...draft,signature:(core.queueEditor() as any).host.legacySignature('main')});boundary(draft.id!);}
};
const draft=core.queueEditor().create('main',{},'synthetic-capture');
if(phase==='steer-first-admission'){
  const accept=core.store.accept.bind(core.store);let first=true;core.store.accept=(...args)=>{accept(...args);if(first&&core.runtime.setting(`queue-edit-signal:${args[0]}`,null)){first=false;boundary(draft.id);}};
}
if(crashPhase==='submitted'){
  const transaction=core.store.transaction.bind(core.store);core.store.transaction=action=>{const result=transaction(action);const actual=core.queueEditor().page('main',draft.id).draft;if(actual.submission?.groupReady)boundary(draft.id);return result;};
}
await core.queueEditor().submit('main',draft.id,{expectedRevision:draft.revision,...(phase==='steer-first-admission'?{mode:'steer',expectedRunId:active.runId}:{})},'synthetic-submit');
release();await new Promise(()=>{});
throw Error('crash_boundary_not_reached');
