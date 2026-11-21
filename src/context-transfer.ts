import { z } from 'zod';
import { AppError, contextIdSchema } from './domain.js';
import type { SessionArchive } from './protocol.js';
import {thinkingLevels} from './models.js';
import {parsePiSession,parsePiSessionEntries} from './session-graph.js';
import {isBase64String} from './base64.js';
import {logicalSessionInputSchema} from './logical-session-input.js';
import {parsePortableSessionArtifact,unavailableSessionArtifactSchema} from './session-artifacts.js';

export const MAX_SESSION_ARCHIVE_BYTES = 32 * 1024 * 1024;
const messageSchema = z.object({
  id: z.string().min(1).max(1024), contextId: contextIdSchema,
  role: z.enum(['user', 'assistant', 'event']), content: z.string().max(MAX_SESSION_ARCHIVE_BYTES),
  createdAt: z.iso.datetime({ offset: true }), runId: z.string().max(200).nullable(),
  status: z.string().min(1).max(80), kind: z.enum(['message', 'artifact', 'event', 'control']),
  replyDraftId: z.string().max(200).optional(), originContextId: z.string().max(200).optional(),
  originMessageId: z.string().max(1024).optional(), imported:z.literal(true).optional(), attachments: z.array(z.string().uuid()).max(10000).optional(),
}).strict();
const archiveSchema = z.object({
  format: z.literal('shittimchest-session'), version: z.literal(1),
  context: z.object({ id: contextIdSchema, name: z.string().min(1).max(200), purpose: z.string().max(8000),
    modelProfile: z.string().min(1).max(200), workspaceId: z.string().min(1).max(80), createdAt: z.iso.datetime({ offset: true }),thinkingLevel:z.enum(thinkingLevels).optional(),thinkingPreference:z.enum(thinkingLevels).optional() }).strict(),
  messages: z.array(messageSchema).max(100000),
  continuation:z.object({
    messages:z.array(z.object({id:z.string().min(1).max(1024),role:z.enum(['user','assistant']),createdAt:z.iso.datetime({offset:true}),content:z.object({format:z.literal(2),parts:z.array(z.unknown()).max(10000)}).strict()}).strict()).max(100000),
    publicMessageMap:z.record(z.string().max(1024),z.string().max(1024)),
    checkpoint:z.object({summary:z.string().max(4*1024*1024),summarizedMessages:z.number().int().nonnegative()}).strict().optional(),
    automaticCheckpoint:z.object({signature:z.string().regex(/^[a-f0-9]{64}$/),summary:z.string().max(4*1024*1024),coveredMessages:z.number().int().positive(),prefixHash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime({offset:true})}).strict().optional(),
    assets:z.array(z.object({id:z.string().uuid(),name:z.string().min(1).max(240),mediaType:z.string().max(200),sha256:z.string().regex(/^[a-f0-9]{64}$/),data:z.string().max(24*1024*1024),purpose:z.literal('client-shell-output').optional(),originalAssetIds:z.array(z.string().uuid()).optional()}).strict()).max(10000),
    artifacts:z.array(z.unknown()).optional(),
    unavailableArtifacts:z.array(unavailableSessionArtifactSchema).optional(),
    graph:z.object({header:z.unknown(),leafId:z.string().min(1).max(1024).nullable(),entries:z.array(z.object({entry:z.unknown(),source:z.object({messageId:z.string().min(1).max(1024),messageIds:z.array(z.string().min(1).max(1024)).min(2).max(100000).optional(),logicalInputId:z.string().min(1).max(1024).optional(),partIndexes:z.array(z.number().int().nonnegative()).optional(),projectionIndex:z.number().int().nonnegative().optional(),publicMessageIds:z.array(z.string().min(1).max(1024)).optional(),runId:z.string().nullable().optional(),replayRaw:z.literal(false).optional(),recoveredSignalId:z.string().max(1024).optional(),originalNativeMessageId:z.string().max(1024).optional(),recoveredFromEntryId:z.string().min(1).max(1024).optional(),recoveryId:z.string().min(1).max(1024).optional(),attachmentIds:z.array(z.string().uuid()).max(10000).optional(),attachmentsProjected:z.boolean().optional()}).strict().optional()}).strict()).max(100000),sources:z.array(z.unknown()).max(100000)}).strict().optional(),
  }).strict().optional(),
}).strict();

