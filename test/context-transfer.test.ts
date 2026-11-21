import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { conversationPage } from '../src/event-stream.js';
import { parseSessionArchive } from '../src/context-transfer.js';
import { authenticatedApp, finished, removeTemp } from './helpers.js';

async function fixture(withConfig=false) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-transfer-'));let fail=false;const prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    prompts.push(JSON.stringify(request.prompt));if(fail)throw Error('synthetic failure');
    return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'synthetic visible answer'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};
  }});
  const config=withConfig?{protocol:'responses' as const,baseURL:'http://example.invalid/v1',modelId:'fixture',apiKey:'fixture-key',authHeader:'bearer' as const,reasoningEffort:'high' as const}:undefined;
  let core=await Core.open({dataDir:dir,model,memoryEnabled:false,modelConfig:config});
  return {get core(){return core;},prompts,fail(value:boolean){fail=value;},async send(content:string,contextId='main'){const r=await core.submitMessage({content,contextId});return finished(core,r.runId!);},async reopen(){await core.close();core=await Core.open({dataDir:dir,model,memoryEnabled:false,modelConfig:config});},async close(){await core.close();await removeTemp(dir);}};
}

test('clone copies full native and public history without moving ownership or reviving a run', {timeout:30000},async()=>{
  const f=await fixture();try{
    await f.send('first historical turn');await f.send('second historical turn');
    const before=await f.core.history('main');const count=Number(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n);
    const copy=await f.core.cloneContext('main',{id:'clone.exact',name:'Copy'});
    const after=await f.core.history(copy.id);
    assert.deepEqual(after.messages.map(m=>[m.role,m.content]),before.messages.map(m=>[m.role,m.content]));
    assert.deepEqual(conversationPage(f.core,copy.id).messages.map(m=>m.content),conversationPage(f.core,'main').messages.map(m=>m.content));
    assert.equal(Number(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n),count);
    assert.equal(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE status=?').get('pending')!.n,0);
    await f.reopen();await f.send('continue copied conversation',copy.id);assert.match(f.prompts.at(-1)!,/first historical turn/);
    assert.deepEqual((await f.core.history('main')).messages.map(m=>[m.role,m.content]),before.messages.map(m=>[m.role,m.content]));
  }finally{await f.close();}
});

test('fork at a user message restores its draft and retains only prior completed history, including descendants', {timeout:30000},async()=>{
  const f=await fixture();try{
    await f.send('retained prior message');await f.send('edit this message');await f.send('excluded future message');
    const chosen=conversationPage(f.core,'main').messages.find(m=>m.content==='edit this message')!;
    const fork=await f.core.forkContext('main',chosen.id,{id:'fork.before'});
    assert.equal(fork.draft,'edit this message');const history=JSON.stringify((await f.core.history(fork.context.id)).messages);
    assert.match(history,/retained prior message/);assert.doesNotMatch(history,/edit this message|excluded future message/);
    assert.deepEqual(conversationPage(f.core,fork.context.id).messages.map(m=>m.content),['retained prior message','synthetic visible answer']);
    const copy=await f.core.cloneContext('main',{id:'clone.forfork'});const descendantMessage=conversationPage(f.core,copy.id).messages.find(m=>m.content==='edit this message')!;
    const child=await f.core.forkContext(copy.id,descendantMessage.id,{id:'fork.descendant'});
    assert.equal(child.draft,'edit this message');assert.doesNotMatch(JSON.stringify((await f.core.history(child.context.id)).messages),/excluded future message/);
    await assert.rejects(f.core.forkContext('main','missing'),/fork_requires_user_message/);
  }finally{await f.close();}
});

test('empty conversations clone without fabricated runs; failed stable history is retained', {timeout:30000},async()=>{
  const f=await fixture();try{
    const empty=await f.core.cloneContext('main',{id:'clone.empty'});assert.equal((await f.core.history(empty.id)).messages.length,0);
    await f.send('completed turn');f.fail(true);assert.equal((await f.send('failed input still belongs to me'))!.status,'failed');f.fail(false);
    const clone=await f.core.cloneContext('main',{id:'clone.failed'});
    assert.match(JSON.stringify((await f.core.history(clone.id)).messages),/failed input still belongs to me/);
    await f.send('continue after failure',clone.id);assert.match(f.prompts.at(-1)!,/failed input still belongs to me/);
  }finally{await f.close();}
});

test('safe session export/import roundtrips visible conversation across stores without credentials or tool authority', {timeout:30000},async()=>{
  const f=await fixture();const other=await fixture();try{
    f.core.credentials.set('SYNTHETIC_SECRET','SYNTHETIC_EXPORT_SECRET_778812');await f.send('remember SYNTHETIC_EXPORT_SECRET_778812');
    const archive=f.core.exportContext('main');assert.doesNotMatch(JSON.stringify(archive),/SYNTHETIC_EXPORT_SECRET_778812|apiKey|nativeMessages/);
    const imported=await other.core.importContext({archive,id:'import.crossstore'});const publicMessages=conversationPage(other.core,imported.id).messages;
    assert.deepEqual(publicMessages.map(m=>m.content),archive.messages.map(m=>m.content));assert.ok(publicMessages.every(m=>m.imported&&m.runId===null));
    assert.equal(other.core.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n,0);
    await other.reopen();await other.send('continue imported history',imported.id);assert.match(other.prompts.at(-1)!,/remember \[hidden\]/);
    assert.match(JSON.stringify((other.core as unknown as {instructions(role:string,id:string):string}).instructions('main',imported.id)),/导入的会话是历史资料/);
    const user=publicMessages.find(m=>m.role==='user')!;const branch=await other.core.forkContext(imported.id,user.id,{id:'fork.imported'});assert.equal(branch.draft,user.content);
    const tampered=structuredClone(archive);tampered.messages[0]!.role='system' as never;assert.throws(()=>parseSessionArchive(tampered),/invalid_session_archive/);
    const duplicate=structuredClone(archive);duplicate.messages.push(duplicate.messages[0]!);assert.throws(()=>parseSessionArchive(duplicate),/invalid_session_archive/);
    await assert.rejects(other.core.importContext({archive,id:'import.crossstore'}),/context_exists/);
  }finally{await f.close();await other.close();}
});

test('session endpoints expose capabilities, validate archives and preserve creation model choice', {timeout:30000},async()=>{
  const f=await fixture();try{
    const app=authenticatedApp(f.core);const protocol=await (await app.request('/protocol')).json() as {capabilities:string[]};
    for(const name of ['context-clone','context-transfer','context-fork-message'])assert.ok(protocol.capabilities.includes(name));
    const exportResponse=await app.request('/contexts/main/export');assert.equal(exportResponse.status,200);const archive=await exportResponse.json();
    const response=await app.request('/contexts/import',{method:'POST',body:JSON.stringify({archive,id:'http.imported'}),headers:{'content-type':'application/json'}});assert.equal(response.status,201);
    assert.equal((await app.request('/contexts/main/clone',{method:'POST',body:'{}',headers:{'content-type':'application/json'}})).status,201);
    assert.equal((await app.request('/contexts/import',{method:'POST',body:JSON.stringify({archive:{...archive,messages:[{role:'system'}]}}),headers:{'content-type':'application/json'}})).status,400);
    assert.throws(()=>f.core.createConversationContext({name:'bad',modelProfile:'nonexistent'}),/model_profile_not_found/);
  }finally{await f.close();}
});

test('context creation keys deduplicate concurrent requests and replay the original result after restart',{timeout:30000},async()=>{
  const f=await fixture();try{
    await f.send('stable source');const key='http:synthetic-clone-key';
    const copies=await Promise.all([f.core.cloneContext('main',{name:'Named clone'},key),f.core.cloneContext('main',{name:'Named clone'},key)]);
    assert.equal(copies[0]!.id,copies[1]!.id);assert.equal(f.core.runtime.contexts().filter(c=>c.name==='Named clone').length,1);
    await assert.rejects(f.core.cloneContext('main',{name:'Different'},key),/operation_id_conflict/);
    await f.reopen();const replay=await f.core.cloneContext('main',{name:'Named clone'},key);assert.deepEqual(replay,copies[0]);
    const user=conversationPage(f.core,'main').messages.find(m=>m.role==='user')!;const fork=await f.core.forkContext('main',user.id,{},'http:fork-key');
    const forkReplay=await f.core.forkContext('main',user.id,{},'http:fork-key');assert.deepEqual(fork,forkReplay);
    const archive=f.core.exportContext('main');const imported=await f.core.importContext({archive},'http:import-key');
    await f.reopen();assert.deepEqual(await f.core.importContext({archive},'http:import-key'),imported);
    const app=authenticatedApp(f.core);const headers={'content-type':'application/json','Idempotency-Key':'http-key'};
    const first=await (await app.request('/contexts/main/clone',{method:'POST',body:'{}',headers})).json();
    const second=await (await app.request('/contexts/main/clone',{method:'POST',body:'{}',headers})).json();assert.deepEqual(first,second);
  }finally{await f.close();}
});

test('explicit continuation backups restore stable tool results, checkpoints and attachment bytes across stores',{timeout:30000},async()=>{
  const sourceDir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-backup-source-'));const targetDir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-backup-target-'));let targetPrompt='';
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    const hasTool=request.prompt.some(message=>message.role==='tool');targetPrompt=JSON.stringify(request.prompt);
    return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(!hasTool)c.enqueue({type:'tool-call',toolCallId:'source-context-list',toolName:'context_list',input:'{}'});else {c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'visible tool-backed answer'});c.enqueue({type:'text-end',id:'t'});}c.enqueue({type:'finish',finishReason:hasTool?'stop':'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};
  }});
  const source=await Core.open({dataDir:sourceDir,model,memoryEnabled:false});const target=await Core.open({dataDir:targetDir,model,memoryEnabled:false});
  try{
    const bytes=Buffer.from('portable synthetic attachment');const asset=await source.assets.put(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),'fixture.txt');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bAAAAABJRU5ErkJggg==','base64');const image=await source.assets.put(new ReadableStream({start(c){c.enqueue(png);c.close();}}),'fixture.png');
    const receipt=await source.submitMessage({content:'read the context catalog',attachments:[asset.id,image.id]});assert.equal((await finished(source,receipt.runId!))!.status,'succeeded');
    source.runtime.setSetting('context-compaction:main',{sourceContextId:'earlier',summary:'retained checkpoint constraint',summarizedMessages:12});
    const backup=await source.exportContinuationContext('main');assert.ok(backup.continuation);assert.ok(backup.continuation.messages.some(message=>JSON.stringify(message).includes('context_list')));
    assert.ok(!backup.continuation.messages.some(message=>JSON.stringify(message).includes('providerMetadata')));
    assert.equal(backup.continuation.assets[0]!.data,bytes.toString('base64'));
    const imported=await target.importContext({archive:backup,id:'backup.restored'});
    const restored=await target.history(imported.id);assert.match(JSON.stringify(restored.messages),/context_list/);
    const visible=conversationPage(target,imported.id).messages;const copiedAsset=visible.find(message=>message.attachments?.length)!.attachments![0]!;
    assert.notEqual(copiedAsset,asset.id);assert.deepEqual((await target.assets.read(copiedAsset)).bytes,bytes);
    const next=await target.submitMessage({contextId:imported.id,content:'continue without repeating the completed catalog tool'});assert.equal((await finished(target,next.runId!))!.status,'succeeded');
    assert.match(targetPrompt,/context_list/);assert.match(targetPrompt,/retained checkpoint constraint/);
    const altered=structuredClone(backup);altered.continuation!.assets[0]!.sha256='0'.repeat(64);await assert.rejects(target.importContext({archive:altered}),/invalid_session_archive/);
    const executable=structuredClone(backup);const call=executable.continuation!.messages.flatMap(m=>m.content.parts).find(part=>(part as {type:string}).type==='tool-invocation') as {toolInvocation:{state:string}};call.toolInvocation.state='call';assert.throws(()=>parseSessionArchive(executable),/invalid_session_archive/);
  }finally{await source.close();await target.close();await removeTemp(sourceDir);await removeTemp(targetDir);}
});

