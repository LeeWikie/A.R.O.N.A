import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,removeTemp,until} from './helpers.js';
import {syntheticPng} from './fixtures/png.js';

for(const owner of['main','task']as const)test(`cancelling a real ${owner} attachment image read waits for the inherited image worker and its original resource lease`,{timeout:20000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-attachment-image-cancel-')),originalPost=Worker.prototype.postMessage,originalTerminate=Worker.prototype.terminate,image=syntheticPng(32,16);let core:Core|undefined,armed=false,worker:Worker|undefined,release:(()=>void)|undefined,terminated=false,returned=false,created=false,assetId='';
 Worker.prototype.postMessage=function(...args:Parameters<Worker['postMessage']>){const value=args[0];if(armed&&!worker&&value&&typeof value==='object'&&'inputBytes'in value&&value.inputBytes instanceof Uint8Array&&'mimeType'in value&&value.mimeType==='image/png'){worker=this;release=()=>Reflect.apply(originalPost,this,args);return;}return Reflect.apply(originalPost,this,args);};
 Worker.prototype.terminate=function(){const result=Reflect.apply(originalTerminate,this,[]) as ReturnType<Worker['terminate']>;if(this===worker)return result.then(code=>{terminated=true;return code;});return result;};
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{
  assert.ok(core);const work=request.tools?.some(tool=>tool.name==='task_report');let name:string|undefined,input:unknown;
  if(owner==='task'&&!work){if(!created){created=true;name='task_create';input={task:{title:'View an attached original image',content:'View the supplied original image.'}};}}
  else{armed=true;const source=work?core.runtime.tasks()[0]!.signalId:String(core.store.db.prepare("SELECT id FROM signals WHERE status='accepted' AND json_extract(body,'$.contextId')='main' ORDER BY rowid DESC LIMIT 1").get()!.id);name='read_attachment';input={id:assetId,signalIds:[source]};}
  return{stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(name)controller.enqueue({type:'tool-call',toolCallId:randomUUID(),toolName:name,input:JSON.stringify(input)});controller.enqueue({type:'finish',finishReason:name?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};
 }});
 try{
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});const asset=await core.assets.put(new Response(new Uint8Array(image)).body,'original.png');assetId=asset.id;const input=await core.submitMessage({content:'View the supplied original image.',attachments:[asset.id]});await until(()=>worker,Boolean);assert.equal(terminated,false);const app=authenticatedApp(core),task=owner==='task'?core.runtime.tasks()[0]:undefined;
  const cancellation=Promise.resolve(owner==='task'?app.request(`/tasks/${task!.id}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:core.runtime.task(task!.id).revision})}):app.request('/contexts/main/interrupt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRunId:input.runId})})).then(response=>{returned=true;return response;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(returned,false,'cancel does not claim termination while the real image worker is waiting');assert.equal(terminated,false);if(task)assert.equal(core.runtime.task(task.id).status,'cancelling');else assert.equal(core.store.getRun(input.runId!)?.status,'running');assert.ok(release);release();release=undefined;assert.equal((await cancellation).status,202);assert.equal(terminated,true,'the inherited image worker terminates before the resource lease acknowledges cancellation');
  if(task){assert.equal(core.runtime.task(task.id).status,'cancelled');assert.equal(core.runtime.task(task.id).report,null);assert.equal(core.runtime.events(task.contextId).filter(row=>row.kind==='task_report').length,0);}else await until(()=>core!.store.getRun(input.runId!)?.status,status=>status==='interrupted');const runId=task?core.runtime.task(task.id).runIds.at(-1):input.runId;assert.equal(core.store.db.prepare('SELECT COUNT(*) AS count FROM runtime_settings WHERE id LIKE ?').get(`attachment-image-policy:${runId}:%`)!.count,0,'an aborted image read does not create a consumed-policy proof');assert.deepEqual((await core.assets.read(asset.id)).bytes,image);
 }finally{release?.();if(worker&&!terminated)await until(()=>terminated,Boolean);Worker.prototype.postMessage=originalPost;Worker.prototype.terminate=originalTerminate;if(core)await core.close();await removeTemp(directory);}
});
