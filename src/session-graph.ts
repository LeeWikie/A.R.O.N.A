import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { SessionManager, migrateSessionEntries, type FileEntry, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { AppError } from './domain.js';
import {isBase64String} from './base64.js';
import {privateCoreDirectory} from './lock.js';

export interface SessionSource {messageId:string;messageIds?:string[];logicalInputId?:string;partIndexes?:number[];projectionIndex?:number;publicMessageIds?:string[];runId?:string|null;replayRaw?:false;recoveredSignalId?:string;originalNativeMessageId?:string;recoveredFromEntryId?:string;recoveryId?:string;attachmentIds?:string[];attachmentsProjected?:boolean}
export interface SessionGraphHead {contextId:string;rootContextId:string;leafId:string|null;revision:number;header:SessionHeader}
export interface SessionGraphRecord {entry:SessionEntry;source?:SessionSource}
const entryTypes=new Set(['message','thinking_level_change','model_change','usage','compaction','branch_summary','custom','label','session_info','custom_message','context_edit']);
const boundedId=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\u0000-\u001f]/.test(value);
function validateContent(content:unknown,assistant=false){
  if(typeof content==='string'){if(assistant)throw new AppError('invalid_pi_session_message');return;}
  if(!Array.isArray(content))throw new AppError('invalid_pi_session_message');
  for(const part of content){if(!part||typeof part!=='object'||typeof part.type!=='string')throw new AppError('invalid_pi_session_message');
    if(part.type==='text'){if(typeof part.text!=='string')throw new AppError('invalid_pi_session_message');}
    else if(part.type==='image'&&!assistant){if(!isBase64String(part.data)||!['image/png','image/jpeg','image/webp','image/gif'].includes(part.mimeType))throw new AppError('invalid_pi_session_media');}
    else if(part.type==='thinking'&&assistant){if(typeof part.thinking!=='string'||part.thinkingSignature!==undefined&&typeof part.thinkingSignature!=='string')throw new AppError('invalid_pi_session_message');}
    else if(part.type==='toolCall'&&assistant){if(!boundedId(part.id)||!boundedId(part.name)||!part.arguments||typeof part.arguments!=='object'||Array.isArray(part.arguments))throw new AppError('invalid_pi_session_tool_call');}
    else throw new AppError('invalid_pi_session_message');
  }
}

