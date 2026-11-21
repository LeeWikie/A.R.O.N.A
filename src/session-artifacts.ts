import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {AppError} from './domain.js';
import {isBase64String} from './base64.js';
import {createReadTool,type SessionEntry} from '@earendil-works/pi-coding-agent';
import type {SessionGraphRecord} from './session-graph.js';
import {isPrivateMcpRepresentation,mcpResultReferenceSchema,mcpResultPageSchema,type McpResultPageOptions} from './tools/mcp-results.js';

export const SESSION_ARTIFACT_PART_BYTES=256*1024;
const digest=z.string().regex(/^[a-f0-9]{64}$/),nonempty=z.string().min(1);
const partSchema=z.object({sha256:digest,bytes:z.number().int().min(1).max(SESSION_ARTIFACT_PART_BYTES)}).strict();
export const sessionArtifactSchema=z.object({
 version:z.literal(1),id:nonempty,kind:z.enum(['web-result','terminal-output','worker-session','worker-continuation','task-delivery','mcp-result']),entryIds:z.array(nonempty).min(1),
 origin:z.object({ref:nonempty,contextId:nonempty,runId:nonempty.nullable(),taskId:nonempty.nullable(),entryId:nonempty.optional(),stream:z.enum(['stdout','stderr']).optional()}).strict(),
 name:nonempty,mediaType:nonempty,bytes:z.number().int().nonnegative().refine(Number.isSafeInteger),sha256:digest,complete:z.boolean(),
 original:z.record(z.string(),z.json()).optional(),
 parts:z.array(partSchema),
}).strict().superRefine((row,ctx)=>{
 if(new Set(row.entryIds).size!==row.entryIds.length||row.parts.reduce((sum,part)=>sum+part.bytes,0)!==row.bytes||row.parts.some((part,index)=>index<row.parts.length-1&&part.bytes!==SESSION_ARTIFACT_PART_BYTES)||row.kind!=='terminal-output'&&row.origin.stream!==undefined||row.kind==='terminal-output'&&row.origin.stream===undefined)ctx.addIssue({code:'custom',message:'Invalid artifact manifest'});
 if(row.kind==='mcp-result'){const reference=mcpResultReferenceSchema.safeParse(row.original?.mcp);if(!reference.success||reference.data.id!==row.origin.ref||reference.data.sha256!==row.sha256||reference.data.bytes!==row.bytes||reference.data.name!==row.name||reference.data.mediaType!==row.mediaType||!row.complete)ctx.addIssue({code:'custom',message:'Invalid MCP artifact reference'});}
 else if(row.original?.mcp!==undefined||/^mcp-result\.[0-9a-f-]{36}$/.test(row.origin.ref))ctx.addIssue({code:'custom',message:'Reserved MCP artifact metadata'});
});
export type SessionArtifact=z.infer<typeof sessionArtifactSchema>;
export type PortableSessionArtifact=Omit<SessionArtifact,'parts'>&{parts:Array<SessionArtifact['parts'][number]&{data:string}>};
export type SessionArtifactPayload=Pick<SessionArtifact,'bytes'|'sha256'|'parts'>;
export function privateSessionArtifact(row:Pick<SessionArtifact,'kind'|'original'>){return row.kind==='worker-continuation'||row.kind==='mcp-result'&&row.original?.mcp&&typeof row.original.mcp==='object'&&!Array.isArray(row.original.mcp)&&isPrivateMcpRepresentation(row.original.mcp.representation);}
function modelArtifact<T extends Pick<SessionArtifact,'kind'|'original'>>(row:T):T{if(row.kind!=='mcp-result'||!row.original?.mcp||typeof row.original.mcp!=='object'||Array.isArray(row.original.mcp))return row;const{originalResultId,...mcp}=row.original.mcp;return{...row,original:{...row.original,mcp}};}
export const unavailableSessionArtifactSchema=z.object({version:z.literal(1),id:nonempty,kind:sessionArtifactSchema.shape.kind,entryIds:z.array(nonempty).min(1),origin:sessionArtifactSchema.shape.origin,name:nonempty,mediaType:nonempty,availability:z.literal('unavailable'),expectedSha256:digest.optional(),reason:z.enum(['not-retained','source-unavailable']),original:sessionArtifactSchema.shape.original}).strict();
export type UnavailableSessionArtifact=z.infer<typeof unavailableSessionArtifactSchema>;
export interface RetainedSessionReference{kind:'web-result'|'terminal-output'|'mcp-result';ref:string;entryId:string;toolCallId:string;toolName:string;runId:string|null;value:unknown}
export function retainedSessionReferences(records:readonly SessionGraphRecord[]):RetainedSessionReference[]{
 const found:RetainedSessionReference[]=[];
 for(const row of records){const entry=row.entry;if(entry.type!=='message'||entry.message.role!=='toolResult')continue;const message=entry.message;
  for(const part of message.content){if(part.type!=='text')continue;const common={entryId:entry.id,toolCallId:message.toolCallId,toolName:message.toolName,runId:row.source?.runId??null,value:part.text as unknown};
   if(['mastra_workspace_execute_command','mastra_workspace_get_process_output'].includes(message.toolName)){const ids=new Set([...part.text.matchAll(/(?:^|\n)\[Full output: (process\.[0-9a-f-]{36}); use terminal_process action=log with (?:stream=stderr and )?encoding=base64 byte pagination\.\](?=\n|$)/g)].map(match=>match[1]!));for(const ref of ids)found.push({...common,kind:'terminal-output',ref});continue;}
   let value:unknown;try{value=JSON.parse(part.text);}catch{continue;}if(!value||typeof value!=='object'||Array.isArray(value))continue;const result=value as Record<string,unknown>;common.value=value;
   if(message.toolName==='web_fetch'){const pages=Array.isArray(result.results)?result.results:[result];for(const page of pages){if(!page||typeof page!=='object'||Array.isArray(page))continue;const ref=(page as {resultRef?:{id?:unknown}}).resultRef;if(ref&&typeof ref.id==='string'&&z.uuid().safeParse(ref.id).success)found.push({...common,kind:'web-result',ref:ref.id});}}
   else if(['terminal_process','read_terminal_result'].includes(message.toolName)&&typeof result.id==='string'&&/^process\.[0-9a-f-]{36}$/.test(result.id))found.push({...common,kind:'terminal-output',ref:result.id});
  }
 }
 return found;
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const invalid=()=>new AppError('invalid_session_artifact',409);
function stableOriginal(original:SessionArtifact['original']){if(!original)return original;const process=original.process;if(!process||typeof process!=='object'||Array.isArray(process))return original;const{capturedAt,...stable}=process;return {...original,process:stable};}

export function parsePortableSessionArtifact(input:unknown):PortableSessionArtifact{
 if(!input||typeof input!=='object'||!Array.isArray((input as {parts?:unknown}).parts))throw invalid();
 const row=input as Record<string,unknown>,parts=row.parts as unknown[],manifest=sessionArtifactSchema.safeParse({...row,parts:parts.map(part=>{if(!part||typeof part!=='object')throw invalid();const{data,...rest}=part as Record<string,unknown>;return rest;})});
 if(!manifest.success)throw invalid();const aggregate=createHash('sha256');
 const checked=parts.map((part,index)=>{const raw=part as Record<string,unknown>;if(Object.keys(raw).some(key=>!['sha256','bytes','data'].includes(key))||typeof raw.data!=='string'||!isBase64String(raw.data)||raw.data.length>Math.ceil(SESSION_ARTIFACT_PART_BYTES/3)*4)throw invalid();const bytes=Buffer.from(raw.data,'base64'),expected=manifest.data.parts[index]!;if(bytes.length!==expected.bytes||hash(bytes)!==expected.sha256||bytes.toString('base64')!==raw.data)throw invalid();aggregate.update(bytes);return {...expected,data:raw.data};});
 if(aggregate.digest('hex')!==manifest.data.sha256)throw invalid();return {...manifest.data,parts:checked};
}

const piArtifactType='org.shittimchest.session-artifact.v1',piArtifactPartType='org.shittimchest.session-artifact-part.v1',piArtifactUnavailableType='org.shittimchest.session-artifact-unavailable.v1';
export function* sessionArtifactPiEntries(artifacts:readonly PortableSessionArtifact[],parentId:string|null,unavailable:readonly UnavailableSessionArtifact[]=[]):Generator<SessionEntry>{
 let parent=parentId;for(const artifact of artifacts){const id=randomUUID();yield {type:'custom',id,parentId:parent,timestamp:new Date().toISOString(),customType:piArtifactType,data:{...artifact,parts:artifact.parts.map(({data,...part})=>part)}};parent=id;for(const[index,part]of artifact.parts.entries()){const id=randomUUID();yield {type:'custom',id,parentId:parent,timestamp:new Date().toISOString(),customType:piArtifactPartType,data:{id:artifact.id,index,data:part.data}};parent=id;}}for(const artifact of unavailable){const id=randomUUID();yield {type:'custom',id,parentId:parent,timestamp:new Date().toISOString(),customType:piArtifactUnavailableType,data:artifact};parent=id;}
}
/** Transport records are data envelopes, never installed extension state. */
export function extractSessionArtifactPiEntries(entries:readonly SessionEntry[]){
 const artifacts=new Map<string,PortableSessionArtifact>(),unavailable:UnavailableSessionArtifact[]=[],removed=new Set<string>();
 for(const entry of entries){if(entry.type!=='custom'||![piArtifactType,piArtifactPartType,piArtifactUnavailableType].includes(entry.customType))continue;removed.add(entry.id);
  if(entry.customType===piArtifactUnavailableType){unavailable.push(unavailableSessionArtifactSchema.parse(entry.data));continue;}
  if(entry.customType===piArtifactType){const row=entry.data as PortableSessionArtifact;if(!row||typeof row.id!=='string'||!Array.isArray(row.parts)||artifacts.has(row.id)||row.parts.some(part=>'data'in part))throw invalid();artifacts.set(row.id,structuredClone(row));}
  else{const row=entry.data as {id?:unknown;index?:unknown;data?:unknown},artifact=typeof row?.id==='string'?artifacts.get(row.id):undefined;if(!artifact||typeof row.index!=='number'||!Number.isSafeInteger(row.index)||row.index<0||row.index>=artifact.parts.length||typeof row.data!=='string'||'data'in artifact.parts[row.index]!)throw invalid();artifact.parts[row.index]!.data=row.data;}
 }
 const kept=entries.filter(entry=>!removed.has(entry.id));if(kept.some(entry=>entry.parentId!==null&&removed.has(entry.parentId)))throw invalid();
 if(new Set(unavailable.map(row=>row.id)).size!==unavailable.length||unavailable.some(row=>artifacts.has(row.id)))throw invalid();return {entries:kept,artifacts:[...artifacts.values()].map(parsePortableSessionArtifact),unavailable};
}

/** Immutable imported data is separate from every live tool binding and permission. */
export class SessionArtifactStore{
 constructor(private readonly db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS session_artifact_chunks(sha256 TEXT PRIMARY KEY,bytes INTEGER NOT NULL,content BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS session_artifact_bindings(context_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(context_id,id));
 CREATE TABLE IF NOT EXISTS session_artifact_unavailable(context_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(context_id,id));
 `);}
 private atomic<T>(action:()=>T):T{if(this.db.isTransaction)return action();this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 private put(bytes:Uint8Array){const sha256=hash(bytes),old=this.db.prepare('SELECT bytes,content FROM session_artifact_chunks WHERE sha256=?').get(sha256);if(old){if(Number(old.bytes)!==bytes.length||!(old.content instanceof Uint8Array)||hash(old.content)!==sha256)throw new AppError('session_artifact_changed',409);}else this.db.prepare('INSERT INTO session_artifact_chunks VALUES(?,?,?)').run(sha256,bytes.length,bytes);return {sha256,bytes:bytes.length};}
 private chunk(part:SessionArtifact['parts'][number]){const row=this.db.prepare('SELECT bytes,content FROM session_artifact_chunks WHERE sha256=?').get(part.sha256);if(!row||Number(row.bytes)!==part.bytes||!(row.content instanceof Uint8Array)||row.content.byteLength!==part.bytes||hash(row.content)!==part.sha256)throw new AppError('session_artifact_changed',409);return Buffer.from(row.content);}
 async captureData(source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<SessionArtifactPayload>{
  const parts:SessionArtifact['parts']=[],aggregate=createHash('sha256');let pending=Buffer.alloc(0),bytes=0;
  const append=(part:Uint8Array)=>{parts.push(this.put(part));aggregate.update(part);bytes+=part.length;if(!Number.isSafeInteger(bytes))throw invalid();};
  for await(const value of source){signal?.throwIfAborted();let current=Buffer.from(value);if(pending.length){const length=Math.min(SESSION_ARTIFACT_PART_BYTES-pending.length,current.length);pending=Buffer.concat([pending,current.subarray(0,length)]);current=current.subarray(length);if(pending.length===SESSION_ARTIFACT_PART_BYTES){append(pending);pending=Buffer.alloc(0);}}while(current.length>=SESSION_ARTIFACT_PART_BYTES){append(current.subarray(0,SESSION_ARTIFACT_PART_BYTES));current=current.subarray(SESSION_ARTIFACT_PART_BYTES);}if(current.length)pending=Buffer.from(current);}
  signal?.throwIfAborted();if(pending.length)append(pending);return {sha256:aggregate.digest('hex'),bytes,parts};
 }
 private payload(input:SessionArtifactPayload):SessionArtifactPayload{
  const parsed=z.object({bytes:z.number().int().nonnegative().refine(Number.isSafeInteger),sha256:digest,parts:z.array(partSchema)}).strict().safeParse(input&&{bytes:input.bytes,sha256:input.sha256,parts:input.parts});
  if(!parsed.success||parsed.data.parts.reduce((sum,part)=>sum+part.bytes,0)!==parsed.data.bytes||parsed.data.parts.some((part,index)=>index<parsed.data.parts.length-1&&part.bytes!==SESSION_ARTIFACT_PART_BYTES))throw invalid();return parsed.data;
 }
 readPayload(input:SessionArtifactPayload,options:{byteOffset?:number;maxBytes?:number;encoding?:'text'|'base64'}={},signal?:AbortSignal){
  signal?.throwIfAborted();const payload=this.payload(input),offset=options.byteOffset??0,limit=options.maxBytes??16384;
  if(!Number.isSafeInteger(offset)||offset<0||offset>payload.bytes||!Number.isSafeInteger(limit)||limit<1||limit>32768||options.encoding!==undefined&&!['text','base64'].includes(options.encoding))throw new AppError('invalid_session_artifact_page');
  const end=Math.min(payload.bytes,offset+limit),chunks:Buffer[]=[];let position=0;
  for(const part of payload.parts){signal?.throwIfAborted();const next=position+part.bytes;if(next>offset&&position<end)chunks.push(this.chunk(part).subarray(Math.max(0,offset-position),Math.min(part.bytes,end-position)));position=next;if(position>=end)break;}
  const bytes=Buffer.concat(chunks),encoding=options.encoding??'text',complete=offset===0&&end===payload.bytes;if(complete&&hash(bytes)!==payload.sha256)throw new AppError('session_artifact_changed',409);let content:string;
  try{content=encoding==='base64'?bytes.toString('base64'):new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('session_artifact_requires_base64',409);}
  signal?.throwIfAborted();return {encoding,byteOffset:offset,byteLength:bytes.length,nextByteOffset:end<payload.bytes?end:null,complete,content};
 }
 async *payloadChunks(input:SessionArtifactPayload,signal?:AbortSignal):AsyncGenerator<Uint8Array>{
  const payload=this.payload(input),aggregate=createHash('sha256');for(const part of payload.parts){signal?.throwIfAborted();const bytes=this.chunk(part);aggregate.update(bytes);yield bytes;}
  signal?.throwIfAborted();if(aggregate.digest('hex')!==payload.sha256)throw new AppError('session_artifact_changed',409);
 }
 async capture(input:Omit<SessionArtifact,'version'|'id'|'bytes'|'sha256'|'parts'>,source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<SessionArtifact>{return this.describe(input,await this.captureData(source,signal));}
 describe(input:Omit<SessionArtifact,'version'|'id'|'bytes'|'sha256'|'parts'>,payload:SessionArtifactPayload):SessionArtifact{const id='history.'+hash(Buffer.from(JSON.stringify([input.kind,input.origin,payload.sha256,payload.bytes,input.complete,stableOriginal(input.original)]))),parsed=sessionArtifactSchema.safeParse({...input,bytes:payload.bytes,sha256:payload.sha256,parts:payload.parts,version:1,id});if(!parsed.success)throw invalid();return parsed.data;}
 async captureFile(file:string,signal?:AbortSignal,validateScope?:()=>void):Promise<SessionArtifactPayload>{
  signal?.throwIfAborted();validateScope?.();const visible=await fs.promises.lstat(file);if(!visible.isFile()||visible.isSymbolicLink()||visible.nlink!==1)throw new AppError('file_verification_refused',403);const handle=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.ino!==visible.ino||before.dev!==visible.dev)throw new AppError('file_verification_refused',403);validateScope?.();const payload=await this.captureData(handle.createReadStream({autoClose:false,signal}),signal),after=await handle.stat(),current=await fs.promises.lstat(file);if(payload.bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1||current.isSymbolicLink()||current.ino!==before.ino||current.dev!==before.dev)throw new AppError('file_changed_during_verification',409);validateScope?.();signal?.throwIfAborted();return payload;}finally{await handle.close();}
 }
 stage(inputs:readonly unknown[]){const seen=new Set<string>();return inputs.map(input=>{const row=parsePortableSessionArtifact(input);if(seen.has(row.id))throw invalid();seen.add(row.id);for(const part of row.parts)this.put(Buffer.from(part.data,'base64'));return {...row,parts:row.parts.map(({data,...part})=>part)};});}
 bind(contextId:string,inputs:readonly SessionArtifact[],allowedEntryIds:ReadonlySet<string>){this.atomic(()=>{for(const input of inputs){const parsed=sessionArtifactSchema.safeParse(input);if(!parsed.success||input.entryIds.some(id=>!allowedEntryIds.has(id)))throw invalid();let row=parsed.data;const aggregate=createHash('sha256');for(const part of row.parts)aggregate.update(this.chunk(part));if(aggregate.digest('hex')!==row.sha256)throw new AppError('session_artifact_changed',409);const old=this.db.prepare('SELECT body FROM session_artifact_bindings WHERE context_id=? AND id=?').get(contextId,row.id);if(old){const previous=sessionArtifactSchema.parse(JSON.parse(String(old.body)));if(!isDeepStrictEqual({...previous,entryIds:[],original:stableOriginal(previous.original)},{...row,entryIds:[],original:stableOriginal(row.original)}))throw new AppError('session_artifact_conflict',409);row={...previous,entryIds:[...new Set([...previous.entryIds,...row.entryIds])]};this.db.prepare('UPDATE session_artifact_bindings SET body=? WHERE context_id=? AND id=?').run(JSON.stringify(row),contextId,row.id);}else this.db.prepare('INSERT INTO session_artifact_bindings VALUES(?,?,?)').run(contextId,row.id,JSON.stringify(row));}});}
 all(contextId:string):SessionArtifact[]{return this.db.prepare('SELECT body FROM session_artifact_bindings WHERE context_id=? ORDER BY rowid').all(contextId).map(row=>{const parsed=sessionArtifactSchema.safeParse(JSON.parse(String(row.body)));if(!parsed.success)throw new AppError('session_artifact_changed',409);return parsed.data;});}
 unavailable(contextId:string):UnavailableSessionArtifact[]{return this.db.prepare('SELECT body FROM session_artifact_unavailable WHERE context_id=? ORDER BY rowid').all(contextId).map(row=>unavailableSessionArtifactSchema.parse(JSON.parse(String(row.body))));}
 describeUnavailable(input:Omit<UnavailableSessionArtifact,'version'|'id'|'availability'>):UnavailableSessionArtifact{return unavailableSessionArtifactSchema.parse({...input,version:1,id:'history.'+hash(Buffer.from(JSON.stringify([input.kind,input.origin,input.expectedSha256,input.reason,stableOriginal(input.original)]))),availability:'unavailable'});}
 bindUnavailable(contextId:string,inputs:readonly UnavailableSessionArtifact[],allowedEntryIds:ReadonlySet<string>){this.atomic(()=>{for(const input of inputs){let row=unavailableSessionArtifactSchema.parse(input);if(row.entryIds.some(id=>!allowedEntryIds.has(id)))throw invalid();const old=this.db.prepare('SELECT body FROM session_artifact_unavailable WHERE context_id=? AND id=?').get(contextId,row.id);if(old){const previous=unavailableSessionArtifactSchema.parse(JSON.parse(String(old.body)));if(JSON.stringify({...previous,entryIds:[]})!==JSON.stringify({...row,entryIds:[]}))throw new AppError('session_artifact_conflict',409);row={...row,entryIds:[...new Set([...previous.entryIds,...row.entryIds])]};}this.db.prepare('INSERT INTO session_artifact_unavailable VALUES(?,?,?) ON CONFLICT(context_id,id) DO UPDATE SET body=excluded.body').run(contextId,row.id,JSON.stringify(row));}});}
 private identity(row:Pick<SessionArtifact,'kind'|'origin'>){return JSON.stringify([row.kind,row.origin.contextId,row.origin.taskId,row.origin.ref,row.origin.stream]);}
 currentUnavailable(contextId:string,selectedEntryIds?:ReadonlySet<string>){const available=this.all(contextId).filter(row=>!selectedEntryIds||row.entryIds.some(id=>selectedEntryIds.has(id))),current=new Map<string,UnavailableSessionArtifact>();for(const row of this.unavailable(contextId)){if(selectedEntryIds&&!row.entryIds.some(id=>selectedEntryIds.has(id)))continue;if(row.expectedSha256&&available.some(found=>this.identity(found)===this.identity(row)&&found.sha256===row.expectedSha256&&found.entryIds.some(id=>row.entryIds.includes(id))))continue;current.set(this.identity(row),row);}return [...current.values()];}
 list(contextId:string,selectedEntryIds:ReadonlySet<string>){const current=new Map<string,SessionArtifact>();for(const row of this.all(contextId).filter(row=>!privateSessionArtifact(row)&&row.entryIds.some(id=>selectedEntryIds.has(id)))){const key=this.identity(row),previous=current.get(key);if(previous&&row.kind==='terminal-output'&&(previous.complete&&!row.complete||previous.complete===row.complete&&previous.bytes>row.bytes))continue;current.set(key,row);}return [...[...current.values()].map(({parts,...row})=>({...modelArtifact(row),availability:'available' as const,readable:true,authority:'imported-untrusted-history' as const})),...this.currentUnavailable(contextId,selectedEntryIds).filter(row=>!privateSessionArtifact(row)).map(row=>({...modelArtifact(row),readable:false,authority:'imported-untrusted-history' as const}))];}
 copyContext(sourceId:string,targetId:string,keptEntryIds:ReadonlySet<string>){const filter=<T extends {entryIds:string[]}>(rows:T[])=>rows.flatMap(row=>{const entryIds=row.entryIds.filter(id=>keptEntryIds.has(id));return entryIds.length?[{...row,entryIds}]:[];});this.bind(targetId,filter(this.all(sourceId)),keptEntryIds);this.bindUnavailable(targetId,filter(this.unavailable(sourceId)),keptEntryIds);}
 portable(contextId:string):PortableSessionArtifact[]{return this.all(contextId).map(row=>({...row,parts:row.parts.map(part=>({...part,data:this.chunk(part).toString('base64')}))}));}
 private selectedArtifact(contextId:string,id:string,selectedEntryIds:ReadonlySet<string>){
  const available=this.all(contextId).filter(row=>row.entryIds.some(entry=>selectedEntryIds.has(entry)));let row=available.find(row=>row.id===id),requestedId:string|undefined;
  if(!row&&/^mcp-result\.[0-9a-f-]{36}$/.test(id)){const aliases=available.filter(row=>row.kind==='mcp-result'&&row.origin.ref===id);if(aliases.length>1)throw new AppError('session_artifact_reference_ambiguous',409);row=aliases[0];if(row)requestedId=id;}
  if(!row){const missing=this.unavailable(contextId).find(row=>(row.id===id||row.kind==='mcp-result'&&row.origin.ref===id)&&row.entryIds.some(entry=>selectedEntryIds.has(entry)));if(!missing)throw new AppError('session_artifact_not_authorized',403);row=missing.expectedSha256?available.find(found=>this.identity(found)===this.identity(missing)&&found.sha256===missing.expectedSha256&&found.entryIds.some(id=>missing.entryIds.includes(id))):undefined;if(!row)throw new AppError('session_artifact_unavailable',410);requestedId=id;}
  if(privateSessionArtifact(row))throw new AppError('session_artifact_private_backup',403);
  return{row,requestedId};
 }
 read(contextId:string,id:string,selectedEntryIds:ReadonlySet<string>,options:{byteOffset?:number;maxBytes?:number;encoding?:'text'|'base64'}={}){
  const{row,requestedId}=this.selectedArtifact(contextId,id,selectedEntryIds);
  const page=this.readPayload(row,options),{parts,...metadata}=row;return {source:{...modelArtifact(metadata),...(requestedId?{requestedId}:{}),authority:'imported-untrusted-history' as const},...page,complete:row.complete&&page.complete};
 }
 async readMcp(contextId:string,id:string,selectedEntryIds:ReadonlySet<string>,input:McpResultPageOptions={},signal?:AbortSignal){
  signal?.throwIfAborted();const{row,requestedId}=this.selectedArtifact(contextId,id,selectedEntryIds),options=mcpResultPageSchema.parse(input),authority='imported-untrusted-history' as const;
  if(row.kind!=='mcp-result')throw new AppError('session_artifact_not_authorized',403);
  if(options.encoding==='base64')return{...this.read(contextId,id,selectedEntryIds,{encoding:'base64',byteOffset:options.byteOffset,maxBytes:options.maxBytes}),authority,representation:'base64' as const};
  const reference=mcpResultReferenceSchema.parse(row.original?.mcp);
  if(reference.representation==='mcp-model-image'&&options.encoding===undefined&&options.offset===undefined&&options.limit===undefined&&options.byteOffset===undefined&&options.maxBytes===undefined){const chunks:Uint8Array[]=[];for await(const chunk of this.payloadChunks(row,signal))chunks.push(chunk);signal?.throwIfAborted();const{parts,...metadata}=row;return{source:{...modelArtifact(metadata),...(requestedId?{requestedId}:{}),authority},authority,representation:'image' as const,complete:true as const,mediaType:row.mediaType,content:Buffer.concat(chunks).toString('base64'),byteLength:row.bytes,hints:[] as string[],imageOmitted:false};}
  if(!['mcp-model-text','mcp-model-structured'].includes(reference.representation))throw new AppError('mcp_result_requires_base64',409);
  const decoder=new TextDecoder('utf8',{fatal:true}),store=this;let lines=1;
  try{for await(const bytes of this.payloadChunks(row,signal)){decoder.decode(bytes,{stream:true});for(const byte of bytes)if(byte===10)lines++;}decoder.decode();}catch(error){if(error instanceof TypeError)throw new AppError('mcp_result_requires_base64',409);throw error;}
  const offset=options.offset??1,limit=options.limit??200,reader=createReadTool('/session-artifacts',{operations:{access:async()=>{},detectImageMimeType:async()=>undefined,readFile:async()=>{throw new AppError('session_artifact_unexpected_read',409);},createReadStream:(_file,{signal})=>store.payloadChunks(row,signal)}}),result=await reader.execute('read-history-mcp',{path:id,offset,limit},signal),truncation=result.details?.truncation,requiresByteRead=Boolean(truncation?.firstLineExceedsLimit),count=requiresByteRead?0:truncation?.truncated?truncation.outputLines:Math.max(0,Math.min(limit,lines-offset+1)),next=offset+count,{parts,...metadata}=row;
  signal?.throwIfAborted();return{source:{...modelArtifact(metadata),...(requestedId?{requestedId}:{}),authority},authority,representation:'utf8-source-text' as const,complete:offset===1&&next>lines,offset,nextOffset:next<=lines?next:null,requiresByteRead,content:requiresByteRead?'The selected line exceeds the text page size. Use encoding=base64 with byteOffset and maxBytes to read its original bytes.':result.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')};
 }
}
