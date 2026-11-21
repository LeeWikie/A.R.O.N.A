import {createHash} from 'node:crypto';
import {AppError} from './domain.js';
import {setImmediate as nextTurn} from 'node:timers/promises';

export const JSON_CONTENT_MEDIA_TYPE='application/vnd.shittimchest.json-content+ndjson';
export const JSON_CONTENT_PART_CHARACTERS=32*1024;
type RecordValue=Record<string,unknown>;
type Pending={kind:'value';value:unknown}|{kind:'record';value:RecordValue}|{kind:'key';value:string}|{kind:'end';value:object;type:'object-end'|'array-end'};

/** JSON values stay intact; bounded structural records avoid a whole-response string limit. */
export function* encodeJsonContent(value:unknown):Generator<string>{
 const hash=createHash('sha256'),seen=new Set<object>(),pending:Pending[]=[{kind:'value',value}];let records=0;
 const encode=(row:RecordValue)=>{const line=JSON.stringify(row);hash.update(line+'\n');records++;return line;};
 yield encode({type:'json-content',version:1});
 while(pending.length){const item=pending.pop()!;
  if(item.kind==='record'){yield encode(item.value);continue;}
  if(item.kind==='key'){if(item.value.length<=JSON_CONTENT_PART_CHARACTERS)yield encode({type:'key',value:item.value});else{yield encode({type:'key-start'});for(let at=0;at<item.value.length;){let end=Math.min(item.value.length,at+JSON_CONTENT_PART_CHARACTERS);if(end<item.value.length&&/^[\uD800-\uDBFF]$/.test(item.value[end-1]!))end--;yield encode({type:'text',value:item.value.slice(at,end)});at=end;}yield encode({type:'key-end'});}continue;}
  if(item.kind==='end'){seen.delete(item.value);yield encode({type:item.type});continue;}
  let row=item.value;if(row&&typeof row==='object'&&'toJSON'in row&&typeof row.toJSON==='function')row=row.toJSON();
  if(typeof row==='string'){
   yield encode({type:'text-start'});for(let at=0;at<row.length;){let end=Math.min(row.length,at+JSON_CONTENT_PART_CHARACTERS);if(end<row.length&&/^[\uD800-\uDBFF]$/.test(row[end-1]!))end--;yield encode({type:'text',value:row.slice(at,end)});at=end;}yield encode({type:'text-end'});continue;
  }
  if(row===null||typeof row==='boolean'||typeof row==='number'){yield encode({type:'value',value:typeof row==='number'&&!Number.isFinite(row)?null:row});continue;}
  if(!row||typeof row!=='object'||seen.has(row))throw new AppError('response_content_not_serializable',500);seen.add(row);
  if(Array.isArray(row)){yield encode({type:'array-start'});pending.push({kind:'end',value:row,type:'array-end'});for(let index=row.length-1;index>=0;index--)pending.push({kind:'value',value:row[index]===undefined||typeof row[index]==='function'||typeof row[index]==='symbol'?null:row[index]});}
  else{yield encode({type:'object-start'});pending.push({kind:'end',value:row,type:'object-end'});const entries=Object.entries(row).filter(([,child])=>child!==undefined&&typeof child!=='function'&&typeof child!=='symbol');for(let index=entries.length-1;index>=0;index--){const[key,child]=entries[index]!;pending.push({kind:'value',value:child},{kind:'key',value:key});}}
 }
 yield JSON.stringify({type:'complete',records,sha256:hash.digest('hex')});
}

