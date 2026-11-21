import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {splitQueueText} from '../src/queue-content.js';
import {parseSessionArchive} from '../src/context-transfer.js';
import type {ConversationPage,SessionTreeNode} from '../src/protocol.js';
import {authenticatedApp,finished,removeTemp,until} from './helpers.js';

test('a large logical input keeps one history/tree boundary and all native sources across continuation, fork, clone and portable backup',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-logical-session-')),other=fs.mkdtempSync(path.join(os.tmpdir(),'arona-logical-import-'));let release!:()=>void,calls=0;const prompts:string[]=[],gate=new Promise<void>(resolve=>{release=resolve;});
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(++calls===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'synthetic-answer'});c.enqueue({type:'text-delta',id:'synthetic-answer',delta:'SYNTHETIC_LOGICAL_REPLY'});c.enqueue({type:'text-end',id:'synthetic-answer'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
  let core=await Core.open({dataDir:directory,model,memoryEnabled:false}),imported:Core|undefined;
  const content='逻辑原文'.repeat(20000)+'SYNTHETIC_LOGICAL_END',hash=createHash('sha256').update(content).digest('hex');
  const users=(nodes:SessionTreeNode[]):SessionTreeNode[]=>nodes.flatMap(node=>[...(node.entry.type==='message'&&node.entry.message.role==='user'?[node]:[]),...users(node.children)]);
  const conversation=async(host:Core,contextId='main')=>await (await authenticatedApp(host).request(`/conversation?contextId=${contextId}&limit=200`)).json() as ConversationPage;
  try{
    const active=await core.submitMessage({content:'SYNTHETIC_ACTIVE'});await until(()=>calls,n=>n===1);
    const assets=[];for(let i=0;i<9;i++)assets.push(await core.assets.put(new Response(`LOGICAL_ATTACHMENT_${i}`).body,`logical-${i}.txt`));
    await core.submitMessage({content:'SYNTHETIC_LOCAL_SHELL_DATA\nshort source',sourceText:'short source',mode:'queue'});
    const draft=core.queueEditor().create('main',{},'logical-capture'),entry=core.queueEditor().page('main',draft.id).entries[0]!,parts=splitQueueText(content);
    const upload=core.queueEditor().beginEntryEdit('main',draft.id,{entryId:entry.id,expectedRevision:draft.revision,partCount:parts.length,characters:content.length,hash,attachments:assets.map(asset=>asset.id)},'logical-upload');
    for(const [index,part]of parts.entries())core.queueEditor().writeEntryPart('main',draft.id,upload.id,index,{content:part});
    const edited=core.queueEditor().commitEntryEdit('main',draft.id,upload.id);await core.queueEditor().submit('main',draft.id,{expectedRevision:edited.revision},'logical-send');release();await finished(core,active.runId!);
    const submitted=await until(()=>core.queueEditor().page('main',draft.id).draft,value=>value.status==='submitted'),signals=submitted.submission!.entries.map(row=>core.store.getSignal(row.signalId)!);assert.equal(signals.length,2);assert.equal(new Set(signals.map(signal=>signal.runId)).size,1);await finished(core,signals[0]!.runId!);
    assert.equal(calls,2);for(let i=0;i<9;i++)assert.match(prompts[1]!,new RegExp(`LOGICAL_ATTACHMENT_${i}`));assert.match(prompts[1]!,/SYNTHETIC_LOCAL_SHELL_DATA/);assert.match(prompts[1]!,/SYNTHETIC_LOGICAL_END/);
    let page=await conversation(core);assert.deepEqual(page.messages.filter(row=>row.role==='user').map(row=>row.content),['SYNTHETIC_ACTIVE',content]);assert.deepEqual(page.messages.find(row=>row.content===content)!.attachments,assets.map(asset=>asset.id));
    const tree=await core.sessionTree('main'),logical=users(tree.tree).find(node=>node.entry.type==='message'&&node.entry.message.role==='user'&&node.entry.message.content===content)!;assert.ok(logical);assert.equal(users(tree.tree).length,2);
    const record=core.sessionGraph.records('main').find(row=>row.entry.id===logical.entry.id)!;assert.deepEqual(record.source!.messageIds,signals.map(signal=>signal.nativeSignalId));for(const id of record.source!.messageIds!)assert.ok(core.sessionGraph.source('main',id));
    const next=await core.submitMessage({content:'SYNTHETIC_FOLLOW_UP'});await finished(core,next.runId!);for(const signal of signals)assert.ok(prompts.at(-1)!.includes(signal.id),'same-storage replay keeps every original native signal identity');
    const fork=await core.forkSessionEntry('main',logical.entry.id,{id:'chat.logical-fork'});assert.equal(fork.draft,content);assert.deepEqual((await conversation(core,fork.context.id)).messages.filter(row=>row.role==='user').map(row=>row.content),['SYNTHETIC_ACTIVE']);
    const clone=await core.cloneContext('main',{id:'chat.logical-clone'});assert.deepEqual((await conversation(core,clone.id)).messages.filter(row=>row.role==='user').map(row=>row.content),['SYNTHETIC_ACTIVE',content,'SYNTHETIC_FOLLOW_UP']);const cloneReply=await core.submitMessage({contextId:clone.id,content:'SYNTHETIC_CLONE_CONTINUE'});await finished(core,cloneReply.runId!);assert.match(prompts.at(-1)!,/SYNTHETIC_LOGICAL_END/);for(let i=0;i<9;i++)assert.match(prompts.at(-1)!,new RegExp(`LOGICAL_ATTACHMENT_${i}`));
    const archive=await core.exportContinuationContext('main');assert.equal(archive.continuation!.assets.length,9);
    for(const change of ['content','member','public'] as const){const invalid=structuredClone(archive),graph=invalid.continuation!.graph!,group=graph.entries.find(row=>row.source?.logicalInputId)!;if(change==='content'){const raw=graph.sources.find(value=>value&&typeof value==='object'&&'id'in value&&value.id===group.source!.logicalInputId) as {content:string;contentHash:string};raw.content+='ALTERED';raw.contentHash=createHash('sha256').update(raw.content).digest('hex');}if(change==='member')group.source!.messageIds![1]=group.source!.messageIds![0]!;if(change==='public')invalid.messages.find(row=>row.content===content)!.attachments!.pop();assert.throws(()=>parseSessionArchive(invalid),/invalid_session_archive/);}
    imported=await Core.open({dataDir:other,model,memoryEnabled:false});const target=await imported.importContext({archive,id:'chat.logical-import'});page=await conversation(imported,target.id);assert.deepEqual(page.messages.filter(row=>row.role==='user').map(row=>row.content),['SYNTHETIC_ACTIVE',content,'SYNTHETIC_FOLLOW_UP']);assert.equal(page.messages.find(row=>row.content===content)!.attachments?.length,9);const continued=await imported.submitMessage({contextId:target.id,content:'SYNTHETIC_IMPORTED_CONTINUE'});await finished(imported,continued.runId!);assert.match(prompts.at(-1)!,/SYNTHETIC_LOGICAL_END/);for(let i=0;i<9;i++)assert.match(prompts.at(-1)!,new RegExp(`LOGICAL_ATTACHMENT_${i}`));
    await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});assert.equal(users((await core.sessionTree('main')).tree).filter(node=>node.entry.type==='message'&&node.entry.message.role==='user'&&node.entry.message.content===content).length,1);assert.equal((await conversation(core)).messages.filter(row=>row.content===content).length,1);
  }finally{release();await core.close();await imported?.close();await removeTemp(directory);await removeTemp(other);}
});
