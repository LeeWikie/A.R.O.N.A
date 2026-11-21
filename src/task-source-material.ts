import {isDeepStrictEqual} from 'node:util';
import type {AgentSignalContents,AgentSignalInput} from '@mastra/core/agent';
import {createSignal} from '@mastra/core/agent';
import type {MastraDBMessage} from '@mastra/core/agent/message-list';
import type {SignalRecord} from './domain.js';
import {AppError} from './domain.js';
import {isBase64String} from './base64.js';

/** Extract only the contents of an authenticated native input, retaining its file lanes. */
export function nativeTaskSourceContents(source:SignalRecord,message:MastraDBMessage):AgentSignalContents{
  const fail=()=>new AppError('task_source_material_changed',409);
  if(message.id!==source.nativeSignalId||message.role!=='signal'||message.threadId&&message.threadId!==source.contextId||message.resourceId&&message.resourceId!=='local')throw fail();
  const part=message.content.parts.length===1?message.content.parts[0]:undefined;
  if(!part||!['data-user-message','data-signal'].includes(part.type)||!('data'in part)||!part.data||typeof part.data!=='object'||Array.isArray(part.data))throw fail();
  const data=part.data as Record<string,unknown>,attributes=data.attributes;
  if(data.id!==source.nativeSignalId||data.type!==(source.type==='user-message'?'user':'notification')||data.tagName!==(source.type==='user-message'?'user':source.type)||!isDeepStrictEqual(message.content.metadata?.signal,data)||!attributes||typeof attributes!=='object'||!('signal_id'in attributes)||attributes.signal_id!==source.id||!('source'in attributes)||attributes.source!==source.source)throw fail();
  const contents=data.contents;
  if(typeof contents==='string'){if(contents!==source.content)throw fail();return contents;}
  if(!Array.isArray(contents)||!contents.length||!contents.every(part=>part&&typeof part==='object'&&(part.type==='text'&&typeof part.text==='string'||part.type==='file'&&typeof part.data==='string'&&isBase64String(part.data)&&typeof part.mediaType==='string'))||contents[0]?.type!=='text'||contents[0].text!==source.content)throw fail();
  // The native signal serializer has already converted file data to its canonical
  // storage representation. Reuse that conversion instead of resolving asset paths.
  const normalized=createSignal(data as unknown as AgentSignalInput).toDBMessage({threadId:source.contextId,resourceId:'local'});
  if(normalized.content.parts.length!==contents.length)throw fail();
  return structuredClone(contents) as Exclude<AgentSignalContents,string>;
}

/** Older inputs are read from their original native storage row, never rebuilt from current files. */
export function storedTaskSourceContents(source:SignalRecord,message:MastraDBMessage):AgentSignalContents{
  const fail=()=>new AppError('task_source_material_changed',409);
  if(message.id!==source.nativeSignalId||!['user','signal'].includes(message.role)||message.threadId!==source.contextId||message.resourceId&&message.resourceId!=='local'||message.content.parts[0]?.type!=='text'||message.content.parts[0].text!==source.content)throw fail();
  const parts:Exclude<AgentSignalContents,string>=[];
  for(const part of message.content.parts){
    if(part.type==='text')parts.push({type:'text',text:part.text,...(part.providerMetadata?{providerOptions:structuredClone(part.providerMetadata)}:{})});
    else if(part.type==='file'&&typeof part.data==='string'&&typeof part.mimeType==='string'&&isBase64String(part.data))parts.push({type:'file',data:part.data,mediaType:part.mimeType,...('filename'in part&&typeof part.filename==='string'?{filename:part.filename}:{}),...(part.providerMetadata?{providerOptions:structuredClone(part.providerMetadata)}:{})});
    else throw fail();
  }
  return parts;
}
