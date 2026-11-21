import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,until,removeTemp} from './helpers.js';

for(const owner of ['task','main'] as const)for(const completion of ['closed','unconfirmed'] as const)test(`${owner} attachment cancellation remains truthful when its descriptor is ${completion}`,{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-attachment-cancel-')),originalOpen=fs.promises.open;let core!:Core,assetId='',armed=false,started=false,closed=false,fd=-1,opened:Awaited<ReturnType<typeof fs.promises.open>>|undefined,release!:()=>void,entered!:()=>void,returned=false,mainCreated=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  fs.promises.open=async(...args)=>{const handle=await originalOpen(...args);if(armed&&String(args[0])===path.join(directory,'assets',assetId)&&!started){const read=handle.readFile.bind(handle),close=handle.close.bind(handle);Object.defineProperty(handle,'readFile',{configurable:true,value:async(...readArgs:unknown[])=>{started=true;opened=handle;fd=handle.fd;entered();await gate;return Reflect.apply(read,handle,readArgs);}});Object.defineProperty(handle,'close',{configurable:true,value:async()=>{await close();closed=true;}});}return handle;};
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{const work=request.tools?.some(tool=>tool.name==='task_report');let name:string|undefined,input:unknown;
    if(owner==='task'&&!work){if(!mainCreated){mainCreated=true;name='task_create';input={task:{title:'Read an attached original',content:'Read the supplied original attachment.'}};}}
    else{armed=true;const source=work?core.runtime.tasks()[0]!.signalId:String(core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.contextId')='main' AND status='accepted' ORDER BY rowid DESC LIMIT 1").get()!.id);name='read_attachment';input={id:assetId,signalIds:[source],encoding:'base64',byteOffset:0,maxBytes:32};}
    return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(name)c.enqueue({type:'tool-call',toolCallId:randomUUID(),toolName:name,input:JSON.stringify(input)});c.enqueue({type:'finish',finishReason:name?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};
  }});
  try{core=await Core.open({dataDir:directory,model,memoryEnabled:false});const asset=await core.assets.put(new Response(Buffer.from([0,1,2,255,254])).body,'cancel.bin',undefined,{purpose:'client-shell-output'});assetId=asset.id;const input=await core.submitMessage({content:'Read the supplied original attachment.',attachments:[asset.id]});await ready;assert.equal(fs.fstatSync(fd).isFile(),true);const app=authenticatedApp(core),task=core.runtime.tasks()[0];const request=owner==='task'?app.request(`/tasks/${task!.id}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:core.runtime.task(task!.id).revision})}):app.request('/contexts/main/interrupt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRunId:input.runId})});
    const cancellation=Promise.resolve(request).then(response=>{returned=true;return response;});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(closed,false);assert.equal(returned,false,'A termination receipt must wait for the original attachment descriptor.');if(owner==='task')assert.equal(core.runtime.task(task!.id).status,'cancelling');else assert.equal(core.store.getRun(input.runId!)?.status,'running');
    if(completion==='closed'){release();assert.equal((await cancellation).status,202);}
    else{const response=await cancellation;assert.equal(response.status,504);assert.deepEqual(await response.json(),{error:'workspace_read_cleanup_unconfirmed'});assert.equal(closed,false);if(task)assert.equal(core.runtime.task(task.id).status,'interrupted');release();}
    await until(()=>closed,Boolean);assert.equal(opened?.fd,-1,'The original FileHandle is closed even if its numeric descriptor has already been reused.');if(task){assert.equal(core.runtime.task(task.id).status,completion==='closed'?'cancelled':'interrupted');assert.equal(core.runtime.task(task.id).report,null);assert.equal(core.runtime.events(task.contextId).filter(event=>event.kind==='task_report').length,0);}else await until(()=>core.store.getRun(input.runId!)?.status,status=>status==='interrupted');fs.unlinkSync(path.join(directory,'assets',asset.id));
  }finally{release();if(started)await until(()=>closed,Boolean);fs.promises.open=originalOpen;if(core)await core.close();await removeTemp(directory);}
});