interface Frame {value:Record<string,unknown>|unknown[];key?:string}
export class JsonContentDecoder{
 private readonly hash=createHash('sha256');private records=0;private started=false;private ended=false;private rootSet=false;private root:unknown;private readonly stack:Frame[]=[];private text:string[]|undefined;private textIsKey=false;
 get complete(){return this.ended;}
 private fail():never{throw new AppError('invalid_content_stream',502);}
 private append(value:unknown){const parent=this.stack.at(-1);if(parent){if(Array.isArray(parent.value))parent.value.push(value);else{if(parent.key===undefined||Object.hasOwn(parent.value,parent.key))this.fail();Object.defineProperty(parent.value,parent.key,{value,writable:true,enumerable:true,configurable:true});delete parent.key;}}else{if(this.rootSet)this.fail();this.root=value;this.rootSet=true;}}
 private key(value:string){const frame=this.stack.at(-1);if(!frame||Array.isArray(frame.value)||frame.key!==undefined||Object.hasOwn(frame.value,value))this.fail();frame.key=value;}
 push(line:string):unknown{
  if(this.ended||line.length>512*1024)this.fail();let row:RecordValue;try{const parsed=JSON.parse(line);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))this.fail();row=parsed as RecordValue;}catch{this.fail();}
  if(row.type==='complete'){if(!this.started||!this.rootSet||this.stack.length||this.text||Object.keys(row).length!==3||row.records!==this.records||row.sha256!==this.hash.digest('hex'))this.fail();this.ended=true;return this.root;}
  this.hash.update(line+'\n');this.records++;
  if(!this.started){if(row.type!=='json-content'||row.version!==1||Object.keys(row).length!==2)this.fail();this.started=true;return;}
  if(this.text){if(row.type==='text'&&typeof row.value==='string'&&row.value.length<=JSON_CONTENT_PART_CHARACTERS&&Object.keys(row).length===2){this.text.push(row.value);return;}if(row.type===(this.textIsKey?'key-end':'text-end')&&Object.keys(row).length===1){const value=this.text.join('');this.text=undefined;if(this.textIsKey)this.key(value);else this.append(value);return;}this.fail();}
  if((row.type==='text-start'||row.type==='key-start')&&Object.keys(row).length===1){this.text=[];this.textIsKey=row.type==='key-start';return;}
  if(row.type==='value'&&Object.keys(row).length===2&&(row.value===null||typeof row.value==='boolean'||typeof row.value==='number'&&Number.isFinite(row.value))){this.append(row.value);return;}
  if(row.type==='object-start'||row.type==='array-start'){if(Object.keys(row).length!==1)this.fail();const value=row.type==='object-start'?{}:[];this.append(value);this.stack.push({value});return;}
  if(row.type==='key'&&typeof row.value==='string'&&row.value.length<=JSON_CONTENT_PART_CHARACTERS&&Object.keys(row).length===2){this.key(row.value);return;}
  if(row.type==='object-end'||row.type==='array-end'){const frame=this.stack.pop();if(!frame||Object.keys(row).length!==1||frame.key!==undefined||(row.type==='array-end')!==Array.isArray(frame.value))this.fail();return;}
  this.fail();
 }
 value(){if(!this.ended)this.fail();return this.root;}
}

export function jsonContentResponse(value:unknown):Response{
 const iterator=encodeJsonContent(value),encoder=new TextEncoder();let count=0,cancelled=false;return new Response(new ReadableStream<Uint8Array>({async pull(controller){try{if(count++%128===0)await nextTurn();if(cancelled)return;const next=iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(next.value+'\n'));}catch(error){controller.error(error);}},cancel(){cancelled=true;iterator.return(undefined);}}),{headers:{'content-type':JSON_CONTENT_MEDIA_TYPE,'cache-control':'no-store'}});
}

export async function decodeJsonContent(source:ReadableStream<Uint8Array>,signal?:AbortSignal):Promise<unknown>{
 const decoder=new TextDecoder('utf-8',{fatal:true}),parser=new JsonContentDecoder(),reader=source.getReader();let pending='';
 const abort=()=>{void reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try{for(;;){signal?.throwIfAborted();const next=await reader.read();if(next.done)break;pending+=decoder.decode(next.value,{stream:true});let at:number;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);parser.push(line);}if(pending.length>512*1024)throw new AppError('invalid_content_stream',502);}pending+=decoder.decode();if(pending)throw new AppError('invalid_content_stream',502);return parser.value();}
 catch(error){throw error instanceof AppError?error:new AppError('invalid_content_stream',502);}finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