const continuationSchema=archiveSchema.shape.continuation.unwrap(),graphSchema=continuationSchema.shape.graph.unwrap();
const graphSourceSchema=graphSchema.shape.entries.element.shape.source.unwrap().extend({recoveredFromEntryId:z.string().min(1).max(1024).optional(),recoveryId:z.string().min(1).max(1024).optional()});
const transferredId=z.string().min(1);
const largeGraphEntrySchema=graphSchema.shape.entries.element.extend({source:graphSourceSchema.extend({messageId:transferredId,messageIds:z.array(transferredId).min(2).optional(),publicMessageIds:z.array(transferredId).optional(),originalNativeMessageId:transferredId.optional(),recoveredSignalId:transferredId.optional(),attachmentIds:z.array(z.string().uuid()).optional()}).optional()});
const largeNativeMessageSchema=continuationSchema.shape.messages.element.extend({id:transferredId,content:z.object({format:z.literal(2),parts:z.array(z.unknown())}).strict()});
const largeArchiveSchema=archiveSchema.extend({messages:z.array(messageSchema.extend({id:transferredId,originMessageId:transferredId.optional(),content:z.string(),attachments:z.array(z.string().uuid()).optional()})),continuation:continuationSchema.extend({messages:z.array(largeNativeMessageSchema),publicMessageMap:z.record(transferredId,transferredId),assets:z.array(continuationSchema.shape.assets.element),checkpoint:continuationSchema.shape.checkpoint.unwrap().extend({summary:z.string()}).optional(),automaticCheckpoint:continuationSchema.shape.automaticCheckpoint.unwrap().extend({summary:z.string()}).optional(),graph:graphSchema.extend({entries:z.array(largeGraphEntrySchema),sources:z.array(z.unknown())}).optional()}).optional()});

