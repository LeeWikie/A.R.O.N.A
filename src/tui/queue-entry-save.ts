import {createHash} from 'node:crypto';
import type {QueueEditDocument,QueueEntryEdit} from '../protocol.js';
import {splitQueueText} from '../queue-content.js';
import {AppError} from '../domain.js';

export interface PendingQueueEntryEdit {operationId:string;baseRevision:number;content:string;attachments:string[];captureDraftId?:string;localContext?:string}
export interface QueueEntryWriter {
  attachmentParts?:boolean;
  request<T>(route:string):Promise<T>;
  write(route:string,body:unknown,method?:string,operationId?:string):Promise<unknown>;
}
/** An edit commits only after every immutable transport part has been saved. */
export async function saveQueueEntry(host:QueueEntryWriter,route:string,entryId:string,pending:PendingQueueEntryEdit):Promise<QueueEditDocument>{
  const simple={expectedRevision:pending.baseRevision,action:{kind:'edit',entryId,content:pending.content,attachments:pending.attachments,...(pending.captureDraftId?{captureDraftId:pending.captureDraftId}:{}),...(pending.localContext!==undefined?{localContext:pending.localContext}:{})}};
  if(pending.content.length<=64000&&pending.attachments.length<=8&&(pending.localContext?.length??0)<=64000&&Buffer.byteLength(JSON.stringify(simple))<=512*1024)return await host.write(route,simple,'PATCH',pending.operationId) as QueueEditDocument;
  const parts=splitQueueText(pending.content);
  const contextParts=pending.localContext!==undefined&&pending.localContext.length>64000?splitQueueText(pending.localContext):undefined;
  const attachmentParts=host.attachmentParts&&pending.attachments.length>8?Array.from({length:Math.ceil(pending.attachments.length/1024)},(_,index)=>JSON.stringify(pending.attachments.slice(index*1024,(index+1)*1024))):undefined;
  const input={entryId,expectedRevision:pending.baseRevision,partCount:parts.length,characters:pending.content.length,hash:createHash('sha256').update(pending.content).digest('hex'),attachments:attachmentParts?[]:pending.attachments,...(attachmentParts?{attachmentParts:{partCount:attachmentParts.length,items:pending.attachments.length,hash:createHash('sha256').update(JSON.stringify(pending.attachments)).digest('hex')}}:{}),...(pending.captureDraftId?{captureDraftId:pending.captureDraftId}:{}),...(contextParts?{contextParts:{partCount:contextParts.length,characters:pending.localContext!.length,hash:createHash('sha256').update(pending.localContext!).digest('hex')}}:pending.localContext!==undefined?{localContext:pending.localContext}:{})};
  if(Buffer.byteLength(JSON.stringify(input))>512*1024)throw new AppError('queue_attachment_transfer_unsupported',409);
  const started=await host.write(`${route}/entry-edits`,input,'POST',pending.operationId) as QueueEntryEdit;
  const upload=await host.request<QueueEntryEdit>(`${route}/entry-edits/${encodeURIComponent(started.id)}`);
  if(upload.status==='committed')return upload.result!;
  const received=new Set(upload.receivedParts);for(const [index,content] of parts.entries())if(!received.has(index))await host.write(`${route}/entry-edits/${encodeURIComponent(upload.id)}/parts/${index}`,{content},'PUT',`${pending.operationId}:part:${index}`);
  const receivedContext=new Set(upload.receivedContextParts);for(const [index,content] of contextParts?.entries()??[])if(!receivedContext.has(index))await host.write(`${route}/entry-edits/${encodeURIComponent(upload.id)}/context-parts/${index}`,{content},'PUT',`${pending.operationId}:context:${index}`);
  const receivedAttachments=new Set(upload.receivedAttachmentParts);for(const[index,content]of attachmentParts?.entries()??[])if(!receivedAttachments.has(index))await host.write(`${route}/entry-edits/${encodeURIComponent(upload.id)}/attachment-parts/${index}`,{content},'PUT',`${pending.operationId}:attachments:${index}`);
  return await host.write(`${route}/entry-edits/${encodeURIComponent(upload.id)}/commit`,{},'POST',`${pending.operationId}:commit`) as QueueEditDocument;
}
