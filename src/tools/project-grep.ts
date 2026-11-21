/*
 * Search result collection is adapted from Pi 1.5.1 core/tools/grep.ts:
 * https://github.com/earendil-works/pi/blob/dd30101cfc5b0609411dd80b6f93adbc14db14cf/packages/coding-agent/src/core/tools/grep.ts
 *
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createTool,type Tool} from '@mastra/core/tools';
import {createGlobMatcher,extractGlobBase,isGlobPattern,requireFilesystem} from '@mastra/core/workspace';
import {truncateHead,truncateLine,DEFAULT_MAX_BYTES,formatSize} from '@earendil-works/pi-coding-agent';
import {AppError} from '../domain.js';
import {workspaceRelativePath} from './workspace-filesystem.js';
import type {ProjectResources} from './project-resources.js';
import type {ProjectReadIdentity,ProjectReadLease} from './project-read.js';
import {findRg} from './rg.js';
import {processNullPaths} from './project-process.js';
import {z} from 'zod';

const grepInput=zodInput();
const GREP_MAX_LINE_LENGTH=500;
function zodInput(){return z.object({pattern:z.string(),path:z.string().optional(),contextLines:z.number().optional(),maxCount:z.number().optional(),caseSensitive:z.boolean().optional(),includeHidden:z.boolean().optional(),glob:z.string().optional(),ignoreCase:z.boolean().optional(),literal:z.boolean().optional(),context:z.number().optional(),limit:z.number().optional()}).strict();}

function decodeText(value:unknown):string{
  if(value&&typeof value==='object'){if('text'in value&&typeof value.text==='string')return value.text;if('bytes'in value&&typeof value.bytes==='string')return Buffer.from(value.bytes,'base64').toString('utf8');}return '';
}

/** The original collector's global limit includes trailing context and requires another real match as proof. */
class GrepOutput {
  private readonly lines:string[]=[];private bytes=0;private lineCount=0;private matches=0;private lastFile='';private trailingEnd=0;private limitHit=false;private truncatedLines=false;
  limited=false;done=false;
  constructor(private readonly limit:number,private readonly context:number){}
  event(value:unknown,file:string){
    if(this.done||!value||typeof value!=='object'||!('type'in value)||!['match','context'].includes(String(value.type)))return;
    if(!('data'in value)||!value.data||typeof value.data!=='object'||!('line_number'in value.data)||typeof value.data.line_number!=='number'||!('lines'in value.data))throw new AppError('search_output_invalid',502);
    const number=value.data.line_number,text=decodeText(value.data.lines),match=value.type==='match';
    if(!this.limitHit){this.push(file,number,text,match);if(match&&++this.matches>=this.limit){this.limitHit=true;this.trailingEnd=number+this.context;}return;}
    const within=file===this.lastFile&&number<=this.trailingEnd;if(within)this.push(file,number,text,false);if(match)this.limited=true;
    if(this.limited&&!(within&&number<this.trailingEnd))this.done=true;
  }
  private push(file:string,number:number,text:string,match:boolean){
    this.lastFile=file;const {text:line,wasTruncated}=truncateLine(text.replace(/\r?\n?$/,''));if(wasTruncated)this.truncatedLines=true;
    const formatted=match?`${file}:${number}: ${line}`:`${file}-${number}- ${line}`;if(this.bytes-1<=DEFAULT_MAX_BYTES)this.lines.push(formatted);this.bytes+=Buffer.byteLength(formatted)+1;this.lineCount++;
  }
  output(){
    if(!this.matches)return 'No matches found';const truncated=truncateHead(this.lines.join('\n'),{maxLines:Number.MAX_SAFE_INTEGER});truncated.totalLines=this.lineCount;truncated.totalBytes=this.bytes-1;let output=truncated.content;const notices:string[]=[];
    if(this.limited)notices.push(`${this.limit} matches limit reached. Use limit=${this.limit*2} for more, or refine pattern`);
    if(truncated.truncated)notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);if(this.truncatedLines)notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    if(notices.length)output+=`\n\n[${notices.join('. ')}]`;return output;
  }
}

async function searchFile(binary:string,source:ProjectResources,file:string,args:string[],signal:AbortSignal|undefined,output:GrepOutput){
  signal?.throwIfAborted();const reading=new AbortController(),child=spawn(binary,[...args,'-'],{cwd:source.root,stdio:['pipe','pipe','pipe'],windowsHide:true}),lines=createInterface({input:child.stdout}),input=source.readChunks(file,signal?AbortSignal.any([signal,reading.signal]):reading.signal);let stderr='',failure:unknown,sourceFailure:unknown,stopped=false,spawnError:Error|undefined;
  const closed=new Promise<number|null>(resolve=>{child.once('error',error=>{spawnError=error;});child.once('close',code=>resolve(code));});
  const stop=(aborted=false)=>{if(aborted)reading.abort();if(stopped)return;stopped=true;child.stdin.destroy();if(child.exitCode===null&&!child.killed)child.kill();};const abort=()=>stop(true);signal?.addEventListener('abort',abort,{once:true});
  child.stderr.on('data',(chunk:Buffer)=>{if(stderr.length<65536)stderr+=chunk.toString('utf8').slice(0,65536-stderr.length);});
  lines.on('line',line=>{if(output.done||failure||!line.trim())return;try{output.event(JSON.parse(line),file);if(output.done)stop();}catch(error){failure=error;stop();}});
  // A native early stdin close is distinct from a checked source read/verification failure.
  const checked=async function*(){try{for(;;){let next;try{next=await input.next();}catch(error){sourceFailure=error;throw error;}if(next.done)return;yield next.value;}}finally{try{await input.return(undefined);}catch(error){sourceFailure=error;throw error;}}};
  const feed=pipeline(Readable.from(checked()),child.stdin).catch(error=>{if(!stopped){const pipeClose=error&&typeof error==='object'&&'code'in error&&['EPIPE','ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED'].includes(String(error.code));if(!pipeClose){failure=error;stop();}}});
  try{if(signal?.aborted)stop(true);const code=await closed;await feed;await input.return(undefined);if(signal?.aborted)signal.throwIfAborted();if(sourceFailure)throw sourceFailure;if(spawnError)throw new AppError('search_unavailable',503);if(!stopped&&code!==0&&code!==1){const error=new AppError('search_failed',422);error.message=stderr.trim()||`ripgrep exited with code ${code}`;throw error;}if(failure)throw failure;}
  finally{signal?.removeEventListener('abort',abort);lines.close();stop(Boolean(signal?.aborted));await Promise.allSettled([closed,feed,input.return(undefined)]);}
}

