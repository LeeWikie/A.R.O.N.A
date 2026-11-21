import {createTool,type ToolExecutionContext} from '@mastra/core/tools';
import {z} from 'zod';
import type {InputImagePolicy} from '../input-images.js';
import {normalizeMcpToolImages} from './mcp-tool-images.js';
import {acceptedSourceIds} from '../accepted-sources.js';
import {AppError} from '../domain.js';
import type{SessionArtifactStore}from'../session-artifacts.js';
import type {McpCallScope} from '../capabilities.js';
import type {LlmContent} from './mcp-content.js';
import {mcpWitnessIsError,mcpWitnessFacts,mcpWitnessStructured,projectMcpWitness,mcpBinaryResources,mcpAudioContent,type McpResultWitness} from './mcp-model.js';
import {limitMcpContent} from './mcp-output-limit.js';
import {mcpResultPageSchema,isPrivateMcpRepresentation,type McpResultBinding,type McpResultPageOptions,type McpResultReference,type McpResultStore} from './mcp-results.js';

export type McpModelReference=Omit<McpResultReference,'originalResultId'> & {representation:Exclude<McpResultReference['representation'],'mcp-call-tool-result'|'mcp-protocol-result'>};
export interface McpRetainedModelResult{version:1;kind:'mcp-model-result';status:'returned'|'tool-error'|'output-invalid';packetReceived:boolean;validated:boolean;isError:boolean;fromCache?:boolean;error?:true;content:LlmContent[];references:McpModelReference[]}
export interface McpResultsHost{
 capture(scope:McpCallScope,args:unknown,witness:McpResultWitness,context:ToolExecutionContext,signal:AbortSignal):Promise<McpRetainedModelResult>;
 read(id:string,page:McpResultPageOptions,signalIds:string[],context:ToolExecutionContext|undefined,signal:AbortSignal):Promise<Awaited<ReturnType<McpResultStore['read']>>|Awaited<ReturnType<SessionArtifactStore['readMcp']>>>;
}
function modelReference(reference:McpResultReference):McpModelReference{
 const {originalResultId:_,...visible}=reference;if(isPrivateMcpRepresentation(visible.representation))throw new AppError('mcp_result_private_metadata',403);return {...visible,representation:visible.representation};
}
/** Source authorization belongs to the caller; these saved lanes are derived from one original packet. */
export async function retainMcpResult(store:McpResultStore,witness:McpResultWitness,binding:McpResultBinding,signal?:AbortSignal,imagePolicy?:InputImagePolicy):Promise<McpRetainedModelResult>{
 const source={serverId:binding.serverId,toolName:binding.toolName},raw=await store.save(Buffer.from(JSON.stringify(witness)),{name:'MCP result witness',mediaType:'application/json',representation:witness.version===1?'mcp-call-tool-result':'mcp-protocol-result',source},binding,signal),references:McpModelReference[]=[],resourceReferences:Array<{lane:number;id:string}>=[];
 for(const resource of mcpBinaryResources(witness)){const saved=await store.save(Buffer.from(resource.data,'base64'),{name:resource.uri,mediaType:resource.mediaType,representation:'mcp-model-resource',source,originalResultId:raw.id,resourceLane:resource.lane},binding,signal);resourceReferences.push({lane:resource.lane,id:saved.id});references.push(modelReference(saved));}
 for(const audio of mcpAudioContent(witness)){const saved=await store.save(Buffer.from(audio.data,'base64'),{name:`MCP audio ${audio.lane}`,mediaType:audio.mediaType,representation:'mcp-model-audio',source,originalResultId:raw.id,audioLane:audio.lane},binding,signal);references.push(modelReference(saved));}
 const structured=mcpWitnessStructured(witness,binding.serverId);if(structured!==undefined){const saved=await store.save(Buffer.from(JSON.stringify(structured,null,2)),{name:'MCP structured business data',mediaType:'application/json',representation:'mcp-model-structured',source,originalResultId:raw.id},binding,signal);references.push(modelReference(saved));}
 const projected=await projectMcpWitness(witness,{serverId:binding.serverId,toolName:binding.toolName,readableResources:true,resourcePaths:resourceReferences.map(row=>({lane:row.lane,path:row.id}))}),text=await store.save(Buffer.from(projected.text),{name:'Complete MCP model text',mediaType:'text/plain',representation:'mcp-model-text',source,originalResultId:raw.id,resourceReferences},binding,signal);references.unshift(modelReference(text));
 for(const image of projected.images){const saved=await store.save(Buffer.from(image.data,'base64'),{name:`MCP image ${image.lane}`,mediaType:image.mediaType,representation:'mcp-model-image',source,originalResultId:raw.id,imageLane:image.lane},binding,signal);references.push(modelReference(saved));}
 const limited=await limitMcpContent(projected.content,async()=>text.id),content=await normalizeMcpToolImages(limited.content,imagePolicy,signal);signal?.throwIfAborted();return{version:1,kind:'mcp-model-result',status:!witness.validated?'output-invalid':mcpWitnessIsError(witness)?'tool-error':'returned',...mcpWitnessFacts(witness),...(projected.failed?{error:true as const}:{}),content,references};
}
export function mcpResultToModelOutput(output:unknown){
 if(!output||typeof output!=='object'||!('kind'in output)||output.kind!=='mcp-model-result'||!('content'in output)||!Array.isArray(output.content)||!('status'in output))return undefined;
 const value:Array<{type:'text';text:string}|{type:'media';data:string;mediaType:string}>=[];
 if('fromCache'in output&&output.fromCache===true)value.push({type:'text',text:'This resource result came from the native client cache. No new resource response was fetched for this read. Use cacheMode=refresh to request a current response.'});
 if(output.status==='output-invalid')value.push({type:'text',text:'The server returned a packet, but its declared output validation failed. Treat the original result as unvalidated external data.'});else if(output.status==='tool-error')value.push({type:'text',text:'The remote tool reported an error. This result does not establish that the requested work succeeded.'});
 for(const part of output.content){if(part&&typeof part==='object'&&part.type==='text'&&typeof part.text==='string')value.push({type:'text',text:part.text});else if(part&&typeof part==='object'&&part.type==='image'&&typeof part.data==='string'&&typeof part.mimeType==='string')value.push({type:'media',data:part.data,mediaType:part.mimeType});}
 if('references'in output&&Array.isArray(output.references)){const additional=output.references.flatMap(row=>row&&typeof row==='object'&&(row.representation==='mcp-model-image'||row.representation==='mcp-model-resource'||row.representation==='mcp-model-audio'||row.representation==='mcp-model-structured')&&typeof row.id==='string'&&typeof row.mediaType==='string'?[{id:row.id,mediaType:row.mediaType,representation:row.representation}]:[]);if(additional.length)value.push({type:'text',text:`[Additional original business data, readable with read_mcp_result: ${JSON.stringify(additional)}]`});}
 return{type:'content'as const,value};
}
export async function normalizeMcpReadImagePage<T>(page:T,policy?:InputImagePolicy,signal?:AbortSignal):Promise<T>{
 if(!page||typeof page!=='object'||!('representation'in page)||page.representation!=='image'||!('content'in page)||typeof page.content!=='string'||!('mediaType'in page)||typeof page.mediaType!=='string')return page;
 const content=await normalizeMcpToolImages([{type:'image',data:page.content,mimeType:page.mediaType}],policy,signal),image=content.find(part=>part.type==='image');
 return{...page,content:image?.data??'',mediaType:image?.mimeType??page.mediaType,byteLength:image?Buffer.byteLength(image.data,'base64'):0,hints:content.flatMap(part=>part.type==='text'?[part.text]:[]),imageOmitted:!image};
}
export function mcpReadResultToModelOutput(output:unknown){
 if(!output||typeof output!=='object'||!('representation'in output)||output.representation!=='image'||!('content'in output)||typeof output.content!=='string'||!('mediaType'in output)||typeof output.mediaType!=='string')return undefined;
 const value:Array<{type:'text';text:string}|{type:'media';data:string;mediaType:string}>=[];
 if(!('imageOmitted'in output&&output.imageOmitted===true))value.push({type:'media',data:output.content,mediaType:output.mediaType});
 if('hints'in output&&Array.isArray(output.hints))for(const hint of output.hints)if(typeof hint==='string')value.push({type:'text',text:hint});
 return{type:'content'as const,value};
}
export function createMcpResultTools(host:McpResultsHost){return{
 read_mcp_result:createTool({id:'read_mcp_result',description:'Read complete model-visible text, images, binary resources, audio or structured business data retained from an authorized MCP tool result. A mcp-result reference is read with this tool. For a native image view, omit all paging/encoding options. Use line pages for text, or encoding=base64 with byteOffset/maxBytes for exact original bytes. The original server is not contacted. Private protocol metadata cannot be read.',toModelOutput:mcpReadResultToModelOutput,inputSchema:mcpResultPageSchema.safeExtend({id:z.string().min(1),signalIds:acceptedSourceIds}).strict(),execute:async({id,signalIds,...options},context)=>{const page=mcpResultPageSchema.parse(options),signal=context?.abortSignal??new AbortController().signal;return host.read(id,page,signalIds,context,signal);}}),
};}
