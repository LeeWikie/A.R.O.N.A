import {createHash} from 'node:crypto';
import {specTypeSchemas} from '@modelcontextprotocol/client';
import {AppError} from '../domain.js';
import {isBase64String} from '../base64.js';
import {toLlmContent,type CallToolResult,type LlmContent} from './mcp-content.js';
import {blockToContent,isTextMimeType} from './mcp-tool-content.js';
import {parseMcpProtocolWitness,mcpProtocolBlocks,mcpProtocolStructured,type McpProtocolWitness} from './mcp-protocol-witness.js';

export interface McpCallToolWitness{version:1;packetReceived:true;validated:boolean;result:CallToolResult;validationError?:unknown}
export type McpResultWitness=McpCallToolWitness|McpProtocolWitness;
export function mcpWitnessIsError(witness:McpResultWitness){return witness.version===1&&Boolean(witness.result.isError);}
export interface McpResultFacts{packetReceived:boolean;validated:boolean;isError:boolean;fromCache?:boolean}
export function mcpWitnessFacts(witness:McpResultWitness):McpResultFacts{return{packetReceived:witness.packetReceived,validated:witness.validated,isError:mcpWitnessIsError(witness),...(witness.version===2&&witness.method==='resources/read'&&witness.fromCache!==undefined?{fromCache:witness.fromCache}:{})};}
export function mcpFactsMatch(reference:McpResultFacts,witness:McpResultWitness){const facts=mcpWitnessFacts(witness);return reference.packetReceived===facts.packetReceived&&reference.validated===facts.validated&&reference.isError===facts.isError&&(reference.fromCache??false)===(facts.fromCache??false);}
export function mcpWitnessStructured(witness:McpResultWitness,serverId:string):unknown{return witness.version===1?witness.result.structuredContent:mcpProtocolStructured(witness,serverId);}
function mcpWitnessBlocks(witness:McpResultWitness){return witness.version===1?witness.result.content:mcpProtocolBlocks(witness);}
export interface McpModelImage{lane:number;mediaType:string;data:string;bytes:number;sha256:string}
export interface McpModelProjection{version:1;content:LlmContent[];text:string;images:McpModelImage[];failed:boolean}
export interface McpBinaryResource{lane:number;uri:string;mediaType:string;data:string;bytes:number;sha256:string}
export interface McpDerivedDescriptor{representation:'mcp-model-text'|'mcp-model-image'|'mcp-model-resource'|'mcp-model-audio'|'mcp-model-structured';mediaType:string;source:{serverId:string;toolName:string};imageLane?:number;resourceLane?:number;audioLane?:number;packetReceived:boolean;validated:boolean;isError:boolean;fromCache?:boolean;resourceReferences?:ReadonlyArray<{lane:number;id:string}>}
export function parseMcpWitness(input:unknown):McpResultWitness{
 if(input&&typeof input==='object'&&'version'in input&&input.version===2)return parseMcpProtocolWitness(input);
 if(!input||typeof input!=='object'||!('version'in input)||input.version!==1||!('packetReceived'in input)||input.packetReceived!==true||!('validated'in input)||typeof input.validated!=='boolean'||!('result'in input))throw new AppError('invalid_mcp_result_witness',409);
 const result=specTypeSchemas.CallToolResult['~standard'].validate(input.result);if(result instanceof Promise||result.issues)throw new AppError('invalid_mcp_result_witness',409);
 return {version:1,packetReceived:true,validated:input.validated,result:result.value,...('validationError'in input?{validationError:input.validationError}:{})};
}
export function mcpBinaryResources(input:unknown):McpBinaryResource[]{
 const witness=parseMcpWitness(input),resources:McpBinaryResource[]=[];for(const [lane,part]of mcpWitnessBlocks(witness).entries())if(part.type==='resource'&&'blob'in part.resource&&!part.resource.mimeType?.startsWith('image/')&&!isTextMimeType(part.resource.mimeType)){
  if(!isBase64String(part.resource.blob))throw new AppError('invalid_mcp_result_resource',409);const bytes=Buffer.from(part.resource.blob,'base64');resources.push({lane,uri:part.resource.uri,mediaType:part.resource.mimeType??'application/octet-stream',data:part.resource.blob,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }return resources;
}
export function mcpAudioContent(input:unknown):McpModelImage[]{
 const witness=parseMcpWitness(input),audio:McpModelImage[]=[];for(const [lane,part]of mcpWitnessBlocks(witness).entries())if(part.type==='audio'){
  if(!isBase64String(part.data))throw new AppError('invalid_mcp_result_audio',409);const bytes=Buffer.from(part.data,'base64');audio.push({lane,mediaType:part.mimeType,data:part.data,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }return audio;
}
function imageContent(content:readonly LlmContent[]):McpModelImage[]{
 const images:McpModelImage[]=[];for(const [lane,part]of content.entries())if(part.type==='image'){
  if(!isBase64String(part.data))throw new AppError('invalid_mcp_result_image',409);const bytes=Buffer.from(part.data,'base64');images.push({lane,mediaType:part.mimeType,data:part.data,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }return images;
}
export function mcpImageContent(input:unknown):McpModelImage[]{const witness=parseMcpWitness(input);return imageContent(toLlmContent(witness.version===1?witness.result:{content:mcpWitnessBlocks(witness)}));}
/** Fixed product content conversion; private protocol metadata stays outside it. */
export async function projectMcpWitness(input:unknown,options:{serverId:string;toolName?:string;resourcePaths?:ReadonlyArray<{lane:number;path:string}>;readableResources?:boolean}):Promise<McpModelProjection>{
 const witness=parseMcpWitness(input),binary=mcpBinaryResources(witness),paths=new Map((options.resourcePaths??[]).map(row=>[row.lane,row.path]));if(paths.size!==(options.resourcePaths??[]).length||binary.some(resource=>!paths.has(resource.lane))||[...paths.keys()].some(lane=>!binary.some(resource=>resource.lane===lane)))throw new AppError('mcp_result_resource_mapping_changed',409);
 const blocks=mcpWitnessBlocks(witness),content=blocks.length?(await Promise.all(blocks.map((block,lane)=>blockToContent(options.serverId,block,{readableResources:options.readableResources,saveOutput:async()=>paths.get(lane)!})))).flat():toLlmContent({content:[],structuredContent:mcpWitnessStructured(witness,options.serverId)});
 if(mcpWitnessIsError(witness)&&content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')==='')content.push({type:'text',text:`MCP tool ${options.serverId}${options.toolName?'/'+options.toolName:''} returned an error`});
 return {version:1,content,text:content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n'),images:imageContent(content),failed:mcpWitnessIsError(witness)||!witness.validated};
}
/** Verifies derived business bytes only; it does not grant source or storage access. */
export async function verifyMcpDerivedPayload(data:Uint8Array,reference:McpDerivedDescriptor,input:unknown,options:{serverId:string;resourcePaths?:ReadonlyArray<{lane:number;path:string}>}):Promise<void>{
 const witness=parseMcpWitness(input),changed=()=>new AppError('mcp_result_projection_changed',409),equal=(expected:Uint8Array)=>Buffer.from(data).equals(expected);
 if(!mcpFactsMatch(reference,witness)||reference.source.serverId!==options.serverId)throw changed();
 if(reference.representation==='mcp-model-structured'){
  const structured=mcpWitnessStructured(witness,options.serverId);if(reference.imageLane!==undefined||reference.resourceLane!==undefined||reference.audioLane!==undefined||reference.resourceReferences!==undefined||reference.mediaType!=='application/json'||structured===undefined||!equal(Buffer.from(JSON.stringify(structured,null,2))))throw changed();return;
 }
 if(reference.representation==='mcp-model-audio'){
  const audio=mcpAudioContent(witness).find(row=>row.lane===reference.audioLane);if(reference.imageLane!==undefined||reference.resourceLane!==undefined||reference.resourceReferences!==undefined||!audio||audio.mediaType!==reference.mediaType||!equal(Buffer.from(audio.data,'base64')))throw changed();return;
 }
 if(reference.representation==='mcp-model-resource'){
  const resource=mcpBinaryResources(witness).find(row=>row.lane===reference.resourceLane);if(reference.imageLane!==undefined||reference.audioLane!==undefined||reference.resourceReferences!==undefined||!resource||resource.mediaType!==reference.mediaType||!equal(Buffer.from(resource.data,'base64')))throw changed();return;
 }
 if(reference.representation==='mcp-model-image'){
  const image=mcpImageContent(witness).find(row=>row.lane===reference.imageLane);if(reference.resourceLane!==undefined||reference.audioLane!==undefined||!image||image.mediaType!==reference.mediaType||!equal(Buffer.from(image.data,'base64')))throw changed();return;
 }
 const paths=options.resourcePaths??[],declared=reference.resourceReferences??[];if(paths.length!==declared.length||paths.some(row=>!declared.some(value=>value.lane===row.lane&&value.id===row.path)))throw changed();
 const projected=await projectMcpWitness(witness,{...options,toolName:reference.source.toolName,readableResources:true});
 if(reference.representation==='mcp-model-text'){
  if(reference.imageLane!==undefined||reference.resourceLane!==undefined||reference.audioLane!==undefined||reference.mediaType!=='text/plain'||!equal(Buffer.from(projected.text)))throw changed();return;
 }
 throw changed();
}
