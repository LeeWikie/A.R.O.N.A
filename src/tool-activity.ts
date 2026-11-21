import type {Core} from './core.js';
import type {RuntimeEvent} from './runtime-store.js';
import {redactPublicArgs} from './public-args.js';
export {redactPublicArgs} from './public-args.js';
import {publicArgumentDisplay} from './approval-display.js';
import { publicToolOutput, toolOutputState } from './tool-output.js';
import {toolResultFailed} from './tool-result-status.js';
import type {ToolResultIdentity} from './protocol.js';
import {isBase64String} from './base64.js';


function argsView(core:Core,value:unknown,secrets?:readonly string[]){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const allowed=new Set(['signalIds','id','contextId','parentId','title','path','paths','directory','command','description','query','url','pattern','modelId','profileId','action','revision','scope','name','workspaceId','recursive','maxChars','mode','timeout']);
  const result:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value)){
    if(allowed.has(key)){const text=JSON.stringify(publicArgumentDisplay(core,item,secrets).args);if(text===undefined)continue;result[key]=text.length>16000?{truncated:true,characters:text.length}:JSON.parse(text);}
    else if(typeof item==='string')result[key]={type:'text',characters:item.length};
    else if(Array.isArray(item))result[key]={type:'array',items:item.length};
    else if(item!==null&&typeof item==='object')result[key]={type:'object'};
  }
  const displayed=publicArgumentDisplay(core,result,secrets).args;return displayed&&typeof displayed==='object'&&!Array.isArray(displayed)?displayed as Record<string,unknown>:{unavailable:true};
}
export function publicToolArgs(core:Core,value:unknown){return argsView(core,value);}
function summary(value:unknown){
  if(typeof value==='string')return {type:'text',characters:value.length,lines:value.split('\n').length};
  if(Array.isArray(value))return {type:'array',items:value.length};
  if(value&&typeof value==='object'){
    const result:Record<string,unknown>={type:'object'};const row=value as Record<string,unknown>;
    for(const key of ['bytes','size','count','exitCode','durationMs','truncated'])if(typeof row[key]==='boolean'||(typeof row[key]==='number'&&Number.isFinite(row[key])))result[key]=row[key];
    if(typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256))result.sha256=row.sha256;
    return result;
  }
  return {type:value===null?'null':typeof value};
}
/** Mastra reports validation and execution failures as a `{ error: true }` result rather than isError. */
type ToolData = Record<string, unknown>;
function eventData(value: unknown): ToolData {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ToolData : {};
}
function commandExit(value: unknown): { exitCode: number; success: boolean } | undefined {
  const row = eventData(value);
  if (typeof row.exitCode !== 'number' || !Number.isInteger(row.exitCode) || typeof row.success !== 'boolean') return undefined;
  return { exitCode: row.exitCode, success: row.success };
}
/** Terminal evidence is monotonic and uses the same precedence for pages and snapshots. */
function terminalState(previous: unknown, next: unknown, exitCode?: unknown) {
  if (previous === 'denied' || next === 'denied') return 'denied';
  if (previous === 'failed' || next === 'failed' || (typeof exitCode === 'number' && exitCode !== 0)) return 'failed';
  if (previous === 'finished' || next === 'finished' || typeof exitCode === 'number') return 'finished';
  return 'running';
}
/** Project only structured command-exit evidence; output text is never an exit-code source. */
export function publicToolEvent(core: Core, event: RuntimeEvent, secrets?: readonly string[], legacy = false) {
  const data = eventData(event.data);
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
  const nativeMessageId=typeof core.toolMessageId==='function'?core.toolMessageId(event.contextId,event.runId,toolCallId,event.seq+1):undefined;
  const sourceRow=nativeMessageId?core.store.db.prepare("SELECT MIN(seq) AS seq FROM runtime_events WHERE context_id=? AND run_id IS ? AND seq<=? AND ((kind='message_start' AND json_extract(data,'$.message.id')=?) OR (kind='tool_input_start' AND json_extract(data,'$.messageId')=?))").get(event.contextId,event.runId,event.seq,nativeMessageId,nativeMessageId):undefined;
  const firstSeq=Number(sourceRow?.seq??0);
  const lookup = (kind: string, order = 'DESC') => {
    const previous = core.store.db.prepare(`SELECT data FROM runtime_events WHERE context_id=? AND run_id IS ? AND kind=? AND json_extract(data,'$.toolCallId')=? AND seq>=? AND seq<=? ORDER BY seq ${order} LIMIT 1`).get(event.contextId, event.runId, kind, toolCallId,firstSeq, event.seq);
    return previous ? eventData(JSON.parse(String(previous.data))) : undefined;
  };
  const start = event.kind === 'tool_start' ? data : lookup('tool_start');
  const end = event.kind === 'tool_end' ? data : lookup('tool_end');
  const evidence = (kind: string) => core.store.db.prepare("SELECT data FROM runtime_events WHERE context_id=? AND run_id IS ? AND kind=? AND json_extract(data,'$.toolCallId')=? AND seq>=? AND seq<=? ORDER BY seq").all(event.contextId, event.runId, kind, toolCallId,firstSeq, event.seq).map(row => eventData(JSON.parse(String(row.data))));
  // Ignore malformed notifications before selecting the first durable, valid exit.
  const exit = evidence('command_exit').map(commandExit).find(item => item !== undefined) ?? (event.kind === 'command_exit' ? commandExit(data) : undefined);
  const name = start?.toolName ?? data.toolName;
  const endState = (row: ToolData) => row.denied === true ? 'denied' : row.isError === true || toolResultFailed(typeof name==='string'?name:'',row.result) ? 'failed' : 'finished';
  let state = evidence('tool_end').reduce<string>((previous, row) => terminalState(previous, endState(row)), 'running');
  if (end) state = terminalState(state, endState(end));
  state = terminalState(state, exit ? exit.exitCode !== 0 || !exit.success ? 'failed' : 'finished' : 'running', exit?.exitCode);
  const projection = !legacy && typeof name === 'string' ? toolOutputState(core, event, name) : undefined;
  if (projection) secrets = projection.secrets;
  const resultSummary = end ? summary(end.result) : undefined;
  const publishedResult = !legacy ? core.store.db.prepare("SELECT p.data FROM runtime_events p JOIN runtime_events r ON p.event_key='tool.public:'||r.seq WHERE r.context_id=? AND r.run_id IS ? AND r.kind='tool_end' AND json_extract(r.data,'$.toolCallId')=? AND r.seq>=? AND p.seq<? ORDER BY p.seq LIMIT 1").get(event.contextId, event.runId, toolCallId,firstSeq, event.seq) : undefined;
  const savedBody = publishedResult ? eventData(JSON.parse(String(publishedResult.data))) as ReturnType<typeof publicToolOutput> : undefined;
  const body = savedBody ? { ...(savedBody.output ? { output: savedBody.output } : {}), ...(savedBody.diff ? { diff: savedBody.diff } : {}) } : projection && typeof name === 'string'
    ? publicToolOutput(core, name, start?.args, end?.result, secrets, Boolean(end) && state === 'finished')
    : {};
  const publishedStart = !legacy && event.kind !== 'tool_start' ? core.store.db.prepare("SELECT p.data FROM runtime_events p JOIN runtime_events r ON p.event_key='tool.public:'||r.seq WHERE r.context_id=? AND r.run_id IS ? AND r.kind='tool_start' AND json_extract(r.data,'$.toolCallId')=? AND r.seq>=? AND p.seq<? ORDER BY p.seq LIMIT 1").get(event.contextId, event.runId, toolCallId,firstSeq, event.seq) : undefined;
  const savedArgs = publishedStart ? eventData(JSON.parse(String(publishedStart.data))).args : undefined;
  let resultContent:Array<{type:'text';text:string}|{type:'image';mimeType:string;data:string}>|undefined;
  if(!legacy&&event.kind==='tool_end'&&typeof name==='string'&&typeof core.publicToolModelOutput==='function')try{
    const output=eventData(core.publicToolModelOutput(event.contextId,event.runId,name,data.result));
    if(output.type==='content'&&Array.isArray(output.value)&&output.value.some(part=>eventData(part).type==='media')){
      const converted=output.value.map(value=>{const part=eventData(value);if(part.type==='text'&&typeof part.text==='string')return{type:'text' as const,text:String(redactPublicArgs(core,part.text,'',secrets))};if(part.type==='media'&&typeof part.mediaType==='string'&&part.mediaType.startsWith('image/')&&typeof part.data==='string'&&isBase64String(part.data))return{type:'image' as const,mimeType:part.mediaType,data:part.data};return undefined;});
      if(converted.every(part=>part!==undefined)&&nativeMessageId){core.sealToolResultContent(event,toolCallId,nativeMessageId,converted);resultContent=converted;}
    }
  }catch{/* The original native result remains available for the canonical history projection. */}
  return {
    toolCallId, ...(nativeMessageId?{nativeMessageId}:{}),toolName: typeof name === 'string' ? name : '', state,
    ...(!legacy && start?.args ? { args: savedArgs ?? (projection ? argsView(core, start.args, secrets) : {}) } : {}),
    ...(legacy ? { legacy: true } : {}),
    ...(exit ? { exitCode: exit.exitCode } : {}),
    ...(resultSummary || exit ? { summary: { ...resultSummary, ...(exit ? { exitCode: exit.exitCode } : {}) } } : {}),
    ...(event.kind === 'tool_update' ? { progress: summary(data.partialResult) } : {}),
    ...(!body.output && projection?.output ? { output: projection.output } : {}), ...body,
    ...(resultContent?{resultContent,resultEventSeq:event.seq}:{}),
  };
}
export function toolActivity(core: Core, contextId: string,includeContent=false,selector?:ToolResultIdentity) {
  const key = (runId: unknown, toolCallId: unknown,nativeMessageId?:unknown) => JSON.stringify([runId, toolCallId,...(nativeMessageId?[nativeMessageId]:[])]);
  const seed=core.runtime.setting<Record<string, unknown>[]>(`context-tools:${contextId}`, []).filter(item=>!selector||(item.runId??null)===selector.runId&&(item.toolCallId===selector.toolCallId||typeof item.toolCallId==='string'&&item.toolCallId.endsWith(':'+selector.toolCallId)));
  const entries = new Map<string, Record<string, unknown>>(seed.map(item => [key(item.runId, item.toolCallId,item.nativeMessageId), item]));
  let secrets: readonly string[] | undefined; try { secrets = core.redactionValues(); } catch { /* argsView fails closed. */ }
  const rows = core.store.db.prepare("SELECT seq,kind,context_id,run_id,task_id,data,created_at FROM runtime_events WHERE context_id=? AND kind IN ('tool_start','tool_update','tool_end','command_exit','shell_output','public_tool')"+(selector?" AND run_id IS ? AND json_extract(data,'$.toolCallId')=?":"")+" ORDER BY seq").all(...(selector?[contextId,selector.runId,selector.toolCallId]:[contextId]));
  for (const row of rows) {
    const event: RuntimeEvent = { seq: Number(row.seq), kind: String(row.kind), contextId: String(row.context_id), runId: row.run_id as string | null, taskId: row.task_id as string | null, data: JSON.parse(String(row.data)), createdAt: String(row.created_at) };
    if (event.kind !== 'public_tool' && core.store.db.prepare('SELECT 1 FROM runtime_events WHERE event_key=?').get('tool.public:' + event.seq)) continue;
    if (event.kind === 'command_exit' && !commandExit(event.data)) continue;
    const data = event.kind === 'public_tool' ? eventData(event.data) : publicToolEvent(core, event, secrets, true);
    if (typeof data.toolCallId !== 'string' || !data.toolCallId) continue;
    const id = key(event.runId, data.toolCallId,data.nativeMessageId); const old = entries.get(id);
    // Snapshots may seed the reducer ahead of the retained raw rows. Preserve known exit evidence.
    const exitCode = typeof old?.exitCode === 'number' ? old.exitCode : data.exitCode;
    const state = terminalState(old?.state, data.state, exitCode);
    entries.set(id, { ...old, ...data, toolName: data.toolName || old?.toolName || '', state,
      ...(exitCode !== undefined ? { exitCode, summary: { ...(Object.hasOwn(eventData(data.summary), 'type') ? {} : eventData(old?.summary)), ...eventData(data.summary), exitCode } } : {}),
      contextId, runId: event.runId, startedAt: old?.startedAt ?? event.createdAt, updatedAt: event.createdAt });
  }
  const result=[...entries.values()];return typeof core.projectSessionTools==='function'?core.projectSessionTools(contextId,result,includeContent,selector):result;
}
