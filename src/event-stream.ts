import {publicToolEvent,toolActivity,redactPublicArgs} from './tool-activity.js';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { Core } from './core.js';
import type { RuntimeEvent, TaskRecord } from './runtime-store.js';
import type { ConversationMessage, ConversationPage, PublicEvent, TuiSnapshot } from './protocol.js';
import type { SignalRecord } from './domain.js';
import { AppError } from './domain.js';

function committedMessage(core: Core, output: import('./domain.js').OutputRecord): ConversationMessage {
  const row = core.store.db.prepare('SELECT tool_call_id FROM outputs WHERE id=?').get(output.id);
  const call = row?.tool_call_id;
  const replyDraftId = typeof call === 'string' && call.startsWith('reply:') ? call.slice(6) : undefined;
  return { id: 'output:' + output.id, contextId: output.contextId, role: 'assistant', content: output.content,
    createdAt: output.createdAt, runId: output.runId, status: 'committed', kind: output.kind,
    ...(replyDraftId ? { replyDraftId } : {}) };
}

/** Public projection is separate from raw model-message and diagnostic storage. */
export function projectEvent(core: Core, event: RuntimeEvent): PublicEvent | undefined {
  const data = event.data as Record<string, unknown> | null;
  const base = { seq: event.seq, contextId: event.contextId, runId: event.runId, createdAt: event.createdAt };
  if (event.kind === 'input' && data) {
    const signal = core.store.getSignal(String(data.id));
    if (signal?.type === 'user-message') return { ...base, kind: 'conversation', data: userMessage(signal) };
    return { ...base, kind: 'state', data: { area: 'inputs' } };
  }
  if (event.kind === 'delivery' && data) {
    const output = core.store.listOutputs({ after: Math.max(0, Number(data.seq) - 1), limit: 1 }).find(row => row.id === data.id);
    if (output) return { ...base, kind: 'conversation', data: committedMessage(core, output) };
  }
  if (event.kind.startsWith('reply.')) return { ...base, kind: event.kind, data };
  if (['agent_start', 'agent_end'].includes(event.kind)) return { ...base, kind: 'run', data: { state: event.kind === 'agent_start' ? 'running' : 'ended', ...(data && ['complete', 'aborted', 'error', 'suspended'].includes(String(data.reason)) ? { reason: data.reason } : {}) } };
  if(event.kind==='capacity_state')return {...base,kind:'capacity',data};
  if(event.kind==='public_tool')return {...base,kind:'tool',data};
  if (['tool_start','tool_end','tool_update'].includes(event.kind)&&data) {
    if(core.store.db.prepare('SELECT 1 FROM runtime_events WHERE event_key=?').get('tool.public:'+event.seq))return undefined;
    return {...base,kind:'tool',data:publicToolEvent(core,event,undefined,true)};
  }
  if (event.kind === 'tool_approval_required') return { ...base, kind: 'state', data: { area: 'approvals' } };
  if (event.kind === 'usage_update') {
    const usage = (data?.usage ?? {}) as Record<string, unknown>; const safe: Record<string, number> = {};
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheCreationInputTokens']) if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) safe[key] = usage[key];
    return { ...base, kind: 'usage', data: safe };
  }
  const areas: Record<string, string> = { task_created: 'tasks', task_state: 'tasks', task_report: 'tasks', task_attempt_requested: 'tasks', context_state: 'contexts', configuration_state: 'configuration', approval_state: 'approvals', notification_state: 'notifications', input_status: 'conversation', message_queue_state:'message-queue', memory_updated: 'memory', method_publication: 'methods' };
  if (areas[event.kind]) return { ...base, kind: 'state', data: { area: areas[event.kind], ...(event.taskId ? { taskId: event.taskId } : {}) } };
  if (['error', 'snapshot_failed', 'task_execution_error', 'native_cleanup_incomplete'].includes(event.kind)) return { ...base, kind: 'error', data: { code: event.kind === 'error' ? 'model_execution_failed' : String(data?.code ?? event.kind) } };
  return undefined;
}

