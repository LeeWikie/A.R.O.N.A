import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import {AppError} from './domain.js';
import {isBase64String} from './base64.js';
import {parseSessionArchive} from './context-transfer.js';
import type {SessionArchive} from './protocol.js';
import type {SessionSource} from './session-graph.js';
import type {PortableSessionAsset} from './session-assets.js';

export const SESSION_PROVENANCE_CAPABILITY='session-provenance';
const manifestType='org.shittimchest.session-provenance.v1',partType='org.shittimchest.session-provenance-part.v1',partBytes=256*1024;
type Continuation=NonNullable<SessionArchive['continuation']>;
export interface SessionProvenance {
 version:1;context:SessionArchive['context'];messages:SessionArchive['messages'];
 entries:Array<{id:string;source:SessionSource}>;sources:unknown[];
 checkpoint?:Continuation['checkpoint'];automaticCheckpoint?:Continuation['automaticCheckpoint'];
}
const bodySchema=z.object({version:z.literal(1),context:z.unknown(),messages:z.array(z.unknown()),entries:z.array(z.object({id:z.string().min(1),source:z.unknown()}).strict()),sources:z.array(z.unknown()),checkpoint:z.unknown().optional(),automaticCheckpoint:z.unknown().optional()}).strict();
const manifestSchema=z.object({version:z.literal(1),id:z.string().uuid(),bytes:z.number().int().positive().safe(),sha256:z.string().regex(/^[a-f0-9]{64}$/),parts:z.number().int().positive().safe()}).strict();
const invalid=()=>new AppError('invalid_session_provenance',409);
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');

/** Private transport records preserve source data without turning it into a new user message. */
export function* sessionProvenancePiEntries(input:SessionProvenance,parentId:string|null):Generator<SessionEntry>{
 const bytes=Buffer.from(JSON.stringify(input)),id=randomUUID(),parts=Math.ceil(bytes.length/partBytes),manifest=manifestSchema.parse({version:1,id,bytes:bytes.length,sha256:hash(bytes),parts});let parent=randomUUID();
 yield{type:'custom',id:parent,parentId,timestamp:new Date().toISOString(),customType:manifestType,data:manifest};
 for(let index=0;index<parts;index++){const next=randomUUID();yield{type:'custom',id:next,parentId:parent,timestamp:new Date().toISOString(),customType:partType,data:{id,index,data:bytes.subarray(index*partBytes,(index+1)*partBytes).toString('base64')}};parent=next;}
}

export function extractSessionProvenancePiEntries(entries:readonly SessionEntry[]){
 let manifest:z.infer<typeof manifestSchema>|undefined;const parts=new Map<number,Buffer>(),removed=new Set<string>();
 for(const entry of entries){if(entry.type!=='custom')continue;if(entry.customType.startsWith('org.shittimchest.session-provenance')&&entry.customType!==manifestType&&entry.customType!==partType)throw new AppError('session_data_feature_unsupported',409);if(entry.customType!==manifestType&&entry.customType!==partType)continue;removed.add(entry.id);
  if(entry.customType===manifestType){const checked=manifestSchema.safeParse(entry.data);if(manifest||!checked.success||checked.data.parts!==Math.ceil(checked.data.bytes/partBytes))throw invalid();manifest=checked.data;}
  else{const checked=z.object({id:z.string().uuid(),index:z.number().int().nonnegative().safe(),data:z.string().max(Math.ceil(partBytes/3)*4)}).strict().safeParse(entry.data);if(!manifest||!checked.success||checked.data.id!==manifest.id||checked.data.index>=manifest.parts||parts.has(checked.data.index)||!isBase64String(checked.data.data))throw invalid();const bytes=Buffer.from(checked.data.data,'base64');if(bytes.toString('base64')!==checked.data.data||bytes.length!==Math.min(partBytes,manifest.bytes-checked.data.index*partBytes))throw invalid();parts.set(checked.data.index,bytes);}
 }
 const kept=entries.filter(entry=>!removed.has(entry.id));if(kept.some(entry=>entry.parentId!==null&&removed.has(entry.parentId)))throw invalid();if(!manifest)return{entries:kept};
 if(parts.size!==manifest.parts)throw invalid();const bytes=Buffer.concat(Array.from({length:manifest.parts},(_,index)=>parts.get(index)!));if(bytes.length!==manifest.bytes||hash(bytes)!==manifest.sha256)throw invalid();let input:unknown;try{input=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{throw invalid();}const checked=bodySchema.safeParse(input);if(!checked.success)throw invalid();return{entries:kept,provenance:checked.data};
}

/** Reuses the complete archive validator; source metadata remains imported history data. */
export function verifySessionProvenance(input:NonNullable<ReturnType<typeof extractSessionProvenancePiEntries>['provenance']>,session:{header:unknown;entries:readonly SessionEntry[];leafId:string|null},assets:readonly PortableSessionAsset[]):SessionProvenance{
 const ids=new Set(session.entries.map(entry=>entry.id)),sources=new Map<string,unknown>();for(const row of input.entries){if(!ids.has(row.id)||sources.has(row.id))throw invalid();sources.set(row.id,row.source);}
 let archive:SessionArchive;try{archive=parseSessionArchive({format:'shittimchest-session',version:1,context:input.context,messages:input.messages,continuation:{messages:[],publicMessageMap:{},assets:assets.map(({entryIds,...asset})=>asset),graph:{header:session.header,leafId:session.leafId,entries:session.entries.map(entry=>({entry,...(sources.has(entry.id)?{source:sources.get(entry.id)}:{})})),sources:input.sources},...(input.checkpoint!==undefined?{checkpoint:input.checkpoint}:{}),...(input.automaticCheckpoint!==undefined?{automaticCheckpoint:input.automaticCheckpoint}:{})}},{large:true});}catch{throw invalid();}
 const graph=archive.continuation!.graph!;return{version:1,context:archive.context,messages:archive.messages,entries:graph.entries.flatMap(row=>row.source?[{id:(row.entry as SessionEntry).id,source:row.source}]:[]),sources:graph.sources,...(archive.continuation!.checkpoint?{checkpoint:archive.continuation!.checkpoint}:{}),...(archive.continuation!.automaticCheckpoint?{automaticCheckpoint:archive.continuation!.automaticCheckpoint}:{})};
}