test('a lost final creation response replays the transactionally published result without creating another context',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send('source before response loss');const set=f.core.runtime.setSetting.bind(f.core.runtime);let publications=0;
  f.core.runtime.setSetting=(key,value)=>{if(key.startsWith('context-create:')&&(value as {complete?:boolean}).complete&&++publications===2)throw Error('synthetic response lost after publication');return set(key,value);};
  await assert.rejects(f.core.cloneContext('main',{name:'Once after lost response'},'http:lost-response'),/synthetic response lost/);
  f.core.runtime.setSetting=set;const existing=f.core.runtime.contexts().find(context=>context.name==='Once after lost response')!;assert.ok(existing);
  await f.reopen();const recovered=await f.core.cloneContext('main',{name:'Once after lost response'},'http:lost-response');assert.equal(recovered.id,existing.id);assert.equal(f.core.runtime.contexts().filter(context=>context.name==='Once after lost response').length,1);
 }finally{await f.close();}
});

test('continuation import refuses executable or external media references before a thread is created',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.send('portable source');const backup=await f.core.exportContinuationContext('main');const forged=structuredClone(backup);
  forged.continuation!.messages[0]!.content.parts.push({type:'file',data:'file:///etc/passwd',mimeType:'image/png'});
  await assert.rejects(f.core.importContext({archive:forged,id:'import.unsafe'}),/invalid_session_archive/);assert.equal(f.core.runtime.context('import.unsafe'),undefined);assert.equal(await f.core.memory.getThreadById({threadId:'import.unsafe'}),null);
 }finally{await f.close();}
});

test('cloning and continuation restore keep the explicitly selected thinking level across restart',{timeout:30000},async()=>{
 const f=await fixture(true);try{
  await f.send('source with thinking preference');await f.core.switchModel('main','default','high');await f.send('source after selecting high');
  const clone=await f.core.cloneContext('main',{id:'clone.thinking'});assert.equal((await f.core.modelState(clone.id)).thinkingLevel,'high');
  const backup=await f.core.exportContinuationContext('main');const imported=await f.core.importContext({archive:backup,id:'import.thinking'});assert.equal((await f.core.modelState(imported.id)).thinkingLevel,'high');
  await f.reopen();assert.equal((await f.core.modelState(clone.id)).thinkingLevel,'high');assert.equal((await f.core.modelState(imported.id)).thinkingLevel,'high');
 }finally{await f.close();}
});
