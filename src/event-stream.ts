import {publicToolEvent,toolActivity,redactPublicArgs} from './tool-activity.js';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { Core } from './core.js';
import type { RuntimeEvent } from './runtime-store.js';
import { publicTask } from './task-view.js';
import type { ConversationMessage, ConversationPage, PublicEvent, TuiSnapshot } from './protocol.js';
import type { SignalRecord } from './domain.js';
import { AppError } from './domain.js';
import {encodeJsonContent} from './json-content-stream.js';
import {approvalDisplay} from './approval-display.js';

function committedMessage(core: Core, output: import('./domain.js').OutputRecord): ConversationMessage {
  const row = core.store.db.prepare('SELECT tool_call_id FROM outputs WHERE id=?').get(output.id);
  const call = row?.tool_call_id;
  const replyDraftId = typeof call === 'string' && call.startsWith('reply:') ? call.slice(6) : undefined;
  return { id: 'output:' + output.id, contextId: output.contextId, role: 'assistant', content: core.runtime.publicOutput(output.id).content,
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
  if (event.kind.startsWith('reply.')) { const safe = core.runtime.publicReply(event.seq); return safe ? { ...base, ...safe } : undefined; }
  if (event.kind === 'public_thinking') {
    const thinking = core.runtime.publicThinking(event.seq);
    return thinking ? { ...base, kind: 'thinking', data: thinking } : undefined;
  }
  // Private/legacy reasoning has no public fallback, even after credential rotation.
  if (event.kind === 'message_update') return undefined;
  if (['agent_start', 'agent_end'].includes(event.kind)) return { ...base, kind: 'run', data: { state: event.kind === 'agent_start' ? 'running' : 'ended', ...(data && ['complete', 'aborted', 'error', 'suspended'].includes(String(data.reason)) ? { reason: data.reason } : {}) } };
  if(event.kind==='capacity_state')return {...base,kind:'capacity',data};
  if(event.kind==='compaction_state'&&data&&['running','finished','failed'].includes(String(data.state))&&['threshold','overflow'].includes(String(data.reason))){
    return {...base,kind:'compaction',data:{state:data.state,automatic:true,reason:data.reason,...(typeof data.coveredMessages==='number'?{coveredMessages:data.coveredMessages}:{}),...(['compaction_cancelled','auto_compaction_failed'].includes(String(data.code))?{code:data.code}:{})}};
  }
  if(event.kind==='public_tool'){const {resultContent:_,...summary}=data??{};return {...base,kind:'tool',data:summary};}
  if (['tool_start','tool_end','tool_update','command_exit','shell_output'].includes(event.kind)&&data) {
    if (event.kind === 'command_exit' && (typeof data.toolCallId !== 'string' || !data.toolCallId || !Number.isInteger(data.exitCode) || typeof data.success !== 'boolean')) return undefined;
    if(core.store.db.prepare('SELECT 1 FROM runtime_events WHERE event_key=?').get('tool.public:'+event.seq))return undefined;
    return {...base,kind:'tool',data:publicToolEvent(core,event,undefined,true)};
  }
  if (event.kind === 'tool_approval_required') return { ...base, kind: 'state', data: { area: 'approvals' } };
  if(['run_recovery_cleanup_failed','run_recovery_resources_released'].includes(event.kind))return {...base,kind:'state',data:{area:'tasks'}};
  if (event.kind === 'usage_update') {
    const usage = (data?.usage ?? {}) as Record<string, unknown>; const safe: Record<string, number> = {};
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheCreationInputTokens']) if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) safe[key] = usage[key];
    return { ...base, kind: 'usage', data: safe };
  }
  const areas: Record<string, string> = { companion_state:'companion', session_transfer_state:'session-transfers', session_tree_state:'session-tree', interaction_state: 'interactions', compaction_state: 'compaction', task_created: 'tasks', task_state: 'tasks', task_report: 'tasks', task_attempt_requested: 'tasks', context_state: 'contexts', configuration_state: 'configuration', approval_state: 'approvals', notification_state: 'notifications', input_status: 'conversation', message_queue_state:'message-queue', memory_updated: 'memory', method_publication: 'methods' };
  if (areas[event.kind]) return { ...base, kind: 'state', data: { area: areas[event.kind], ...(event.taskId ? { taskId: event.taskId } : {}),...(event.kind==='session_tree_state'&&data?.selectedPathChanged===true?{selectedPathChanged:true}:{}) } };
  if (['error', 'snapshot_failed', 'task_execution_error', 'native_cleanup_incomplete'].includes(event.kind)) {
    // Only an application error code (snake_case) is public; provider messages may echo request content.
    const nested = (data?.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>).code : undefined);
    const code = event.kind === 'error' ? (typeof nested === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(nested) ? nested : 'model_execution_failed') : String(data?.code ?? event.kind);
    return { ...base, kind: 'error', data: { code, ...(event.kind === 'error' && typeof data?.retryable === 'boolean' ? { retryable: data.retryable } : {}) } };
  }
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
export function conversationPage(core: Core, contextId: string, after?: string, limit = 60, allBranches = false): ConversationPage {
  if (!core.runtime.context(contextId)) throw new AppError('context_not_found', 404);
  const point = decodeCursor(after); const messages: ConversationMessage[] = core.runtime.setting<ConversationMessage[]>(`context-transcript:${contextId}`,[]).map(message => {
    if (message.role !== 'assistant') return message;
    const origin = !message.imported && message.originMessageId?.startsWith('output:') ? message.originMessageId.slice(7) : undefined;
    return { ...message, content: origin ? core.runtime.publicOutput(origin).content : core.runtime.publicLegacyMessage(`${contextId}:${message.id}`, message.content) };
  });
  const rows = core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.contextId')=? AND json_extract(body,'$.type')='user-message'").all(contextId);
  for (const row of rows) { const signal = core.store.getSignal(String(row.id)); if (signal) messages.push(userMessage(signal)); }
  let seq = 0;
  for (;;) {
    const page = core.store.listOutputs({ after: seq, contextId, limit: 500 });
    for (const output of page) messages.push(committedMessage(core, output));
    if (page.length < 500) break; seq = page.at(-1)!.seq;
  }
  const logical=core.sessionLogicalMessages(contextId,messages);const selected=allBranches?logical:core.sessionConversationMessages(contextId,logical);
  const canonical=!allBranches&&Boolean(core.sessionGraph.head(contextId));const position=point?selected.findIndex(message=>message.id===point.id):-1;
  const sorted = canonical?selected.slice(point&&position>=0?position+1:0):selected.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).filter(message => !point || message.createdAt > point.at || (message.createdAt === point.at && message.id > point.id));
  const page = sorted.slice(0, limit); const last = page.at(-1);
  return { messages: page, nextCursor: last ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url') : after ?? null, hasMore: sorted.length > page.length };
}
function safeArgs(core:Core,value:unknown){return redactPublicArgs(core,value);}
/** History reload uses the same immutable public deltas as event pages and SSE. */
export function contextThinking(core: Core, contextId: string) {
  const rows = core.store.db.prepare("SELECT seq,kind,context_id,run_id,task_id,data,created_at FROM runtime_events WHERE context_id=? AND kind='public_thinking' ORDER BY seq").all(contextId);
  const runs = new Map<string, { runId: string; createdAt: string; text: string }>();
  const selected=typeof core.sessionRunIds==='function'?core.sessionRunIds(contextId):undefined;
  const selectedMessages=typeof core.sessionMessageIds==='function'?core.sessionMessageIds(contextId):undefined;
  for (const row of rows) {
    if(selected&&typeof row.run_id==='string'&&!selected.has(row.run_id))continue;
    const event = projectEvent(core, { seq: Number(row.seq), kind: String(row.kind), contextId: String(row.context_id), runId: row.run_id as string | null, taskId: row.task_id as string | null, data: JSON.parse(String(row.data)), createdAt: String(row.created_at) });
    if (!event || event.kind !== 'thinking' || !event.runId) continue;
    if(selectedMessages&&core.store.getRun(event.runId)?.status!=='running'&&!selectedMessages.has(String((event.data as {messageId:string}).messageId)))continue;
    const entry = runs.get(event.runId) ?? { runId: event.runId, createdAt: event.createdAt, text: '' };
    entry.text += (event.data as { delta: string }).delta; runs.set(event.runId, entry);
  }
  return [...runs.values()];
}
export function activeDrafts(core:Core,contextId:string){
  const drafts=new Map<string,{draftId:string;signalId:string;contextId:string;runId:string;text:string}>();
  const events=core.store.db.prepare("SELECT seq FROM runtime_events WHERE context_id=? AND kind LIKE 'reply.%' ORDER BY seq").all(contextId);
  for(const row of events){const event=core.runtime.publicReply(Number(row.seq));if(!event)continue;const value=event.data as {draftId:string;signalId:string;contextId:string;runId:string;delta?:string;text?:string};
    if(event.kind==='reply.start')drafts.set(value.draftId,{draftId:value.draftId,signalId:value.signalId,contextId:value.contextId,runId:value.runId,text:''});
    else if(event.kind==='reply.delta'){const draft=drafts.get(value.draftId);if(draft)draft.text+=value.delta??'';}
    else if(event.kind==='reply.replace'){const draft=drafts.get(value.draftId);if(draft)draft.text=value.text??'';}
    else if(event.kind==='reply.commit'||event.kind==='reply.cancel')drafts.delete(value.draftId);
  }
  return [...drafts.values()];
}
/** Approvals as clients may see them: no capability key, secrets redacted from arguments. */
export function publicApprovals(core: Core) { return core.runtime.approvals().map(({ capabilityKey: _, args, ...row }) => {const display=approvalDisplay(core,args);return { ...row,args:display.args,...(display.changed?{argsDisplayNotice:'以下为显示用参数：不可见字符已转义，终端控制内容未显示。',...(display.argsText.length<=32000?{argsText:display.argsText}:{})}:{}),allowedScopes: core.approvalScopes({ ...row, args }) };}); }
export function snapshot(core: Core, contextId = 'main',toolResultContent=false): TuiSnapshot {
  const watermark = core.runtime.eventHead();
  const approvals = publicApprovals(core);
  const selectedRuns=core.sessionRunIds(contextId);
  const runs = core.store.db.prepare('SELECT id FROM runs WHERE context_id=? ORDER BY created_at DESC LIMIT 100').all(contextId).map(row => core.store.getRun(String(row.id))!).filter(run=>!selectedRuns||selectedRuns.has(run.id));
  return { protocolVersion: 1, instanceId: core.instanceId, storageId: core.storageId, watermark, selectedContextId: contextId,companion:core.companionRhythm.view(),queuedMessages:core.queuedMessages(contextId),toolActivity:toolActivity(core,contextId,toolResultContent),capacity:core.contextPolicy.view(contextId),drafts:activeDrafts(core,contextId),thinking:contextThinking(core,contextId), contexts: core.runtime.contexts(), tasks: core.runtime.tasks().map(publicTask), approvals, conversation: conversationPage(core, contextId), runs, models: core.models.list(), workspaces: core.capabilities.roots(), notifications: core.runtime.pendingNotifications() };
}
export function publicEventPage(core: Core, after: number, contextId?: string, limit = 500) {
  if (after > core.runtime.eventHead()) throw new AppError('event_cursor_out_of_range', 409);
  // Scan the global sequence even with a display filter; filtered seq gaps are not loss.
  const raw = core.runtime.events(undefined, after, limit);
  return { events: raw.map(event=>projectEvent(core,event)).filter((event):event is PublicEvent=>Boolean(event&&(!contextId||event.contextId===contextId||event.kind==='state'))), nextCursor: raw.at(-1)?.seq ?? after, hasMore: raw.length === limit };
}
export function serveEventStream(c: Context, core: Core, after: number, contextId?: string,contentStream=false) {
  if (after > core.runtime.eventHead()) throw new AppError('event_cursor_out_of_range', 409);
  return streamSSE(c, async stream => {
    let position = after; let stopped = false; let wake: (() => void) | undefined;
    const notify = () => { const callback = wake; wake = undefined; callback?.(); };
    const unsubscribe = core.runtime.subscribe(notify);
    stream.onAbort(() => { stopped = true; notify(); });
    try {
      while (!stopped) {
        const page = publicEventPage(core, position, contextId);
        for (const event of page.events){
          const data=JSON.stringify(event);
          if(data.length<=2*1024*1024-1024)await stream.writeSSE({id:String(event.seq),event:'event',data});
          else if(contentStream){for(const record of encodeJsonContent(event)){if(stopped)break;await stream.writeSSE({event:'event-content',data:record});}}
          else await stream.writeSSE({id:String(event.seq),event:'event',data:JSON.stringify({...event,kind:'state',data:{area:'content',code:'event_content_requires_new_client',sourceKind:event.kind}})});
          if(stopped)break;
        }
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
