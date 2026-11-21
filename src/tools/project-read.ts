import {createReadTool} from '@earendil-works/pi-coding-agent';
import type {ModelImageResizeOptions} from '@earendil-works/pi-ai';
import {createTool,type Tool} from '@mastra/core/tools';
import {requireFilesystem} from '@mastra/core/workspace';
import {fileTypeFromBuffer} from 'file-type';
import {z} from 'zod';
import {AppError} from '../domain.js';
import {workspaceRelativePath} from './workspace-filesystem.js';
import type {ProjectResources} from './project-resources.js';
import {detectSupportedImageMimeType} from './image-mime.js';

const readInput=z.object({path:z.string(),offset:z.number().optional(),limit:z.number().optional(),showLineNumbers:z.boolean().optional(),encoding:z.enum(['utf-8','utf8','base64','hex','binary']).optional(),byteOffset:z.number().int().nonnegative().optional(),maxBytes:z.number().int().min(1).max(32768).optional()}).strict();
const media=z.object({__workspaceMedia:z.literal(true),text:z.string(),mediaType:z.string(),data:z.string()});
const textApplications=new Set(['application/json','application/javascript','application/typescript','application/xml','application/graphql','application/x-sh','application/x-yaml','application/yaml','application/ld+json','application/sql','application/jsonl','application/x-php','application/dart']);
export interface ProjectImageReadOptions {resizeOptions?:ModelImageResizeOptions;supportsImages?:boolean}
export interface ProjectReadLease {signal:AbortSignal;finish:()=>void}
export interface ProjectReadIdentity {runId?:string;toolCallId?:string;agent:boolean;taskAdmission?:{taskId:string;attempt:number}}

