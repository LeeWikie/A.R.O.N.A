import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {serialize} from 'node:v8';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {finished,until} from './helpers.js';

const directory=process.argv[2];
assert.ok(directory&&path.isAbsolute(directory)&&path.basename(directory).startsWith('arona-legacy-memory-crash-'));
let calls=0;
const model=new MastraLanguageModelV2Mock({
 doStream:async()=>({stream:new ReadableStream({start(controller){
  controller.enqueue({type:'stream-start',warnings:[]});controller.enqueue({type:'text-start',id:'reply'});controller.enqueue({type:'text-delta',id:'reply',delta:'Synthetic acknowledgement.'});controller.enqueue({type:'text-end',id:'reply'});controller.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();
 }})}),
 doGenerate:async request=>{
  assert.ok(request.tools?.some(tool=>tool.name==='memory_commit'));calls++;
  assert.ok(request.abortSignal);request.abortSignal.throwIfAborted();
  return new Promise<never>((_resolve,reject)=>request.abortSignal!.addEventListener('abort',()=>reject(request.abortSignal!.reason),{once:true}));
 },
});
setInterval(()=>{},1000);
const core=await Core.open({dataDir:directory,model,memoryEnabled:true});
const signal=await core.submitMessage({content:'Remember the synthetic recovery preference: blue.'});await finished(core,signal.runId!);
const jobs=await until(()=>core.projectMemory.jobs(),rows=>rows.some(job=>job.runId===signal.runId&&job.status==='running'&&!!job.nativeTaskId)&&calls===1);
const job=jobs.find(row=>row.runId===signal.runId)!;
const body=core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(signal.id)?.body;assert.equal(typeof body,'string');
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
process.send?.({ready:true,runId:signal.runId,signalId:signal.id,jobId:job.id,nativeTaskId:job.nativeTaskId,snapshotSha256:hash(serialize(core.projectMemory.snapshot(signal.runId!))),signalSha256:hash(String(body))});
