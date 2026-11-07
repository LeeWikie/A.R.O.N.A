import {MAX_ASSET_BYTES} from './assets.js';
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
import {rootSchema,mcpSchema} from './capabilities.js';
import { taskLifecycleEventSchema } from './protocol.js';

const integer = (value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = z.coerce.number().int().min(0).max(max).safeParse(value ?? fallback);
  if (!parsed.success) throw new AppError('invalid_query'); return parsed.data;
};
export function createApp(core: Core) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' && c.req.method === 'GET') return next();
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'origin_not_allowed' }, 403);
    const match = /^Bearer (.+)$/i.exec(c.req.header('Authorization') ?? '');
    if (!tokenMatches(match?.[1], core.controlToken)) return c.json({ error: 'authentication_required' }, 401);
    if(c.req.method==='POST'&&c.req.path==='/assets'&&c.req.header('X-ShittimChest-Storage-Id')!==core.storageId)return c.json({error:'storage_changed'},409);
    return next();
  });
  const ordinaryLimit=bodyLimit({maxSize:128*1024,onError:c=>c.json({error:'request_too_large'},413)});
  const assetLimit=bodyLimit({maxSize:MAX_ASSET_BYTES,onError:c=>c.json({error:'asset_too_large'},413)});
  app.use('*',(c,next)=>c.req.method==='POST'&&c.req.path==='/assets'?assetLimit(c,next):ordinaryLimit(c,next));
  app.onError((error, c) => c.json({ error: error instanceof AppError ? error.code : error instanceof z.ZodError ? 'invalid_request' : 'internal_error' }, (error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500) as 400));
  app.notFound(c => c.json({ error: 'not_found' }, 404));
  app.get('/health', c => c.json({ status: 'ok' }));
  app.get('/protocol', c => c.json({ protocolVersion: 1 as const, instanceId: core.instanceId, storageId: core.storageId, capabilities: ['task-lifecycle-pagination','snapshot','event-stream','conversation-history','provider-auth','foreground-interrupt','reply-stream','message-queue','context-branch','web-tools','attachments','file-deliveries','context-capacity'] }));
  const readJSON = async (request: Request) => { try { return await request.json() as unknown; } catch { throw new AppError('invalid_json'); } };
  const operationKey = (request: Request) => {
    const key = request.headers.get('Idempotency-Key'); if (key !== null && !/^[\w.-]{1,128}$/.test(key)) throw new AppError('invalid_operation_id'); return key ? `http:${key}` : undefined;
  };
  app.post('/assets',async c=>c.json(await core.assets.put(c.req.raw.body,c.req.query('name')??'attachment',c.req.raw.signal),201));
  app.get('/assets/:id/metadata',c=>c.json(core.assets.describe(z.string().uuid().parse(c.req.param('id')))));
  app.get('/assets/:id',async c=>{const {metadata,bytes}=await core.assets.read(z.string().uuid().parse(c.req.param('id')),c.req.raw.signal);return new Response(bytes,{headers:{'content-type':metadata.mediaType,'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,'x-content-type-options':'nosniff','cache-control':'no-store'}});});
  app.post('/messages',async c=>c.json(await core.submitMessage(await readJSON(c.req.raw)),202));
  app.get('/contexts/:id/message-queue',c=>c.json(core.queuedMessages(contextIdSchema.parse(c.req.param('id')))));
  app.delete('/messages/:id',async c=>{const body=z.object({revision:z.number().int().positive()}).strict().parse(await readJSON(c.req.raw));return c.json(core.cancelQueuedMessage(z.string().uuid().parse(c.req.param('id')),body.revision));});
  app.patch('/messages/:id',async c=>{const body=z.object({revision:z.number().int().positive(),id:z.string().uuid(),content:z.string().min(1).max(64000)}).strict().parse(await readJSON(c.req.raw));return c.json(await core.replaceQueuedMessage(z.string().uuid().parse(c.req.param('id')),body.revision,body.content,body.id),202);});
  app.get('/snapshot',c=>c.json(snapshot(core,contextIdSchema.parse(c.req.query('contextId')??'main'))));
  app.get('/conversation',c=>c.json(conversationPage(core,contextIdSchema.parse(c.req.query('contextId')??'main'),c.req.query('after'),integer(c.req.query('limit'),60,200))));
  app.get('/event-stream',c=>{const contextId=c.req.query('contextId');if(contextId)contextIdSchema.parse(contextId);return serveEventStream(c,core,integer(c.req.query('after')??c.req.header('Last-Event-ID'),0),contextId);});
  app.get('/event-page',c=>c.json(publicEventPage(core,integer(c.req.query('after'),0),c.req.query('contextId'))));
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
  app.get('/contexts', c => c.json({ contexts: core.runtime.contexts(c.req.query('query') ?? '') }));
  app.post('/contexts', async c => {
    const input = z.object({ id: contextIdSchema.optional(), name: z.string().min(1).max(200), purpose: z.string().max(8000).optional(), workspaceId: z.string().optional(),role:z.enum(['main','work']).optional() }).strict().parse(await readJSON(c.req.raw));
    const {role,...details}=input;return c.json(role==='main'?core.createConversationContext(details):core.createWorkContext(details),201);
  });
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
  app.get('/tasks', c => c.json({ tasks: core.runtime.tasks({ query: c.req.query('query'), contextId: c.req.query('contextId'), status: c.req.query('status') }) }));
  app.post('/tasks', async c => c.json(await core.submitTask(await readJSON(c.req.raw), operationKey(c.req.raw) ?? `http:${randomUUID()}`), 202));
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
  app.get('/tasks/:id', c => c.json(core.taskDetails(c.req.param('id'))));
  app.post('/tasks/:id/messages', async c => {
    const input = z.object({ content: z.string().min(1).max(64000) }).strict().parse(await readJSON(c.req.raw));
    return c.json(await core.taskMessage(c.req.param('id'), input.content, []), 202);
  });
  for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) app.post(`/tasks/:id/${action}`, async c => {
    const input = z.object({ revision: z.number().int().positive() }).strict().parse(await readJSON(c.req.raw));
    return c.json(await core.tasks.control(c.req.param('id'), action, input.revision), 202);
  });
  app.get('/approvals', c => c.json({ approvals: publicApprovals(core) }));
  app.post('/approvals/:id', async c => {
    const input = z.object({ decision: z.enum(['approve', 'decline']), scope: z.enum(['once', 'task', 'duty']).default('once') }).strict().parse(await readJSON(c.req.raw));
    return c.json(await core.approve(c.req.param('id'), input.decision, input.scope));
  });
  app.get('/notifications',c=>c.json({pending:core.runtime.pendingNotifications()}));
  app.post('/notifications/:id/retry',async c=>c.json(await core.retryNotification(c.req.param('id')),202));
  app.get('/models', c => c.json({ models: core.models.list() }));
  app.get('/workspaces', c => c.json({ workspaces: core.capabilities.roots() }));
  app.get('/credentials', c => c.json({ credentials: core.credentials.list() }));
  app.put('/credentials/:name', async c => {
    const input = z.object({ value: z.string().min(1).max(64000) }).strict().parse(await readJSON(c.req.raw));
    return c.json(core.credentials.set(c.req.param('name'), input.value));
  });
  app.delete('/credentials/:name', c => c.json(core.credentials.remove(c.req.param('name'))));
  app.get('/configuration', c => c.json({ models: core.models.list(),modelProfiles:core.models.configurationProfiles(),workspaces: core.capabilities.roots(), mcp: core.capabilities.mcpStatus(),mcpConfigurations:core.capabilities.mcpConfigs(), memoryEnabled: core.memoryEnabled(),runtime:core.configure('runtime',{}),web:core.runtime.setting('web',{type:'none'}),schemas:{web:z.toJSONSchema(webConfigurationSchema),model:z.toJSONSchema(profileSchema),workspace:z.toJSONSchema(rootSchema),mcp:z.toJSONSchema(mcpSchema)} }));
  app.post('/configuration/:kind', async c => {
    const kind = z.enum(['model', 'mcp', 'workspace', 'runtime', 'web']).parse(c.req.param('kind'));
    return c.json(await core.configure(kind, await readJSON(c.req.raw)));
  });
  app.get('/mcp', c => c.json({ servers: core.capabilities.mcpStatus() }));
  for (const action of ['connect', 'reconnect', 'disconnect'] as const) app.post(`/mcp/:id/${action}`, async c => {
    const id = c.req.param('id'); if (action !== 'connect') await core.capabilities.disconnect(id);
    return c.json(action === 'disconnect' ? core.capabilities.mcpStatus() : await core.capabilities.connect(id));
  });
  app.get('/methods', c => c.json({ methods: core.methods.list() }));
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
  app.get('/memory/resident', c => c.json(core.projectMemory.resident()));
  app.post('/memory/requests', async c => {
    const input = z.object({ runId: z.string() }).strict().parse(await readJSON(c.req.raw)); return c.json(await core.queueMemory(input.runId), 202);
  });
  app.post('/memory/jobs/:id/retry', async c => {
    const job = core.projectMemory.jobs().find(x => x.id === c.req.param('id')); if (!job) throw new AppError('memory_job_not_found', 404);
    if (!['failed', 'interrupted'].includes(job.status)) throw new AppError('memory_job_not_retryable', 409); return c.json(await core.queueMemory(job.runId), 202);
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
    return c.json({ outputs, nextCursor: outputs.at(-1)?.seq ?? after });
  });
  app.get('/contexts/:id/history', async c => {
    const id = contextIdSchema.safeParse(c.req.param('id')); if (!id.success) throw new AppError('invalid_context');
    const page = integer(c.req.query('page'), 0), perPage = integer(c.req.query('perPage'), 40, 100); if (!perPage) throw new AppError('invalid_query');
    return c.json(await core.history(id.data, page, perPage));
  });
  return app;
}