function userMessage(signal: SignalRecord): ConversationMessage {
  return { id: 'signal:' + signal.id, contextId: signal.contextId, role: 'user', content: signal.content, createdAt: signal.createdAt, runId: signal.runId, status: signal.status, kind: signal.source === 'authenticated-control' ? 'control' : 'message',...(signal.attachments?{attachments:signal.attachments}:{}) };
}
function decodeCursor(value: string | undefined): { at: string; id: string } | undefined {
  if (!value) return undefined;
  try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string' || !Number.isFinite(Date.parse(parsed.at))) throw Error(); return parsed; }
  catch { throw new AppError('invalid_history_cursor'); }
}
export function conversationPage(core: Core, contextId: string, after?: string, limit = 60): ConversationPage {
  if (!core.runtime.context(contextId)) throw new AppError('context_not_found', 404);
  const point = decodeCursor(after); const messages: ConversationMessage[] = core.runtime.setting<ConversationMessage[]>(`context-transcript:${contextId}`,[]);
  const rows = core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.contextId')=? AND json_extract(body,'$.type')='user-message'").all(contextId);
  for (const row of rows) { const signal = core.store.getSignal(String(row.id)); if (signal) messages.push(userMessage(signal)); }
  let seq = 0;
  for (;;) {
    const page = core.store.listOutputs({ after: seq, contextId, limit: 500 });
    for (const output of page) messages.push(committedMessage(core, output));
    if (page.length < 500) break; seq = page.at(-1)!.seq;
  }
  const sorted = messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).filter(message => !point || message.createdAt > point.at || (message.createdAt === point.at && message.id > point.id));
  const page = sorted.slice(0, limit); const last = page.at(-1);
  return { messages: page, nextCursor: last ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url') : after ?? null, hasMore: sorted.length > page.length };
}
function safeTask(task: TaskRecord) { const { toolGrants: _, mcpKeys: __, ...visible } = task; return visible; }
function safeArgs(core:Core,value:unknown){return redactPublicArgs(core,value);}
export function activeDrafts(core:Core,contextId:string){
  const drafts=new Map<string,{draftId:string;signalId:string;contextId:string;runId:string;text:string}>();
  const events=core.store.db.prepare("SELECT kind,data FROM runtime_events WHERE context_id=? AND kind LIKE 'reply.%' ORDER BY seq").all(contextId);
  for(const event of events){const value=JSON.parse(String(event.data)) as {draftId:string;signalId:string;contextId:string;runId:string;delta?:string;text?:string};
    if(event.kind==='reply.start')drafts.set(value.draftId,{draftId:value.draftId,signalId:value.signalId,contextId:value.contextId,runId:value.runId,text:''});
    else if(event.kind==='reply.delta'){const draft=drafts.get(value.draftId);if(draft)draft.text+=value.delta??'';}
    else if(event.kind==='reply.replace'){const draft=drafts.get(value.draftId);if(draft)draft.text=value.text??'';}
    else if(event.kind==='reply.commit'||event.kind==='reply.cancel')drafts.delete(value.draftId);
  }
  return [...drafts.values()];
}
/** Approvals as clients may see them: no capability key, secrets redacted from arguments. */
export function publicApprovals(core: Core) { return core.runtime.approvals().map(({ capabilityKey: _, args, ...row }) => ({ ...row, args: safeArgs(core, args) })); }
export function snapshot(core: Core, contextId = 'main'): TuiSnapshot {
  const watermark = core.runtime.eventHead();
  const approvals = publicApprovals(core);
  const runs = core.store.db.prepare('SELECT id FROM runs WHERE context_id=? ORDER BY created_at DESC LIMIT 100').all(contextId).map(row => core.store.getRun(String(row.id))!);
  return { protocolVersion: 1, instanceId: core.instanceId, storageId: core.storageId, watermark, selectedContextId: contextId,queuedMessages:core.queuedMessages(contextId),toolActivity:toolActivity(core,contextId),capacity:core.contextPolicy.view(contextId),drafts:activeDrafts(core,contextId), contexts: core.runtime.contexts(), tasks: core.runtime.tasks().map(safeTask), approvals, conversation: conversationPage(core, contextId), runs, models: core.models.list(), workspaces: core.capabilities.roots(), notifications: core.runtime.pendingNotifications() };
}
export function publicEventPage(core: Core, after: number, contextId?: string, limit = 500) {
  if (after > core.runtime.eventHead()) throw new AppError('event_cursor_out_of_range', 409);
  // Scan the global sequence even with a display filter; filtered seq gaps are not loss.
  const raw = core.runtime.events(undefined, after, limit);
  return { events: raw.map(event=>projectEvent(core,event)).filter((event):event is PublicEvent=>Boolean(event&&(!contextId||event.contextId===contextId||event.kind==='state'))), nextCursor: raw.at(-1)?.seq ?? after, hasMore: raw.length === limit };
}
export function serveEventStream(c: Context, core: Core, after: number, contextId?: string) {
  if (after > core.runtime.eventHead()) throw new AppError('event_cursor_out_of_range', 409);
  return streamSSE(c, async stream => {
    let position = after; let stopped = false; let wake: (() => void) | undefined;
    const notify = () => { const callback = wake; wake = undefined; callback?.(); };
    const unsubscribe = core.runtime.subscribe(notify);
    stream.onAbort(() => { stopped = true; notify(); });
    try {
      while (!stopped) {
        const page = publicEventPage(core, position, contextId);
        for (const event of page.events) await stream.writeSSE({ id: String(event.seq), event: 'event', data: JSON.stringify(event) });
        if (page.nextCursor > position) { position = page.nextCursor; await stream.writeSSE({ id: String(position), event: 'checkpoint', data: JSON.stringify({ cursor: position, storageId: core.storageId, instanceId: core.instanceId }) }); }
        if (page.hasMore) continue;
        if (stopped) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 15000); if (core.runtime.eventHead() > position) notify(); });
        clearTimeout(timer); wake = undefined;
        if (!stopped) await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    } finally { unsubscribe(); }
  });
}
