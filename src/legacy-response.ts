import {createHash} from 'node:crypto';
import {AppError} from './domain.js';
import type {ConversationMessage,ConversationPage,TuiSnapshot} from './protocol.js';

export const LEGACY_RESPONSE_CHARACTERS=12*1024*1024;
const cursor=(message:ConversationMessage)=>Buffer.from(JSON.stringify({at:message.createdAt,id:message.id})).toString('base64url');
function preview(message:ConversationMessage):ConversationMessage{
 const bytes=Buffer.from(JSON.stringify(message)),attachments=message.attachments?.length??0;
 return {...message,...(attachments>8?{attachments:message.attachments!.slice(0,8)}:{}),content:message.content.slice(0,4096)+`\n\n[此消息的完整记录超出当前客户端单次响应容量：正文 ${message.content.length} 字符，附件 ${attachments} 项。新版客户端将自动读取完整记录；会话导出保留原文。]`,payloadRef:{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,characters:message.content.length,attachmentCount:attachments,route:`/conversation/messages/${encodeURIComponent(message.id)}?contextId=${encodeURIComponent(message.contextId)}`}};
}

/** The canonical page remains untouched; only the legacy JSON envelope is bounded. */
export function legacyConversationPage(source:ConversationPage,characters=LEGACY_RESPONSE_CHARACTERS):ConversationPage{
 const messages:ConversationMessage[]=[];let contentSize=0;
 const envelope=(last:ConversationMessage|undefined,count:number):ConversationPage=>({messages:[],hasMore:source.hasMore||count<source.messages.length,nextCursor:last?cursor(last):source.nextCursor});
 for(const original of source.messages){
  let row=original,length=JSON.stringify(row).length;
  // A smaller snapshot remainder must not turn a message that a standalone
  // legacy page can already carry into a lossy preview.
  if(JSON.stringify(envelope(original,1)).length+length>LEGACY_RESPONSE_CHARACTERS){row=preview(original);length=JSON.stringify(row).length;}
  const count=messages.length+1,size=JSON.stringify(envelope(row,count)).length+contentSize+length+(count-1);
  if(size>characters){if(!messages.length)throw new AppError('conversation_requires_stream',413);break;}
  messages.push(row);contentSize+=length;
 }
 const result={...envelope(messages.at(-1),messages.length),messages};
 if(JSON.stringify(result).length>characters)throw new AppError('conversation_requires_stream',413);return result;
}
export function legacySnapshot(source:TuiSnapshot):TuiSnapshot{
 const{conversation,...state}=source,base=JSON.stringify({...state,conversation:null}).length-4;
 if(base>=LEGACY_RESPONSE_CHARACTERS)throw new AppError('snapshot_requires_stream',413);
 let page:ConversationPage;try{page=legacyConversationPage(conversation,LEGACY_RESPONSE_CHARACTERS-base);}catch(error){if(error instanceof AppError&&error.code==='conversation_requires_stream')throw new AppError('snapshot_requires_stream',413);throw error;}
 const result={...state,conversation:page};
 if(JSON.stringify(result).length>LEGACY_RESPONSE_CHARACTERS)throw new AppError('snapshot_requires_stream',413);return result;
}
