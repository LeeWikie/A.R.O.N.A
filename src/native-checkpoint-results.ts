import {MessageList,type MastraDBMessage,type MastraToolInvocationPart} from '@mastra/core/agent/message-list';
import {isDeepStrictEqual} from 'node:util';
import {getErrorFromUnknown} from '@mastra/core/error';
import {interactionAnswerCheckpoint} from './interaction-outbox.js';
import {recoveryDigest} from './run-recovery.js';
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const equal=(left:unknown,right:unknown)=>isDeepStrictEqual(left===undefined?undefined:JSON.parse(JSON.stringify(left)),right===undefined?undefined:JSON.parse(JSON.stringify(right)));
export interface NativeCheckpointCompletion {index:number;part:MastraToolInvocationPart;endedAt:number}
export interface NativeCheckpointResults {messageId:string;snapshotHash:string;original:MastraDBMessage;message:MastraDBMessage;completions:NativeCheckpointCompletion[]}
export interface NativeCheckpointProof {version:1;contextId:string;runId:string;messageId:string;snapshotHash:string;sourceHashes:Record<string,string>;calls:Record<string,string>;callEvents:Record<string,{seq:number;kind:'message_start'|'message_update';hash:string}>;parts:NativeCheckpointCompletion[];eventSeq:number;eventHash:string;startSeq:number;startHash:string;requestSeq:number;requestHash:string}
export const nativeCheckpointCallHash=(part:MastraToolInvocationPart)=>recoveryDigest({toolCallId:part.toolInvocation.toolCallId,toolName:part.toolInvocation.toolName,args:part.toolInvocation.args,providerMetadata:part.providerMetadata,providerExecuted:part.providerExecuted,title:part.title});
export const nativeCheckpointCallInputHash=(part:MastraToolInvocationPart)=>recoveryDigest({toolCallId:part.toolInvocation.toolCallId,toolName:part.toolInvocation.toolName,args:part.toolInvocation.args});
export function nativeCheckpointPartHash(part:MastraToolInvocationPart){const {createdAt:_,updatedAt:__,...content}=part;return recoveryDigest(content);}
export function nativeCheckpointMessageId(snapshot:unknown){const id=object(object(object(object(snapshot)?.context)?.['llm-execution'])?.output)?.messageId;return typeof id==='string'&&id?id:undefined;}

/** Only the original suspended tool branch owns these saved system messages. */
export function suspendedNativeSystemFrames(snapshot:unknown,address:{contextId:string;runId:string;gates:readonly {toolCallId?:string;toolName?:string}[]}):string[]|undefined{
 const state=object(snapshot),context=object(state?.context),step=object(context?.toolCallStep),messageId=nativeCheckpointMessageId(snapshot),planned=step?.payload;
 if(state?.status!=='suspended'||state.runId!==undefined&&state.runId!==address.runId||step?.status!=='suspended'||!messageId||!Array.isArray(planned)||!address.gates.length)return;
 const outputs=object(object(step.suspendPayload)?.__workflow_meta)?.foreachOutput;if(!Array.isArray(outputs)&&!object(outputs))return;
 const frames=new Set<string>();
 for(const gate of address.gates){
  const positions=planned.flatMap((value,index)=>{const call=object(value);return call&&call.toolCallId===gate.toolCallId&&call.toolName===gate.toolName?[index]:[];});if(positions.length!==1)return;
  const index=positions[0]!,call=object(planned[index])!,entry=object(Array.isArray(outputs)?outputs[index]:object(outputs)?.[String(index)]),suspend=object(entry?.suspendPayload),stream=object(suspend?.__streamState),list=object(stream?.messageList),memory=object(list?.memoryInfo);
  if(entry?.status!=='suspended'||stream?.status!=='suspended'||!suspend||suspend.toolCallId!==gate.toolCallId||suspend.toolName!==gate.toolName||memory?.threadId!==address.contextId||memory.resourceId!=='local'||!Array.isArray(list?.messages)||!Array.isArray(list.systemMessages))return;
  const assistants=list.messages.flatMap(value=>{const message=object(value);return message?.id===messageId?[message]:[];});if(assistants.length!==1)return;
  const assistant=assistants[0]!,content=object(assistant.content),parts=Array.isArray(content?.parts)?content.parts:[],calls=parts.flatMap(value=>{const part=object(value),invocation=object(part?.toolInvocation);return part?.type==='tool-invocation'&&invocation?.toolCallId===gate.toolCallId?[invocation]:[];});
  if(assistant.role!=='assistant'||assistant.threadId!==address.contextId||assistant.resourceId!=='local'||calls.length!==1||calls[0]!.toolName!==gate.toolName||!equal(calls[0]!.args,call.args))return;
  for(const value of list.systemMessages){const message=object(value);if(message?.role!=='system'||typeof message.content!=='string')return;frames.add(message.content);}
 }
 return [...frames];
}