export async function backupSessionGraphData(directory:string){
  const records=path.join(directory,'records.sqlite');if(!fs.existsSync(records))return;
  const probe=new DatabaseSync(records,{readOnly:true});let migrated=false;
  try{migrated=Boolean(probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_graph_heads'").get());}finally{probe.close();}
  if(migrated)return;
  const destination=path.join(privateCoreDirectory(directory,'migration-backups'),`session-graph-${randomUUID()}`);fs.mkdirSync(destination,{mode:0o700});
  const files:Array<{name:string;sha256:string;integrity:string}>=[];
  try{for(const name of ['records.sqlite','history.sqlite']){const file=path.join(directory,name);if(!fs.existsSync(file))continue;const source=new DatabaseSync(file,{readOnly:true});try{const target=path.join(destination,name);await backup(source,target);if(process.platform!=='win32')fs.chmodSync(target,0o600);const check=new DatabaseSync(target,{readOnly:true});let integrity:string;try{integrity=String(check.prepare('PRAGMA integrity_check').get()!.integrity_check);}finally{check.close();}if(integrity!=='ok')throw new Error('invalid_backup');files.push({name,integrity,sha256:createHash('sha256').update(fs.readFileSync(target)).digest('hex')});}finally{source.close();}}fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({format:'session-graph-migration-backup',version:1,createdAt:new Date().toISOString(),files},null,2),{mode:0o600,flag:'wx'});}catch{throw new AppError('session_migration_backup_failed');}
}

/** Parse strictly before invoking the upstream format migrations; malformed lines cannot disappear. */
export function parsePiSession(jsonl:string):{header:SessionHeader;entries:SessionEntry[];leafId:string|null} {
  if(Buffer.byteLength(jsonl)>32*1024*1024)throw new AppError('session_import_too_large',413);
  let file:FileEntry[];
  try{file=jsonl.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));}catch{throw new AppError('invalid_pi_session');}
  return parsePiSessionEntries(file);
}
/** The streamed transport has already verified every byte before structural validation. */
export function parsePiSessionEntries(input:unknown[],large=false):{header:SessionHeader;entries:SessionEntry[];leafId:string|null}{
  const file=structuredClone(input) as FileEntry[];
  const pending:Array<{value:unknown;depth:number}>=[{value:file,depth:0}];let nodes=0;while(pending.length){const {value,depth}=pending.pop()!;if((++nodes>2000000&&!large)||depth>100||typeof value==='number'&&!Number.isFinite(value))throw new AppError('invalid_pi_session');if(value&&typeof value==='object')for(const child of Object.values(value))pending.push({value:child,depth:depth+1});}
  if(!file.length||!large&&file.length>100000||file[0]?.type!=='session'||file.slice(1).some(item=>item?.type==='session'))throw new AppError('invalid_pi_session');
  const rawHeader=file[0] as SessionHeader;
  if(!boundedId(rawHeader.id)||typeof rawHeader.cwd!=='string'||!Number.isFinite(Date.parse(rawHeader.timestamp))||rawHeader.version!==undefined&&![1,2,3].includes(rawHeader.version))throw new AppError('invalid_pi_session');
  migrateSessionEntries(file);
  const header=file[0] as SessionHeader;const entries=file.slice(1) as SessionEntry[];
  const seen=new Map<string,SessionEntry>();
  for(const entry of entries){
    if(!entry||!entryTypes.has(entry.type)||!boundedId(entry.id)||seen.has(entry.id)||!Number.isFinite(Date.parse(entry.timestamp))||entry.parentId!==null&&(!boundedId(entry.parentId)||!seen.has(entry.parentId)))throw new AppError('invalid_pi_session_graph');
    if(entry.type==='message'){
      const message=entry.message;
      if(!message||!['user','assistant','toolResult','system','bashExecution','custom'].includes(message.role))throw new AppError('invalid_pi_session_message');
      if(message.role==='bashExecution'){if(typeof message.command!=='string'||typeof message.output!=='string')throw new AppError('invalid_pi_session_message');}
      else if(!('content' in message)||typeof message.content!=='string'&&!Array.isArray(message.content))throw new AppError('invalid_pi_session_message');
      if('content' in message)validateContent(message.content,message.role==='assistant');
      if(message.role==='toolResult'&&(!boundedId(message.toolCallId)||!boundedId(message.toolName)||typeof message.isError!=='boolean'))throw new AppError('invalid_pi_session_tool_result');
      if(message.role==='assistant'&&(typeof message.api!=='string'||typeof message.provider!=='string'||typeof message.model!=='string'))throw new AppError('invalid_pi_session_model');
    }
    if(entry.type==='model_change'&&(!boundedId(entry.provider)||!boundedId(entry.modelId)))throw new AppError('invalid_pi_session_model');
    if(entry.type==='thinking_level_change'&&typeof entry.thinkingLevel!=='string')throw new AppError('invalid_pi_session_thinking');
    if(entry.type==='compaction'&&(typeof entry.summary!=='string'||!Number.isFinite(entry.tokensBefore)||entry.firstKeptEntryId!==entry.id&&!seen.has(entry.firstKeptEntryId)))throw new AppError('invalid_pi_session_compaction');
    if(entry.type==='branch_summary'&&(typeof entry.summary!=='string'||entry.fromId!==null&&typeof entry.fromId!=='string'))throw new AppError('invalid_pi_session_summary');
    if(entry.type==='label'&&(!seen.has(entry.targetId)||entry.label!==undefined&&typeof entry.label!=='string'))throw new AppError('invalid_pi_session_label');
    if(entry.type==='context_edit'&&(!seen.has(entry.targetId)||entry.replacement!==null&&(!entry.replacement||typeof entry.replacement.content!=='string'&&!Array.isArray(entry.replacement.content))))throw new AppError('invalid_pi_session_edit');
    if(entry.type==='context_edit'&&entry.replacement){const target=seen.get(entry.targetId);validateContent(entry.replacement.content,target?.type==='message'&&target.message.role==='assistant');}
    if(entry.type==='custom_message')validateContent(entry.content);
    seen.set(entry.id,entry);
  }
  const manager=SessionManager.inMemory(header.cwd,{id:header.id},structuredClone(file));
  // Native projection validates compaction and context-edit behavior without loading extensions or tools.
  manager.buildSessionProjection();
  return {header,entries,leafId:manager.getLeafId()};
}

