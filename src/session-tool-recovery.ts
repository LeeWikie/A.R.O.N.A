import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import {nativeSessionEntries,type NativeSessionMessage} from './providers/session-replay.js';
import type {SessionGraphRecord} from './session-graph.js';
import type {NativeToolCompletion} from './native-tool-recovery.js';

export interface SessionToolRepairPlan {id:string;contextId:string;runId:string;fromLeafId:string|null;fromRevision:number;records:SessionGraphRecord[];sources:NativeSessionMessage[];originalSourceIds:string[];completions:NativeToolCompletion[];entryMap:Record<string,string>}
export interface SessionToolRepairReceipt {version:1;id:string;contextId:string;runId:string;status:'published';sourceMap:Record<string,string>;originalHashes:Record<string,string>;sourceHashes:Record<string,string>;entryMap:Record<string,string>;completions?:Array<Pick<NativeToolCompletion,'messageId'|'toolCallId'|'startSeq'|'partSeq'|'endSeq'|'origin'>>;digest:string}
const id=(...values:string[])=>'repair.'+createHash('sha256').update(JSON.stringify(values)).digest('hex');
const equivalent=(left:SessionEntry,right:SessionEntry)=>left.type===right.type&&(left.type==='message'&&right.type==='message'?isDeepStrictEqual(JSON.parse(JSON.stringify(left.message)),JSON.parse(JSON.stringify(right.message))):false);

/** Make an append-only correction branch; every previous node and native source stays intact. */
export async function planSessionToolRepair(input:{contextId:string;runId:string;leafId:string|null;revision:number;records:SessionGraphRecord[];branch:SessionEntry[];messages:NativeSessionMessage[];completions:NativeToolCompletion[]}):Promise<SessionToolRepairPlan|undefined>{
 const selected=new Set(input.branch.map(entry=>entry.id)),byId=new Map(input.records.map(record=>[record.entry.id,record]));
 const changes=new Map<string,{records:SessionGraphRecord[];source:NativeSessionMessage;original:SessionGraphRecord[]}>();
 const safe:NativeToolCompletion[]=[];
 for(const message of input.messages){
  const completions=input.completions.filter(value=>value.messageId===message.id);if(!completions.length)continue;
  const original=input.records.filter(record=>record.source?.messageId===message.id);if(!original.length||original.some(record=>record.source?.runId!==input.runId||!selected.has(record.entry.id)))continue;
  const originalIds=new Set(original.map(record=>record.entry.id));
  if(input.records.some(record=>record.entry.type==='context_edit'&&originalIds.has(record.entry.targetId)))continue;
  if(completions.some(completion=>input.records.some(record=>record.source?.runId===input.runId&&(record.source.messageId===message.id||record.source.originalNativeMessageId===message.id)&&record.entry.type==='message'&&record.entry.message.role==='toolResult'&&record.entry.message.toolCallId===completion.toolCallId)))continue;
  const positions=original.map(record=>input.branch.findIndex(entry=>entry.id===record.entry.id)).sort((a,b)=>a-b);if(positions.some((position,index)=>index>0&&position!==positions[index-1]!+1))continue;
  const source={...message,id:id(input.contextId,input.runId,message.id,JSON.stringify(completions.map(value=>[value.startSeq,value.partSeq,value.endSeq,value.part])))};
  const records=await nativeSessionEntries([source],null);
  if(records.some(record=>record.entry.type!=='message')||original.some(record=>!records.some(candidate=>equivalent(record.entry,candidate.entry))))continue;
  if(completions.some(completion=>!records.some(record=>record.entry.type==='message'&&record.entry.message.role==='toolResult'&&record.entry.message.toolCallId===completion.toolCallId)))continue;
  changes.set(message.id,{records,source,original});safe.push(...completions);
 }
 if(!changes.size)return;
 const repairId=id(input.contextId,input.runId,...[...changes.values()].map(value=>value.source.id));const start=input.branch.findIndex(entry=>changes.has(byId.get(entry.id)?.source?.messageId??''));if(start<0)return;
 const output:SessionGraphRecord[]=[],entryMap:Record<string,string>=Object.create(null),handled=new Set<string>();
 for(const entry of input.branch.slice(start)){
  const original=byId.get(entry.id)!;const change=changes.get(original.source?.messageId??'');
  if(change){if(handled.has(original.source!.messageId))continue;handled.add(original.source!.messageId);
   for(const record of change.records){const old=change.original.find(candidate=>equivalent(candidate.entry,record.entry));if(old)entryMap[old.entry.id]=record.entry.id;record.source={...record.source,messageId:change.source.id,runId:input.runId,originalNativeMessageId:original.source!.messageId,recoveryId:repairId,...(old?{recoveredFromEntryId:old.entry.id,publicMessageIds:old.source?.publicMessageIds}:{})};output.push(record);}
  }else{const copy=structuredClone(original);copy.entry.id=id(repairId,entry.id);entryMap[entry.id]=copy.entry.id;copy.source={...(copy.source??{messageId:`entry:${entry.id}`}),recoveredFromEntryId:entry.id,recoveryId:repairId};output.push(copy);}
 }
 let parent=input.branch[start-1]?.id??null;
 for(const record of output){const entry=record.entry;entry.parentId=parent;parent=entry.id;if(entry.type==='context_edit'||entry.type==='label')entry.targetId=entryMap[entry.targetId]??entry.targetId;if(entry.type==='compaction')entry.firstKeptEntryId=entryMap[entry.firstKeptEntryId]??entry.firstKeptEntryId;if(entry.type==='branch_summary'&&entry.fromId)entry.fromId=entryMap[entry.fromId]??entry.fromId;}
 return {id:repairId,contextId:input.contextId,runId:input.runId,fromLeafId:input.leafId,fromRevision:input.revision,records:output,sources:[...changes.values()].map(value=>value.source),originalSourceIds:[...changes.keys()],completions:safe,entryMap};
}
