import {processImage,type ProcessImageOptions,type ProcessImageResult} from '@earendil-works/pi-coding-agent';
import type {AgentSignalContents} from '@mastra/core/agent';
import {isBase64String} from './base64.js';
import {AppError} from './domain.js';

export type InputImagePolicy=ProcessImageOptions&{supportsImages?:boolean};

/** Produce model input without changing the retained original bytes. */
export async function processInputImage(bytes:Uint8Array,mimeType:string,policy:InputImagePolicy={},signal?:AbortSignal):Promise<ProcessImageResult>{
 signal?.throwIfAborted();
 if(policy.supportsImages===false)return{ok:false,message:'[Image omitted: the selected model does not support images.]'};
 const result=await processImage(bytes,mimeType,{autoResizeImages:policy.autoResizeImages,resizeOptions:policy.resizeOptions});
 signal?.throwIfAborted();return result;
}

export async function processInputImages(contents:AgentSignalContents,policy:InputImagePolicy={},signal?:AbortSignal):Promise<AgentSignalContents>{
 if(typeof contents==='string')return contents;
 const parts:Exclude<AgentSignalContents,string>=[];
 for(const part of contents){
  signal?.throwIfAborted();if(part.type!=='file'||!part.mediaType.startsWith('image/')){parts.push(part);continue;}
  const bytes=part.data instanceof Uint8Array?part.data:part.data instanceof ArrayBuffer?new Uint8Array(part.data):typeof part.data==='string'&&isBase64String(part.data)?Buffer.from(part.data,'base64'):undefined;
  if(!bytes)throw new AppError('input_image_data_invalid',409);
  const result=await processInputImage(bytes,part.mediaType,policy,signal);
  if(!result.ok){parts.push({type:'text',text:result.message});continue;}
  for(const text of result.hints)parts.push({type:'text',text});parts.push({...part,data:Buffer.from(result.data,'base64'),mediaType:result.mimeType});
 }
 signal?.throwIfAborted();return parts;
}
