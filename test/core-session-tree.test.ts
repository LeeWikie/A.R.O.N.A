import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { conversationPage } from '../src/event-stream.js';
import { authenticatedApp, finished, removeTemp } from './helpers.js';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

const at='2026-01-02T03:04:05.000Z';
const user=(id:string,parentId:string|null,text:string):SessionEntry=>({type:'message',id,parentId,timestamp:at,message:{role:'user',content:text,timestamp:1}});
const file=(entries:SessionEntry[])=>[{type:'session',version:3,id:'synthetic-native',timestamp:at,cwd:'/never-register-external-cwd'},...entries].map(row=>JSON.stringify(row)).join('\n');
async function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-session-tree-'));const prompts:string[]=[];let blockSummary=false;const model=new MastraLanguageModelV2Mock({doStream:async request=>{const prompt=JSON.stringify(request.prompt);prompts.push(prompt);const summary=!request.tools?.length;if(blockSummary&&summary)await new Promise<void>((_resolve,reject)=>{const abort=()=>reject(new DOMException('Synthetic summary cancelled','AbortError'));request.abortSignal?.addEventListener('abort',abort,{once:true});if(request.abortSignal?.aborted)abort();});return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'text'});c.enqueue({type:'text-delta',id:'text',delta:summary?'SYNTHETIC_COMPACTION_SUMMARY':'SYNTHETIC_PUBLISHED_ANSWER'});c.enqueue({type:'text-end',id:'text'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});let core=await Core.open({dataDir:dir,model,memoryEnabled:false});return {get core(){return core;},dir,prompts,blockSummary(value:boolean){blockSummary=value;},async send(content:string,contextId='main'){const receipt=await core.submitMessage({content,contextId});await finished(core,receipt.runId!);assert.equal(core.store.getRun(receipt.runId!)!.status,'succeeded');return receipt;},async reopen(){await core.close();core=await Core.open({dataDir:dir,model,memoryEnabled:false});},async close(){await core.close();await removeTemp(dir);}};}

test('same-context navigation changes actual native context and retains abandoned siblings across restart',async()=>{
  const f=await fixture();try{await f.send('FIRST_SOURCE');await f.send('ABANDONED_SECOND_SOURCE');
    const tree=await f.core.sessionTree('main');const records=f.core.sessionGraph.records('main');const second=records.find(row=>row.entry.type==='message'&&row.entry.message.role==='user'&&JSON.stringify(row.entry.message.content).includes('ABANDONED_SECOND_SOURCE'))!;
    const navigation=await f.core.navigateSession('main',{targetId:second.entry.id,expectedRevision:tree.revision,expectedLeafId:tree.leafId},'synthetic-navigation');assert.equal(navigation.context.id,'main');assert.equal(navigation.draft,'ABANDONED_SECOND_SOURCE');
    assert.ok(!conversationPage(f.core,'main').messages.some(row=>row.content.includes('ABANDONED_SECOND_SOURCE')));
    await f.send('REPLACEMENT_SOURCE');assert.ok(f.prompts.at(-1)!.includes('FIRST_SOURCE'));assert.ok(f.prompts.at(-1)!.includes('REPLACEMENT_SOURCE'));assert.ok(!f.prompts.at(-1)!.includes('ABANDONED_SECOND_SOURCE'));
    assert.ok(f.core.sessionGraph.records('main').some(row=>row.entry.id===second.entry.id));const head=f.core.sessionGraph.head('main');await f.reopen();assert.deepEqual(f.core.sessionGraph.head('main'),head);
    const replay=await f.core.navigateSession('main',{targetId:second.entry.id,expectedRevision:tree.revision,expectedLeafId:tree.leafId},'synthetic-navigation');assert.deepEqual(replay,navigation);
  }finally{await f.close();}
});