/** Recover only completed native foreach outputs belonging to the original assistant call. */
export function completedNativeCheckpointResults(snapshot:unknown,messages:readonly MastraDBMessage[],address:{contextId:string;runId:string}):NativeCheckpointResults|undefined{
 const state=object(snapshot),context=object(state?.context),output=object(object(context?.['llm-execution'])?.output),messageId=output?.messageId;
 if(state?.status!=='suspended'||typeof messageId!=='string')return;
 const originals=messages.filter(message=>message.id===messageId&&message.role==='assistant'&&message.threadId===address.contextId&&(!message.resourceId||message.resourceId==='local'));if(originals.length!==1)return;
 const original=originals[0]!,step=object(context?.toolCallStep),payload=step?.payload;
 if(step?.status!=='suspended'||!Array.isArray(payload)||!payload.length)return;
 const calls=payload.map(object);if(calls.some(call=>typeof call?.toolCallId!=='string'||typeof call.toolName!=='string')||new Set(calls.map(call=>call!.toolCallId)).size!==calls.length)return;
 const entries=object(object(step?.suspendPayload)?.__workflow_meta)?.foreachOutput;if(!Array.isArray(entries)&&!object(entries))return;
 const completions:NativeCheckpointCompletion[]=[];
 for(const [index,part]of original.content.parts.entries()){
  if(part.type!=='tool-invocation')continue;const call=part.toolInvocation,matches=calls.flatMap((candidate,index)=>candidate?.toolCallId===call.toolCallId&&candidate.toolName===call.toolName?[index]:[]);if(matches.length!==1)continue;
  const position=matches[0]!,planned=calls[position]!,entry=object(Array.isArray(entries)?entries[position]:object(entries)?.[String(position)]),result=object(entry?.output);
  const checkpoint=interactionAnswerCheckpoint(snapshot,{...address,toolCallId:call.toolCallId,toolName:call.toolName,nativeMessageId:messageId});
  if(checkpoint?.status!=='completed'||!result||!equal(planned.args,call.args)||!equal(result.args,call.args)||!Number.isFinite(entry?.endedAt))continue;
  if(original.content.parts.filter(candidate=>candidate.type==='tool-invocation'&&candidate.toolInvocation.toolCallId===call.toolCallId).length!==1)return;
  if(!Object.prototype.hasOwnProperty.call(result,'result')&&!Object.prototype.hasOwnProperty.call(result,'error'))continue;
  const invocation:MastraToolInvocationPart['toolInvocation']={...call,state:result.isError===true?'output-error':'result',result:checkpoint.result,...(result.isError===true?{errorText:typeof checkpoint.result==='string'?checkpoint.result:JSON.stringify(checkpoint.result)}:{})};
  if(Object.prototype.hasOwnProperty.call(result,'error')){const error=getErrorFromUnknown(result.error,{fallbackMessage:'Tool execution failed'}).message;invocation.state='output-error';invocation.errorText=error.trim()?error:'Tool execution failed';delete invocation.result;}
  if(result.approval!==undefined){const approval=object(result.approval);if(!approval||approval.id!==call.toolCallId||typeof approval.approved!=='boolean')return;invocation.approval={id:call.toolCallId,approved:approval.approved,...(typeof approval.reason==='string'?{reason:approval.reason}:{})};if(approval.approved===false)invocation.state='output-denied';}
  if(['result','output-error','output-denied'].includes(call.state)){if(call.state!==invocation.state||!equal(call.result,checkpoint.result))return;continue;}
  if(call.state!=='call')continue;
  if(result.providerMetadata!==undefined&&!equal(result.providerMetadata,part.providerMetadata))return;
  completions.push({index,part:{...structuredClone(part),toolInvocation:invocation,updatedAt:Number(entry!.endedAt)},endedAt:Number(entry!.endedAt)});
 }
 if(!completions.length)return;
 const list=new MessageList({threadId:address.contextId,resourceId:'local',filterIncompleteToolCalls:false});list.add([structuredClone(original)],'memory');for(const completion of completions)if(!list.updateToolInvocation(completion.part))return;
 const message=list.get.all.db()[0];if(!message||message.id!==original.id)return;message.createdAt=original.createdAt;
 return {messageId,snapshotHash:recoveryDigest(snapshot),original,message,completions};
}
