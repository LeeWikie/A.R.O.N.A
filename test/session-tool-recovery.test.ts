import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {MessageList,type MastraToolInvocationPart} from '@mastra/core/agent/message-list';
import {nativeSessionEntries} from '../src/providers/session-replay.js';
import {SessionGraph,type SessionGraphRecord} from '../src/session-graph.js';
import {planSessionToolRepair} from '../src/session-tool-recovery.js';

async function fixture(){
 const contextId='synthetic-context',runId='synthetic-run',list=new MessageList({threadId:contextId,resourceId:'local',generateMessageId:()=> 'original-native-assistant',filterIncompleteToolCalls:false});list.add([{role:'assistant',content:[{type:'text',text:'Original assistant body.'},{type:'tool-call',toolCallId:'actual-completed-call',toolName:'synthetic_tool',input:{file:'original.txt'}}]}],'memory');const original=structuredClone(list.get.all.db()[0]!);
 const part:MastraToolInvocationPart={type:'tool-invocation',toolInvocation:{state:'result',toolCallId:'actual-completed-call',toolName:'synthetic_tool',args:{file:'original.txt'},result:{content:[{type:'text',text:'ACTUAL_COMPLETED_RESULT'}]},isError:false}};assert.equal(list.updateToolInvocation(part),true);const completed=structuredClone(list.get.all.db()[0]!);completed.createdAt=original.createdAt;
 const sourceRecords=await nativeSessionEntries([original],null);for(const row of sourceRecords)row.source!.runId=runId;
 const suffix=new MessageList({threadId:contextId,resourceId:'local',generateMessageId:(()=>{let n=0;return()=>`suffix-native-${++n}`;})()});suffix.add([{role:'user',content:'A later actual user message.'},{role:'assistant',content:'A later actual answer.'}],'memory');const suffixMessages=suffix.get.all.db(),suffixRecords=await nativeSessionEntries(suffixMessages,sourceRecords.at(-1)!.entry.id);for(const row of suffixRecords)row.source!.runId='later-run';
 const records=[...sourceRecords,...suffixRecords];let parent=records.at(-1)!.entry.id;const timestamp=new Date().toISOString();for(const entry of [{type:'context_edit' as const,id:'edit-later-answer',targetId:suffixRecords.at(-1)!.entry.id,replacement:{content:[{type:'text' as const,text:'Edited later answer.'}]}},{type:'label' as const,id:'label-later-answer',targetId:suffixRecords.at(-1)!.entry.id,label:'Important later answer'},{type:'compaction' as const,id:'later-compaction',summary:'Earlier work was summarized.',tokensBefore:100,firstKeptEntryId:suffixRecords[0]!.entry.id}]){records.push({entry:{...entry,parentId:parent,timestamp}});parent=entry.id;}
 const db=new DatabaseSync(':memory:'),graph=new SessionGraph(db);graph.create(contextId,{type:'session',version:3,id:contextId,timestamp,cwd:'/synthetic'},records);for(const message of [original,...suffixMessages])graph.saveSource(contextId,message.id,message);
 const input=()=>({contextId,runId,leafId:graph.head(contextId)!.leafId,revision:graph.head(contextId)!.revision,records:graph.records(contextId),branch:graph.manager(contextId).getBranch(),messages:[completed],completions:[{messageId:original.id,toolCallId:'actual-completed-call',startSeq:1,partSeq:2,endSeq:3,part}]});return {db,graph,original,completed,sourceRecords,suffixRecords,input};
}

test('append-only tool repair preserves the complete later suffix, native sources and edit/label/compaction targets',async()=>{
 const value=await fixture();try{const {graph,input,db}=value,records=graph.records('synthetic-context'),raw=graph.sources('synthetic-context'),plan=await planSessionToolRepair(input());assert.ok(plan);assert.equal(plan.sources.length,1);graph.append(plan.contextId,plan.records,plan.fromRevision);for(const source of plan.sources)graph.saveSource(plan.contextId,source.id,source);
  assert.deepEqual(graph.records(plan.contextId).slice(0,records.length),records);assert.deepEqual(graph.sources(plan.contextId).slice(0,raw.length),raw);const branch=graph.manager(plan.contextId).getBranch();assert.ok(branch.some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&JSON.stringify(entry.message).includes('ACTUAL_COMPLETED_RESULT')));assert.equal(branch.filter(entry=>entry.type==='message'&&entry.message.role==='user').length,1);
  const edit=branch.find(entry=>entry.type==='context_edit')!,label=branch.find(entry=>entry.type==='label')!,compaction=branch.find(entry=>entry.type==='compaction')!;assert.equal(edit.type,'context_edit');assert.equal(label.type,'label');assert.equal(compaction.type,'compaction');if(edit.type==='context_edit'&&label.type==='label'&&compaction.type==='compaction'){assert.equal(edit.targetId,plan.entryMap[value.suffixRecords.at(-1)!.entry.id]);assert.equal(label.targetId,edit.targetId);assert.equal(compaction.firstKeptEntryId,plan.entryMap[value.suffixRecords[0]!.entry.id]);}
  const projected=graph.manager(plan.contextId).buildSessionProjection();assert.equal(JSON.stringify(projected.messages).includes('ACTUAL_COMPLETED_RESULT'),false,'a later real compaction still excludes its original prefix');assert.ok(JSON.stringify(projected.messages).includes('Edited later answer.'));assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
 }finally{value.db.close();}
});

for(const mode of ['selected-before-call','explicit-edit','known-result-on-another-branch'] as const)test(`tool repair respects an intentional historical selection: ${mode}`,async()=>{
 const value=await fixture();try{const {graph,input,sourceRecords}=value;let state=input();
  if(mode==='selected-before-call')state={...state,branch:[]};
  if(mode==='explicit-edit'){const row:SessionGraphRecord={entry:{type:'context_edit',id:'intentional-removal',parentId:state.leafId,timestamp:new Date().toISOString(),targetId:sourceRecords[0]!.entry.id,replacement:null}};state={...state,records:[...state.records,row],branch:[...state.branch,row.entry]};}
  if(mode==='known-result-on-another-branch'){const actual=await nativeSessionEntries([value.completed],sourceRecords[0]!.entry.id),result=actual.find(row=>row.entry.type==='message'&&row.entry.message.role==='toolResult')!;result.source!.runId=state.runId;state={...state,records:[...state.records,result]};}
  assert.equal(await planSessionToolRepair(state),undefined);assert.deepEqual(graph.records(state.contextId),input().records);
 }finally{value.db.close();}
});
