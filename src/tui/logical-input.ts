import { randomUUID } from 'node:crypto';
import { AppError } from '../domain.js';
import type { QueueEditDocument, QueueEditPage,QueueInputSource } from '../protocol.js';
import type {RunRecord}from'../domain.js';
import { saveQueueEntry } from './queue-entry-save.js';
import { QueueLocalEdits, type QueueLocalEdit } from './queue-local-edits.js';

export interface LogicalInputIntent {
  id: string; storageId: string; contextId: string; content: string; attachments: string[];
  localContext?: string; selectedSkillName?: string; shellCaptureIds?: string[];
  shellObservations?:Record<string,string>;
  restoredFromSignalIds?:string[];
  expectedSource?:QueueInputSource;
  mode: 'queue' | 'steer'; expectedRunId?: string;
}
export interface LogicalInputHost {
  attachmentParts?:boolean;
  local: QueueLocalEdits;
  request<T>(route: string): Promise<T>;
  write(route: string, body: unknown, method?: string, key?: string): Promise<unknown>;
  validate(): void;
  saved?(intent:LogicalInputIntent):void;
  confirmed?(intent:LogicalInputIntent,draft:QueueEditDocument):void;
}
export function logicalInputAdmitted(draft:QueueEditDocument){const entries=draft.submission?.entries??[],leader=entries.find(value=>value.signalId===draft.submission?.leaderSignalId);return draft.status!=='blocked'&&Boolean(entries.length)&&(!entries.some(value=>value.status==='pending')||leader?.status==='queued');}
export function acknowledgeLogicalInput(host:LogicalInputHost,intent:LogicalInputIntent,draft:QueueEditDocument){
  if(!logicalInputAdmitted(draft))throw new AppError(draft.errorCode??'logical_input_admission_unconfirmed',409);
  host.confirmed?.(intent,draft);
  const address={storageId:intent.storageId,contextId:intent.contextId,draftId:intent.id},acknowledged=host.local.current(address,intent.id);
  if(acknowledged&&acknowledged.content===intent.content&&JSON.stringify(acknowledged.attachments)===JSON.stringify(intent.attachments))host.local.acknowledge(address,intent.id,acknowledged);
  resolveLogicalInputVersions(host.local,intent);
}
export function resolveLogicalInputVersions(local:QueueLocalEdits,intent:LogicalInputIntent){
  const address={storageId:intent.storageId,contextId:intent.contextId,draftId:intent.id};
  for(const version of local.list(address,true)){
    if(JSON.stringify(version.expectedSource)!==JSON.stringify(intent.expectedSource))continue;
    if(JSON.stringify(version.shellObservations??{})!==JSON.stringify(intent.shellObservations??{}))continue;
    const envelope=version.publicationPending?JSON.stringify(intent.attachments.slice(0,version.attachments.length))===JSON.stringify(version.attachments)&&(!version.localContext||intent.localContext===version.localContext||intent.localContext?.startsWith(version.localContext+'\n\n')):JSON.stringify(version.attachments)===JSON.stringify(intent.attachments)&&version.localContext===intent.localContext;
    if(version.entryId===intent.id&&version.content===intent.content&&envelope&&version.selectedSkillName===intent.selectedSkillName&&JSON.stringify(version.restoredFromSignalIds??[])===JSON.stringify(intent.restoredFromSignalIds??[])&&JSON.stringify(version.shellCaptureIds??[])===JSON.stringify(intent.shellCaptureIds??[])&&version.directInput?.mode===intent.mode&&version.directInput.expectedRunId===intent.expectedRunId)local.acknowledgeExactVersion(version);
  }
}

