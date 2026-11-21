import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Client} from './client.js';
import type {SessionTransferJob} from './protocol.js';
import type {SessionTransferOptions} from './session-transfer-store.js';
import {AppError} from './domain.js';
import {sensitiveFile} from './file-policy.js';
import{sessionDataRequirements}from'./session-assets.js';

export interface SessionFileTransferOptions {
 operationId:string;signal?:AbortSignal;onProgress?:(job:SessionTransferJob)=>void|Promise<void>;
}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function jobRequest<T>(client:Client,storageId:string,route:string,signal?:AbortSignal,body?:unknown,method=body===undefined?'GET':'POST',operationId?:string){return client.request<T>(route,{method,signal,headers:{'content-type':'application/json','X-ShittimChest-Storage-Id':storageId,...(operationId?{'Idempotency-Key':operationId}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function wait(client:Client,storageId:string,job:SessionTransferJob,options:SessionFileTransferOptions){for(;;){options.signal?.throwIfAborted();await options.onProgress?.(job);if(['completed','ready'].includes(job.state))return job;if(job.state==='failed'||job.state==='cancelled')throw new AppError(job.errorCode??`session_transfer_${job.state}`,409);await delay(100,undefined,{signal:options.signal});job=(await jobRequest<{transfer:SessionTransferJob}>(client,storageId,`/session-transfers/${job.id}`,options.signal)).transfer;}}
function sameFile(before:fs.Stats,after:fs.Stats){return after.isFile()&&after.nlink===1&&before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs;}
async function safeInput(file:string){if(sensitiveFile(file))throw new AppError('import_private_path');const visible=await fs.promises.lstat(file);if(!visible.isFile()||visible.isSymbolicLink()||visible.nlink!==1||sensitiveFile(await fs.promises.realpath(file)))throw new AppError('session_archive_redirected',403);const handle=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const stat=await handle.stat();if(!sameFile(visible,stat))throw new AppError('session_archive_changed',409);return {handle,stat};}catch(error){await handle.close();throw error;}}
async function syncDirectory(directory:string){if(process.platform==='win32')return;const handle=await fs.promises.open(directory,fs.constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}}
async function recoverExportPublication(file:string,job:SessionTransferJob){
 let visible:fs.Stats;try{visible=await fs.promises.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}if(!visible.isFile()||visible.isSymbolicLink())throw new AppError('session_archive_redirected',403);if(visible.nlink===1)return;if(visible.nlink!==2)throw new AppError('session_archive_redirected',403);
 const prefix=`.session-${job.id}-`,directory=path.dirname(file);for(const name of await fs.promises.readdir(directory)){if(!name.startsWith(prefix)||!/^[-a-f0-9]{36}\.part$/.test(name.slice(prefix.length)))continue;const temporary=path.join(directory,name),other=await fs.promises.lstat(temporary);if(!other.isFile()||other.isSymbolicLink()||other.dev!==visible.dev||other.ino!==visible.ino||other.nlink!==2||other.size!==job.bytes)continue;const handle=await fs.promises.open(temporary,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=await handle.stat();if(opened.dev!==other.dev||opened.ino!==other.ino||opened.nlink!==2)continue;const hash=createHash('sha256');for await(const part of handle.createReadStream({autoClose:false}))hash.update(part);const final=await fs.promises.lstat(file),own=await fs.promises.lstat(temporary),after=await handle.stat();if(hash.digest('hex')!==job.sha256||after.size!==job.bytes||after.dev!==opened.dev||after.ino!==opened.ino||after.nlink!==2||final.isSymbolicLink()||own.isSymbolicLink()||final.dev!==opened.dev||final.ino!==opened.ino||own.dev!==opened.dev||own.ino!==opened.ino||final.nlink!==2||own.nlink!==2)continue;await fs.promises.unlink(temporary);await syncDirectory(directory);return;}finally{await handle.close();}}
 throw new AppError('session_archive_redirected',403);
}
async function existingExport(file:string,job:SessionTransferJob){
 try{await fs.promises.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}await recoverExportPublication(file,job);const previous=await safeInput(file);try{const hash=createHash('sha256');for await(const part of previous.handle.createReadStream({autoClose:false}))hash.update(part);if(!sameFile(previous.stat,await previous.handle.stat())||!sameFile(previous.stat,await fs.promises.lstat(file)))throw new AppError('session_archive_changed',409);if(previous.stat.size!==job.bytes||hash.digest('hex')!==job.sha256)throw new AppError('session_export_exists',409);return true;}finally{await previous.handle.close();}
}

export async function importSessionFile(client:Client,file:string,input:SessionTransferOptions,options:SessionFileTransferOptions){
 const protocol=await client.handshake(options.signal);if(!protocol.capabilities.includes('session-transfer-stream'))throw new AppError('session_transfer_unavailable',409);
 const {handle,stat}=await safeInput(file);try{
  const hash=createHash('sha256'),buffer=Buffer.alloc(256*1024);let position=0;
  for(;;){options.signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
  const{readSessionTransferHeader}=await import('./session-transfer-codec.js'),first=await readSessionTransferHeader((async function*(){const bytes=Buffer.alloc(256*1024);let offset=0;for(;;){options.signal?.throwIfAborted();const{bytesRead}=await handle.read(bytes,0,bytes.length,offset);if(!bytesRead)break;offset+=bytesRead;yield bytes.subarray(0,bytesRead);}})(),options.signal);for(const required of sessionDataRequirements(first))if(!protocol.capabilities.includes(required))throw new AppError('session_data_feature_unsupported',409);
  if(!sameFile(stat,await handle.stat())||!sameFile(stat,await fs.promises.lstat(file)))throw new AppError('session_archive_changed',409);
  const {transfer:created}=await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,'/session-transfers/import',options.signal,{bytes:position,sha256:hash.digest('hex'),options:input},'POST',options.operationId);let job=created;await options.onProgress?.(job);
  if(job.state==='completed')return job;
  if(job.state==='failed'&&job.retryable)job=(await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,`/session-transfers/${job.id}/retry`,options.signal,{})).transfer;
  if(job.state==='uploading'||job.state==='uploaded'){
   const received=new Map<number,{sha256:string;bytes:number}>();let after=-1;
   for(;;){const page=await jobRequest<{parts:Array<{index:number;sha256:string;bytes:number}>;nextCursor:number|null}>(client,protocol.storageId,`/session-transfers/${job.id}/parts?after=${after}`,options.signal);for(const part of page.parts)received.set(part.index,part);if(page.nextCursor===null)break;after=page.nextCursor;}
   const part=Buffer.alloc(job.partSize);for(let index=0;index<job.partCount;index++){options.signal?.throwIfAborted();const count=Math.min(job.partSize,stat.size-index*job.partSize),{bytesRead}=await handle.read(part,0,count,index*job.partSize);if(bytesRead!==count)throw new AppError('session_archive_changed',409);const body=part.subarray(0,count),sha256=digest(body),old=received.get(index);if(old){if(old.sha256!==sha256||old.bytes!==count)throw new AppError('session_archive_changed',409);continue;}job=(await client.request<{transfer:SessionTransferJob}>(`/session-transfers/${job.id}/parts/${index}`,{method:'PUT',signal:options.signal,headers:{'content-type':'application/octet-stream','X-ShittimChest-Storage-Id':protocol.storageId,'X-Content-SHA256':sha256},body:new Uint8Array(body)})).transfer;await options.onProgress?.(job);}
   if(!sameFile(stat,await handle.stat())||!sameFile(stat,await fs.promises.lstat(file)))throw new AppError('session_archive_changed',409);
   job=(await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,`/session-transfers/${job.id}/commit`,options.signal,{})).transfer;
  }
  return await wait(client,protocol.storageId,job,options);
 }finally{await handle.close();}
}

export async function exportSessionFile(client:Client,file:string,input:{contextId:string;format:'pi'|'archive';continuation?:boolean},options:SessionFileTransferOptions){
 if(sensitiveFile(file))throw new AppError('export_private_path');await fs.promises.mkdir(path.dirname(file),{recursive:true});if(sensitiveFile(await fs.promises.realpath(path.dirname(file))))throw new AppError('export_private_path');
 const protocol=await client.handshake(options.signal);if(!protocol.capabilities.includes('session-transfer-stream'))throw new AppError('session_transfer_unavailable',409);
 let job=(await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,'/session-transfers/export',options.signal,input,'POST',options.operationId)).transfer;
 if(job.state==='cancelled'&&job.readyAt&&await existingExport(file,job)){job=(await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,`/session-transfers/${job.id}/acknowledge`,options.signal,{sha256:job.sha256})).transfer;await options.onProgress?.(job);return job;}
 if(job.state==='failed'&&job.retryable)job=(await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,`/session-transfers/${job.id}/retry`,options.signal,{})).transfer;
 job=await wait(client,protocol.storageId,job,options);
 if(await existingExport(file,job)){job=(await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,`/session-transfers/${job.id}/acknowledge`,options.signal,{sha256:job.sha256})).transfer;await options.onProgress?.(job);return job;}
 const temporary=path.join(path.dirname(file),`.session-${job.id}-${randomUUID()}.part`),handle=await fs.promises.open(temporary,'wx',0o600);let complete=false;
 try{
  const hash=createHash('sha256');let total=0;
  for(let index=0;index<job.partCount;index++){
   options.signal?.throwIfAborted();const headers=new Headers({'X-ShittimChest-Storage-Id':protocol.storageId});if(client.token)headers.set('Authorization',`Bearer ${client.token}`);const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
   const response=await fetch(new URL(`/session-transfers/${job.id}/parts/${index}`,client.baseURL),{headers,redirect:'error',signal});if(!response.ok){let code='session_transfer_download_failed';try{const body=await response.json() as {error?:string};if(body.error)code=body.error;}catch{}throw new AppError(code,response.status);}const reader=response.body?.getReader();if(!reader)throw new AppError('session_transfer_corrupt',502);const chunks:Uint8Array[]=[];let count=0;try{for(;;){const next=await reader.read();if(next.done)break;count+=next.value.byteLength;if(count>job.partSize)throw new AppError('session_transfer_corrupt',502);chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}const bytes=Buffer.concat(chunks);if(bytes.length!==Math.min(job.partSize,job.bytes-index*job.partSize)||digest(bytes)!==response.headers.get('X-Content-SHA256'))throw new AppError('session_transfer_corrupt',502);hash.update(bytes);total+=bytes.length;await handle.writeFile(bytes);await options.onProgress?.({...job,receivedBytes:total,receivedParts:index+1});
  }
  if(total!==job.bytes||hash.digest('hex')!==job.sha256)throw new AppError('session_transfer_hash_mismatch',409);await handle.sync();await handle.close();
  try{await fs.promises.link(temporary,file);await fs.promises.unlink(temporary);await syncDirectory(path.dirname(file));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await existingExport(file,job);}
  complete=true;job=(await jobRequest<{transfer:SessionTransferJob}>(client,protocol.storageId,`/session-transfers/${job.id}/acknowledge`,options.signal,{sha256:job.sha256})).transfer;await options.onProgress?.(job);return job;
 }finally{if(!complete)await handle.close().catch(()=>{});await fs.promises.unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}