test('native JSONL imports whole tree and applies real context edits and compaction while foreign cwd/extensions grant nothing',async()=>{
  const f=await fixture();try{
    const entries:SessionEntry[]=[user('first',null,'SUMMARIZED_ORIGINAL'),user('kept','first','KEPT_ORIGINAL'),user('sibling','first','SIBLING_ONLY'),{type:'custom',id:'extension',parentId:'sibling',timestamp:at,customType:'executable-extension',data:{command:'must-not-execute'}},{type:'label',id:'label',parentId:'extension',targetId:'kept',label:'synthetic label',timestamp:at},{type:'compaction',id:'compact',parentId:'kept',timestamp:at,summary:'SYNTHETIC_SUMMARY',firstKeptEntryId:'kept',tokensBefore:100},{type:'context_edit',id:'edit',parentId:'compact',timestamp:at,targetId:'kept',replacement:{content:'EDITED_KEPT'}}];
    const app=authenticatedApp(f.core);const response=await app.request('/contexts/import-pi',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'native-import'},body:JSON.stringify({jsonl:file(entries),id:'imported.tree',modelProfile:'default'})});assert.equal(response.status,201,await response.text());
    const tree=await f.core.sessionTree('imported.tree');assert.equal(tree.leafId,'edit');assert.equal(f.core.sessionGraph.records('imported.tree').length,entries.length);assert.equal(f.core.sessionGraph.manager('imported.tree').getLabel('kept'),'synthetic label');assert.equal(f.core.capabilities.roots().some(root=>root.path==='/never-register-external-cwd'),false);
    await f.send('CURRENT_AUTHORIZED_INPUT','imported.tree');const prompt=f.prompts.at(-1)!;assert.ok(prompt.includes('SYNTHETIC_SUMMARY'));assert.ok(prompt.includes('EDITED_KEPT'));assert.ok(!prompt.includes('KEPT_ORIGINAL'));assert.ok(!prompt.includes('SUMMARIZED_ORIGINAL'));assert.ok(!prompt.includes('SIBLING_ONLY'));assert.ok(!prompt.includes('must-not-execute'));
    await f.reopen();assert.equal(f.core.sessionGraph.manager('imported.tree').getEntry('sibling')?.id,'sibling');
  }finally{await f.close();}
});

test('session browser searches source messages and label CAS survives response retry without duplicate events',async()=>{
  const f=await fixture();try{await f.send('HIDDEN_IN_SESSION_SEARCH');const tree=await f.core.sessionTree('main');const first=f.core.sessionGraph.records('main').find(row=>row.entry.type==='message'&&row.entry.message.role==='user')!;
    await f.core.labelSessionEntry('main',first.entry.id,'bookmark',tree.revision,'label-op');const after=f.core.sessionGraph.head('main');await f.core.labelSessionEntry('main',first.entry.id,'bookmark',tree.revision,'label-op');assert.deepEqual(f.core.sessionGraph.head('main'),after);
    await assert.rejects(f.core.labelSessionEntry('main',first.entry.id,'changed',tree.revision),/session_revision_conflict/);
    const list=await f.core.browseSessions({scope:'all'});assert.ok(list.sessions[0]!.allMessagesText.includes('HIDDEN_IN_SESSION_SEARCH'));assert.equal(list.sessions[0]!.firstMessage,'HIDDEN_IN_SESSION_SEARCH');
  }finally{await f.close();}
});

