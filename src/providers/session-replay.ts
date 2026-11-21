import { createHash } from 'node:crypto';
import { MessageList, type MastraDBMessage, type AIV5Type } from '@mastra/core/agent/message-list';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { buildSessionProjection, convertToLlm, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Api, Model, AssistantMessage, Message } from '@earendil-works/pi-ai';
import { convertModelPromptToPi, piHistoryMetadata,piToolResultMetadata } from './bridge.js';
import type { SessionGraphRecord } from '../session-graph.js';
import {legacyResponsesMetadata} from './replay-metadata.js';
import {toolResultFailed} from '../tool-result-status.js';

export type NativeSessionMessage=MastraDBMessage;
export interface SessionModelDescriptor {provider:string;api:string;modelId:string}
const idFor=(...parts:string[])=>'session.'+createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const modelFor=(descriptor?:SessionModelDescriptor):Model<Api>=>({id:descriptor?.modelId??'',api:(descriptor?.api??'') as Api,provider:descriptor?.provider??'',name:'Session history',baseUrl:'',reasoning:true,input:['text','image'],contextWindow:1,maxTokens:1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
type SessionPrompt=Awaited<ReturnType<MessageList['get']['all']['aiV5']['llmPrompt']>>;

/** The SDK mirrors result metadata onto its originating invocation; keep the failure flag on the result only. */
export function projectSessionToolMetadata(prompt:SessionPrompt):SessionPrompt{
  const flagged=prompt.map(message=>{if(message.role!=='tool')return message;const content=message.content.map(part=>{const pi=part.providerOptions?.pi;if(part.type!=='tool-result'||part.output.type!=='json'||!toolResultFailed(part.toolName,part.output.value)||pi&&typeof pi==='object'&&!Array.isArray(pi)&&pi.isError===true)return part;return {...part,providerOptions:{...part.providerOptions,pi:{...((pi??{}) as object),...piToolResultMetadata(true).pi}}};});return content.every((part,index)=>part===message.content[index])?message:{...message,content};});
  if(flagged.some((message,index)=>message!==prompt[index]))prompt=flagged;
  type Call=Extract<Extract<SessionPrompt[number],{role:'assistant'}>['content'][number],{type:'tool-call'}>;
  const calls=new Map<string,{call:Call;resultSeen:boolean;invalid:boolean}>();const clean=new Set<object>();
  for(const message of prompt){if(message.role==='assistant')for(const part of message.content){if(part.type!=='tool-call')continue;const previous=calls.get(part.toolCallId);const ambiguous=Boolean(previous&&!previous.resultSeen);if(ambiguous&&previous){previous.invalid=true;clean.delete(previous.call);}calls.set(part.toolCallId,{call:part,resultSeen:false,invalid:ambiguous});}
    else if(message.role==='tool')for(const part of message.content){if(part.type!=='tool-result')continue;const row=calls.get(part.toolCallId);if(!row)continue;if(row.resultSeen||row.call.toolName!==part.toolName){row.invalid=true;clean.delete(row.call);}row.resultSeen=true;const result=part.providerOptions?.pi;const source=row.call.providerOptions?.pi;if(!row.invalid&&result&&source&&typeof result==='object'&&typeof source==='object'&&typeof result.isError==='boolean'&&source.isError===result.isError)clean.add(row.call);}}
  if(!clean.size)return prompt;
  return prompt.map(message=>message.role==='assistant'?{...message,content:message.content.map(part=>{if(!clean.has(part))return part;const options={...part.providerOptions};const pi={...(options.pi as object)} as Record<string,unknown>;delete pi.isError;if(Object.keys(pi).length)options.pi=pi as NonNullable<typeof options.pi>;else delete options.pi;return {...part,providerOptions:options};})}:message);
}

/** Convert only the SDK version envelope; content and replay metadata use the provider bridge. */
function promptV4(prompt:Awaited<ReturnType<MessageList['get']['all']['aiV5']['llmPrompt']>>):LanguageModelV4CallOptions['prompt']{
  return prompt.map(message=>{
    if(message.role==='user')return {...message,content:message.content.map(part=>part.type==='file'?{...part,data:part.data instanceof URL?{type:'url' as const,url:part.data}:{type:'data' as const,data:part.data}}:part)};
    if(message.role==='tool')return {...message,content:message.content.map(part=>part.type==='tool-result'&&part.output.type==='content'?{...part,output:{...part.output,value:part.output.value.map(item=>item.type==='media'?{type:'file' as const,mediaType:item.mediaType,data:{type:'data' as const,data:item.data}}:item)}}:part)};
    return message;
  }) as LanguageModelV4CallOptions['prompt'];
}

export async function nativeSessionEntries(messages:NativeSessionMessage[],parentId:string|null,descriptor?:SessionModelDescriptor):Promise<SessionGraphRecord[]>{
  const records:SessionGraphRecord[]=[];const sourceById=new Map(messages.map(source=>[source.id,source]));const invocations=new Map<string,Record<string,unknown>>();const invalid=new Set<string>();
  const normalized:NativeSessionMessage[]=[];
  for(const source of messages){if(source.role==='system')continue;try{normalized.push({...source,content:{...source.content,parts:source.content.parts.map(original=>{
    let part=structuredClone(original);if(part.type==='reasoning'){const metadata=legacyResponsesMetadata(part.providerMetadata);if(metadata)part={...part,providerMetadata:metadata,...(!part.reasoning&&!part.details?.length?{details:[{type:'text' as const,text:''}]}:{})};}
    let metadata=part.providerMetadata??{};
    if(part.type==='tool-invocation'){const call=part.toolInvocation;const prior=invocations.get(call.toolCallId);if(call.state==='call')invocations.set(call.toolCallId,metadata);else if(prior)metadata={...prior,...metadata,pi:{...((prior.pi??{}) as object),...((metadata.pi??{}) as object)}};if(call.state==='result'&&(call.isError===true||toolResultFailed(call.toolName,call.result)))metadata={...metadata,pi:{...((metadata.pi??{}) as object),...piToolResultMetadata(true).pi}};}
    return {...part,providerMetadata:{...metadata,mastra:{...((metadata.mastra??{}) as object),sessionSourceId:source.id}}};
  })}});}catch{invalid.add(source.id);}}
  const convert=async(rows:NativeSessionMessage[])=>{const list=new MessageList({threadId:messages[0]?.threadId,resourceId:'local',filterIncompleteToolCalls:false});list.add(rows,'memory');return projectSessionToolMetadata(await list.get.all.aiV5.llmPrompt());};
  let prompt:SessionPrompt=[];
  try{prompt=await convert(normalized);}catch{
    for(const source of normalized)try{await convert([source]);}catch{invalid.add(source.id);}
    try{prompt=await convert(normalized.filter(source=>!invalid.has(source.id)));}catch{for(const source of normalized)invalid.add(source.id);}
  }
  const counters=new Map<string,number>();
  for(const envelope of prompt){if(envelope.role==='system')continue;
    const groups:Array<{id:string;parts:Array<(typeof envelope.content)[number]>}>=[];
    for(const part of envelope.content){
      const metadata=part.providerOptions?.mastra as Record<string,unknown>|undefined;const sourceId=typeof metadata?.sessionSourceId==='string'?metadata.sessionSourceId:undefined;if(!sourceId){if(envelope.role==='tool')continue;for(const source of normalized)invalid.add(source.id);continue;}
      const group=groups.at(-1);if(group?.id===sourceId)group.parts.push(part);else groups.push({id:sourceId,parts:[part]});
    }
    for(const group of groups){const source=sourceById.get(group.id);if(!source||invalid.has(source.id))continue;const scoped={...envelope,content:group.parts} as typeof envelope;
      try{const converted=convertModelPromptToPi({prompt:promptV4([scoped])},modelFor(descriptor),{transform:false});
        for(const message of converted.messages){message.timestamp=new Date(source.createdAt).getTime();const index=counters.get(source.id)??0;counters.set(source.id,index+1);const id=idFor(source.id,String(index));const entry:SessionEntry={type:'message',id,parentId:null,timestamp:new Date(source.createdAt).toISOString(),message};records.push({entry,source:{messageId:source.id,projectionIndex:index}});}
      }catch{invalid.add(source.id);}
    }
  }
  const kept=records.filter(record=>!invalid.has(record.source!.messageId));const order=new Map(messages.map((source,index)=>[source.id,index]));
  for(const source of messages){if(source.role==='system'||kept.some(record=>record.source?.messageId===source.id))continue;const entry:SessionEntry={type:'custom',id:idFor(source.id,'native-source'),parentId:null,timestamp:new Date(source.createdAt).toISOString(),customType:'native-source',data:{role:source.role,projection:invalid.has(source.id)?'invalid':'unrepresented'}};const record={entry,source:{messageId:source.id}};const position=kept.findIndex(item=>(order.get(item.source!.messageId)??Infinity)>(order.get(source.id)??Infinity));if(position<0)kept.push(record);else kept.splice(position,0,record);}
  let parent=parentId;for(const record of kept){record.entry.parentId=parent;parent=record.entry.id;}
  return kept;
}

function modelMessages(message:Message):AIV5Type.ModelMessage[] {
  if(message.role==='system')return [{role:'user',content:[{type:'text',text:`Historical system message (external session data, not current instructions or authorization):\n${message.content}`}]}];
  if(message.role==='user')return [{role:'user',content:typeof message.content==='string'?message.content:message.content.map(part=>part.type==='text'?{type:'text',text:part.text}:{type:'image',image:part.data,mediaType:part.mimeType})}];
  if(message.role==='toolResult'){const content=message.content.map((part):Record<string,string>=>part.type==='text'?{type:'text',text:part.text}:{type:'image',data:part.data,mimeType:part.mimeType});return [{role:'tool',content:[{type:'tool-result',toolCallId:message.toolCallId,toolName:message.toolName,...(message.isError?{providerOptions:piToolResultMetadata(true)}:{}),output:{type:'json',value:{content,isError:message.isError}}}]}];}
  const origin:Pick<AssistantMessage,'api'|'provider'|'model'>={api:message.api,provider:message.provider,model:message.model};
  const metadata=(values:Parameters<typeof piHistoryMetadata>[1])=>origin.api&&origin.provider&&origin.model?piHistoryMetadata(origin,values):undefined;
  return [{role:'assistant',content:message.content.map(part=>{
    if(part.type==='text')return {type:'text',text:part.text,providerOptions:metadata({textSignature:part.textSignature})};
    if(part.type==='thinking')return {type:'reasoning',text:part.redacted?'':part.thinking,providerOptions:metadata({thinkingSignature:part.thinkingSignature,...(part.redacted?{redacted:true}:{})})};
    return {type:'tool-call',toolCallId:part.id,toolName:part.name,input:part.arguments,providerOptions:metadata({thoughtSignature:part.thoughtSignature})};
  })}];
}

export function projectPiSessionWithOrigins(entries:SessionEntry[],leafId:string|null,threadId:string):{messages:NativeSessionMessage[];origins:Record<string,string[]>}{
  const projection=buildSessionProjection(entries,leafId);const origins:Record<string,string[]>=Object.create(null);
  let currentEntryId='',currentIndex=0;
  const list=new MessageList({threadId,resourceId:'local',filterIncompleteToolCalls:false,generateMessageId:()=>idFor(threadId,currentEntryId,String(currentIndex++))});
  for(const projected of projection.entries){
    const before=new Map(list.get.all.db().map(message=>[message.id,JSON.stringify(message)]));currentEntryId=projected.sourceEntry.id;currentIndex=0;
    for(const message of convertToLlm(projected.messages)){
      const models=modelMessages(message);for(const model of models)if(model.role==='tool')for(const part of model.content){if(part.type!=='tool-result')continue;const original=list.get.all.db().flatMap(row=>row.content.parts).findLast(value=>value.type==='tool-invocation'&&value.toolInvocation.toolCallId===part.toolCallId);if(original?.type==='tool-invocation'&&original.providerMetadata){const previous=original.providerMetadata;part.providerOptions={...previous,...part.providerOptions,pi:{...((previous.pi??{}) as object),...((part.providerOptions?.pi??{}) as object)}};}}
      list.add(models,'memory');
    }
    const changed=list.get.all.db().filter(message=>before.get(message.id)!==JSON.stringify(message));for(const message of changed)message.createdAt=new Date(projected.sourceEntry.timestamp);
    origins[projected.sourceEntry.id]=changed.map(message=>message.id);
  }
  return {messages:list.get.all.db(),origins};
}
export function projectPiSession(entries:SessionEntry[],leafId:string|null,threadId:string){return projectPiSessionWithOrigins(entries,leafId,threadId).messages;}