export class SessionGraph {
  constructor(readonly db:DatabaseSync){db.exec(`
    CREATE TABLE IF NOT EXISTS session_graph_heads(context_id TEXT PRIMARY KEY,root_context_id TEXT NOT NULL,leaf_id TEXT,revision INTEGER NOT NULL,header TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_graph_entries(context_id TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,ordinal INTEGER NOT NULL,entry TEXT NOT NULL,source TEXT,PRIMARY KEY(context_id,id),UNIQUE(context_id,ordinal));
    CREATE INDEX IF NOT EXISTS session_graph_children ON session_graph_entries(context_id,parent_id,ordinal);
    CREATE INDEX IF NOT EXISTS session_graph_native_tool_lookup ON session_graph_entries(context_id,json_extract(source,'$.messageId'),ordinal);
    CREATE TABLE IF NOT EXISTS session_graph_sources(context_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(context_id,id));
  `);}
  private atomic<T>(action:()=>T):T{if(this.db.isTransaction)return action();this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  head(contextId:string):SessionGraphHead|undefined{const row=this.db.prepare('SELECT * FROM session_graph_heads WHERE context_id=?').get(contextId);return row?{contextId,rootContextId:String(row.root_context_id),leafId:row.leaf_id as string|null,revision:Number(row.revision),header:JSON.parse(String(row.header))}:undefined;}
  records(contextId:string):SessionGraphRecord[]{return this.db.prepare('SELECT entry,source FROM session_graph_entries WHERE context_id=? ORDER BY ordinal').all(contextId).map(row=>({entry:JSON.parse(String(row.entry)),...(row.source?{source:JSON.parse(String(row.source))}:{})}));}
  /** Read the selected lineage without materializing unrelated message content. */
  nativeToolRecords(contextId:string,nativeMessageId:string,toolCallId:string):SessionGraphRecord[]{
    const head=this.head(contextId);if(!head?.leafId)return[];
    const lineage=this.db.prepare(`WITH RECURSIVE selected(id,parent_id) AS (
      SELECT id,parent_id FROM session_graph_entries WHERE context_id=? AND id=?
      UNION SELECT e.id,e.parent_id FROM session_graph_entries e JOIN selected s ON e.id=s.parent_id WHERE e.context_id=?
    ) SELECT id,parent_id FROM selected`).all(contextId,head.leafId,contextId);
    const parents=new Map(lineage.map(row=>[String(row.id),row.parent_id as string|null])),selected=new Set<string>();let id:string|null=head.leafId;
    while(id!==null){if(selected.has(id)||!parents.has(id))throw new AppError('session_graph_inconsistent',409);selected.add(id);id=parents.get(id)!;}
    return this.db.prepare(`SELECT id,entry,source FROM session_graph_entries INDEXED BY session_graph_native_tool_lookup
      WHERE context_id=? AND json_extract(source,'$.messageId')=? AND (
        (json_extract(entry,'$.message.role')='toolResult' AND json_extract(entry,'$.message.toolCallId')=?) OR
        (json_extract(entry,'$.message.role')='assistant' AND EXISTS(SELECT 1 FROM json_each(json_extract(entry,'$.message.content')) p WHERE json_extract(p.value,'$.type')='toolCall' AND json_extract(p.value,'$.id')=?))
      ) ORDER BY ordinal`).all(contextId,nativeMessageId,toolCallId,toolCallId).filter(row=>selected.has(String(row.id))).map(row=>({entry:JSON.parse(String(row.entry)),...(row.source?{source:JSON.parse(String(row.source))}:{})}));
  }
  manager(contextId:string){const head=this.head(contextId);if(!head)throw new AppError('session_graph_unavailable',409);const manager=SessionManager.inMemory(head.header.cwd,{id:head.header.id},[structuredClone(head.header),...this.records(contextId).map(row=>structuredClone(row.entry))]);if(head.leafId===null)manager.resetLeaf();else manager.branch(head.leafId);return manager;}
  create(contextId:string,header:SessionHeader,records:SessionGraphRecord[]=[],leafId:string|null=records.at(-1)?.entry.id??null,rootContextId=contextId){return this.atomic(()=>{if(this.head(contextId))throw new AppError('session_graph_exists',409);this.db.prepare('INSERT INTO session_graph_heads VALUES(?,?,?,?,?)').run(contextId,rootContextId,null,0,JSON.stringify(header));this.append(contextId,records);if(this.head(contextId)!.leafId!==leafId)this.select(contextId,leafId);return this.head(contextId)!;});}
  append(contextId:string,records:SessionGraphRecord[],expectedRevision?:number){return this.atomic(()=>{const head=this.checked(contextId,expectedRevision);let ordinal=Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),0) n FROM session_graph_entries WHERE context_id=?').get(contextId)!.n);let leaf=head.leafId;
    for(const record of records){const entry=record.entry;if(this.db.prepare('SELECT 1 FROM session_graph_entries WHERE context_id=? AND id=?').get(contextId,entry.id))throw new AppError('session_entry_exists',409);if(entry.parentId!==null&&!this.db.prepare('SELECT 1 FROM session_graph_entries WHERE context_id=? AND id=?').get(contextId,entry.parentId))throw new AppError('session_parent_not_found',409);this.db.prepare('INSERT INTO session_graph_entries VALUES(?,?,?,?,?,?)').run(contextId,entry.id,entry.parentId,++ordinal,JSON.stringify(entry),record.source?JSON.stringify(record.source):null);leaf=entry.id;}
    if(records.length)this.db.prepare('UPDATE session_graph_heads SET leaf_id=?,revision=revision+1 WHERE context_id=?').run(leaf,contextId);return this.head(contextId)!;});}
  select(contextId:string,leafId:string|null,expectedRevision?:number,expectedLeafId?:string|null){return this.atomic(()=>{const head=this.checked(contextId,expectedRevision);if(expectedLeafId!==undefined&&head.leafId!==expectedLeafId)throw new AppError('session_leaf_conflict',409);if(leafId!==null&&!this.db.prepare('SELECT 1 FROM session_graph_entries WHERE context_id=? AND id=?').get(contextId,leafId))throw new AppError('session_entry_not_found',404);if(leafId!==head.leafId)this.db.prepare('UPDATE session_graph_heads SET leaf_id=?,revision=revision+1 WHERE context_id=?').run(leafId,contextId);return this.head(contextId)!;});}
  label(contextId:string,targetId:string,label:string|null,expectedRevision?:number){return this.atomic(()=>{const head=this.checked(contextId,expectedRevision);const manager=this.manager(contextId);if(!manager.getEntry(targetId))throw new AppError('session_entry_not_found',404);const entry:SessionEntry={type:'label',id:randomUUID(),parentId:head.leafId,timestamp:new Date().toISOString(),targetId,...(label?{label}:{label:undefined})};return this.append(contextId,[{entry}],head.revision);});}
  source(contextId:string,id:string):unknown{const row=this.db.prepare('SELECT body FROM session_graph_sources WHERE context_id=? AND id=?').get(contextId,id);return row?JSON.parse(String(row.body)):undefined;}
  hasSource(contextId:string,id:string){return Boolean(this.db.prepare('SELECT 1 FROM session_graph_sources WHERE context_id=? AND id=?').get(contextId,id));}
  saveSource(contextId:string,id:string,body:unknown){const encoded=JSON.stringify(body);const old=this.db.prepare('SELECT body FROM session_graph_sources WHERE context_id=? AND id=?').get(contextId,id);if(old&&old.body!==encoded)throw new AppError('session_source_changed',409);this.db.prepare('INSERT OR IGNORE INTO session_graph_sources VALUES(?,?,?)').run(contextId,id,encoded);}
  sources(contextId:string):unknown[]{return this.db.prepare('SELECT body FROM session_graph_sources WHERE context_id=? ORDER BY rowid').all(contextId).map(row=>JSON.parse(String(row.body)));}
  clone(sourceId:string,targetId:string,leafId?:string|null){return this.atomic(()=>{const head=this.head(sourceId);if(!head)throw new AppError('session_graph_unavailable',409);let records=this.records(sourceId);let leaf=leafId===undefined?head.leafId:leafId;if(leafId!==undefined){if(leafId===null)records=[];else{const manager=this.manager(sourceId);manager.createBranchedSession(leafId);const original=new Map(records.map(row=>[row.entry.id,row]));records=manager.getEntries().map(entry=>({...original.get(entry.id),entry}));leaf=manager.getLeafId();}}this.create(targetId,{...head.header,id:targetId,parentSession:head.header.id},records,leaf,head.rootContextId);for(const source of this.sources(sourceId)){const id=(source as {id:string}).id;this.saveSource(targetId,id,source);}return this.head(targetId)!;});}
  private checked(contextId:string,expectedRevision?:number){const head=this.head(contextId);if(!head)throw new AppError('session_graph_unavailable',409);if(expectedRevision!==undefined&&head.revision!==expectedRevision)throw new AppError('session_revision_conflict',409);return head;}
}