test('full tree clones and imported before-user forks preserve siblings and independent labels, then private backups restore the selected graph',async()=>{
  const f=await fixture();try{await f.send('ROOT_USER');await f.send('ABANDONED_USER');const second=f.core.sessionGraph.records('main').find(row=>row.entry.type==='message'&&row.entry.message.role==='user'&&JSON.stringify(row.entry.message.content).includes('ABANDONED_USER'))!;
    await f.core.navigateSession('main',{targetId:second.entry.id});await f.send('CURRENT_BRANCH_USER');const originalIds=f.core.sessionGraph.records('main').map(row=>row.entry.id);const leaf=f.core.sessionGraph.head('main')!.leafId;
    const clone=await f.core.cloneContext('main',{id:'clone.tree'});assert.deepEqual(f.core.sessionGraph.records(clone.id).map(row=>row.entry.id),originalIds);assert.equal(f.core.sessionGraph.head(clone.id)!.leafId,leaf);
    await f.core.labelSessionEntry(clone.id,second.entry.id,'clone-only');assert.equal(f.core.sessionGraph.manager('main').getLabel(second.entry.id),undefined);
    const fork=await f.core.forkSessionEntry(clone.id,second.entry.id,{id:'fork.tree'});assert.equal(fork.draft,'ABANDONED_USER');assert.ok(!JSON.stringify((await f.core.history(fork.context.id)).messages).includes('CURRENT_BRANCH_USER'));
    const archive=await f.core.exportContinuationContext('main');assert.ok(archive.continuation?.graph);assert.equal(archive.continuation.graph.leafId,leaf);const restored=await f.core.importContext({archive,id:'restore.tree'});
    assert.deepEqual(f.core.sessionGraph.records(restored.id).map(row=>row.entry.id),originalIds);assert.equal(f.core.sessionGraph.head(restored.id)!.leafId,leaf);await f.send('AFTER_PRIVATE_RESTORE',restored.id);assert.ok(f.prompts.at(-1)!.includes('CURRENT_BRANCH_USER'));assert.ok(!f.prompts.at(-1)!.includes('ABANDONED_USER'));
    await f.core.navigateSession(restored.id,{targetId:second.entry.id});await f.send('RESTORED_SIBLING_REWRITE',restored.id);assert.ok(!f.prompts.at(-1)!.includes('CURRENT_BRANCH_USER'));
  }finally{await f.close();}
});