export function parseSessionArchive(input: unknown,options:{large?:boolean}={}): SessionArchive {
  let serialized: string;
  try { serialized = options.large?'':JSON.stringify(input); } catch { throw new AppError('invalid_session_archive'); }
  if (!options.large&&(typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_SESSION_ARCHIVE_BYTES)) throw new AppError('session_archive_too_large', 413);
  const parsed = (options.large?largeArchiveSchema:archiveSchema).safeParse(input);
  if (!parsed.success) throw new AppError('invalid_session_archive');
  const archive = parsed.data;
  const ids = new Set<string>();
  for (const message of archive.messages) {
    if (message.contextId !== archive.context.id || ids.has(message.id) || !['accepted', 'committed', 'interrupted'].includes(message.status)) throw new AppError('invalid_session_archive');
    ids.add(message.id);
  }
  if(archive.continuation){
    if(archive.continuation.unavailableArtifacts){const ids=new Set<string>((archive.continuation.artifacts??[]).flatMap(row=>row&&typeof row==='object'&&'id'in row&&typeof row.id==='string'?[row.id]:[]));for(const artifact of archive.continuation.unavailableArtifacts){if(ids.has(artifact.id)||!archive.continuation.graph||artifact.entryIds.some(id=>!archive.continuation!.graph!.entries.some(row=>(row.entry as {id?:unknown}).id===id)))throw new AppError('invalid_session_archive');ids.add(artifact.id);}}
    if(archive.continuation.artifacts){const artifacts=archive.continuation.artifacts.map(parsePortableSessionArtifact),ids=new Set<string>();for(const artifact of artifacts){if(ids.has(artifact.id)||!archive.continuation.graph||artifact.entryIds.some(id=>!archive.continuation!.graph!.entries.some(row=>(row.entry as {id?:unknown}).id===id)))throw new AppError('invalid_session_archive');ids.add(artifact.id);}archive.continuation.artifacts=artifacts;}
    if(archive.continuation.graph)for(const row of archive.continuation.graph.entries){if(!row.source?.messageIds&&!row.source?.logicalInputId)continue;const source=row.source;if(!source?.messageIds||!source.logicalInputId||source.messageIds[0]!==source.messageId||new Set(source.messageIds).size!==source.messageIds.length)throw new AppError('invalid_session_archive');const logical=logicalSessionInputSchema.safeParse(archive.continuation.graph.sources.find(value=>value&&typeof value==='object'&&'id'in value&&value.id===source.logicalInputId));if(!logical.success||JSON.stringify(logical.data.nativeMessageIds)!==JSON.stringify(source.messageIds)||source.messageIds.some(id=>!archive.continuation!.graph!.sources.some(value=>value&&typeof value==='object'&&'id'in value&&value.id===id)))throw new AppError('invalid_session_archive');const entry=row.entry as {type?:unknown;message?:{role?:unknown}};if(entry.type!=='message'||entry.message?.role!=='user'||!source.publicMessageIds?.length||source.publicMessageIds.some(id=>{const message=archive.messages.find(message=>message.id===id);return !message||message.role!=='user'||message.content!==logical.data.content||JSON.stringify(message.attachments??[])!==JSON.stringify(logical.data.attachments);}))throw new AppError('invalid_session_archive');}
    if(archive.continuation.graph){const graph=archive.continuation.graph,entries=[graph.header,...graph.entries.map(row=>row.entry)];const parsed=options.large?parsePiSessionEntries(entries,true):parsePiSession(entries.map(row=>JSON.stringify(row)).join('\n'));const entryIds=new Set(parsed.entries.map(row=>row.id));if(graph.leafId!==null&&!entryIds.has(graph.leafId))throw new AppError('invalid_session_archive');const sourceIds=new Set<string>();for(const source of graph.sources){if(!source||typeof source!=='object'||Array.isArray(source)||typeof (source as {id?:unknown}).id!=='string'||sourceIds.has((source as {id:string}).id))throw new AppError('invalid_session_archive');sourceIds.add((source as {id:string}).id);}for(const row of graph.entries)for(const publicId of row.source?.publicMessageIds??[])if(!ids.has(publicId))throw new AppError('invalid_session_archive');}
    const nativeIds=new Set<string>();
    for(const message of archive.continuation.messages){
      if(nativeIds.has(message.id))throw new AppError('invalid_session_archive');nativeIds.add(message.id);
      for(const part of message.content.parts){
        if(!part||typeof part!=='object'||Array.isArray(part))throw new AppError('invalid_session_archive');
        const row=part as Record<string,unknown>;
        if(!['text','tool-invocation','file','image','step-start','source','error'].includes(String(row.type))||Object.keys(row).some(key=>['providerMetadata','providerOptions','signature','thinkingSignature','encrypted_content'].includes(key)))throw new AppError('invalid_session_archive');
        if(row.type==='text'&&typeof row.text!=='string')throw new AppError('invalid_session_archive');
        if(row.type==='image')throw new AppError('session_history_not_portable',409);
        if(row.type==='file'){
          // Native user uploads are embedded bytes. Importing a file/HTTP URL would
          // bypass the ordinary attachment and network boundaries during replay.
          if(typeof row.data!=='string'||!isBase64String(row.data)||typeof row.mimeType!=='string'||!['image/png','image/jpeg','image/webp','image/gif'].includes(row.mimeType)||'url' in row)throw new AppError('invalid_session_archive');
        }
        if(row.type==='tool-invocation'){
          const invocation=row.toolInvocation as Record<string,unknown>|undefined;
          if(!invocation||typeof invocation.toolCallId!=='string'||typeof invocation.toolName!=='string'||!['result','output-error','output-denied'].includes(String(invocation.state)))throw new AppError('invalid_session_archive');
        }
      }
    }
    for(const [publicId,nativeId] of Object.entries(archive.continuation.publicMessageMap))if(!ids.has(publicId)||!nativeIds.has(nativeId))throw new AppError('invalid_session_archive');
    const assetIds=new Set<string>();for(const asset of archive.continuation.assets){if(assetIds.has(asset.id)||!isBase64String(asset.data))throw new AppError('invalid_session_archive');assetIds.add(asset.id);}
    for(const message of archive.messages)for(const asset of message.attachments??[])if(!assetIds.has(asset))throw new AppError('invalid_session_archive');
    for(const record of archive.continuation.graph?.entries??[])for(const asset of record.source?.attachmentIds??[])if(!assetIds.has(asset))throw new AppError('invalid_session_archive');
  }
  return archive as SessionArchive;
}