/** Keep native file-tool presentation and tracking while the pinned reader selects bounded pages. */
export function projectReadTool(original:Tool<any,any,any,any,any>,source:ProjectResources,currentRoot:()=>string,imageOptions?:()=>ProjectImageReadOptions|undefined,leaseFactory?:(signal:AbortSignal|undefined,identity:ProjectReadIdentity)=>ProjectReadLease){
  const configuredRoot=currentRoot();
  return createTool({
    id:original.id,
    description:'Read a workspace file or image. Text reads keep bounded pages and provide the next line offset when more remains. offset is 1-based; limit selects lines. Supported images are resized for model input. For raw or very long single-line data use encoding=base64 or hex with byteOffset and maxBytes; every page preserves the original bytes. Existing showLineNumbers and explicit encoding fields remain accepted.',
    inputSchema:readInput,outputSchema:z.union([z.string(),media]),toModelOutput:original.toModelOutput,
    execute:async(input,context)=>{
      const native=context?.requestContext?.get('shittimchest-native-input-run'),runId=native&&typeof native==='object'&&'runId'in native&&typeof native.runId==='string'?native.runId:undefined;
      const lease=leaseFactory?.(context?.abortSignal,{runId,toolCallId:context?.agent?.toolCallId,agent:Boolean(context?.agent)});
      try{
      const {workspace,filesystem}=requireFilesystem(context!),signal=lease?.signal??context?.abortSignal,options=imageOptions?.();
      const relative=(absolute:string)=>{if(currentRoot()!==configuredRoot)throw new AppError('workspace_changed',409);return workspaceRelativePath(configuredRoot,absolute);};
      const path=relative(input.path),stat=await filesystem.stat(path),metadata=await workspace.getInfo({requestContext:context?.requestContext,resolveDynamicProviders:false});
      await context?.writer?.custom({type:'data-workspace-metadata',data:{toolName:original.id,toolCallId:context?.agent?.toolCallId,...metadata}});
      if(input.byteOffset!==undefined||input.maxBytes!==undefined||input.encoding&&!['utf8','utf-8'].includes(input.encoding)){
        const encoding=input.encoding&&!['utf8','utf-8'].includes(input.encoding)?input.encoding:'base64',page=await source.readRange(path,input.byteOffset??0,input.maxBytes??32768,signal),body=page.bytes.toString(encoding),complete=page.byteOffset===0&&page.nextByteOffset===null;
        return `${input.path} (${page.totalBytes} bytes, ${encoding}${complete?'':`, bytes ${page.byteOffset}-${page.byteOffset+page.bytes.length}`})\n${body}${page.nextByteOffset===null?'':`\n\n[More bytes remain. Use byteOffset=${page.nextByteOffset}, maxBytes=${input.maxBytes??32768}, encoding=${encoding} to continue.]`}`;
      }
      const prefix=await source.readRange(path,0,4100,signal);let detected:string|undefined;
      try{detected=(await fileTypeFromBuffer(prefix.bytes))?.mime;}catch{/* A short or incomplete header is still handled by the reader. */}
      const image=detectSupportedImageMimeType(prefix.bytes)??undefined;
      const mime=detected??stat.mimeType,textLike=!mime||mime==='application/octet-stream'||mime.startsWith('text/')||textApplications.has(mime)||mime.endsWith('+json')||mime.endsWith('+xml');
      if(!input.encoding&&!image&&!textLike)return `${input.path} (${stat.size} bytes, ${mime}) — binary file not readable as text. Use encoding=base64 or hex with byteOffset and maxBytes to read exact bytes.`;
      let totalLines=1,completed=false;const decoder=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}),reads=new Set<Promise<void>>();
      const count=(bytes:Uint8Array)=>{try{decoder.decode(bytes,{stream:true});}catch{throw new AppError('resource_invalid_utf8',415);}for(const byte of bytes)if(byte===10)totalLines++;};
      const reader=createReadTool(source.root,{resizeOptions:options?.resizeOptions,operations:{
        access:async absolute=>{await filesystem.stat(relative(absolute));},
        detectImageMimeType:async()=>image,
        readFile:async absolute=>{const bytes=source.readBytes(relative(absolute),Number.MAX_SAFE_INTEGER);if(!image){count(bytes);try{decoder.decode();}catch{throw new AppError('resource_invalid_utf8',415);}completed=true;}return bytes;},
        createReadStream:(absolute,{signal})=>{
          let closed!:()=>void;const drain=new Promise<void>(resolve=>{closed=resolve;});reads.add(drain);
          return (async function*(){try{for await(const bytes of source.readChunks(relative(absolute),signal)){count(bytes);yield bytes;}try{decoder.decode();}catch{throw new AppError('resource_invalid_utf8',415);}completed=true;}finally{closed();reads.delete(drain);}})();
        },
      }});
      let result:Awaited<ReturnType<typeof reader.execute>>;
      try{result=await reader.execute(context?.agent?.toolCallId??'workspace-read',{path:input.path,offset:input.offset,limit:input.limit},signal);}
      catch(error){if(error instanceof AppError&&error.code==='resource_invalid_utf8')return `${input.path} (${stat.size} bytes) — not UTF-8 text. Use encoding=base64 or hex with byteOffset and maxBytes to read exact bytes.`;throw error;}
      finally{await Promise.allSettled([...reads]);}
      const texts=result.content.flatMap(part=>part.type==='text'?[part.text]:[]),picture=result.content.find(part=>part.type==='image');
      const visibility=options?.supportsImages===false?'\n[Current model does not support images. The image will be omitted from this request.]':'';
      if(picture?.type==='image'){const hints=texts.filter(text=>text!==`Read image file [${picture.mimeType}]`);return {__workspaceMedia:true as const,text:`${input.path} (${stat.size} bytes, ${picture.mimeType})${hints.length?'\n'+hints.join('\n'):''}${visibility}`,mediaType:picture.mimeType,data:picture.data};}
      if(image)return `${input.path} (${stat.size} bytes, ${image})\n${texts.join('\n')}${visibility}`;
      if(!completed)throw new AppError('resource_read_unconfirmed',409);
      const text=texts.join('\n'),start=input.offset?Math.max(0,input.offset-1):0,first=Math.trunc(start)+1,truncation=result.details?.truncation;
      let body=text,notice='';
      if(truncation?.firstLineExceedsLimit){body='';notice='[The selected line exceeds the text page size. Use encoding=base64 or hex with byteOffset and maxBytes to read its original bytes.]';}
      else if(truncation?.truncated){body=truncation.content;if(!text.startsWith(body))throw new AppError('resource_read_unconfirmed',409);notice=text.slice(body.length);}
      else if(input.limit!==undefined){const limited=Math.min(start+input.limit,totalLines)-start;if(start+limited<totalLines){const suffix=`\n\n[${totalLines-(start+limited)} more lines in file. Use offset=${start+limited+1} to continue.]`;if(text.endsWith(suffix)){body=text.slice(0,-suffix.length);notice=suffix;}}}
      const rows=body.split('\n'),hasRows=input.limit!==0&&!truncation?.firstLineExceedsLimit,lines=hasRows?rows.length:0,range=input.offset!==undefined||input.limit!==undefined;
      const header=range?`${input.path} (lines ${lines?first:0}-${lines?first+lines-1:0} of ${totalLines}, ${stat.size} bytes)`:`${input.path} (${stat.size} bytes)`;
      const width=Math.max(6,String(lines?first+lines-1:0).length+1),formatted=input.showLineNumbers===false||!hasRows?body:rows.map((line,index)=>`${String(first+index).padStart(width)}→${line}`).join('\n');
      return `${header}\n${formatted}${notice}`;
      }finally{lease?.finish();}
    },
  });
}
