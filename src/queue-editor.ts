import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import{serialize,deserialize}from'node:v8';
import{ImmutablePayloadStorage,type ImmutablePayloadReference}from'./storage/immutable-payloads.js';
import { AppError, type SignalRecord } from './domain.js';
import type { RuntimeStore } from './runtime-store.js';
import type { QueueEditDocument, QueueEditEntry, QueueEditPage, QueueEntryEdit, QueueWithdrawalResult,QueueInputSource,QueueRetainedVersion } from './protocol.js';
import type {PreparedQueueGroup,QueueLogicalSource} from './queue-logical.js';

const inputSchema=z.object({content:z.string().max(64000).default(''),sourceText:z.string().max(64000).optional(),localContext:z.string().max(64000).optional(),clientDraftId:z.string().uuid().optional(),selectedSkillName:z.string().min(1).max(1024).optional(),restoredFromSignalIds:z.array(z.string().uuid()).optional(),attachments:z.array(z.string().uuid()).max(8).default([])}).strict();
type Input=z.infer<typeof inputSchema>;
interface StoredEntry extends QueueEditEntry {localContext?:string;referenceContext?:string;materialSourceSignalId?:string}
interface StoredDraft extends QueueEditDocument {
  signature:string;capture:Array<{id:string;revision:number}>;body:StoredEntry[];request:string;
  captureId?:string;captureBaseIds?:string[];
  versions?:Record<string,StoredEntry[]>;nativeEntries?:Record<string,StoredEntry>;
}
interface EntryUpload {id:string;contextId:string;draftId:string;entryId:string;revision:number;partCount:number;characters:number;hash:string;attachments:string[];receivedParts:number[];status:'uploading'|'committed';request:string;captureDraftId?:string;localContext?:string;localContextRef?:ImmutablePayloadReference;contextParts?:{partCount:number;characters:number;hash:string};receivedContextParts?:number[];attachmentParts?:{partCount:number;items:number;hash:string};receivedAttachmentParts?:number[];result?:QueueEditDocument}
type ContentPart={content:string}|{payload:ImmutablePayloadReference};
interface RetainedEntryVersion {id:string;draftId:string;contextId:string;revision:number;entry:StoredEntry;referenceContext:string;createdAt:string}
const sendable=(entry:StoredEntry)=>!entry.removed&&!entry.admittedSignalId&&Boolean(entry.content.trim()||entry.attachments.length);
export interface QueueEditorHost {
  runtime:RuntimeStore;
  transaction<T>(action:()=>T):T;
  signature(contextId:string):string;
  validateInputSource?(contextId:string,source:QueueInputSource):void;
  legacySignature?(contextId:string):string;
  queued(contextId:string):Array<SignalRecord&{revision:number}>;
  receipts(contextId:string):QueueWithdrawalResult[];
  withdraw(contextId:string,entries:Array<{id:string;revision:number}>,operationId:string):QueueWithdrawalResult;
  validateAsset(id:string):Promise<void>;
  validateSubmission(contextId:string,mode:'queue'|'steer',expectedRunId?:string):void;
  validateEntry(contextId:string,entry:StoredEntry):void;
  prepareEntry?(contextId:string,entry:StoredEntry):Promise<(signalId:string)=>void>;
  historicalMaterials?(contextId:string,entry:StoredEntry,ownedSignalIds:readonly string[],copyProof?:{draftId:string;runId?:string}):{content:string;signalIds:string[]};
  splitEntry(contextId:string,entry:StoredEntry):StoredEntry[];
  signal(id:string):SignalRecord|undefined;
  stage(contextId:string,entry:StoredEntry,signalId:string):void;
  admit(contextId:string,entry:StoredEntry,signalId:string,mode:'queue'|'steer',expectedRunId?:string):Promise<SignalRecord>;
  deliverGroup(contextId:string,entries:Array<{entry:StoredEntry;signalId:string}>,expectedRunId:string,group:{id:string;signalIds:string[]}):Promise<SignalRecord[]>;
  initialGroup(contextId:string,entries:Array<{entry:StoredEntry;signalId:string}>,runId:string):Promise<unknown>;
  acceptGroup(contextId:string,signalIds:string[],leader:SignalRecord):void;
  recoverPreparedGroup(group:PreparedQueueGroup,entry:StoredEntry):Promise<boolean>;
  cancelledBeforeRequest(runId:string):boolean;
  detach(contextId:string,signalId:string):'pending'|'queued'|'accepted'|'started';
}

