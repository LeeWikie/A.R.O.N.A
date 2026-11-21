import {AppError} from './domain.js';
import type {QueueEditEntry} from './protocol.js';

export function splitQueueText(content:string,limit=64000):string[]{
  if(!Number.isSafeInteger(limit)||limit<2)throw new AppError('invalid_queue_part_limit');
  const parts:string[]=[];for(let offset=0;offset<content.length;){let end=Math.min(content.length,offset+limit);const code=content.charCodeAt(end-1),next=content.charCodeAt(end);if(end<content.length&&code>=0xd800&&code<=0xdbff&&next>=0xdc00&&next<=0xdfff)end--;parts.push(content.slice(offset,end));offset=end;}return parts.length?parts:[''];
}

/** Keep logical input intact while respecting each native message's resource bounds. */
export function splitQueueEntry<T extends QueueEditEntry>(entry:T,bytes:(id:string)=>number):T[]{
  const texts=splitQueueText(entry.content),files:string[][]=[];let current:string[]=[],size=0;
  for(const id of entry.attachments){const length=bytes(id);if(!Number.isSafeInteger(length)||length<0||length>32*1024*1024)throw new AppError('message_attachments_too_large');if(current.length&&(current.length===8||size+length>32*1024*1024)){files.push(current);current=[];size=0;}current.push(id);size+=length;}if(current.length)files.push(current);
  return Array.from({length:Math.max(texts.length,files.length)},(_,index)=>{const part={...entry,content:texts[index]??'',attachments:files[index]??[],sourceSignalIds:index===0?entry.sourceSignalIds:[]} as T;if(index>0){delete(part as T&{localContext?:string}).localContext;delete(part as T&{referenceContext?:string}).referenceContext;}return part;});
}
