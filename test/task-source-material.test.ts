import assert from 'node:assert/strict';
import test from 'node:test';
import {createSignal} from '@mastra/core/agent';
import {signalSchema,type SignalRecord} from '../src/domain.js';
import {nativeTaskSourceContents,storedTaskSourceContents} from '../src/task-source-material.js';

function fixture(){
  const input=signalSchema.parse({version:2,type:'user-message',source:'synthetic-input',contextId:'main',content:'SYNTHETIC_ORIGINAL_TEXT',output:{kind:'none',contextId:'main'}});
  const source:SignalRecord={...input,status:'accepted',nativeSignalId:input.id,runId:'synthetic-original-run',action:'wake',errorCode:null,createdAt:new Date().toISOString()};
  const native=createSignal({id:input.id,type:'user',tagName:'user',contents:[{type:'text',text:input.content},{type:'file',data:new Uint8Array([0,1,2,255]),mediaType:'application/octet-stream',filename:'source.bin',providerOptions:{synthetic:{signature:'SYNTHETIC_FILE_METADATA'}}}],attributes:{signal_id:input.id,source:input.source}});
  const data=native.toDataPart(),stored=native.toDBMessage({threadId:'main',resourceId:'local'}),observed={...stored,content:{format:2 as const,parts:[data],metadata:{signal:data.data}}};return{source,stored,observed};
}
test('authenticated input projection and older native storage preserve original inline file bytes and metadata without changing either row',()=>{
  const{source,stored,observed}=fixture(),original=structuredClone({source,stored,observed}),live=nativeTaskSourceContents(source,observed),legacy=storedTaskSourceContents(source,stored);assert.deepEqual(live,legacy);assert.ok(Array.isArray(live));assert.deepEqual(live[1],{type:'file',data:'AAEC/w==',mediaType:'application/octet-stream',filename:'source.bin',providerOptions:{synthetic:{signature:'SYNTHETIC_FILE_METADATA'}}});assert.deepEqual({source,stored,observed},original);
});
for(const change of ['context','source','text','external-file'] as const)test(`input projection rejects a mismatched ${change} rather than resolving new source data`,()=>{
  const{source,observed}=fixture();if(change==='context')observed.threadId='other';else if(change==='source')observed.content.parts[0]!.data.attributes!.source='other';else if(change==='text'){const contents=observed.content.parts[0]!.data.contents;assert.ok(Array.isArray(contents));contents[0]={type:'text',text:'SYNTHETIC_DIFFERENT_TEXT'};}else{const contents=observed.content.parts[0]!.data.contents;assert.ok(Array.isArray(contents));contents[1]={type:'file',data:'https://source.invalid/private.bin',mediaType:'application/octet-stream'};}assert.throws(()=>nativeTaskSourceContents(source,observed),{code:'task_source_material_changed'});
});
