import {MessageList,type MastraDBMessage,type MastraToolInvocationPart} from '@mastra/core/agent/message-list';
import type {AgentControllerEvent} from '@mastra/core/agent-controller';
import {isDeepStrictEqual} from 'node:util';
import {recoveryDigest} from './run-recovery.js';

export interface NativeToolRecoveryEvent {seq:number;contextId:string;runId:string|null;kind:string;data:unknown}
export interface NativeToolCompletion {messageId:string;toolCallId:string;startSeq:number;partSeq:number;endSeq:number;part:MastraToolInvocationPart;origin?:{kind:'native-checkpoint';snapshotHash:string}|{kind:'mcp-capture';receiptId:string;receiptHash:string}}
export interface NativeToolRecovery {messages:MastraDBMessage[];completions:NativeToolCompletion[]}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const jsonEqual=(left:unknown,right:unknown)=>isDeepStrictEqual(left===undefined?undefined:JSON.parse(JSON.stringify(left)),right===undefined?undefined:JSON.parse(JSON.stringify(right)));
const finished=(part:MastraToolInvocationPart)=>['result','output-error','output-denied'].includes(part.toolInvocation.state);

/** Reuse the native message merger only after the complete native execution evidence agrees. */
export function recoverNativeToolResults(input:MastraDBMessage[],events:NativeToolRecoveryEvent[],contextId:string,runId:string):NativeToolRecovery{
  const messages=structuredClone(input),byId=new Map(messages.map(message=>[message.id,message]));
  const completions:NativeToolCompletion[]=[];
  for(const event of events){
    if(event.contextId!==contextId||event.runId!==runId||event.kind!=='message_update'||!object(event.data)||event.data.type!=='message_update'||typeof event.data.id!=='string'||!object(event.data.event)||event.data.event.type!=='part')continue;
    const update=event.data.event;
    if(!Number.isSafeInteger(update.index)||Number(update.index)<0||!object(update.part)||update.part.type!=='tool-invocation'||!object(update.part.toolInvocation))continue;
    const result=update.part as unknown as MastraToolInvocationPart,call=result.toolInvocation;
    if(!finished(result)||typeof call.toolCallId!=='string'||!call.toolCallId||typeof call.toolName!=='string'||!call.toolName)continue;
    const original=byId.get(event.data.id);if(!original||original.role!=='assistant'||original.threadId!==contextId||original.resourceId&&original.resourceId!=='local')continue;
    const index=Number(update.index),part=original.content.parts[index];
    if(part?.type!=='tool-invocation'||part.toolInvocation.toolCallId!==call.toolCallId||part.toolInvocation.toolName!==call.toolName||finished(part)||!jsonEqual(part.toolInvocation.args,call.args))continue;
    const originalCalls=original.content.parts.filter(candidate=>candidate.type==='tool-invocation'&&candidate.toolInvocation.toolCallId===call.toolCallId);
    if(originalCalls.length!==1)continue;
    const starts=events.filter(candidate=>candidate.seq<event.seq&&candidate.contextId===contextId&&candidate.runId===runId&&candidate.kind==='message_start'&&object(candidate.data)&&object(candidate.data.message)&&candidate.data.message.id===original.id);
    if(starts.length!==1)continue;
    const startMessage=(starts[0]!.data as Extract<AgentControllerEvent,{type:'message_start'}>).message,startPart=startMessage.content?.parts?.[index];
    if(startMessage.role!=='assistant'||startMessage.threadId&&startMessage.threadId!==contextId||startMessage.resourceId&&startMessage.resourceId!=='local'||startPart?.type!=='tool-invocation'||!jsonEqual(startPart.toolInvocation.args,part.toolInvocation.args)||startPart.toolInvocation.toolCallId!==call.toolCallId||startPart.toolInvocation.toolName!==call.toolName)continue;
    const executions=events.filter(candidate=>candidate.seq>starts[0]!.seq&&candidate.seq<event.seq&&candidate.contextId===contextId&&candidate.runId===runId&&candidate.kind==='tool_start'&&object(candidate.data)&&candidate.data.type==='tool_start'&&candidate.data.toolCallId===call.toolCallId);
    if(executions.length!==1)continue;const execution=executions[0]!;const executionData=execution.data as Extract<AgentControllerEvent,{type:'tool_start'}>;
    if(executionData.threadId&&executionData.threadId!==contextId||executionData.toolName!==call.toolName||!jsonEqual(executionData.args,call.args))continue;
    const nextStart=events.find(candidate=>candidate.seq>event.seq&&candidate.contextId===contextId&&candidate.runId===runId&&candidate.kind==='tool_start'&&object(candidate.data)&&candidate.data.toolCallId===call.toolCallId)?.seq??Infinity;
    const ends=events.filter(candidate=>candidate.seq>event.seq&&candidate.seq<nextStart&&candidate.contextId===contextId&&candidate.runId===runId&&candidate.kind==='tool_end'&&object(candidate.data)&&candidate.data.type==='tool_end'&&candidate.data.toolCallId===call.toolCallId);
    if(ends.length!==1)continue;const end=ends[0]!,endData=end.data as Extract<AgentControllerEvent,{type:'tool_end'}>;
    if(endData.threadId&&endData.threadId!==contextId||typeof endData.isError!=='boolean'||(call.isError??call.state==='output-error')!==endData.isError||(call.state==='output-denied')!==(endData.denied===true)||!jsonEqual(call.result,endData.result))continue;
    const conflicting=events.some(candidate=>candidate.seq!==event.seq&&candidate.seq>execution.seq&&candidate.seq<end.seq&&candidate.kind==='message_update'&&object(candidate.data)&&candidate.data.id===original.id&&object(candidate.data.event)&&candidate.data.event.type==='part'&&candidate.data.event.index===index&&object(candidate.data.event.part)&&candidate.data.event.part.type==='tool-invocation'&&object(candidate.data.event.part.toolInvocation)&&['result','output-error','output-denied'].includes(String(candidate.data.event.part.toolInvocation.state))&&!jsonEqual(candidate.data.event.part,result));
    if(conflicting)continue;
    const list=new MessageList({threadId:contextId,resourceId:'local',filterIncompleteToolCalls:false});list.add([original],'memory');
    if(!list.updateToolInvocation(result))continue;
    const merged=list.get.all.db()[0];if(!merged||merged.id!==original.id)continue;
    merged.createdAt=original.createdAt;
    const mergedPart=merged.content.parts[index];if(mergedPart?.type!=='tool-invocation')continue;
    if(result.updatedAt===undefined&&part.updatedAt===undefined)delete mergedPart.updatedAt;
    Object.assign(original,merged);
    completions.push({messageId:original.id,toolCallId:call.toolCallId,startSeq:execution.seq,partSeq:event.seq,endSeq:end.seq,part:result});
  }
  return {messages,completions};
}

export const nativeToolRecoveryHash=(value:unknown)=>recoveryDigest(JSON.parse(JSON.stringify(value)));