/** Durable editing and admission records; execution stays in the host's native queue. */
export class QueueEditor {
  private readonly active=new Map<string,Promise<QueueEditDocument>>();
  private readonly joining=new Map<string,Promise<void>>();
  private readonly payloads:ImmutablePayloadStorage;
  constructor(private readonly host:QueueEditorHost){this.payloads=new ImmutablePayloadStorage(host.runtime.db);}
  private payloadText(reference:ImmutablePayloadReference,namespace:string,id:string){if(!reference||reference.namespace!==namespace||reference.id!==id)throw new AppError('queue_entry_payload_mismatch',409);const value:unknown=deserialize(this.payloads.read(reference));if(typeof value!=='string')throw new AppError('queue_entry_payload_mismatch',409);return value;}
  private partText(key:string,part:ContentPart){if('content'in part){if(typeof part.content!=='string')throw new AppError('queue_entry_payload_mismatch',409);return part.content;}return this.payloadText(part.payload,'queue-entry-parts',key);}
  private editOperation<T>(key:string,request:unknown,series:string,action:()=>T):T{
    const encoded=JSON.stringify(request),previous=this.host.runtime.db.prepare('SELECT request,result FROM runtime_operations WHERE id=?').get(key);
    if(previous){let original=String(previous.request);const value:unknown=JSON.parse(original);if(value&&typeof value==='object'&&!Array.isArray(value)&&'format'in value&&value.format==='queue-request-payload-v1'&&'payload'in value)original=this.payloadText(value.payload as ImmutablePayloadReference,'queue-operation-requests',key);if(original!==encoded)throw new AppError('operation_id_conflict',409);return JSON.parse(String(previous.result)) as T;}
    return this.host.transaction(()=>{const result=action(),payload=this.payloads.put('queue-operation-requests',series,key,serialize(encoded));this.host.runtime.db.prepare('INSERT INTO runtime_operations VALUES(?,?,?)').run(key,JSON.stringify({format:'queue-request-payload-v1',payload}),JSON.stringify(result));return result;});
  }
  private signatureMatches(draft:StoredDraft,current=this.host.signature(draft.contextId)){return draft.signature===current||!draft.signature.startsWith('queue-source-v2:')&&draft.signature===this.host.legacySignature?.(draft.contextId);}
  private signatureError(draft:StoredDraft){return new AppError(draft.signature.startsWith('queue-source-v2:')?'queue_configuration_changed':'queue_source_unverified',409);}
  private index(draft:StoredDraft){for(const submission of [...(draft.previousSubmissions??[]),...(draft.submission?[draft.submission]:[])])if(submission.runId){const key=`queue-edit-run:${submission.runId}`,ids=this.host.runtime.setting<string[]>(key,[]);if(!ids.includes(draft.id))this.host.runtime.setSetting(key,[...ids,draft.id]);}}
  private save(draft:StoredDraft){draft.updatedAt=new Date().toISOString();draft.entryCount=draft.submission?new Set(draft.submission.entries.filter(row=>row.status==='pending').map(row=>row.entryId)).size:draft.body.filter(sendable).length;this.host.runtime.setSetting(`queue-edit:${draft.id}`,draft);this.index(draft);this.host.runtime.event({contextId:draft.contextId,kind:'message_queue_state',data:{id:draft.id}});}
  private read(contextId:string,id:string){const draft=this.host.runtime.setting<StoredDraft|null>(`queue-edit:${id}`,null);if(!draft||draft.contextId!==contextId)throw new AppError('queue_draft_not_found',404);return draft;}
  private view(draft:StoredDraft):QueueEditDocument{const {body,signature,capture,request,captureId,captureBaseIds,versions,nativeEntries,...view}=draft,retainedVersionCount=this.host.runtime.setting<string[]>(`queue-entry-versions:${draft.id}`,[]).length;const captures=body.flatMap(row=>row.captureDraftId?[{draftId:row.captureDraftId,entryId:row.id,detached:row.captureInputDetached??false,unconfirmed:row.captureInputUnconfirmed??false}]:[]);if(!captures.length&&draft.capturedDraftId&&draft.capturedEntryId)captures.push({draftId:draft.capturedDraftId,entryId:draft.capturedEntryId,detached:draft.capturedInputDetached??false,unconfirmed:draft.capturedInputUnconfirmed??false});return structuredClone({...view,...(captures.length?{captures}:{}),...(retainedVersionCount?{retainedVersionCount}:{})});}
  list(contextId:string,includeRetained=false){this.host.signature(contextId);return this.host.runtime.queueEditDocuments<StoredDraft>().filter(row=>row.contextId===contextId&&!row.rebasedTo&&(row.status!=='submitted'||includeRetained&&this.host.runtime.setting<string[]>(`queue-entry-versions:${row.id}`,[]).length>0)).map(row=>this.view(row));}
  private entry(input:Input,sources:string[]=[]):StoredEntry {
    const content=input.sourceText??input.content;
    if(input.sourceText!==undefined&&!input.content.endsWith(input.sourceText))throw new AppError('message_source_mismatch');
    const localContext=input.localContext??(input.sourceText===undefined?'':input.content.slice(0,input.content.length-input.sourceText.length));
    return {id:randomUUID(),content,attachments:input.attachments,sourceSignalIds:[...new Set([...sources,...(input.restoredFromSignalIds??[])])],removed:false,...(localContext?{localContext}:{}),...(input.selectedSkillName?{selectedSkillName:input.selectedSkillName}:{}),...(input.clientDraftId?{captureDraftId:input.clientDraftId,captureInputDetached:false,captureInputUnconfirmed:false}:{})};
  }
  create(contextId:string,body:unknown,operationId:string){
    if(!operationId)throw new AppError('operation_id_required');
    const input=z.object({current:inputSchema.optional(),localCapture:z.boolean().optional(),captureQueue:z.boolean().optional(),expectedSource:z.object({workspaceId:z.string().min(1),directory:z.object({path:z.string().min(1),dev:z.string().regex(/^\d+$/),ino:z.string().regex(/^\d+$/)}).strict()}).strict().optional()}).strict().parse(body);
    if(input.expectedSource){if(!this.host.validateInputSource)throw new AppError('queue_input_source_unavailable',409);this.host.validateInputSource(contextId,input.expectedSource);}
    const request=JSON.stringify([contextId,input]),key=`queue-edit-create:${createHash('sha256').update(operationId).digest('hex')}`;
    const old=this.host.runtime.setting<{request:string;id:string}|null>(key,null);
    if(old){if(old.request!==request)throw new AppError('operation_id_conflict',409);return this.capture(this.read(contextId,old.id));}
    const signature=this.host.signature(contextId),rows=input.captureQueue===false?[]:this.host.queued(contextId);
    const documents=this.host.runtime.queueEditDocuments<StoredDraft>();
    const editing=input.captureQueue===false?undefined:documents.filter(row=>row.contextId===contextId&&row.status==='editing').at(-1);
    const claimed=new Set(documents.filter(row=>row.status!=='submitted').flatMap(row=>row.body.flatMap(entry=>entry.sourceSignalIds)));
    const recovered=input.captureQueue===false?[]:this.host.receipts(contextId).flatMap(receipt=>receipt.withdrawn).filter(row=>!claimed.has(row.id));
    if(!rows.length&&!recovered.length&&!editing&&!(input.localCapture&&input.current?.clientDraftId))throw new AppError('message_queue_empty',409);
    const now=new Date().toISOString();
    const base=editing?structuredClone(editing.body):[];
    const draft:StoredDraft={...(editing?{previousSubmissions:editing.previousSubmissions,versions:editing.versions,nativeEntries:editing.nativeEntries,capturedDraftId:editing.capturedDraftId,capturedEntryId:editing.capturedEntryId,capturedInputDetached:editing.capturedInputDetached,capturedInputUnconfirmed:editing.capturedInputUnconfirmed}:{}),id:editing?.id??randomUUID(),contextId,revision:editing?editing.revision+1:1,status:'capturing',createdAt:editing?.createdAt??now,updatedAt:now,entryCount:0,skipped:[],signature,request,captureId:randomUUID(),captureBaseIds:base.map(row=>row.id),capture:rows.map(row=>({id:row.id,revision:row.revision})),body:[...recovered.map(row=>this.entry({content:row.content,attachments:row.attachments??[]},[row.id])),...base]};
    if(input.current){const entry=this.entry(input.current);entry.captureInputUnconfirmed=Boolean(input.localCapture);draft.body.push(entry);draft.captureBaseIds!.push(entry.id);draft.capturedEntryId=entry.id;draft.capturedInputDetached=false;draft.capturedInputUnconfirmed=Boolean(input.localCapture);if(input.current.clientDraftId)draft.capturedDraftId=input.current.clientDraftId;}
    this.host.transaction(()=>{this.save(draft);this.host.runtime.setSetting(key,{request,id:draft.id});});
    return this.capture(draft);
  }
  private capture(draft:StoredDraft){
    if(draft.status!=='capturing')return this.view(draft);
    // The immutable server snapshot is paged through the existing cancellation journal.
    const baseIds=new Set(draft.captureBaseIds??draft.body.filter(row=>!row.sourceSignalIds.length).map(row=>row.id));
    const current=draft.body.filter(row=>baseIds.has(row.id)),sources=draft.body.filter(row=>!baseIds.has(row.id));
    for(let offset=0;offset<draft.capture.length;offset+=64){
      const result=this.host.withdraw(draft.contextId,draft.capture.slice(offset,offset+64),`queue-edit:${draft.id}:${draft.captureId??'initial'}:${offset}`);
      for(const row of result.withdrawn)if(!sources.some(entry=>entry.sourceSignalIds.includes(row.id)))sources.push(this.entry({content:row.content,attachments:row.attachments??[]},[row.id]));
      draft.skipped.push(...result.skipped.filter(row=>!draft.skipped.some(old=>old.id===row.id)));
      draft.body=[...current.filter(row=>row.admittedSignalId),...sources,...current.filter(row=>!row.admittedSignalId)];this.save(draft);
    }
    draft.status='editing';this.save(draft);return this.view(draft);
  }
  page(contextId:string,id:string,cursor=0,limit=20):QueueEditPage{
    const draft=this.read(contextId,id);if(draft.status==='capturing')this.capture(draft);
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new AppError('invalid_queue_page');
    return {draft:this.view(draft),entries:draft.body.slice(cursor,cursor+limit).map(entry=>this.publicEntry(entry)),nextCursor:cursor+limit<draft.body.length?cursor+limit:null};
  }
  private publicEntry({localContext,referenceContext,materialSourceSignalId,...entry}:StoredEntry):QueueEditEntry{return structuredClone({...entry,localContextHash:createHash('sha256').update(localContext??'').digest('hex'),...(referenceContext?{referenceContextHash:createHash('sha256').update(referenceContext).digest('hex')}:{})});}
  private versionView(row:RetainedEntryVersion):QueueRetainedVersion{return {id:row.id,draftId:row.draftId,revision:row.revision,entry:this.publicEntry(row.entry),createdAt:row.createdAt,materialHash:createHash('sha256').update(JSON.stringify([row.entry.localContext??'',row.entry.referenceContext??'',row.referenceContext])).digest('hex'),materialCharacters:(row.entry.localContext??'').length+(row.entry.referenceContext??'').length+row.referenceContext.length};}
  retainedVersions(contextId:string,id:string){this.read(contextId,id);const ids=this.host.runtime.setting<string[]>(`queue-entry-versions:${id}`,[]);return ids.map(versionId=>this.retainedVersion(contextId,id,versionId));}
  retainedVersion(contextId:string,id:string,versionId:string){const row=this.host.runtime.setting<RetainedEntryVersion|null>(`queue-entry-version:${versionId}`,null);if(!row||row.contextId!==contextId||row.draftId!==id)throw new AppError('queue_entry_version_not_found',404);return this.versionView(row);}
  retainVersion(contextId:string,id:string,body:unknown,operationId:string){
    const input=z.object({expectedRevision:z.number().int().positive(),entryId:z.string().uuid()}).strict().parse(body);if(!operationId)throw new AppError('operation_id_required');
    return this.host.runtime.operation(`queue-entry-retain:${operationId}`,[contextId,id,input],()=>{
      const draft=this.read(contextId,id);if(draft.revision!==input.expectedRevision)throw new AppError('revision_conflict',409);const entry=draft.body.find(row=>row.id===input.entryId);if(!entry)throw new AppError('queue_entry_not_found',404);
      const row:RetainedEntryVersion={id:randomUUID(),draftId:id,contextId,revision:draft.revision,entry:structuredClone(entry),referenceContext:this.host.historicalMaterials?.(contextId,entry,draft.submission?.entries.map(receipt=>receipt.signalId)??[])?.content??'',createdAt:new Date().toISOString()};
      this.host.runtime.setSetting(`queue-entry-version:${row.id}`,row);this.host.runtime.setSetting(`queue-entry-versions:${id}`,[...this.host.runtime.setting<string[]>(`queue-entry-versions:${id}`,[]),row.id]);this.host.runtime.event({contextId,kind:'message_queue_state',data:{id}});return this.versionView(row);
    });
  }
  restoreRetainedVersion(contextId:string,id:string,versionId:string,operationId:string){
    if(!operationId)throw new AppError('operation_id_required');return this.host.runtime.operation(`queue-entry-restore:${operationId}`,[contextId,id,versionId],()=>{
      const original=this.read(contextId,id),row=this.host.runtime.setting<RetainedEntryVersion|null>(`queue-entry-version:${versionId}`,null);if(!row||row.contextId!==contextId||row.draftId!==id)throw new AppError('queue_entry_version_not_found',404);
      const entry:StoredEntry={...structuredClone(row.entry),id:randomUUID(),sourceSignalIds:[],removed:false,localContext:[row.entry.localContext,row.referenceContext].filter(Boolean).join('\n\n'),clearSkills:true,rebasedFrom:{draftId:id,revision:row.revision,entryId:row.entry.id,signalIds:[...row.entry.sourceSignalIds]}};
      delete entry.selectedSkillName;delete entry.materialSourceSignalId;delete entry.admittedSignalId;delete entry.captureDraftId;delete entry.captureInputDetached;delete entry.captureInputUnconfirmed;delete entry.copiedFrom;
      const now=new Date().toISOString(),draft:StoredDraft={id:randomUUID(),contextId,revision:1,status:'editing',createdAt:now,updatedAt:now,entryCount:1,skipped:[],signature:this.host.signature(contextId),capture:[],body:[entry],request:JSON.stringify([id,versionId])};this.save(draft);return this.page(contextId,draft.id);
    });
  }
  beginEntryEdit(contextId:string,id:string,body:unknown,operationId:string):QueueEntryEdit{
    const input=z.object({entryId:z.string().uuid(),expectedRevision:z.number().int().positive(),partCount:z.number().int().positive(),characters:z.number().int().nonnegative(),hash:z.string().regex(/^[a-f0-9]{64}$/),attachments:z.array(z.string().uuid()),captureDraftId:z.string().uuid().optional(),localContext:z.string().max(64000).optional(),contextParts:z.object({partCount:z.number().int().positive(),characters:z.number().int().nonnegative(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),attachmentParts:z.object({partCount:z.number().int().positive(),items:z.number().int().nonnegative(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional()}).strict().parse(body);
    if(input.localContext!==undefined&&input.contextParts)throw new AppError('queue_entry_context_conflict',409);
    if(input.attachmentParts&&input.attachments.length)throw new AppError('queue_entry_attachment_conflict',409);
    if(!operationId)throw new AppError('operation_id_required');const key=`queue-entry-upload-key:${createHash('sha256').update(operationId).digest('hex')}`,originalRequest=JSON.stringify([contextId,id,input]),request='sha256:'+createHash('sha256').update(originalRequest).digest('hex');
    const prior=this.host.runtime.setting<{id:string;request:string}|null>(key,null);
    if(prior){if(prior.request!==(prior.request.startsWith('sha256:')?request:originalRequest))throw new AppError('operation_id_conflict',409);return this.entryEdit(contextId,id,prior.id);}
    const draft=this.read(contextId,id),entry=draft.body.find(row=>row.id===input.entryId);
    if(draft.status!=='editing')throw new AppError('queue_draft_not_editable',409);if(draft.revision!==input.expectedRevision)throw new AppError('revision_conflict',409);if(!entry)throw new AppError('queue_entry_not_found',404);if(entry.admittedSignalId)throw new AppError('queue_entry_already_admitted',409);
    const upload:EntryUpload={id:randomUUID(),contextId,draftId:id,entryId:input.entryId,revision:input.expectedRevision,partCount:input.partCount,characters:input.characters,hash:input.hash,attachments:input.attachments,receivedParts:[],status:'uploading',request,...(input.captureDraftId?{captureDraftId:input.captureDraftId}:{}),...(input.contextParts?{contextParts:input.contextParts,receivedContextParts:[]}:{}),...(input.attachmentParts?{attachmentParts:input.attachmentParts,receivedAttachmentParts:[]}:{})};
    this.host.transaction(()=>{if(input.localContext!==undefined)upload.localContextRef=this.payloads.put('queue-entry-contexts',`${id}:${input.entryId}`,`queue-entry-context:${upload.id}`,serialize(input.localContext));this.host.runtime.setSetting(`queue-entry-upload:${upload.id}`,upload);this.host.runtime.setSetting(key,{id:upload.id,request});});return this.entryEdit(contextId,id,upload.id);
  }
  private upload(contextId:string,id:string,uploadId:string){const row=this.host.runtime.setting<EntryUpload|null>(`queue-entry-upload:${uploadId}`,null);if(!row||row.contextId!==contextId||row.draftId!==id)throw new AppError('queue_entry_edit_not_found',404);return row;}
  copyVersion(contextId:string,id:string,body:unknown,operationId:string){
    const input=z.object({expectedRevision:z.number().int().positive(),entryId:z.string().uuid(),selection:z.discriminatedUnion('kind',[z.object({kind:z.literal('inherit')}).strict(),z.object({kind:z.literal('none')}).strict(),z.object({kind:z.literal('selected'),name:z.string().min(1).max(1024)}).strict()]).optional()}).strict().parse(body);if(!operationId)throw new AppError('operation_id_required');
    return this.host.runtime.operation(`queue-edit-version:${operationId}`,[contextId,id,input],()=>{
      const original=this.read(contextId,id);if(original.revision!==input.expectedRevision)throw new AppError('revision_conflict',409);
      const submission=original.submission,version=submission?.revision,entry=version===undefined?undefined:original.versions?.[String(version)]?.find(row=>row.id===input.entryId),manifest=submission?.logicalEntries?.find(row=>row.entryId===input.entryId);
      if(!submission||!entry||!manifest||createHash('sha256').update(entry.content).digest('hex')!==manifest.contentHash||JSON.stringify(entry.attachments)!==JSON.stringify(manifest.attachmentIds)||!manifest.signalIds.length)throw new AppError('queue_version_source_unavailable',409);
      for(const signalId of manifest.signalIds)if(!original.nativeEntries?.[signalId]||this.host.signal(signalId)?.contextId!==contextId)throw new AppError('queue_version_source_unavailable',409);
      const now=new Date().toISOString(),runId=submission.runId??this.host.signal(submission.leaderSignalId??'')?.runId,history=this.host.historicalMaterials?.(contextId,entry,manifest.signalIds,{draftId:id,...(runId?{runId}:{})}),copy:StoredEntry={...structuredClone(entry),id:randomUUID(),sourceSignalIds:[],removed:false,...(history?.content?{referenceContext:[entry.referenceContext,history.content].filter(Boolean).join('\n\n')}:{}),copiedFrom:{draftId:id,revision:version!,entryId:entry.id,signalIds:[...manifest.signalIds]}};
      if(!history&&(entry.sourceSignalIds.length||entry.materialSourceSignalId))throw new AppError('queue_version_source_unavailable',409);
      delete copy.materialSourceSignalId;delete copy.admittedSignalId;delete copy.captureDraftId;delete copy.captureInputDetached;delete copy.captureInputUnconfirmed;
      if(input.selection){delete copy.selectedSkillName;if(input.selection.kind==='selected'){copy.selectedSkillName=input.selection.name;delete copy.clearSkills;}else copy.clearSkills=true;}
      if(!this.signatureMatches(original)){delete copy.selectedSkillName;copy.clearSkills=true;}
      const draft:StoredDraft={id:randomUUID(),contextId,revision:1,status:'editing',createdAt:now,updatedAt:now,entryCount:1,skipped:[],signature:this.host.signature(contextId),capture:[],body:[copy],request:JSON.stringify([id,input])};this.save(draft);return this.page(contextId,draft.id);
    });
  }
  entryEdit(contextId:string,id:string,uploadId:string):QueueEntryEdit{const row=this.upload(contextId,id,uploadId);return {id:row.id,entryId:row.entryId,revision:row.revision,partCount:row.partCount,receivedParts:row.receivedParts,status:row.status,...(row.receivedContextParts?{receivedContextParts:row.receivedContextParts}:{}),...(row.attachmentParts?{attachmentPartCount:row.attachmentParts.partCount,receivedAttachmentParts:row.receivedAttachmentParts}:{}),...(row.result?{result:row.result}:{})};}
  writeEntryPart(contextId:string,id:string,uploadId:string,index:number,body:unknown,kind:'content'|'context'|'attachments'='content'){
    const input=z.object({content:z.string().max(64000)}).strict().parse(body),upload=this.upload(contextId,id,uploadId),count=kind==='context'?upload.contextParts?.partCount:kind==='attachments'?upload.attachmentParts?.partCount:upload.partCount;
    if(count===undefined||!Number.isSafeInteger(index)||index<0||index>=count)throw new AppError('invalid_queue_entry_part');
    if(kind==='attachments'){let decoded:unknown;try{decoded=JSON.parse(input.content);}catch{throw new AppError('invalid_queue_attachment_part');}z.array(z.string().uuid()).parse(decoded);}
    const key=`queue-entry-part:${uploadId}:${kind==='content'?'':kind+':'}${index}`,old=this.host.runtime.setting<ContentPart|null>(key,null);if(old){if(this.partText(key,old)!==input.content)throw new AppError('operation_id_conflict',409);return this.entryEdit(contextId,id,uploadId);}if(upload.status!=='uploading')throw new AppError('queue_entry_edit_committed',409);
    this.host.transaction(()=>{const payload=this.payloads.put('queue-entry-parts',`${id}:${upload.entryId}:${kind}:${index}`,key,serialize(input.content));this.host.runtime.setSetting(key,{payload});const received=kind==='context'?upload.receivedContextParts!:kind==='attachments'?upload.receivedAttachmentParts!:upload.receivedParts;received.push(index);received.sort((a,b)=>a-b);this.host.runtime.setSetting(`queue-entry-upload:${uploadId}`,upload);});return this.entryEdit(contextId,id,uploadId);
  }
  private joinUploadParts(upload:EntryUpload,kind:'content'|'context'){
    const plan=kind==='content'?upload:upload.contextParts!,received=kind==='content'?upload.receivedParts:upload.receivedContextParts!;
    if(received.length!==plan.partCount)throw new AppError('queue_entry_parts_missing',409);
    const parts:string[]=[];for(let index=0;index<plan.partCount;index++){const key=`queue-entry-part:${upload.id}:${kind==='context'?'context:':''}${index}`,part=this.host.runtime.setting<ContentPart|null>(key,null);if(!part)throw new AppError('queue_entry_parts_missing',409);parts.push(this.partText(key,part));}
    const content=parts.join('');if(content.length!==plan.characters||createHash('sha256').update(content).digest('hex')!==plan.hash)throw new AppError('queue_entry_edit_mismatch',409);return content;
  }
  private joinAttachmentParts(upload:EntryUpload){if(!upload.attachmentParts)return upload.attachments;const plan=upload.attachmentParts;if(upload.receivedAttachmentParts?.length!==plan.partCount)throw new AppError('queue_entry_parts_missing',409);const attachments:string[]=[];for(let index=0;index<plan.partCount;index++){const key=`queue-entry-part:${upload.id}:attachments:${index}`,part=this.host.runtime.setting<ContentPart|null>(key,null);if(!part)throw new AppError('queue_entry_parts_missing',409);let decoded:unknown;try{decoded=JSON.parse(this.partText(key,part));}catch{throw new AppError('invalid_queue_attachment_part',409);}attachments.push(...z.array(z.string().uuid()).parse(decoded));}if(attachments.length!==plan.items||createHash('sha256').update(JSON.stringify(attachments)).digest('hex')!==plan.hash)throw new AppError('queue_entry_edit_mismatch',409);return attachments;}
  commitEntryEdit(contextId:string,id:string,uploadId:string){const upload=this.upload(contextId,id,uploadId);if(upload.status==='committed')return upload.result!;const content=this.joinUploadParts(upload,'content'),localContext=upload.contextParts?this.joinUploadParts(upload,'context'):upload.localContextRef?this.payloadText(upload.localContextRef,'queue-entry-contexts',`queue-entry-context:${upload.id}`):upload.localContext,attachments=this.joinAttachmentParts(upload);
    return this.host.transaction(()=>{const draft=this.read(contextId,id),entry=draft.body.find(row=>row.id===upload.entryId);if(draft.status!=='editing')throw new AppError('queue_draft_not_editable',409);if(draft.revision!==upload.revision)throw new AppError('revision_conflict',409);if(!entry)throw new AppError('queue_entry_not_found',404);if(entry.admittedSignalId)throw new AppError('queue_entry_already_admitted',409);if(upload.captureDraftId&&((entry.captureDraftId??(entry.id===draft.capturedEntryId?draft.capturedDraftId:undefined))!==upload.captureDraftId||(entry.captureInputDetached??(entry.id===draft.capturedEntryId&&draft.capturedInputDetached))))throw new AppError('captured_input_changed',409);entry.content=content;entry.attachments=attachments;if(localContext!==undefined)entry.localContext=localContext;if(upload.captureDraftId){entry.captureInputUnconfirmed=false;if(entry.id===draft.capturedEntryId)draft.capturedInputUnconfirmed=false;}else if(entry.captureDraftId)entry.captureInputDetached=true;if(entry.id===draft.capturedEntryId&&!upload.captureDraftId)draft.capturedInputDetached=true;draft.revision++;this.save(draft);upload.status='committed';upload.result=this.view(draft);this.host.runtime.setSetting(`queue-entry-upload:${uploadId}`,upload);return upload.result;});
  }
  mutate(contextId:string,id:string,body:unknown,operationId:string){
    const schema=z.object({expectedRevision:z.number().int().positive(),action:z.discriminatedUnion('kind',[
      z.object({kind:z.literal('edit'),entryId:z.string().uuid(),captureDraftId:z.string().uuid().optional(),content:z.string().max(64000),localContext:z.string().max(64000).optional(),attachments:z.array(z.string().uuid()).max(8)}).strict(),
      z.object({kind:z.literal('add'),afterId:z.string().uuid().nullable(),input:inputSchema}).strict(),
      z.object({kind:z.literal('remove'),entryId:z.string().uuid(),removed:z.boolean()}).strict(),
      z.object({kind:z.literal('move'),entryId:z.string().uuid(),beforeId:z.string().uuid().nullable()}).strict(),
      z.object({kind:z.literal('skill'),entryId:z.string().uuid(),selection:z.discriminatedUnion('kind',[z.object({kind:z.literal('inherit')}).strict(),z.object({kind:z.literal('none')}).strict(),z.object({kind:z.literal('selected'),name:z.string().min(1).max(1024)}).strict()])}).strict(),
    ])}).strict();const input=schema.parse(body);if(!operationId)throw new AppError('operation_id_required');
    return this.editOperation(`queue-edit-mutation:${operationId}`,[contextId,id,input],`${id}:${'entryId'in input.action?input.action.entryId:'new'}:${input.action.kind}`,()=>{
      const draft=this.read(contextId,id);if(draft.status!=='editing')throw new AppError('queue_draft_not_editable',409);
      if(draft.revision!==input.expectedRevision)throw new AppError('revision_conflict',409);
      const action=input.action,index='entryId'in action?draft.body.findIndex(row=>row.id===action.entryId):-1;
      if('entryId'in action&&index<0)throw new AppError('queue_entry_not_found',404);
      if(index>=0&&draft.body[index]!.admittedSignalId)throw new AppError('queue_entry_already_admitted',409);
      if(action.kind==='edit'&&action.captureDraftId&&((draft.body[index]!.captureDraftId??(action.entryId===draft.capturedEntryId?draft.capturedDraftId:undefined))!==action.captureDraftId||(draft.body[index]!.captureInputDetached??(action.entryId===draft.capturedEntryId&&draft.capturedInputDetached))))throw new AppError('captured_input_changed',409);
      if(action.kind==='move'&&action.beforeId&&draft.body.find(row=>row.id===action.beforeId)?.admittedSignalId)throw new AppError('queue_entry_already_admitted',409);
      if(action.kind==='edit'){draft.body[index]!.content=action.content;draft.body[index]!.attachments=action.attachments;if(action.localContext!==undefined)draft.body[index]!.localContext=action.localContext;if(action.captureDraftId){draft.body[index]!.captureInputUnconfirmed=false;if(action.entryId===draft.capturedEntryId)draft.capturedInputUnconfirmed=false;}}
      if(index>=0&&draft.body[index]!.captureDraftId&&action.kind!=='move'&&!(action.kind==='edit'&&action.captureDraftId))draft.body[index]!.captureInputDetached=true;
      if('entryId'in action&&action.entryId===draft.capturedEntryId&&action.kind!=='move'&&!(action.kind==='edit'&&action.captureDraftId))draft.capturedInputDetached=true;
      if(action.kind==='remove')draft.body[index]!.removed=action.removed;
      if(action.kind==='skill'){const entry=draft.body[index]!;if(action.selection.kind==='selected'){entry.selectedSkillName=action.selection.name;delete entry.clearSkills;}else{delete entry.selectedSkillName;if(action.selection.kind==='none')entry.clearSkills=true;else delete entry.clearSkills;}}
      if(action.kind==='add'){const at=action.afterId===null?-1:draft.body.findIndex(row=>row.id===action.afterId);if(action.afterId!==null&&at<0)throw new AppError('queue_entry_not_found',404);const added=this.entry(action.input);draft.body.splice(at+1,0,added);if(action.input.clientDraftId){added.captureInputUnconfirmed=!added.content&&!added.attachments.length;draft.capturedDraftId=action.input.clientDraftId;draft.capturedEntryId=added.id;draft.capturedInputDetached=false;draft.capturedInputUnconfirmed=added.captureInputUnconfirmed;}}
      if(action.kind==='move'){if(action.beforeId===action.entryId)throw new AppError('invalid_queue_order');const [entry]=draft.body.splice(index,1);const at=action.beforeId===null?draft.body.length:draft.body.findIndex(row=>row.id===action.beforeId);if(at<0)throw new AppError('queue_entry_not_found',404);draft.body.splice(at,0,entry!);}
      draft.revision++;this.save(draft);return this.view(draft);
    });
  }
  submit(contextId:string,id:string,body:unknown,operationId:string){
    const input=z.object({expectedRevision:z.number().int().positive(),mode:z.enum(['queue','steer']).default('queue'),expectedRunId:z.string().min(1).max(200).optional()}).strict().parse(body);
    if(!operationId)throw new AppError('operation_id_required');const key=`queue-edit-submit:${createHash('sha256').update(operationId).digest('hex')}`,request=JSON.stringify([contextId,id,input]),prior=this.host.runtime.setting<string|null>(key,null);if(prior&&prior!==request)throw new AppError('operation_id_conflict',409);
    const draft=this.read(contextId,id);
    if(draft.submission){if(draft.revision!==input.expectedRevision||draft.submission.mode!==input.mode||draft.submission.expectedRunId!==input.expectedRunId)throw new AppError('operation_id_conflict',409);}
    else if(draft.revision!==input.expectedRevision)throw new AppError('revision_conflict',409);
    const existing=this.active.get(id);if(existing)return existing;
    this.host.runtime.setSetting(key,request);
    const promise=this.publish(draft,input,operationId).catch(error=>{const actual=this.read(contextId,id);if(actual.submission&&actual.status!=='submitted'){actual.status='blocked';actual.errorCode=error instanceof AppError?error.code:'queue_admission_unknown';this.save(actual);}throw error;}).finally(()=>this.active.delete(id));this.active.set(id,promise);return promise;
  }
  private async publish(draft:StoredDraft,input:{mode:'queue'|'steer';expectedRunId?:string},operationId:string){
    if(draft.status==='submitted')return this.view(draft);
    const signature=this.host.signature(draft.contextId);
    this.host.validateSubmission(draft.contextId,input.mode,input.expectedRunId);
    const candidates=draft.submission?draft.submission.entries.filter(row=>row.status==='pending').map(row=>draft.body.find(entry=>entry.id===row.entryId)!):draft.body.filter(sendable);
    for(const entry of candidates){this.host.validateEntry(draft.contextId,entry);this.host.splitEntry(draft.contextId,entry);for(const id of entry.attachments)await this.host.validateAsset(id);}
    const prepared=new Map<string,(signalId:string)=>void>();
    if(!draft.submission&&this.host.prepareEntry)for(const entry of candidates)prepared.set(entry.id,await this.host.prepareEntry(draft.contextId,entry));
    if(!this.signatureMatches(draft,signature))throw this.signatureError(draft);
    if(signature!==this.host.signature(draft.contextId))throw new AppError('queue_configuration_changed',409);
    if(!draft.submission){
      if(draft.status!=='editing')throw new AppError('queue_draft_not_editable',409);
      const entries=draft.body.filter(sendable);
      this.host.transaction(()=>{
        const actual=this.read(draft.contextId,draft.id);if(actual.revision!==draft.revision||actual.status!=='editing')throw new AppError('revision_conflict',409);
        if(signature!==this.host.signature(draft.contextId))throw new AppError('queue_configuration_changed',409);
        draft.signature=signature;
        const plans=entries.map(entry=>({entry,parts:this.host.splitEntry(draft.contextId,entry)}));
        draft.submission={operationId,mode:input.mode,...(input.expectedRunId?{expectedRunId:input.expectedRunId}:{}),revision:draft.revision,entries:plans.flatMap(({entry,parts})=>parts.map((_,partIndex)=>({entryId:entry.id,signalId:randomUUID(),status:'pending' as const,partIndex,partCount:parts.length})))};
        (draft.versions??={})[String(draft.revision)]=structuredClone(draft.body);draft.nativeEntries??={};
        draft.submission.logicalEntries=plans.map(({entry})=>({entryId:entry.id,signalIds:draft.submission!.entries.filter(row=>row.entryId===entry.id).map(row=>row.signalId),contentHash:createHash('sha256').update(entry.content).digest('hex'),attachmentIds:[...entry.attachments]}));
        const orphanContext=draft.body.filter(row=>!row.removed&&!row.content.trim()&&!row.attachments.length&&row.localContext).map(row=>row.localContext).join('\n\n');
        const capturedMaterials=new Map<string,string>();
        for(const receipt of draft.submission.entries){const entry=plans.find(row=>row.entry.id===receipt.entryId)!.parts[receipt.partIndex??0]!;const head=draft.submission.logicalEntries.find(row=>row.entryId===receipt.entryId)!.signalIds[0]!;let material=receipt.partIndex?{...entry,materialSourceSignalId:head}:entry;
          if(!receipt.partIndex)prepared.get(receipt.entryId)?.(receipt.signalId);
          if(!receipt.partIndex&&entry.captureDraftId&&entry.localContext){const key=JSON.stringify([entry.captureDraftId,entry.localContext,entry.sourceSignalIds]),shared=capturedMaterials.get(key);if(shared){material={...entry,materialSourceSignalId:shared};delete material.localContext;}else capturedMaterials.set(key,head);}
          const part=receipt.partIndex===0&&receipt.entryId===plans.at(-1)!.entry.id&&orphanContext?{...material,localContext:[material.localContext,orphanContext].filter(Boolean).join('\n\n')}:material;draft.nativeEntries[receipt.signalId]=part;this.host.stage(draft.contextId,part,receipt.signalId);}
        for(const entry of draft.body.filter(row=>row.removed||!row.content.trim()&&!row.attachments.length))for(const source of entry.sourceSignalIds)this.host.runtime.setSetting(`queue-restoration-consumed:${source}`,{bySignalId:`discarded:${draft.id}`,contextId:draft.contextId});
        draft.status='submitting';delete draft.errorCode;this.save(draft);
      });
    }else if(draft.signature!==signature){draft.signature=signature;this.save(draft);}
    const submission=draft.submission!;
    if(!submission.entries.length){draft.status='submitted';submission.groupReady=true;this.save(draft);return this.view(draft);}
    if(!submission.leaderSignalId){submission.leaderSignalId=submission.entries[0]!.signalId;this.host.runtime.setSetting(`queue-edit-group:${submission.leaderSignalId}`,{contextId:draft.contextId,draftId:draft.id});this.save(draft);}
    if(input.mode==='steer')await this.join(draft.contextId,draft.id,input.expectedRunId!);
    else {
      const leader=submission.entries[0]!,entry=draft.nativeEntries?.[leader.signalId]??draft.body.find(row=>row.id===leader.entryId)!;
      const actual=this.host.signal(leader.signalId);
      if(actual?.action!==null&&actual?.runId){
        if(!submission.groupReady)throw new AppError('queue_group_interrupted',409);
      }else await this.host.admit(draft.contextId,entry,leader.signalId,'queue');
      // beforeStream owns the group barrier; it may already have acknowledged
      // every member while native queue admission was still returning here.
      const latest=this.read(draft.contextId,draft.id);this.observe(latest);this.save(latest);
    }
    return this.view(this.read(draft.contextId,draft.id));
  }
  private observe(draft:StoredDraft){for(const receipt of draft.submission?.entries??[]){const actual=this.host.signal(receipt.signalId);if(actual?.status==='queued'||actual?.status==='accepted'){receipt.status=actual.status;if(receipt.signalId===draft.submission?.leaderSignalId&&actual.runId){if(draft.submission.runId&&draft.submission.runId!==actual.runId)throw new AppError('queue_group_run_changed',409);draft.submission.runId=actual.runId;}}else if(actual?.action!=null&&actual.nativeSignalId)receipt.status='started';}}
  /** Runs inside the native stream entrance, before its first model request. */
  async beforeStream(signalId:string,runId:string){
    const owner=this.host.runtime.setting<{contextId:string;draftId:string}|null>(`queue-edit-group:${signalId}`,null);
    if(!owner)return;
    const draft=this.read(owner.contextId,owner.draftId),submission=draft.submission;
    if(!submission||submission.mode!=='queue'||submission.leaderSignalId!==signalId)return;
    if(this.host.cancelledBeforeRequest(runId))throw new AppError('queue_group_cancelled',409);
    if(submission.runId&&submission.runId!==runId)throw new AppError('queue_group_run_changed',409);
    if(!this.signatureMatches(draft))throw this.signatureError(draft);
    const entries=submission.entries.map(row=>({entry:draft.nativeEntries?.[row.signalId]??draft.body.find(entry=>entry.id===row.entryId)!,signalId:row.signalId}));
    for(const {entry} of entries){this.host.validateEntry(draft.contextId,entry);for(const asset of entry.attachments)await this.host.validateAsset(asset);}
    const input=await this.host.initialGroup(draft.contextId,entries,runId);
    if(this.host.cancelledBeforeRequest(runId))throw new AppError('queue_group_cancelled',409);
    if(!this.signatureMatches(draft))throw this.signatureError(draft);
    draft.signature=this.host.signature(draft.contextId);submission.runId=runId;submission.inputPrepared=true;this.save(draft);this.accepted(signalId,runId);return input;
  }
  accepted(signalId:string,runId:string){
    const owner=this.host.runtime.setting<{contextId:string;draftId:string}|null>(`queue-edit-group:${signalId}`,null);if(!owner)return;
    const draft=this.read(owner.contextId,owner.draftId),submission=draft.submission,leader=this.host.signal(signalId);
    if(!submission?.inputPrepared||submission.runId!==runId||leader?.status!=='accepted'||leader.runId!==runId)return;
    this.host.transaction(()=>{this.host.acceptGroup(draft.contextId,submission.entries.map(row=>row.signalId),leader);this.observe(draft);submission.groupReady=true;draft.status='submitted';delete draft.errorCode;this.save(draft);});
  }
  failed(signalId:string,error:unknown){const owner=this.host.runtime.setting<{contextId:string;draftId:string}|null>(`queue-edit-group:${signalId}`,null);if(!owner)return;const draft=this.read(owner.contextId,owner.draftId);if(draft.submission&&!draft.submission.groupReady){this.observe(draft);draft.status='blocked';draft.errorCode=error instanceof AppError?error.code:'queue_admission_unknown';this.save(draft);}}
  cancelled(signalId:string){this.failed(signalId,new AppError('queue_group_cancelled',409));}
  private async join(contextId:string,id:string,runId:string){
    const running=this.joining.get(id);if(running)return running;
    const operation=this.joinNow(contextId,id,runId).finally(()=>this.joining.delete(id));this.joining.set(id,operation);return operation;
  }
  private async joinNow(contextId:string,id:string,runId:string){
    let draft=this.read(contextId,id);const submission=draft.submission;if(!submission||submission.groupReady)return;
    if(submission.runId&&submission.runId!==runId)throw new AppError('queue_group_run_changed',409);
    submission.runId=runId;this.observe(draft);this.save(draft);
    try{
      this.host.validateSubmission(contextId,'steer',runId);
      if(!this.signatureMatches(draft))throw this.signatureError(draft);
      const pending=submission.entries.filter(row=>this.host.signal(row.signalId)?.action==null);
      const entries=pending.map(receipt=>({entry:draft.nativeEntries?.[receipt.signalId]??draft.body.find(row=>row.id===receipt.entryId)!,signalId:receipt.signalId}));
      for(const {entry} of entries){this.host.validateEntry(contextId,entry);for(const asset of entry.attachments)await this.host.validateAsset(asset);}
      await this.host.deliverGroup(contextId,entries,runId,{id:submission.leaderSignalId!,signalIds:submission.entries.map(row=>row.signalId)});
      draft=this.read(contextId,id);this.observe(draft);
      if(draft.submission!.entries.some(row=>row.status==='pending'||row.status==='queued'))throw new AppError('queue_group_not_acknowledged',409);
      draft.submission!.groupReady=true;draft.status='submitted';delete draft.errorCode;this.save(draft);
    }catch(error){draft=this.read(contextId,id);this.observe(draft);draft.status='blocked';draft.errorCode=error instanceof AppError?error.code:'queue_admission_unknown';this.save(draft);throw error;}
  }
  reopen(contextId:string,id:string,body:unknown,operationId:string){
    const input=z.object({expectedRevision:z.number().int().positive()}).strict().parse(body);
    if(!operationId)throw new AppError('operation_id_required');if(this.active.has(id)||this.joining.has(id))throw new AppError('queue_draft_busy',409);
    return this.host.runtime.operation(`queue-edit-reopen:${operationId}`,[contextId,id,input],()=>{
      const draft=this.read(contextId,id);if(draft.revision!==input.expectedRevision)throw new AppError('revision_conflict',409);
      if(!draft.submission)throw new AppError('queue_draft_not_submitted',409);
      const next:StoredEntry[]=[];
      for(const entry of draft.body){const receipts=draft.submission.entries.filter(row=>row.entryId===entry.id);if(!receipts.length){next.push(entry);continue;}
        const states=receipts.map(receipt=>{const previous=this.host.signal(receipt.signalId),state=this.host.detach(contextId,receipt.signalId);receipt.status=state;return {receipt,previous,state};});
        if(states.every(row=>row.state!=='pending')){entry.admittedSignalId=receipts[0]!.signalId;next.push(entry);continue;}
        if(states.every(row=>row.state==='pending')){const first=states[0]!;if(first.previous?.status==='queued'||first.previous?.action!=null||first.previous?.status==='cancelled'&&this.host.runtime.setting(`queue-restoration-consumed:${entry.sourceSignalIds[0]}`,null)){entry.sourceSignalIds=[first.receipt.signalId];delete entry.localContext;}next.push(entry);continue;}
        for(const [index,{receipt,state}] of states.entries()){const original=draft.nativeEntries?.[receipt.signalId]??entry;const fragment:StoredEntry={...structuredClone(original),id:index===0?entry.id:randomUUID(),sourceSignalIds:state==='pending'?[receipt.signalId]:entry.sourceSignalIds,originEntryId:entry.originEntryId??entry.id,originRevision:entry.originRevision??draft.submission.revision??draft.revision,...(state!=='pending'?{admittedSignalId:receipt.signalId}:{})};if(fragment.captureDraftId)fragment.captureInputDetached=true;delete fragment.localContext;delete fragment.materialSourceSignalId;next.push(fragment);}if(entry.id===draft.capturedEntryId)draft.capturedInputDetached=true;
      }
      draft.body=next;
      (draft.previousSubmissions??=[]).push(draft.submission);delete draft.submission;delete draft.errorCode;
      draft.status='editing';draft.revision++;this.save(draft);return this.view(draft);
    });
  }
  rebase(contextId:string,id:string,body:unknown,operationId:string):QueueEditPage{
    const input=z.object({expectedRevision:z.number().int().positive(),expectedSource:z.object({workspaceId:z.string().min(1),directory:z.object({path:z.string().min(1),dev:z.string().regex(/^\d+$/),ino:z.string().regex(/^\d+$/)}).strict()}).strict()}).strict().parse(body);
    if(!operationId)throw new AppError('operation_id_required');if(this.active.has(id)||this.joining.has(id))throw new AppError('queue_draft_busy',409);
    return this.host.runtime.operation(`queue-edit-rebase:${operationId}`,[contextId,id,input],()=>{
      const source=this.read(contextId,id);if(source.revision!==input.expectedRevision)throw new AppError('revision_conflict',409);if(source.status!=='editing'||source.submission)throw new AppError('queue_reopen_required',409);
      if(!this.host.validateInputSource||!this.host.historicalMaterials)throw new AppError('queue_rebase_unavailable',409);this.host.validateInputSource(contextId,input.expectedSource);
      if(source.rebasedTo)return this.page(contextId,source.rebasedTo);
      const now=new Date().toISOString(),nextId=randomUUID(),owned=(source.previousSubmissions??[]).flatMap(submission=>submission.entries.map(row=>row.signalId)),body:StoredEntry[]=[];
      for(const entry of source.body.filter(row=>!row.removed&&!row.admittedSignalId)){
        const history=this.host.historicalMaterials(contextId,entry,owned),copy:StoredEntry={...structuredClone(entry),id:randomUUID(),sourceSignalIds:[],rebasedFrom:{draftId:id,revision:source.revision,entryId:entry.id,signalIds:history.signalIds},localContext:[entry.localContext,history.content].filter(Boolean).join('\n\n')};
        delete copy.materialSourceSignalId;delete copy.admittedSignalId;delete copy.copiedFrom;if(copy.captureDraftId){copy.captureInputDetached=true;copy.captureInputUnconfirmed=false;}body.push(copy);
        if(!copy.selectedSkillName)copy.clearSkills=true;
        for(const signalId of entry.sourceSignalIds)this.host.runtime.setSetting(`queue-restoration-consumed:${signalId}`,{bySignalId:`rebased:${nextId}`,contextId});entry.removed=true;
      }
      if(!body.some(sendable))throw new AppError('queue_draft_empty',409);
      const draft:StoredDraft={id:nextId,contextId,revision:1,status:'editing',createdAt:now,updatedAt:now,entryCount:body.length,skipped:source.skipped,signature:this.host.signature(contextId),capture:[],body,request:JSON.stringify([id,input])};
      source.rebasedTo=nextId;source.revision++;this.save(source);this.save(draft);return this.page(contextId,nextId);
    });
  }
  logicalSources(contextId:string,runId:string):QueueLogicalSource[]{const result:QueueLogicalSource[]=[];const ids=this.host.runtime.setting<string[]|null>(`queue-edit-run:${runId}`,null);const documents=ids?ids.map(id=>this.read(contextId,id)):this.host.runtime.setting('queue-edit-index-ready',false)?[]:this.host.runtime.queueEditDocuments<StoredDraft>();for(const draft of documents){if(draft.contextId!==contextId)continue;for(const submission of [...(draft.previousSubmissions??[]),...(draft.submission?[draft.submission]:[])]){if(submission.runId!==runId||submission.revision===undefined)continue;const version=draft.versions?.[String(submission.revision)];if(!version)continue;for(const logical of submission.logicalEntries??[]){const entry=version.find(row=>row.id===logical.entryId),receipts=submission.entries.filter(row=>row.entryId===logical.entryId),records=logical.signalIds.map(id=>this.host.signal(id));if(!entry||createHash('sha256').update(entry.content).digest('hex')!==logical.contentHash||JSON.stringify(entry.attachments)!==JSON.stringify(logical.attachmentIds)||JSON.stringify(receipts.map(row=>row.signalId))!==JSON.stringify(logical.signalIds)||new Set(logical.signalIds).size!==logical.signalIds.length||records.some(record=>!record||record.contextId!==contextId)||records.map(record=>record!.content).join('')!==entry.content||JSON.stringify(records.flatMap(record=>record!.attachments??[]))!==JSON.stringify(entry.attachments))throw new AppError('queue_logical_source_mismatch',409);const complete=records.every(record=>record!.action!==null&&record!.runId===runId&&record!.nativeSignalId===record!.id&&['accepted','interrupted'].includes(record!.status));result.push({draftId:draft.id,revision:submission.revision,entryId:entry.id,contextId,runId,signalIds:[...logical.signalIds],contentHash:logical.contentHash,content:entry.content,attachments:[...entry.attachments],sourceSignalIds:[...entry.sourceSignalIds],complete,...(entry.originEntryId?{originEntryId:entry.originEntryId,originRevision:entry.originRevision}:{})});}}}return result;}
  preparedGroups():PreparedQueueGroup[]{const result:PreparedQueueGroup[]=[];for(const draft of this.host.runtime.queueEditDocuments<StoredDraft>()){
    const submission=draft.submission;if(!submission||submission.mode!=='queue'||!['submitting','submitted'].includes(draft.status)||submission.revision===undefined||!submission.leaderSignalId||!submission.logicalEntries?.length)continue;
    const leader=this.host.signal(submission.leaderSignalId),runId=submission.runId??leader?.runId;if(!leader||!runId||leader.contextId!==draft.contextId||leader.id!==leader.nativeSignalId||leader.runId!==runId||!['queued','accepted'].includes(leader.status)||leader.status==='accepted'&&leader.action!=='wake'||leader.status==='queued'&&leader.action!==null)continue;
    try{if(!this.signatureMatches(draft))continue;const version=draft.versions?.[String(submission.revision)];if(!version)continue;
      const ids=submission.entries.map(row=>row.signalId);if(new Set(ids).size!==ids.length||ids[0]!==leader.id)continue;let valid=true;
      for(const logical of submission.logicalEntries){const entry=version.find(row=>row.id===logical.entryId),receipts=submission.entries.filter(row=>row.entryId===logical.entryId),records=logical.signalIds.map(id=>this.host.signal(id));if(!entry||JSON.stringify(receipts.map(row=>row.signalId))!==JSON.stringify(logical.signalIds)||createHash('sha256').update(entry.content).digest('hex')!==logical.contentHash||JSON.stringify(entry.attachments)!==JSON.stringify(logical.attachmentIds)||records.some(record=>!record||record.contextId!==draft.contextId)||records.map(record=>record!.content).join('')!==entry.content||JSON.stringify(records.flatMap(record=>record!.attachments??[]))!==JSON.stringify(entry.attachments)){valid=false;break;}this.host.validateEntry(draft.contextId,entry);
        for(const receipt of receipts){const record=this.host.signal(receipt.signalId)!,part=draft.nativeEntries?.[receipt.signalId];if(!part||part.content!==record.content||JSON.stringify(part.attachments)!==JSON.stringify(record.attachments??[])||record.id!==leader.id&&!(record.status==='received'&&record.action===null&&record.nativeSignalId===null&&record.runId===null||record.status==='accepted'&&record.action==='deliver'&&record.nativeSignalId===record.id&&record.runId===runId)){valid=false;break;}}
      }
      if(valid&&JSON.stringify(submission.logicalEntries.flatMap(row=>row.signalIds))===JSON.stringify(ids))result.push({draftId:draft.id,contextId:draft.contextId,runId,leaderSignalId:leader.id,signalIds:ids,revision:submission.revision});
    }catch{}
  }return result;}
  async recover(){const preparedGroups=new Map(this.preparedGroups().map(group=>[group.draftId,group]));for(const draft of this.host.runtime.queueEditDocuments<StoredDraft>()){
    this.index(draft);
    if(draft.status==='capturing'){try{this.capture(draft);}catch{}}
    if(draft.submission){
      if(draft.status==='blocked'&&!['queue_admission_unknown','core_stopping'].includes(draft.errorCode??''))continue;
      if(draft.submission.runId&&this.host.cancelledBeforeRequest(draft.submission.runId)){draft.status='blocked';draft.errorCode='queue_group_cancelled';this.observe(draft);this.save(draft);continue;}
      try{if(draft.submission.entries.some(row=>['received','queued','interrupted'].includes(this.host.signal(row.signalId)?.status??''))&&!this.signatureMatches(draft)){draft.status='blocked';draft.errorCode=this.signatureError(draft).code;this.observe(draft);this.save(draft);continue;}}catch(error){draft.status='blocked';draft.errorCode=error instanceof AppError?error.code:'queue_source_unverified';this.save(draft);continue;}
      const prepared=preparedGroups.get(draft.id);
      if(prepared){const entry=draft.nativeEntries?.[prepared.leaderSignalId];if(entry){try{if(await this.host.recoverPreparedGroup(prepared,entry))continue;}catch(error){const actual=this.read(draft.contextId,draft.id);actual.status='blocked';actual.errorCode=error instanceof AppError?error.code:'queue_admission_unknown';this.save(actual);continue;}}}
      let unsent=false;
      for(const receipt of draft.submission.entries){const actual=this.host.signal(receipt.signalId);if(actual?.status==='interrupted'&&actual.action===null){receipt.status='pending';unsent=true;}}
      if(unsent||draft.status==='submitting'||draft.status==='blocked'&&['queue_admission_unknown','core_stopping'].includes(draft.errorCode??'')){
        draft.status='submitting';this.save(draft);
        try{await this.submit(draft.contextId,draft.id,{expectedRevision:draft.revision,mode:draft.submission.mode,expectedRunId:draft.submission.expectedRunId},draft.submission.operationId);}catch{}
      }
    }
  }this.host.runtime.setSetting('queue-edit-index-ready',true);}
}