test('native imported image URLs and invalid content are rejected before creating contexts or making requests',async()=>{
  const f=await fixture();try{const app=authenticatedApp(f.core);const malicious={type:'message',id:'external',parentId:null,timestamp:at,message:{role:'user',timestamp:1,content:[{type:'image',mimeType:'image/png',data:'https://example.invalid/never-fetch'}]}};
    const response=await app.request('/contexts/import-pi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonl:JSON.stringify({type:'session',version:3,id:'synthetic',timestamp:at,cwd:'/sensitive'})+'\n'+JSON.stringify(malicious),id:'refused.import'})});assert.equal(response.status,400);assert.equal(f.core.runtime.context('refused.import'),undefined);assert.equal(f.prompts.length,0);
  }finally{await f.close();}
});

test('manual compaction appends a same-context checkpoint, preserves source bytes and survives repeated compaction and restart',async()=>{
  const f=await fixture();try{await f.send('OLD_EXACT_BYTES '+ 'old payload '.repeat(3000));await f.send('RECENT_KEEP '+ 'recent detail '.repeat(400));const original=f.core.sessionGraph.sources('main').map(row=>JSON.stringify(row));const result=await f.core.compactContext('main',{inPlace:true,keepRecentTokens:1000,instructions:'synthetic focus'});assert.equal(result.context.id,'main');assert.equal(f.core.runtime.contexts().length,1);assert.ok(result.summarizedMessages>0);for(const source of original)assert.ok(f.core.sessionGraph.sources('main').some(row=>JSON.stringify(row)===source));
    assert.equal(f.core.sessionGraph.records('main').filter(row=>row.entry.type==='compaction').length,1);await f.send('AFTER_MANUAL');assert.ok(f.prompts.at(-1)!.includes('SYNTHETIC_COMPACTION_SUMMARY'));assert.ok(!f.prompts.at(-1)!.includes('old payload old payload'));
    await f.send('SECOND_OLD_BYTES '+ 'new payload '.repeat(3000));await f.send('SECOND_RECENT '+ 'recent detail '.repeat(400));await f.core.compactContext('main',{inPlace:true,keepRecentTokens:1000});assert.equal(f.core.sessionGraph.records('main').filter(row=>row.entry.type==='compaction').length,2);await f.reopen();await f.send('RESTART_AFTER_COMPACTION');assert.ok(f.prompts.at(-1)!.includes('SYNTHETIC_COMPACTION_SUMMARY'));assert.ok(!f.prompts.at(-1)!.includes('new payload new payload'));
  }finally{await f.close();}
});

test('HTTP summary cancellation and concurrent navigation leave the native model and canonical cursor unchanged',async()=>{
  const f=await fixture();try{await f.send('FIRST');await f.send('SECOND');const first=f.core.sessionGraph.records('main').find(row=>row.entry.type==='message'&&row.entry.message.role==='user')!;const before=f.core.sessionGraph.head('main');const model=await f.core.modelState('main');f.blockSummary(true);const controller=new AbortController();const app=authenticatedApp(f.core);
    const navigation=app.request(new Request('http://localhost/contexts/main/tree/navigate',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','Idempotency-Key':'cancel-summary'},body:JSON.stringify({targetId:first.entry.id,summarize:true,expectedRevision:before!.revision,expectedLeafId:before!.leafId})}));
    for(let attempt=0;attempt<100&&!f.prompts.some(prompt=>prompt.includes('context checkpoint summary'));attempt++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(f.prompts.some(prompt=>prompt.includes('context checkpoint summary')));
    await assert.rejects(f.core.navigateSession('main',{targetId:null}),/context_busy/);controller.abort();const cancelled=await navigation;assert.notEqual(cancelled.status,200);assert.deepEqual(f.core.sessionGraph.head('main'),before);assert.equal((await f.core.modelState('main')).profileId,model.profileId);assert.equal(f.core.runtime.setting('session-navigation-pending:main',null),null);
    f.blockSummary(false);await f.send('AFTER_CANCEL');assert.ok(f.prompts.at(-1)!.includes('SECOND'));
  }finally{await f.close();}
});

test('imported equal timestamps retain canonical message order across public pagination and restart',async()=>{
  const f=await fixture();try{await f.core.importPiContext({id:'ordered.tree',modelProfile:'default',jsonl:file([user('z-first',null,'FIRST'),{...user('a-second','z-first','SECOND'),timestamp:'2025-01-01T00:00:00.000Z'},user('m-third','a-second','THIRD')])});
    assert.deepEqual(conversationPage(f.core,'ordered.tree').messages.map(row=>row.content),['FIRST','SECOND','THIRD']);let cursor:string|undefined;const messages:string[]=[];for(let index=0;index<3;index++){const page=conversationPage(f.core,'ordered.tree',cursor,1);assert.equal(page.messages.length,1);messages.push(page.messages[0]!.content);cursor=page.nextCursor??undefined;}assert.deepEqual(messages,['FIRST','SECOND','THIRD']);await f.reopen();assert.deepEqual(conversationPage(f.core,'ordered.tree').messages.map(row=>row.content),messages);
  }finally{await f.close();}
});

test('native source reuse cannot bypass a canonical context edit or rewrite the original native row',async()=>{
  const f=await fixture();try{await f.send('SYNTHETIC_ORIGINAL_CONTEXT_TEXT');const record=f.core.sessionGraph.records('main').find(row=>row.entry.type==='message'&&row.entry.message.role==='user')!;const sourceId=record.source!.messageId;const original=(await f.core.memory.recall({threadId:'main',page:0,perPage:100,hideSignals:false})).messages.find(row=>row.id===sourceId)!;const originalBytes=JSON.stringify(original.content);const head=f.core.sessionGraph.head('main')!;
    f.core.sessionGraph.append('main',[{entry:{type:'context_edit',id:'synthetic-context-edit',parentId:head.leafId,timestamp:new Date().toISOString(),targetId:record.entry.id,replacement:{content:'SYNTHETIC_CHANGED_CONTEXT_TEXT'}}}],head.revision);
    await f.send('CONTINUE_EDITED_CONTEXT');assert.ok(f.prompts.at(-1)!.includes('SYNTHETIC_CHANGED_CONTEXT_TEXT'));assert.ok(!f.prompts.at(-1)!.includes('SYNTHETIC_ORIGINAL_CONTEXT_TEXT'));assert.equal(JSON.stringify((await f.core.memory.recall({threadId:'main',page:0,perPage:100,hideSignals:false})).messages.find(row=>row.id===sourceId)!.content),originalBytes);
  }finally{await f.close();}
});
