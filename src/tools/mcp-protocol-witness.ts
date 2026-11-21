import {specTypeSchemas} from '@modelcontextprotocol/client';
import {z} from 'zod';
import {AppError} from '../domain.js';
import type {ContentBlock} from './mcp-content.js';

export const mcpResourceToolNames=new Set(['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource','read_mcp_resource_template','list_mcp_prompts','get_mcp_prompt']);
export function isMcpResultToolName(name:string){return name.startsWith('ext_')||mcpResourceToolNames.has(name);}
const base={version:z.literal(2),packetReceived:z.literal(true),validated:z.literal(true),result:z.record(z.string(),z.unknown())};
const readSchema=z.object({...base,packetReceived:z.boolean(),fromCache:z.boolean().optional(),method:z.literal('resources/read'),params:z.object({uri:z.string().min(1)}).strict()}).strict().superRefine((value,ctx)=>{if(value.packetReceived===(value.fromCache??false))ctx.addIssue({code:'custom',message:'Resource response and cache facts must agree'});});
const promptSchema=z.object({...base,method:z.literal('prompts/get'),params:z.object({name:z.string().min(1),arguments:z.record(z.string(),z.string()).optional()}).strict()}).strict();
const schema=z.discriminatedUnion('method',[readSchema,promptSchema]);
export type McpProtocolWitness=z.infer<typeof schema>;
function record(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function invalid(){return new AppError('invalid_mcp_protocol_witness',409);}
/** Keeps the validated native result under its actual protocol method. */
export function parseMcpProtocolWitness(input:unknown):McpProtocolWitness{
 const parsed=schema.safeParse(input);if(!parsed.success)throw invalid();
 const validation=parsed.data.method==='resources/read'?specTypeSchemas.ReadResourceResult['~standard'].validate(parsed.data.result):specTypeSchemas.GetPromptResult['~standard'].validate(parsed.data.result);
 if(validation instanceof Promise||validation.issues)throw invalid();return parsed.data;
}
function withoutMeta(input:Record<string,unknown>){const{_meta,...value}=input;return value;}
function publicBlock(input:unknown){if(!record(input))throw invalid();const value=withoutMeta(input);return value.type==='resource'&&record(value.resource)?{...value,resource:withoutMeta(value.resource)}:value;}
function modelBlock(input:unknown):ContentBlock{
 if(!record(input))throw invalid();const mime=typeof input.mimeType==='string'?input.mimeType:undefined;
 if(input.type==='text'&&typeof input.text==='string')return{type:'text',text:input.text};
 if(input.type==='image'&&typeof input.data==='string'&&mime)return{type:'image',data:input.data,mimeType:mime};
 if(input.type==='audio'&&typeof input.data==='string'&&mime)return{type:'audio',data:input.data,mimeType:mime};
 if(input.type==='resource_link'&&typeof input.uri==='string'&&typeof input.name==='string')return{type:'resource_link',uri:input.uri,name:input.name,...(typeof input.title==='string'?{title:input.title}:{}),...(typeof input.description==='string'?{description:input.description}:{}),...(mime?{mimeType:mime}:{}),...(typeof input.size==='number'?{size:input.size}:{})};
 if(input.type==='resource'&&record(input.resource)&&typeof input.resource.uri==='string'){
  const resource=input.resource,uri=input.resource.uri,mimeType=typeof resource.mimeType==='string'?resource.mimeType:undefined;
  if(typeof resource.text==='string')return{type:'resource',resource:{uri,text:resource.text,...(typeof resource.blob==='string'?{blob:resource.blob}:{}),...(mimeType?{mimeType}:{})}};
  if(typeof resource.blob==='string')return{type:'resource',resource:{uri,blob:resource.blob,...(mimeType?{mimeType}:{})}};
 }
 throw invalid();
}
export function mcpProtocolBlocks(input:McpProtocolWitness):ContentBlock[]{
 const witness=parseMcpProtocolWitness(input);
 if(witness.method==='resources/read'){
  const contents=witness.result.contents;if(!Array.isArray(contents))throw invalid();const blocks:ContentBlock[]=[];
  for(const value of contents){if(!record(value)||typeof value.uri!=='string')throw invalid();if(contents.length>1)blocks.push({type:'text',text:`${value.uri}:`});blocks.push(modelBlock({type:'resource',resource:value}));}
  return blocks.length?blocks:[{type:'text',text:`Resource ${witness.params.uri} is empty.`}];
 }
 const messages=witness.result.messages;if(!Array.isArray(messages))throw invalid();const blocks:ContentBlock[]=[];
 for(const[index,value]of messages.entries()){
  if(!record(value)||!['user','assistant'].includes(String(value.role)))throw invalid();blocks.push({type:'text',text:`[${value.role} prompt message ${index+1}]`});
  const content=Array.isArray(value.content)?value.content:[value.content];for(const part of content)blocks.push(modelBlock(part));
 }
 return blocks.length?blocks:[{type:'text',text:`Prompt ${witness.params.name} is empty.`}];
}
/** A business view, separate from the privately retained protocol result. */
export function mcpProtocolStructured(input:McpProtocolWitness,serverId:string):unknown{
 const witness=parseMcpProtocolWitness(input);
 if(witness.method==='resources/read'){
  const contents=witness.result.contents;if(!Array.isArray(contents))throw invalid();return{server:serverId,uri:witness.params.uri,contents:contents.map(value=>{if(!record(value))throw invalid();return withoutMeta(value);})};
 }
 const messages=witness.result.messages;if(!Array.isArray(messages))throw invalid();return{server:serverId,name:witness.params.name,...(typeof witness.result.description==='string'?{description:witness.result.description}:{}),messages:messages.map(value=>{if(!record(value))throw invalid();return{...withoutMeta(value),content:Array.isArray(value.content)?value.content.map(publicBlock):publicBlock(value.content)};})};
}
