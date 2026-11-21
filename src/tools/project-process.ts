import {spawn} from 'node:child_process';
import {AppError} from '../domain.js';

/** Await the owned native handle on every path, including a consumer ending a bounded discovery page. */
export async function* processNullPaths(binary:string,args:string[],cwd:string,signal:AbortSignal|undefined,acceptedExitCodes:readonly number[]=[0]):AsyncGenerator<string>{
  signal?.throwIfAborted();const child=spawn(binary,args,{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true});let error:Error|undefined,stderr='',exited=false,pending=Buffer.alloc(0);
  const closed=new Promise<number|null>(resolve=>{child.once('error',value=>{error=value;});child.once('close',code=>{exited=true;resolve(code);});}),stop=()=>{if(!exited&&!child.killed)child.kill();};signal?.addEventListener('abort',stop,{once:true});child.stderr.on('data',(chunk:Buffer)=>{if(stderr.length<65536)stderr+=chunk.toString('utf8').slice(0,65536-stderr.length);});
  try{
    if(signal?.aborted)stop();for await(const chunk of child.stdout){signal?.throwIfAborted();pending=Buffer.concat([pending,chunk]);for(let end;(end=pending.indexOf(0))!==-1;){const bytes=pending.subarray(0,end);pending=pending.subarray(end+1);let file:string;try{file=new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{throw new AppError('search_path_encoding_unsupported',415);}if(!file)throw new AppError('search_output_invalid',502);yield file;}}
    const code=await closed;signal?.throwIfAborted();if(error)throw new AppError('search_unavailable',503);if(pending.length)throw new AppError('search_output_invalid',502);if(code===null||!acceptedExitCodes.includes(code)){const failure=new AppError('search_discovery_failed',422);failure.message=stderr.trim()||failure.message;throw failure;}
  }finally{signal?.removeEventListener('abort',stop);stop();await closed;}
}
