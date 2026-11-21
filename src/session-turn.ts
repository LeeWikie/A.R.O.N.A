import {isDeepStrictEqual} from 'node:util';
import {MessageList,type UIMessageV4,type MastraDBMessage} from '@mastra/core/agent/message-list';
import {AppError} from './domain.js';

/** A persisted call snapshot can be completed by a later native result row. */
type Invocation={toolCallId?:string;toolName?:string;args?:unknown;state?:string};
type TurnPart={type?:string;toolInvocation?:Invocation};
type TurnMessage={id:string;role?:string;createdAt?:Date|string;threadId?:string;resourceId?:string;content?:{format?:number;parts?:TurnPart[];toolInvocations?:Invocation[]}};
export async function completeNativeToolRoundTrips<T extends TurnMessage>(messages:readonly T[],options:{incomplete?:'error'|'reject'}={}):Promise<T[]>{
 const pending=new Map<string,{name:string;args:unknown;part:object}>(),completedSnapshots=new Set<object>();
 const completedParts=new Map<object,object>();
 const mirrorParts=new Map<object,TurnPart>();
 const fail:()=>never=()=>{throw new AppError('branch_requires_complete_turn',409);};
 const mergeMetadata=(before:unknown,after:unknown):unknown=>{if(before===undefined)return after;if(after===undefined||isDeepStrictEqual(before,after))return before;if(!before||!after||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)||Array.isArray(after))return fail();const merged:Record<string,unknown>=Object.create(null);for(const key of new Set([...Object.keys(before),...Object.keys(after)]))merged[key]=mergeMetadata((before as Record<string,unknown>)[key],(after as Record<string,unknown>)[key]);return merged;};
 const closeIncomplete=()=>{if(!pending.size)return;if(options.incomplete!=='error')fail();for(const {part}of pending.values()){const original=part as {toolInvocation:object};completedParts.set(part,{...part,toolInvocation:{...original.toolInvocation,state:'output-error',errorText:'No result provided'}});}pending.clear();};
 for(const message of messages){if(message.role==='user'||message.role==='signal')closeIncomplete();const local=new Set<string>(),parts=[...message.content?.parts??[]];for(const mirror of message.content?.toolInvocations??[]){let source=parts.find(part=>part.type==='tool-invocation'&&isDeepStrictEqual(part.toolInvocation,mirror));if(!source){source={type:'tool-invocation',toolInvocation:mirror};parts.push(source);}mirrorParts.set(mirror,source);}for(const part of parts){
  if(part.type!=='tool-invocation')continue;const call=part.toolInvocation;if(!call)fail();
  if(!call.toolCallId||!call.toolName||local.has(call.toolCallId))fail();local.add(call.toolCallId);
  if(call.state==='call'){if(pending.has(call.toolCallId)){if(options.incomplete!=='error')fail();closeIncomplete();}pending.set(call.toolCallId,{name:call.toolName,args:call.args,part});continue;}
  if(!['result','output-error','output-denied'].includes(call.state??''))fail();
  const previous=pending.get(call.toolCallId);if(previous){if(previous.name!==call.toolName||!isDeepStrictEqual(previous.args,call.args))fail();const before=previous.part as Record<string,unknown>,after=part as Record<string,unknown>,merged={...part};for(const key of ['providerMetadata','providerOptions']){const metadata=mergeMetadata(before[key],after[key]);if(metadata!==undefined)Object.defineProperty(merged,key,{value:metadata,enumerable:true,configurable:true,writable:true});}completedParts.set(part,merged);completedSnapshots.add(previous.part);pending.delete(call.toolCallId);}
 }}
 closeIncomplete();
 // The SDK's ordinary call-state serializer adds a pending placeholder. Do not
 // let that placeholder stand in for the real completion being validated.
 const normalized=messages.map(message=>message.content?({...message,content:{...message.content,...(message.content.parts?{parts:message.content.parts.filter(part=>!completedSnapshots.has(part)).map(part=>completedParts.get(part)??part)}:{}),...(message.content.toolInvocations?{toolInvocations:message.content.toolInvocations.flatMap(call=>{const part=mirrorParts.get(call);if(part&&completedSnapshots.has(part))return [];const replacement=part&&completedParts.get(part) as TurnPart|undefined;return [replacement?.toolInvocation??call];})}:{})}}):message) as T[];
 const list=new MessageList({threadId:'session-verification',resourceId:'local',filterIncompleteToolCalls:false});
 const native=(message:TurnMessage):message is MastraDBMessage=>message.createdAt instanceof Date&&message.content?.format===2&&Array.isArray(message.content.parts)&&['user','assistant','system'].includes(message.role??'');
 const nativeRows=normalized.filter((message):message is T&MastraDBMessage=>native(message));if(nativeRows.length===normalized.length)list.add(nativeRows,'memory');else list.add(normalized.map(message=>({id:message.id,role:message.role==='assistant'?'assistant':message.role==='system'?'system':'user',parts:message.content?.parts??[],toolInvocations:message.content?.toolInvocations})) as UIMessageV4[],'memory');
 const restored=new MessageList({threadId:'session-verification',resourceId:'local',filterIncompleteToolCalls:false});restored.deserialize(list.serialize());
 const open=new Map<string,string>();
 for(const message of await restored.get.all.aiV5.llmPrompt()){
  if(message.role==='assistant'){for(const part of message.content){if(part.type!=='tool-call')continue;if(open.has(part.toolCallId))fail();open.set(part.toolCallId,part.toolName);}}
  else if(message.role==='tool'){for(const part of message.content){if(part.type!=='tool-result')continue;if(open.get(part.toolCallId)!==part.toolName)fail();open.delete(part.toolCallId);}}
  else if(open.size)fail();
 }
 if(open.size)fail();return normalized;
}
export async function assertCompleteSessionTurn(messages:readonly TurnMessage[]){await completeNativeToolRoundTrips(messages);}
