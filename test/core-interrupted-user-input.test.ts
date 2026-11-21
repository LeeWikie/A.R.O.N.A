import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import type { NativeSessionMessage } from '../src/providers/session-replay.js';
import type { SignalRecord } from '../src/domain.js';
import { Core } from '../src/core.js';
import { finished, removeTemp } from './helpers.js';

test('the actual native user frame matches its stored projection and rejects altered source evidence', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-user-proof-'));
  const model=new MastraLanguageModelV2Mock({doStream:async()=>({stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});controller.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})})});
  const core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    const input=await core.submitMessage({content:'Original user data with an exact native source.'});await finished(core,input.runId!);
    const source=core.store.getSignal(input.id);assert.ok(source?.nativeSignalId);
    const event=core.runtime.events('main',0,1000).find(row=>row.kind==='message_start'&&(row.data as Extract<AgentControllerEvent,{type:'message_start'}>).message.id===source.nativeSignalId);assert.ok(event);
    const frame=(event.data as Extract<AgentControllerEvent,{type:'message_start'}>).message;
    assert.equal(frame.role,'signal');assert.equal(frame.content.parts[0]?.type,'data-user-message');
    const read=Reflect.get(Core.prototype,'storedNativeConversation') as (id:string)=>Promise<NativeSessionMessage[]>;
    const stored=(await read.call(core,'main')).find(row=>row.id===source.nativeSignalId);assert.ok(stored);assert.equal(stored.content.parts[0]?.type,'text');
    const verify=Reflect.get(Core.prototype,'verifiedInterruptedNativeInput') as (source:SignalRecord,frame:unknown,stored:NativeSessionMessage)=>boolean;
    assert.equal(verify.call(core,source,frame,stored),true);
    for(const change of ['content','tag','type','metadata','scope','message-id'] as const){
      const altered=structuredClone(frame),part=altered.content.parts[0];assert.ok(part&&'data'in part&&part.data&&typeof part.data==='object');
      if(change==='content')Object.assign(part.data,{contents:'Changed user content'});
      if(change==='tag')Object.assign(part.data,{tagName:'notification'});
      if(change==='type')Object.assign(part.data,{type:'notification'});
      if(change==='metadata')altered.content.metadata={...altered.content.metadata,signal:{changed:true}};
      if(change==='scope')altered.threadId='unrelated';
      if(change==='message-id')altered.id='unrelated';
      assert.equal(verify.call(core,source,altered,stored),false,change);
    }
    const key=`session-native-input:${source.runId}:${source.nativeSignalId}`,original=core.store.db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(key);assert.ok(original);
    try{const proof=JSON.parse(String(original.body));proof.nativeHash='0'.repeat(64);core.store.db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(proof),key);assert.equal(verify.call(core,source,frame,stored),false,'a changed host seal is rejected');}
    finally{core.store.db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(original.body!,key);}
    assert.equal(verify.call(core,source,frame,stored),true);assert.deepEqual(core.store.getSignal(source.id),source);
  }finally{await core.close();await removeTemp(directory);}
});
