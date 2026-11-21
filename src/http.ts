import {MAX_ASSET_BYTES} from './assets.js';
import {MAX_INTERACTION_ANSWER_REQUEST_BYTES} from './interactions.js';
import {appBuildInfo} from './version.js';
import {MAX_SESSION_ARCHIVE_BYTES} from './context-transfer.js';
import { companionConfigurationSchema } from './companion-rhythm.js';
import { interactionReference } from './interaction-reference.js';
import {JSON_CONTENT_MEDIA_TYPE,jsonContentResponse} from './json-content-stream.js';
import {legacyConversationPage,legacySnapshot,LEGACY_RESPONSE_CHARACTERS} from './legacy-response.js';
import {webConfigurationSchema} from './web/index.js';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {interruptForeground} from './control.js';
import {snapshot,conversationPage,publicEventPage,serveEventStream,publicApprovals} from './event-stream.js';
import {workflowCatalog} from './workflows.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Core } from './core.js';
import { AppError, contextIdSchema } from './domain.js';
import { tokenMatches } from './credentials.js';
import { thinkingLevels,profileSchema } from './models.js';
import { modelCatalog,testModel } from './model-probe.js';
import {rootSchema,mcpSchema} from './capabilities.js';
import { taskLifecycleEventSchema,toolResultIdentitySchema } from './protocol.js';
import { publicTask } from './task-view.js';
import {redactPublicArgs} from './tool-activity.js';
import { publicMemoryVersion, publicMemoryVersionDiff, publicMemoryEntry, publicMemoryRunView } from './memory/v1/public-view.js';
import { publicMemoryJob } from './memory/job-view.js';
import { MemoryImportError } from './memory/v1/import.js';
import { publicTaskHistoryDetails, projectHostToolResult } from './history-projection.js';

