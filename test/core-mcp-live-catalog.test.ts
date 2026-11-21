import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,removeTemp,until} from './helpers.js';
import {liveMcpCatalogFixture} from './mcp-live-catalog-fixture.js';

function stream(action?:{name:string;input:unknown},step=0){return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`synthetic-catalog-step-${step}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

test('the original agent loop waits for a live MCP catalog and requires new authority for a newly advertised tool',{timeout:20000},async()=>{
 const remote=await liveMcpCatalogFixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-mcp-refresh-'));let core!:Core,step=0,held:ReturnType<typeof remote.holdNextList>|undefined;const seen:string[][]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return stream();const task=core.runtime.tasks().find(task=>task.status==='running');assert.ok(task);const phase=step++,names=request.tools.map(tool=>tool.name);seen.push(names);
  if(phase===0){assert.ok(names.includes('ext_live_old_read'));assert.ok(!names.includes('ext_live_new_read'));return stream({name:'ext_live_change',input:{}},phase);}
  if(phase===1){assert.ok(names.includes('ext_live_new_read'));assert.ok(!names.includes('ext_live_old_read'));return stream({name:'ext_live_new_read',input:{}},phase);}
  if(phase===2){assert.match(JSON.stringify(request.prompt),/Executed new_read/);return stream({name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Used the current live tool after its own approval.',checks:[{description:'The old tool was removed and the new tool returned its original result.',passed:true}],deliveries:[],unresolved:[]}}},phase);}
  return stream();
 }});
 core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 try{
  await core.capabilities.saveMCP(remote.configuration);await core.capabilities.connect('live');await core.capabilities.prepareMcpWorkspace('default');held=remote.holdNextList();
  const task=await core.submitTask({title:'Use the live catalog',content:'Change the remote catalog, then use its newly available read tool.',grants:{write:false,execute:false,mcp:true}},'synthetic-live-catalog');await held.entered;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(step,1,'the next model request waits for the catalog change already announced by this connection');held.release();held=undefined;
  const gate=(await until(()=>core.runtime.approvals(),rows=>rows.some(row=>row.taskId===task.id&&row.toolName==='ext_live_new_read'&&row.status==='pending'))).find(row=>row.taskId===task.id&&row.toolName==='ext_live_new_read'&&row.status==='pending')!;
  assert.deepEqual(remote.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['change']);assert.equal(core.runtime.task(task.id).mcpKeys?.includes(gate.capabilityKey??''),false,'the original task snapshot does not acquire a new tool grant from a notification');
  const response=await authenticatedApp(core).request(`/approvals/${gate.id}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'approve',scope:'once'})});assert.equal(response.status,200);
  const result=await until(()=>core.runtime.task(task.id),row=>['succeeded','failed','blocked','unreported','interrupted'].includes(row.status));assert.equal(result.status,'succeeded');assert.deepEqual(remote.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['change','new_read']);assert.equal(seen.length,4);assert.deepEqual(result.mcpKeys,task.mcpKeys,'one-call approval does not rewrite creation-time catalog authority');
 }finally{held?.release();await core.close();await remote.close();await removeTemp(directory);}
});