/** One user input is saved as a logical entry, then admitted through the existing native queue. */
export async function submitLogicalInput(host: LogicalInputHost, intent: LogicalInputIntent): Promise<QueueEditDocument> {
  return logicalInput(host,intent,true);
}
export async function saveLogicalInput(host:LogicalInputHost,intent:LogicalInputIntent):Promise<QueueEditDocument>{return logicalInput(host,intent,false);}
async function logicalInput(host:LogicalInputHost,intent:LogicalInputIntent,submit:boolean):Promise<QueueEditDocument>{
  const base = `/contexts/${encodeURIComponent(intent.contextId)}/message-queue/drafts`;
  host.validate();
  const previous = host.local.current({ storageId: intent.storageId, contextId: intent.contextId, draftId: intent.id }, intent.id);
  if(previous&&JSON.stringify(previous.expectedSource)!==JSON.stringify(intent.expectedSource))throw new AppError('logical_input_source_changed',409);
  if(previous&&JSON.stringify(previous.shellObservations??{})!==JSON.stringify(intent.shellObservations??{}))throw new AppError('logical_input_observation_changed',409);
  if(previous&&(previous.content!==intent.content||(!previous.publicationPending&&(JSON.stringify(previous.attachments)!==JSON.stringify(intent.attachments)||previous.localContext!==intent.localContext))||previous.publicationPending&&JSON.stringify(intent.attachments.slice(0,previous.attachments.length))!==JSON.stringify(previous.attachments)||previous.selectedSkillName!==intent.selectedSkillName||JSON.stringify(previous.restoredFromSignalIds??[])!==JSON.stringify(intent.restoredFromSignalIds??[])||JSON.stringify(previous.shellCaptureIds??[])!==JSON.stringify(intent.shellCaptureIds??[])||previous.directInput?.mode!==intent.mode||previous.directInput?.expectedRunId!==intent.expectedRunId))throw new AppError('logical_input_version_conflict',409);
  const local: QueueLocalEdit = host.local.save({
    storageId: intent.storageId, contextId: intent.contextId, draftId: intent.id, entryId: intent.id,
    baseRevision: previous?.baseRevision ?? 1, base: previous?.base ?? { id: intent.id, content: '', attachments: [], sourceSignalIds: [], removed: false },
    ...(previous?.localId ? { localId: previous.localId } : {}), content: intent.content, attachments: intent.attachments,
    ...(intent.localContext !== undefined ? { localContext: intent.localContext } : {}), ...(intent.selectedSkillName ? { selectedSkillName: intent.selectedSkillName } : {}),
    ...(intent.shellCaptureIds?.length ? { shellCaptureIds: intent.shellCaptureIds } : {}),
    ...(intent.shellObservations?{shellObservations:intent.shellObservations}:{}),
    ...(intent.restoredFromSignalIds?.length?{restoredFromSignalIds:intent.restoredFromSignalIds}:{}),
    ...(intent.expectedSource?{expectedSource:intent.expectedSource}:{}),
    directInput: { mode: intent.mode, ...(intent.expectedRunId ? { expectedRunId: intent.expectedRunId } : {}) },
    provisional: true,localOnly:true, captureQueue: false, updatedAt: new Date().toISOString(),
  });
  host.saved?.(intent);
  let draft = await host.write(base, { current: { content: '', attachments: [], clientDraftId: intent.id, ...(intent.selectedSkillName ? { selectedSkillName: intent.selectedSkillName } : {}),...(intent.restoredFromSignalIds?.length?{restoredFromSignalIds:intent.restoredFromSignalIds}:{}) }, localCapture: true, captureQueue: false,...(intent.expectedSource?{expectedSource:intent.expectedSource}:{}) }, 'POST', intent.id) as QueueEditDocument;
  host.validate();
  const capture = draft.captures?.find(row => row.draftId === intent.id);
  const entryId = capture?.entryId ?? (draft.capturedDraftId === intent.id ? draft.capturedEntryId : undefined);
  if (!entryId) throw new AppError('logical_input_capture_changed', 409);
  const route = `${base}/${encodeURIComponent(draft.id)}`;
  const page = await host.request<QueueEditPage>(`${route}?limit=50`);
  host.validate();
  const entry = page.entries.find(value => value.id === entryId);
  if (!entry || entry.selectedSkillName !== intent.selectedSkillName||entry.clearSkills) throw new AppError('logical_input_version_conflict', 409);
  const same = entry.content === intent.content && JSON.stringify(entry.attachments) === JSON.stringify(intent.attachments);
  if (!same && (draft.status !== 'editing' || !(capture?.unconfirmed ?? draft.capturedInputUnconfirmed))) throw new AppError('logical_input_version_conflict', 409);
  if (draft.status === 'editing' && (!same || capture?.unconfirmed || draft.capturedInputUnconfirmed)) {
    const pending = previous?.pending ?? { operationId: randomUUID(), baseRevision: draft.revision, content: intent.content, attachments: [...intent.attachments], captureDraftId: intent.id, ...(intent.localContext !== undefined ? { localContext: intent.localContext } : {}) };
    const saving = host.local.save({ ...local, pending });
    draft = await saveQueueEntry(host, route, entryId, pending);
    host.validate();
    // Keep the immutable input until native admission is confirmed, including a lost submit ACK.
    host.local.save({ ...saving, pending: undefined, baseRevision: draft.revision });
  }
  if(!submit)return draft;
  if (!logicalInputAdmitted(draft)) {
    const existing=draft.submission,mode=existing?.mode??intent.mode,expectedRunId=existing?.expectedRunId??(existing?undefined:intent.expectedRunId),operation=`${intent.id}.${existing?'reconcile':'submit'}`;
    try{draft = await host.write(`${route}/submit`, { expectedRevision: draft.revision, mode, ...(expectedRunId ? { expectedRunId } : {}) }, 'POST', operation) as QueueEditDocument;}
    catch(error){
      if(existing||mode!=='steer'||!expectedRunId||!(error instanceof AppError)||error.code!=='run_changed'||error.status!==409)throw error;
      const run=await host.request<RunRecord>(`/runs/${encodeURIComponent(expectedRunId)}`),latest=await host.request<QueueEditPage>(`${route}?limit=50`);host.validate();
      if(run.contextId!==intent.contextId||run.status==='running'||latest.draft.submission||latest.draft.status!=='editing'||latest.draft.revision!==draft.revision)throw error;
      draft=await host.write(`${route}/submit`,{expectedRevision:latest.draft.revision,mode:'queue'},'POST',`${intent.id}.idle-submit`) as QueueEditDocument;
    }
    host.validate();
  }
  acknowledgeLogicalInput(host,intent,draft);
  return draft;
}