/** rg discovers paths and ignore rules; only the checked descriptor adapter ever supplies file contents. */
async function* searchFiles(binary:string,source:ProjectResources,base:string,glob:string|undefined,hidden:boolean,signal:AbortSignal|undefined):AsyncGenerator<string>{
  signal?.throwIfAborted();const args=['--no-config','--files','--null','--no-require-git','--glob','!.git'];if(hidden)args.push('--hidden');if(glob)args.push('--glob',glob);args.push('--','.');
  for await(const file of processNullPaths(binary,args,path.join(source.root,base),signal,[0,1]))yield workspaceRelativePath(source.root,path.join(base,file));
}

export function projectGrepTool(original:Tool<any,any,any,any,any>,source:ProjectResources,currentRoot:()=>string,leaseFactory?:(signal:AbortSignal|undefined,identity:ProjectReadIdentity)=>ProjectReadLease){
  const configuredRoot=currentRoot();
  return createTool({id:original.id,description:'Search workspace file contents with ripgrep regular expressions or literal text. Respects .gitignore and .ignore, searches all ordinary text file names, and returns matching paths and line numbers with bounded context. path accepts a file, directory or legacy glob; glob filters paths within the selected directory. limit is a global match limit (default 100); maxCount retains the legacy per-file limit. ignoreCase/literal/context and the legacy caseSensitive/contextLines/includeHidden fields are accepted. Read the indicated file and line to see full truncated lines.',inputSchema:grepInput,outputSchema:z.string(),execute:async(input,context)=>{
    const native=context?.requestContext?.get('shittimchest-native-input-run'),runId=native&&typeof native==='object'&&'runId'in native&&typeof native.runId==='string'?native.runId:undefined,lease=leaseFactory?.(context?.abortSignal,{runId,toolCallId:context?.agent?.toolCallId,agent:Boolean(context?.agent)}),signal=lease?.signal??context?.abortSignal;
    try{
      if(signal?.aborted)return 'Search incomplete: aborted. No files were read.';const {workspace,filesystem}=requireFilesystem(context!);const metadata=await workspace.getInfo({requestContext:context?.requestContext,resolveDynamicProviders:false});await context?.writer?.custom({type:'data-workspace-metadata',data:{toolName:original.id,toolCallId:context?.agent?.toolCallId,...metadata}});
      const inputPath=input.path||'.',legacyGlob=isGlobPattern(inputPath),base=workspaceRelativePath(configuredRoot,legacyGlob?extractGlobBase(inputPath):inputPath),check=()=>{signal?.throwIfAborted();if(currentRoot()!==configuredRoot)throw new AppError('workspace_changed',409);source.checkRoot();};check();let stat;
      try{stat=await source.stat(base);}catch(error){if(error instanceof AppError&&error.status===403)return 'Search target is not available within this workspace.';throw error;}
      const binary=findRg();if(!binary)throw new AppError('search_unavailable',503);const contextLines=Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(input.context??input.contextLines??0))),limit=Math.max(1,Math.floor(input.limit??100)),maxCount=input.maxCount===undefined?undefined:Math.max(1,Math.floor(input.maxCount)),output=new GrepOutput(limit,contextLines),args=['--no-config','--json','--line-number','--color=never'];
      if(input.ignoreCase??input.caseSensitive===false)args.push('--ignore-case');if(input.literal)args.push('--fixed-strings');if(contextLines)args.push('--context',String(contextLines));if(maxCount)args.push('--max-count',String(maxCount));args.push('--',input.pattern);
      const matchLegacy=legacyGlob?createGlobMatcher(inputPath.replace(/^(?:\.\/)+/,''),{dot:input.includeHidden??true}):undefined,glob=input.glob?.replace(/^(!?)(?:\.\/)+/,'$1');
      if(stat.type==='file')await searchFile(binary,source,base,args,signal,output);else for await(const file of searchFiles(binary,source,base,glob,input.includeHidden??true,signal)){check();if(matchLegacy&&!matchLegacy(file.split(path.sep).join('/')))continue;try{await source.stat(file);}catch(error){if(error instanceof AppError&&error.status===403)continue;throw error;}await searchFile(binary,source,file,args,signal,output);if(output.done)break;}
      check();return output.output();
    }finally{lease?.finish();}
  }});
}