const integer = (value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = z.coerce.number().int().min(0).max(max).safeParse(value ?? fallback);
  if (!parsed.success) throw new AppError('invalid_query'); return parsed.data;
};
export function createApp(core: Core) {
  const app = new Hono();
  const respond=(request:Request,value:unknown)=>request.headers.get('Accept')?.includes(JSON_CONTENT_MEDIA_TYPE)?jsonContentResponse(value):Response.json(value);
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' && c.req.method === 'GET') return next();
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'origin_not_allowed' }, 403);
    const match = /^Bearer (.+)$/i.exec(c.req.header('Authorization') ?? '');
    if (!tokenMatches(match?.[1], core.controlToken)) return c.json({ error: 'authentication_required' }, 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const storage = c.req.header('X-ShittimChest-Storage-Id');
      const instance = c.req.header('X-ShittimChest-Instance-Id');
      if (storage && storage !== core.storageId) return c.json({ error: 'core_storage_changed' }, 409);
      if (instance && instance !== core.instanceId) return c.json({ error: 'core_instance_changed' }, 409);
    }
    if(c.req.method==='POST'&&c.req.path==='/assets'&&c.req.header('X-ShittimChest-Storage-Id')!==core.storageId)return c.json({error:'storage_changed'},409);
    if(c.req.path.startsWith('/session-transfers')&&c.req.header('X-ShittimChest-Storage-Id')!==core.storageId)return c.json({error:'storage_changed'},409);
    if(/^\/contexts\/[^/]+\/(?:project-directory|path-completions|tool-result)$/.test(c.req.path)){
      if(c.req.header('X-ShittimChest-Storage-Id')!==core.storageId)return c.json({error:'core_storage_changed'},409);
      const instance=c.req.header('X-ShittimChest-Instance-Id');if(instance&&instance!==core.instanceId)return c.json({error:'core_instance_changed'},409);
    }
    return next();
  });
  const ordinaryLimit=bodyLimit({maxSize:512*1024,onError:c=>c.json({error:'request_too_large'},413)});
  const assetLimit=bodyLimit({maxSize:MAX_ASSET_BYTES,onError:c=>c.json({error:'asset_too_large'},413)});
  const sessionLimit=bodyLimit({maxSize:MAX_SESSION_ARCHIVE_BYTES+4096,onError:c=>c.json({error:'session_archive_too_large'},413)});
  const piSessionLimit=bodyLimit({maxSize:2*MAX_SESSION_ARCHIVE_BYTES+4096,onError:c=>c.json({error:'session_archive_too_large'},413)});
  const interactionAnswerLimit=bodyLimit({maxSize:MAX_INTERACTION_ANSWER_REQUEST_BYTES,onError:c=>c.json({error:'request_too_large'},413)});
  app.use('*',(c,next)=>c.req.method==='POST'&&c.req.path==='/assets'?assetLimit(c,next):c.req.method==='POST'&&c.req.path==='/contexts/import'?sessionLimit(c,next):c.req.method==='POST'&&c.req.path==='/contexts/import-pi'?piSessionLimit(c,next):c.req.method==='POST'&&/^\/interactions\/[^/]+\/(?:answer|answer-outbox|answer-receipt)$/.test(c.req.path)?interactionAnswerLimit(c,next):ordinaryLimit(c,next));
  app.onError((error, c) => c.json({ error: error instanceof AppError ? error.code : error instanceof MemoryImportError ? error.message : error instanceof z.ZodError ? 'invalid_request' : 'internal_error' }, (error instanceof AppError ? error.status : error instanceof z.ZodError || error instanceof MemoryImportError ? 400 : 500) as 400));
  app.notFound(c => c.json({ error: 'not_found' }, 404));
  app.get('/health', c => c.json({ status: 'ok' }));
  app.get('/version',c=>c.json(appBuildInfo));
  app.get('/protocol', c => c.json({ protocolVersion: 1 as const, instanceId: core.instanceId, storageId: core.storageId, capabilities: ['task-lifecycle-pagination','snapshot','event-stream','conversation-history','message-source-text','provider-auth','foreground-interrupt','reply-stream','message-queue','context-branch','context-clone','context-transfer','context-continuation','context-fork-message','interactive-tools','context-compaction','automatic-context-compaction','workspace-skills','workspace-skill-invoke','mcp-oauth','mcp-resources','mcp-prompts','web-tools','attachments','file-deliveries','context-capacity','memory-v1','model-thinking-state','model-request-auth','message-queue-withdraw','app-build-info','native-run-recovery','native-run-resource-cleanup','context-tree','session-browser','pi-session-import','session-transfer-stream','session-user-assets','session-provenance','response-content-stream','tool-result-content','tool-result-lookup','message-queue-editor','logical-input','queue-entry-attachment-parts','input-draft-review','interaction-answer-outbox','interaction-answer-receipt-lookup','interaction-reference','companion-state','workspace-directory-listing','workspace-recursive-find','workspace-byte-reads','workspace-batch-edits','workspace-native-search','terminal-project-sessions','project-path-completion','terminal-processes','terminal-process-recovery','terminal-pipe-stdin-eof',...(process.platform==='win32'?[]:['terminal-pty-eof-key'])] }));
  const readJSON = async (request: Request) => { try { return await request.json() as unknown; } catch { throw new AppError('invalid_json'); } };
  const operationKey = (request: Request) => {
    const key = request.headers.get('Idempotency-Key'); if (key !== null && !/^[\w.-]{1,128}$/.test(key)) throw new AppError('invalid_operation_id'); return key ? `http:${key}` : undefined;
  };
  app.post('/terminal/sessions', async c => c.json(core.terminalSessions().open(await readJSON(c.req.raw), operationKey(c.req.raw) ?? ''), 201));
  app.get('/terminal/sessions/operations/:id', c => c.json(core.terminalSessions().get(`http:${c.req.param('id')}`)));
  app.get('/contexts/:id/project-directory',c=>c.json(core.projectDirectory(contextIdSchema.parse(c.req.param('id')))));
  app.post('/contexts/:id/path-completions',async c=>c.json(await core.projectPathSuggestions(contextIdSchema.parse(c.req.param('id')),await readJSON(c.req.raw),c.req.raw.signal)));
  app.get('/companion', c => c.json(core.companionRhythm.view()));
  app.get('/runs/:id/recovery-cleanup',c=>{const row=core.recoveryCleanup(z.string().min(1).max(200).parse(c.req.param('id')));if(!row)throw new AppError('run_recovery_cleanup_not_found',404);return c.json(row);});
  app.post('/runs/:id/recovery-cleanup',async c=>c.json(await core.retryRecoveryCleanup(z.string().min(1).max(200).parse(c.req.param('id')))));
  app.put('/companion', async c => {
    const body = z.object({ expectedRevision: z.number().int().nonnegative(), configuration: companionConfigurationSchema }).strict().parse(await readJSON(c.req.raw));
    const key = operationKey(c.req.raw);
    return c.json(core.configureCompanion(body.configuration,body.expectedRevision,key));
  });
  app.post('/assets',async c=>{
    const purpose=z.literal('client-shell-output').optional().parse(c.req.query('purpose'));
    const id=z.string().uuid().optional().parse(c.req.query('id')),sha256=z.string().regex(/^[a-f0-9]{64}$/).optional().parse(c.req.query('sha256')),bytes=z.coerce.number().int().positive().max(MAX_ASSET_BYTES).optional().parse(c.req.query('bytes'));
    if((id||sha256||bytes)&&(!purpose||!id||!sha256||bytes===undefined))throw new AppError('invalid_asset_options');
    return c.json(await core.assets.put(c.req.raw.body,c.req.query('name')??'attachment',c.req.raw.signal,{...(purpose?{purpose}:{}),...(id?{id,sha256,bytes}:{})}),201);
  });
  app.get('/assets/:id/metadata',c=>c.json(core.assets.describe(z.string().uuid().parse(c.req.param('id')))));
  app.get('/assets/:id',async c=>{const {metadata,bytes}=await core.assets.read(z.string().uuid().parse(c.req.param('id')),c.req.raw.signal);return new Response(bytes,{headers:{'content-type':metadata.mediaType,'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,'x-content-type-options':'nosniff','cache-control':'no-store'}});});
  app.post('/messages',async c=>c.json(await core.submitMessage(await readJSON(c.req.raw)),202));
  app.get('/contexts/:id/message-queue',c=>{const id=contextIdSchema.parse(c.req.param('id'));return c.json(c.req.query('view')==='summary'?core.queuedMessageSummary(id):core.queuedMessages(id));});
  app.post('/contexts/:id/message-queue/withdraw',async c=>{const body=z.object({entries:z.array(z.object({id:z.string().uuid(),revision:z.number().int().positive()}).strict()).min(1).max(64)}).strict().parse(await readJSON(c.req.raw));const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.withdrawQueuedMessages(contextIdSchema.parse(c.req.param('id')),body.entries,key));});
  app.get('/contexts/:id/message-queue/withdrawals',c=>c.json({operations:core.queueWithdrawalReceipts(contextIdSchema.parse(c.req.param('id')))}));
  app.get('/contexts/:id/message-queue/drafts',c=>c.json({drafts:core.queueEditor().list(contextIdSchema.parse(c.req.param('id')),c.req.query('includeRetained')==='1')}));
  app.post('/contexts/:id/message-queue/drafts',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().create(contextIdSchema.parse(c.req.param('id')),await readJSON(c.req.raw),key));});
  app.get('/contexts/:id/message-queue/drafts/:draftId',c=>c.json(core.queueEditor().page(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),integer(c.req.query('cursor'),0),integer(c.req.query('limit'),20,50))));
  app.patch('/contexts/:id/message-queue/drafts/:draftId',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().mutate(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),await readJSON(c.req.raw),key));});
  app.post('/contexts/:id/message-queue/drafts/:draftId/submit',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(await core.queueEditor().submit(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),await readJSON(c.req.raw),key),202);});
  app.post('/contexts/:id/message-queue/drafts/:draftId/reopen',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().reopen(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),await readJSON(c.req.raw),key));});
  app.post('/contexts/:id/message-queue/drafts/:draftId/rebase',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().rebase(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),await readJSON(c.req.raw),key));});
  app.post('/contexts/:id/message-queue/drafts/:draftId/versions',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().copyVersion(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),await readJSON(c.req.raw),key));});
  app.get('/contexts/:id/message-queue/drafts/:draftId/retained-versions',c=>c.json({versions:core.queueEditor().retainedVersions(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')))}));
  app.post('/contexts/:id/message-queue/drafts/:draftId/retained-versions',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().retainVersion(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),await readJSON(c.req.raw),key));});
  app.post('/contexts/:id/message-queue/drafts/:draftId/retained-versions/:versionId/restore',c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().restoreRetainedVersion(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),z.string().uuid().parse(c.req.param('versionId')),key));});
  app.post('/contexts/:id/message-queue/drafts/:draftId/entry-edits',async c=>{const key=operationKey(c.req.raw);if(!key)throw new AppError('operation_id_required');return c.json(core.queueEditor().beginEntryEdit(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),await readJSON(c.req.raw),key));});
  app.get('/contexts/:id/message-queue/drafts/:draftId/entry-edits/:editId',c=>c.json(core.queueEditor().entryEdit(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),z.string().uuid().parse(c.req.param('editId')))));
  app.put('/contexts/:id/message-queue/drafts/:draftId/entry-edits/:editId/parts/:part',async c=>c.json(core.queueEditor().writeEntryPart(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),z.string().uuid().parse(c.req.param('editId')),z.coerce.number().int().nonnegative().parse(c.req.param('part')),await readJSON(c.req.raw))));
  app.put('/contexts/:id/message-queue/drafts/:draftId/entry-edits/:editId/context-parts/:part',async c=>c.json(core.queueEditor().writeEntryPart(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),z.string().uuid().parse(c.req.param('editId')),z.coerce.number().int().nonnegative().parse(c.req.param('part')),await readJSON(c.req.raw),'context')));
  app.put('/contexts/:id/message-queue/drafts/:draftId/entry-edits/:editId/attachment-parts/:part',async c=>c.json(core.queueEditor().writeEntryPart(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),z.string().uuid().parse(c.req.param('editId')),z.coerce.number().int().nonnegative().parse(c.req.param('part')),await readJSON(c.req.raw),'attachments')));
  app.post('/contexts/:id/message-queue/drafts/:draftId/entry-edits/:editId/commit',c=>c.json(core.queueEditor().commitEntryEdit(contextIdSchema.parse(c.req.param('id')),z.string().uuid().parse(c.req.param('draftId')),z.string().uuid().parse(c.req.param('editId')))));
  app.delete('/messages/:id',async c=>{const body=z.object({revision:z.number().int().positive()}).strict().parse(await readJSON(c.req.raw));return c.json(core.cancelQueuedMessage(z.string().uuid().parse(c.req.param('id')),body.revision));});
  app.patch('/messages/:id',async c=>{const body=z.object({revision:z.number().int().positive(),id:z.string().uuid(),content:z.string().min(1).max(64000)}).strict().parse(await readJSON(c.req.raw));return c.json(await core.replaceQueuedMessage(z.string().uuid().parse(c.req.param('id')),body.revision,body.content,body.id),202);});
  app.get('/snapshot',c=>{const value=snapshot(core,contextIdSchema.parse(c.req.query('contextId')??'main'),c.req.query('toolResultContent')==='1');return respond(c.req.raw,c.req.header('Accept')?.includes(JSON_CONTENT_MEDIA_TYPE)?value:legacySnapshot(value));});
  app.get('/conversation',c=>{const value=conversationPage(core,contextIdSchema.parse(c.req.query('contextId')??'main'),c.req.query('after'),integer(c.req.query('limit'),60,200));return respond(c.req.raw,c.req.header('Accept')?.includes(JSON_CONTENT_MEDIA_TYPE)?value:legacyConversationPage(value));});
  app.get('/conversation/messages/:messageId',c=>{const contextId=contextIdSchema.parse(c.req.query('contextId')??'main'),id=c.req.param('messageId');let after:string|undefined;for(;;){const page=conversationPage(core,contextId,after,200),message=page.messages.find(row=>row.id===id);if(message){if(!c.req.header('Accept')?.includes(JSON_CONTENT_MEDIA_TYPE)&&JSON.stringify(message).length>=LEGACY_RESPONSE_CHARACTERS)throw new AppError('conversation_requires_stream',413);return respond(c.req.raw,message);}if(!page.hasMore||!page.nextCursor)throw new AppError('message_not_found',404);after=page.nextCursor;}});
  app.get('/event-stream',c=>{const contextId=c.req.query('contextId');if(contextId)contextIdSchema.parse(contextId);return serveEventStream(c,core,integer(c.req.query('after')??c.req.header('Last-Event-ID'),0),contextId,c.req.query('contentStream')==='1');});
  app.get('/event-page',c=>respond(c.req.raw,publicEventPage(core,integer(c.req.query('after'),0),c.req.query('contextId'))));
  app.get('/auth/providers',c=>c.json({providers:core.auth.providers()}));
  app.get('/auth/status/:id',async c=>c.json(await core.auth.status(c.req.param('id'))));
  app.post('/auth/:id/start',async c=>{const input=z.object({type:z.enum(['oauth','api_key'])}).strict().parse(await readJSON(c.req.raw));return c.json(core.auth.start(c.req.param('id'),input.type),202);});
  app.get('/auth/jobs/:id',c=>c.json(core.auth.get(c.req.param('id'))));
  app.post('/auth/jobs/:id/respond',async c=>{const input=z.object({value:z.string().max(64000),promptId:z.string().uuid()}).strict().parse(await readJSON(c.req.raw));return c.json(core.auth.respond(c.req.param('id'),input.value,input.promptId));});
  app.delete('/auth/jobs/:id',c=>c.json(core.auth.cancel(c.req.param('id'))));
  app.delete('/auth/providers/:id',async c=>{await core.providerRegistry.logout(c.req.param('id'));return c.json({removed:true});});
  app.get('/provider-models',c=>c.json({models:core.providerRegistry.getModels(c.req.query('provider')).map(model=>({providerId:model.provider,modelId:model.id,name:model.name,api:model.api,contextWindow:model.contextWindow,maxTokens:model.maxTokens,reasoning:model.reasoning,thinkingLevels:getSupportedThinkingLevels(model),input:model.input}))}));
  app.post('/contexts/:id/interrupt',async c=>{const input=z.object({expectedRunId:z.string().min(1).max(200)}).strict().parse(await readJSON(c.req.raw));return c.json(await interruptForeground(core,contextIdSchema.parse(c.req.param('id')),input.expectedRunId),202);});
  app.get('/contexts/:id/capacity',c=>{const id=contextIdSchema.parse(c.req.param('id'));if(!core.runtime.context(id))throw new AppError('context_not_found',404);return c.json({capacity:core.contextPolicy.view(id)});});
  app.get('/contexts/:id/tool-result',c=>respond(c.req.raw,core.contextToolResult(contextIdSchema.parse(c.req.param('id')),toolResultIdentitySchema.parse({runId:c.req.query('runId')??null,toolCallId:c.req.query('toolCallId'),nativeMessageId:c.req.query('nativeMessageId'),entryId:c.req.query('entryId')}))));
  app.get('/contexts', c => c.json({ contexts: core.runtime.contexts(c.req.query('query') ?? '') }));
  app.get('/sessions',async c=>respond(c.req.raw,await core.browseSessions({workspaceId:c.req.query('workspaceId'),scope:z.enum(['current','all']).optional().parse(c.req.query('scope')),includeArchived:c.req.query('includeArchived')==='1',cursor:c.req.query('cursor'),limit:integer(c.req.query('limit'),50,200)})));
  app.get('/contexts/:id/tree',async c=>respond(c.req.raw,await core.sessionTree(contextIdSchema.parse(c.req.param('id')))));
  app.post('/contexts/:id/tree/navigate',async c=>{const input=z.object({targetId:z.string().min(1).max(1024).nullable(),summarize:z.boolean().optional(),customInstructions:z.string().max(64000).optional(),replaceInstructions:z.boolean().optional(),expectedRevision:z.number().int().nonnegative().optional(),expectedLeafId:z.string().min(1).max(1024).nullable().optional()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.navigateSession(contextIdSchema.parse(c.req.param('id')),input,operationKey(c.req.raw),c.req.raw.signal));});
  app.patch('/contexts/:id/tree/:entryId/label',async c=>{const input=z.object({label:z.string().max(200).nullable(),expectedRevision:z.number().int().nonnegative().optional()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.labelSessionEntry(contextIdSchema.parse(c.req.param('id')),c.req.param('entryId'),input.label,input.expectedRevision,operationKey(c.req.raw)));});
  app.get('/contexts/:id/export-pi',async c=>c.json(await core.exportPiContext(contextIdSchema.parse(c.req.param('id')),c.req.query('continuation')==='1')));
  app.get('/session-transfers',c=>c.json(core.sessionTransfers().list(c.req.query('after'),integer(c.req.query('limit'),50,100))));
  app.post('/session-transfers/import',async c=>c.json({transfer:core.sessionTransfers().createImport(await readJSON(c.req.raw),operationKey(c.req.raw)??'')},202));
  app.post('/session-transfers/export',async c=>c.json({transfer:await core.sessionTransfers().createExport(await readJSON(c.req.raw),operationKey(c.req.raw)??'')},202));
  app.get('/session-transfers/:id',c=>c.json({transfer:core.sessionTransfers().get(c.req.param('id'))}));
  app.get('/session-transfers/:id/parts',c=>c.json(core.sessionTransfers().parts(c.req.param('id'),z.coerce.number().int().min(-1).parse(c.req.query('after')??-1),integer(c.req.query('limit'),100,100))));
  app.put('/session-transfers/:id/parts/:index',async c=>c.json({transfer:core.sessionTransfers().putPart(c.req.param('id'),integer(c.req.param('index'),0),new Uint8Array(await c.req.arrayBuffer()),c.req.header('X-Content-SHA256')??'')}));
  app.get('/session-transfers/:id/parts/:index',c=>{const part=core.sessionTransfers().downloadPart(c.req.param('id'),integer(c.req.param('index'),0));return new Response(new Uint8Array(part.bytes),{headers:{'content-type':'application/octet-stream','content-length':String(part.bytes.length),'X-Content-SHA256':part.sha256}});});
  app.post('/session-transfers/:id/commit',async c=>{z.object({}).strict().parse(await readJSON(c.req.raw));return c.json({transfer:core.sessionTransfers().commit(c.req.param('id'))},202);});
  app.post('/session-transfers/:id/retry',async c=>{z.object({}).strict().parse(await readJSON(c.req.raw));return c.json({transfer:core.sessionTransfers().retry(c.req.param('id'))},202);});
  app.post('/session-transfers/:id/acknowledge',async c=>{const body=z.object({sha256:z.string()}).strict().parse(await readJSON(c.req.raw));return c.json({transfer:core.sessionTransfers().acknowledge(c.req.param('id'),body.sha256)});});
  app.delete('/session-transfers/:id',c=>c.json({transfer:core.sessionTransfers().cancel(c.req.param('id'))},202));
  app.post('/contexts/import-pi',async c=>{const input=z.object({jsonl:z.string().min(1),id:contextIdSchema.optional(),name:z.string().min(1).max(200).optional(),workspaceId:z.string().min(1).max(80).optional(),modelProfile:z.string().min(1).max(80).optional()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.importPiContext(input,operationKey(c.req.raw)),201);});
  app.post('/contexts', async c => {
    const input = z.object({ id: contextIdSchema.optional(), name: z.string().min(1).max(200), purpose: z.string().max(8000).optional(), workspaceId: z.string().optional(),modelProfile:z.string().min(1).max(80).optional(),role:z.enum(['main','work']).optional() }).strict().parse(await readJSON(c.req.raw));
    const {role,...details}=input;return c.json(role==='main'?core.createConversationContext(details):core.createWorkContext(details),201);
  });
  app.get('/contexts/:id/export',async c=>{const id=contextIdSchema.parse(c.req.param('id'));return c.json(c.req.query('continuation')==='1'?await core.exportContinuationContext(id):core.exportContext(id));});
  app.post('/contexts/import',async c=>{const body=z.object({archive:z.unknown(),id:contextIdSchema.optional(),name:z.string().min(1).max(200).optional(),workspaceId:z.string().min(1).max(80).optional()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.importContext(body,operationKey(c.req.raw)),201);});
  app.post('/contexts/:id/clone',async c=>{const body=z.object({id:contextIdSchema.optional(),name:z.string().min(1).max(200).optional()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.cloneContext(contextIdSchema.parse(c.req.param('id')),body,operationKey(c.req.raw)),201);});
  app.post('/contexts/:id/fork',async c=>{const body=z.object({sourceMessageId:z.string().min(1).max(1024).optional(),sourceEntryId:z.string().min(1).max(1024).optional(),id:contextIdSchema.optional(),name:z.string().min(1).max(200).optional()}).strict().refine(value=>Boolean(value.sourceMessageId)!==Boolean(value.sourceEntryId)).parse(await readJSON(c.req.raw));const {sourceMessageId,sourceEntryId,...options}=body;const id=contextIdSchema.parse(c.req.param('id'));return c.json(sourceEntryId?await core.forkSessionEntry(id,sourceEntryId,options,operationKey(c.req.raw)):await core.forkContext(id,sourceMessageId!,options,operationKey(c.req.raw)),201);});
  app.get('/contexts/:id/skills',async c=>{const context=core.runtime.context(contextIdSchema.parse(c.req.param('id')));if(!context)throw new AppError('context_not_found',404);return c.json({skills:await core.capabilities.listSkills(context),diagnostics:await core.capabilities.skillDiagnostics(context)});});
  app.get('/contexts/:id/skills/:name',async c=>{const context=core.runtime.context(contextIdSchema.parse(c.req.param('id')));if(!context)throw new AppError('context_not_found',404);return c.json(await core.capabilities.getSkill(context,c.req.param('name')));});
  app.patch('/contexts/:id/skills/:name',async c=>{const context=core.runtime.context(contextIdSchema.parse(c.req.param('id')));if(!context)throw new AppError('context_not_found',404);const body=z.object({enabled:z.boolean()}).strict().parse(await readJSON(c.req.raw));const skills=await core.capabilities.setSkillEnabled(context,c.req.param('name'),body.enabled);core.runtime.event({contextId:'main',kind:'configuration_state',data:{key:'workspace-skills'}});return c.json({skills});});
  app.get('/contexts/:id/skill-sources',c=>{const context=core.runtime.context(contextIdSchema.parse(c.req.param('id')));if(!context)throw new AppError('context_not_found',404);return c.json({sources:core.capabilities.skillSources(context)});});
  for(const method of ['post','delete'] as const)app[method]('/contexts/:id/skill-sources',async c=>{const context=core.runtime.context(contextIdSchema.parse(c.req.param('id')));if(!context)throw new AppError('context_not_found',404);const body=z.object({path:z.string().min(1).max(1024)}).strict().parse(await readJSON(c.req.raw));const skills=method==='post'?await core.capabilities.addSkillSource(context,body.path):await core.capabilities.removeSkillSource(context,body.path);core.runtime.event({contextId:'main',kind:'configuration_state',data:{key:'workspace-skills'}});return c.json({sources:core.capabilities.skillSources(context),skills});});
  app.post('/contexts/:id/skills/:name/invoke',async c=>{const body=z.object({id:z.string().uuid().optional(),content:z.string().max(64000).default(''),sourceText:z.string().min(1).max(64000).optional(),attachments:z.array(z.string().uuid()).max(8).optional(),restoredFromSignalIds:z.array(z.string().uuid()).min(1).max(64).optional(),mode:z.enum(['queue','steer']).optional(),expectedRunId:z.string().min(1).max(200).optional()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.invokeSkill(contextIdSchema.parse(c.req.param('id')),c.req.param('name'),body,operationKey(c.req.raw)),202);});
  app.post('/contexts/:id/compact',async c=>{const body=z.object({id:contextIdSchema.optional(),name:z.string().min(1).max(200).optional(),keepRecentTokens:z.number().int().min(1000).max(200000).optional(),instructions:z.string().max(64000).optional(),inPlace:z.boolean().optional()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.compactContext(contextIdSchema.parse(c.req.param('id')),body,c.req.raw.signal),201);});
  app.post('/contexts/:id/branch',async c=>{const body=z.object({id:contextIdSchema.optional(),sourceRunId:z.string().uuid(),fromRunId:z.string().uuid().optional(),name:z.string().min(1).max(200)}).strict().parse(await readJSON(c.req.raw));return c.json(await core.branchContext(contextIdSchema.parse(c.req.param('id')),body.sourceRunId,body.name,body.id,body.fromRunId),201);});
  app.patch('/contexts/:id', async c => {
    const input = z.object({ name: z.string().min(1).max(200).optional(), purpose: z.string().max(8000).optional(), archived: z.boolean().optional() }).strict().parse(await readJSON(c.req.raw));
    if (input.archived !== undefined) core.archiveContext(c.req.param('id'), input.archived);
    return c.json(core.runtime.updateContext(c.req.param('id'), input));
  });
  app.get('/contexts/:id/model', async c => c.json(await core.modelState(contextIdSchema.parse(c.req.param('id')))));
  app.post('/contexts/:id/model', async c => {
    const input = z.object({ profileId: z.string(), thinkingLevel: z.enum(thinkingLevels).nullable().optional() }).strict().parse(await readJSON(c.req.raw));
    return c.json(await core.switchModel(c.req.param('id'), input.profileId, input.thinkingLevel));
  });
  app.get('/tasks', c => c.json({ tasks: core.runtime.tasks({ query: c.req.query('query'), contextId: c.req.query('contextId'), status: c.req.query('status') }).map(publicTask) }));
  app.post('/tasks', async c => c.json(publicTask(await core.submitTask(await readJSON(c.req.raw), operationKey(c.req.raw) ?? `http:${randomUUID()}`)), 202));
  app.get('/tasks/:id/deliveries/:index',async c=>{const item=await core.readDelivery(z.string().uuid().parse(c.req.param('id')),integer(c.req.param('index'),0),c.req.raw.signal,z.coerce.number().int().positive().parse(c.req.query('revision')));return new Response(new Uint8Array(item.bytes),{headers:{'content-type':'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,'x-content-sha256':item.sha256,'x-content-type-options':'nosniff','cache-control':'no-store'}});});
  app.get('/tasks/:id/events', c => {
    const after = integer(c.req.query('after'), 0);
    const limit = integer(c.req.query('limit'), 100, 999);
    if (!limit) throw new AppError('invalid_query');
    const rows = core.runtime.taskEvents(c.req.param('id'), after, limit + 1, true);
    const events = rows.slice(0, limit).map(row => {
      const data = row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : {};
      const reason = z.enum(['complete', 'aborted', 'error', 'suspended']).safeParse(data.reason);
      return taskLifecycleEventSchema.parse({ seq: row.seq, contextId: row.contextId, runId: row.runId,
        kind: row.kind, ...(row.kind === 'agent_end' && reason.success ? { reason: reason.data } : {}), createdAt: row.createdAt });
    });
    return c.json({ events, nextCursor: events.at(-1)?.seq ?? after, hasMore: rows.length > limit });
  });
  app.get('/tasks/:id', c => c.json(publicTaskHistoryDetails(core.taskDetails(c.req.param('id')))));
  app.post('/tasks/:id/messages', async c => {
    const input = z.object({ content: z.string().min(1).max(64000) }).strict().parse(await readJSON(c.req.raw));
    return c.json(projectHostToolResult('task_message', await core.taskMessage(c.req.param('id'), input.content, [])), 202);
  });
  for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) app.post(`/tasks/:id/${action}`, async c => {
    const input = z.object({ revision: z.number().int().positive() }).strict().parse(await readJSON(c.req.raw));
    return c.json(publicTask(await core.tasks.control(c.req.param('id'), action, input.revision)), 202);
  });
  app.get('/approvals', c => c.json({ approvals: publicApprovals(core) }));
  app.post('/approvals/:id', async c => {
    const input = z.object({ decision: z.enum(['approve', 'decline']), scope: z.enum(['once', 'task', 'duty']).default('once') }).strict().parse(await readJSON(c.req.raw));
    return c.json(await core.approve(c.req.param('id'), input.decision, input.scope));
  });
  app.get('/interactions',c=>c.json({interactions:core.interactions(c.req.query('contextId'))}));
  app.get('/interactions/:id/reference',c=>c.json(interactionReference(core,c.req.param('id'),z.string().min(1).max(200).parse(c.req.query('expectedRunId')))));
  app.get('/interaction-answers',c=>{const active=z.enum(['0','1']).optional().parse(c.req.query('active'));return c.json(core.interactionAnswerPage({contextId:c.req.query('contextId'),after:integer(c.req.query('after'),0),limit:integer(c.req.query('limit'),100,2000),active:active==='1'}));});
  app.get('/interaction-answers/:id',c=>c.json({answer:core.interactionAnswer(c.req.param('id'))}));
  app.post('/interactions/:id/answer-receipt',async c=>{const body=z.object({expectedRunId:z.string().min(1).max(200),answer:z.unknown()}).strict().parse(await readJSON(c.req.raw));return c.json({answer:core.lookupInteractionAnswer(c.req.param('id'),body.expectedRunId,body.answer)});});
  app.post('/interactions/:id/answer-outbox',async c=>{const body=z.object({expectedRunId:z.string().min(1).max(200),answer:z.unknown()}).strict().parse(await readJSON(c.req.raw));return c.json({answer:await core.saveInteractionAnswer(c.req.param('id'),body.expectedRunId,body.answer)},202);});
  app.post('/interaction-answers/:id/retry',async c=>{const body=z.object({expectedRunId:z.string().min(1).max(200)}).strict().parse(await readJSON(c.req.raw));return c.json({answer:await core.retryInteractionAnswer(c.req.param('id'),body.expectedRunId)},202);});
  app.post('/interactions/:id/answer',async c=>{const body=z.object({expectedRunId:z.string().min(1).max(200),answer:z.unknown()}).strict().parse(await readJSON(c.req.raw));return c.json(await core.answerInteraction(c.req.param('id'),body.expectedRunId,body.answer),202);});
  app.post('/interactions/:id/cancel',async c=>{const body=z.object({expectedRunId:z.string().min(1).max(200)}).strict().parse(await readJSON(c.req.raw));return c.json(await core.cancelInteraction(c.req.param('id'),body.expectedRunId),202);});
  app.post('/mcp/:id/auth',async c=>c.json(await core.capabilities.startMcpAuth(c.req.param('id')),202));
  app.get('/mcp-auth/jobs/:id',c=>c.json(core.capabilities.mcpAuthJob(c.req.param('id'))));
  app.delete('/mcp-auth/jobs/:id',async c=>c.json(await core.capabilities.cancelMcpAuth(c.req.param('id'))));
  app.post('/mcp/:id/logout',async c=>c.json(await core.capabilities.logoutMcp(c.req.param('id'))));
  app.get('/mcp/:id/resources',async c=>c.json(redactPublicArgs(core,await core.capabilities.mcpResources(c.req.param('id')))));
  app.get('/mcp/:id/resource-templates',async c=>{const result=await core.capabilities.mcpResources(c.req.param('id'));return c.json(redactPublicArgs(core,{templates:result.templates}));});
  app.post('/mcp/:id/resources/read',async c=>{const body=z.object({uri:z.string().min(1).max(16000)}).strict().parse(await readJSON(c.req.raw));return c.json(redactPublicArgs(core,await core.capabilities.readMcpResource(c.req.param('id'),body.uri)));});
  app.post('/mcp/:id/resource-templates/read',async c=>{const body=z.object({uriTemplate:z.string().min(1).max(16000),variables:z.record(z.string().max(200),z.string().max(64000)).default({})}).strict().parse(await readJSON(c.req.raw));return c.json(redactPublicArgs(core,await core.capabilities.readMcpResourceTemplate(c.req.param('id'),body.uriTemplate,body.variables)));});
  app.get('/mcp/:id/prompts',async c=>c.json(redactPublicArgs(core,{prompts:await core.capabilities.mcpPrompts(c.req.param('id'))})));
  app.post('/mcp/:id/prompts/:name',async c=>{const body=z.object({args:z.record(z.string().max(200),z.string().max(64000)).optional()}).strict().parse(await readJSON(c.req.raw));return c.json(redactPublicArgs(core,await core.capabilities.getMcpPrompt(c.req.param('id'),c.req.param('name'),body.args)));});
  app.get('/notifications',c=>c.json({pending:core.runtime.pendingNotifications()}));
  app.post('/notifications/:id/retry',async c=>c.json(await core.retryNotification(c.req.param('id')),202));
  app.get('/models', c => {const models=core.models.list();return c.json({models,thinking:Object.fromEntries(models.map(profile=>[profile.id,core.models.thinking(profile.id)]))});});
  app.post('/models/catalog',async c=>c.json(await modelCatalog(await readJSON(c.req.raw),core.credentials,c.req.raw.signal)));
  app.post('/models/test',async c=>c.json(await testModel(await readJSON(c.req.raw),core.credentials,c.req.raw.signal)));
  app.get('/workspaces', c => c.json({ workspaces: core.capabilities.roots() }));
  app.patch('/workspaces/:id', async c => c.json(await core.updateWorkspace(c.req.param('id'), await readJSON(c.req.raw))));
  app.delete('/workspaces/:id', c => c.json(core.capabilities.removeRoot(c.req.param('id'))));
  app.get('/credentials', c => c.json({ credentials: core.credentials.list() }));
  app.put('/credentials/:name', async c => {
    const input = z.object({ value: z.string().min(1).max(64000) }).strict().parse(await readJSON(c.req.raw));
    return c.json(core.credentials.set(c.req.param('name'), input.value));
  });
  app.delete('/credentials/:name', c => c.json(core.credentials.remove(c.req.param('name'))));
  app.get('/configuration', c => c.json({ models: core.models.list(),modelProfiles:core.models.configurationProfiles(),workspaces: core.capabilities.roots(), mcp: core.capabilities.mcpStatus(),mcpConfigurations:core.capabilities.mcpConfigs(), memoryEnabled: core.memoryEnabled(),runtime:core.configure('runtime',{}),web:core.webConfiguration(),webProviders:redactPublicArgs(core,core.webProviders()),schemas:{web:z.toJSONSchema(webConfigurationSchema),model:z.toJSONSchema(profileSchema),workspace:z.toJSONSchema(rootSchema),mcp:z.toJSONSchema(mcpSchema)} }));
  app.post('/configuration/:kind', async c => {
    const kind = z.enum(['model', 'mcp', 'workspace', 'runtime', 'web']).parse(c.req.param('kind'));
    return c.json(await core.configure(kind, await readJSON(c.req.raw)));
  });
  app.get('/mcp', c => c.json({ servers: core.capabilities.mcpStatus() }));
  app.delete('/mcp/:id', async c => c.json(await core.capabilities.removeMCP(c.req.param('id'))));
  for (const action of ['connect', 'reconnect', 'disconnect'] as const) app.post(`/mcp/:id/${action}`, async c => {
    const id = c.req.param('id'); if (action !== 'connect') await core.capabilities.disconnect(id);
    return c.json(action === 'disconnect' ? core.capabilities.mcpStatus() : await core.capabilities.connect(id));
  });
  app.get('/methods', c => c.json({ methods: core.methods.list() }));
  app.get('/methods/:name/revisions', c => c.json({ revisions: core.methods.revisions(c.req.param('name')) }));
  app.get('/methods/:name', c => c.json(core.methods.get(c.req.param('name'))));
  app.post('/methods', async c => {
    const input = z.object({ method: z.unknown(), revision: z.number().int().positive().optional() }).strict().parse(await readJSON(c.req.raw));
    return c.json(core.methods.save(input.method, input.revision), 201);
  });
  app.post('/methods/:name/control', async c => {
    const input = z.object({ revision: z.number().int().positive(), enabled: z.boolean() }).strict().parse(await readJSON(c.req.raw));
    return c.json(core.methods.control(c.req.param('name'), input.enabled, input.revision));
  });
  app.post('/methods/:name/rollback', async c => {
    const input = z.object({ revision: z.number().int().positive(), restoreRevision: z.number().int().positive() }).strict().parse(await readJSON(c.req.raw));
    return c.json(core.methods.rollback(c.req.param('name'), input.restoreRevision, input.revision));
  });
  app.get('/workflows', c => c.json({ workflows: workflowCatalog }));
  app.post('/workflows/:id/run', async c => {
    const input=z.object({contextId:contextIdSchema,input:z.record(z.string(),z.unknown())}).strict().parse(await readJSON(c.req.raw));
    return c.json(await core.runWorkflow(c.req.param('id'),input.input,input.contextId));
  });
  app.get('/memory', c => c.json({ enabled: core.memoryEnabled(), ...core.projectMemory.status() }));
  app.get('/memory/context', c => c.json(core.memoryV1Status()));
  app.post('/memory/reconcile', async c => c.json(await core.reconcileMemoryV1()));
  app.post('/memory/imports', async c => c.json(await core.importMemory(await readJSON(c.req.raw), c.req.raw.signal), 201));
  app.get('/memory/versions', c => c.json({ versions: core.projectMemory.v1Versions() }));
  app.get('/memory/versions/:id', c => c.json(publicMemoryVersion(core.projectMemory.readV1Version(c.req.param('id')))));
  app.get('/memory/versions/:id/entries/:entry', c => {
    const version = core.projectMemory.readV1Version(c.req.param('id'));
    const entry = version.workspace.candidate.entries.find(row => row.id === c.req.param('entry'));
    if (!entry) throw new AppError('memory_entry_not_found', 404);
    return c.json({ entry: publicMemoryEntry(entry), details: entry.format === 'reviewed' ? version.details.filter(detail => entry.detailRefs.includes(detail.id)) : [] });
  });
  app.get('/memory/diff', c => {
    const from = z.string().min(1).parse(c.req.query('from')), to = z.string().min(1).parse(c.req.query('to'));
    return c.json(publicMemoryVersionDiff(core.projectMemory.readV1Version(from), core.projectMemory.readV1Version(to)));
  });
  app.get('/memory/runs/:id/view', c => c.json({ view: publicMemoryRunView(core.memoryV1RunView(c.req.param('id'))) }));
  app.get('/memory/issues', c => { const status = core.memoryV1Status(); return c.json({ pendingRecords: status.pendingRecords, intake: status.intake, jobs: core.projectMemory.unresolvedJobs().map(publicMemoryJob) }); });
  app.post('/memory/recovery/plans', async c => {
    const body = z.object({ targetVersionId: z.string().min(1), expectedHead: z.string().min(1) }).strict().parse(await readJSON(c.req.raw));
    const key = operationKey(c.req.raw) ?? `http:${randomUUID()}`;
    return c.json(core.runtime.operation(key, ['memory-recovery-plan', body], () => core.planMemoryV1Recovery(body.targetVersionId, body.expectedHead)), 201);
  });
  app.post('/memory/recovery/plans/:id/execute', async c => {
    z.object({}).strict().parse(await readJSON(c.req.raw));
    return c.json(publicMemoryJob(await core.executeMemoryV1Recovery(z.string().uuid().parse(c.req.param('id')))), 202);
  });
  app.get('/memory/resident', c => c.json(core.projectMemory.resident()));
  app.post('/memory/requests', async c => {
    const input = z.object({ runId: z.string() }).strict().parse(await readJSON(c.req.raw)); return c.json(publicMemoryJob(await core.queueMemory(input.runId)), 202);
  });
  app.post('/memory/jobs/:id/retry', async c => {
    const job = core.projectMemory.jobs().find(x => x.id === c.req.param('id')); if (!job) throw new AppError('memory_job_not_found', 404);
    if (!['failed', 'interrupted'].includes(job.status)) throw new AppError('memory_job_not_retryable', 409); return c.json(publicMemoryJob(await core.queueMemory(job.runId, true)), 202);
  });
  app.get('/events', c => c.json({ events: core.runtime.events(c.req.query('contextId'), integer(c.req.query('after'), 0), integer(c.req.query('limit'), 100, 1000)) }));
  app.get('/usage', c => c.json(core.usage(c.req.query('contextId'))));
  app.get('/schedules', c => {
    const contextId = c.req.query('contextId'); if (contextId && !contextIdSchema.safeParse(contextId).success) throw new AppError('invalid_context');
    return c.json({ ...core.schedules.now(), schedules: core.schedules.list(contextId) });
  });
  app.get('/schedules/:id', c => c.json(core.schedules.get(c.req.param('id'))));
  app.post('/schedules', async c => {
    const body = await readJSON(c.req.raw); const key = operationKey(c.req.raw);
    if (body && typeof body === 'object' && 'version' in body && body.version === 2) return c.json(core.scheduleCreate(body, key ?? `http:${randomUUID()}`, 'main'), 201);
    return c.json(core.schedules.create(body, key), 201);
  });
  app.patch('/schedules/:id', async c => c.json(core.schedules.update(c.req.param('id'), await readJSON(c.req.raw), operationKey(c.req.raw))));
  for (const action of ['pause', 'resume', 'cancel'] as const) app.post(`/schedules/:id/${action}`, async c => {
    const input = z.object({ revision: z.number().int().positive() }).strict().parse(await readJSON(c.req.raw));
    return c.json(core.schedules.control(c.req.param('id'), action, input.revision, operationKey(c.req.raw)));
  });
  app.post('/schedules/:id/run', async c => c.json(await core.schedules.run(c.req.param('id'), operationKey(c.req.raw)), 202));
  app.get('/schedules/:id/occurrences', c => {
    const offset = integer(c.req.query('offset'), 0), limit = integer(c.req.query('limit'), 40, 100); if (!limit) throw new AppError('invalid_query');
    const occurrences = core.schedules.occurrences(c.req.param('id'), offset, limit); return c.json({ occurrences, nextOffset: offset + occurrences.length });
  });
  app.post('/signals', async c => c.json(await core.submitSignal(await readJSON(c.req.raw)), 202));
  app.get('/signals/:id', c => { const record = core.store.getSignal(c.req.param('id')); if (!record) throw new AppError('signal_not_found', 404); return c.json(record); });
  app.get('/runs/:id', c => { const record = core.store.getRun(c.req.param('id')); if (!record) throw new AppError('run_not_found', 404); return c.json(record); });
  app.get('/outputs', c => {
    const kind = c.req.query('kind'); if (kind && kind !== 'message' && kind !== 'artifact') throw new AppError('invalid_output_kind');
    const contextId = c.req.query('contextId'); if (contextId && !contextIdSchema.safeParse(contextId).success) throw new AppError('invalid_context');
    const after = integer(c.req.query('after'), 0); const outputs = core.store.listOutputs({ after, kind: kind === 'message' || kind === 'artifact' ? kind : undefined, contextId, limit: 100 });
    return c.json({ outputs: outputs.map(output => ({ ...output, ...core.runtime.publicOutput(output.id) })), nextCursor: outputs.at(-1)?.seq ?? after });
  });
  app.get('/contexts/:id/history', async c => {
    const id = contextIdSchema.safeParse(c.req.param('id')); if (!id.success) throw new AppError('invalid_context');
    const page = integer(c.req.query('page'), 0), perPage = integer(c.req.query('perPage'), 40, 100); if (!perPage) throw new AppError('invalid_query');
    return c.json(await core.history(id.data, page, perPage));
  });
  return app;
}
