import type { RunRecord } from './domain.js';
import type { RuntimeEvent, TaskRecord } from './runtime-store.js';

type Row = Record<string, unknown>;
function record(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function pick(value: Row, keys: readonly string[]): Row {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
}
const taskKeys = ['id', 'title', 'content', 'contextId', 'returnContextId', 'parentId', 'signalId', 'sourceSignalIds', 'occurrenceId', 'status', 'revision', 'attempt', 'runIds', 'report', 'createdAt', 'updatedAt'] as const;
export type PublicTask = Pick<TaskRecord, typeof taskKeys[number] | 'grants'>;

/** Only the host task envelope is projected. Reports and their business JSON remain data. */
export function publicTask(task: PublicTask): PublicTask {
  const result = pick(task as unknown as Row, taskKeys);
  if (record(task.grants)) result.grants = pick(task.grants, ['write', 'execute', 'mcp']);
  return result as unknown as PublicTask;
}
function taskValue(value: unknown): unknown { return record(value) ? publicTask(value as unknown as TaskRecord) : value; }

function encoded(value: unknown, project: (decoded: unknown) => unknown): unknown {
  if (typeof value !== 'string') return project(value);
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { return value; }
  return JSON.stringify(project(decoded));
}
function sourceContent(signal: Row, taskId?: string | null): unknown {
  // Keep an ordinary JSON request byte-for-byte. A task-shaped body alone is not a host envelope.
  let value: unknown = signal.content;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return signal.content; } }
  if (!record(value) || typeof value.taskId !== 'string' || typeof value.title !== 'string' || typeof value.goal !== 'string') return signal.content;
  const owned = signal.type === 'external-event' && signal.source === `task:${value.taskId}` ||
    (signal.type === 'scheduled-task' && taskId === value.taskId && typeof signal.source === 'string' && signal.source.startsWith('schedule:'));
  if (!owned) return signal.content;
  const result = pick(value, ['taskId', 'title', 'goal', 'previousRuns']);
  if (Array.isArray(value.sources)) result.sources = value.sources.map(source => record(source) ? signalValue(source) : source);
  if (Array.isArray(value.childResults)) result.childResults = value.childResults.map(child => record(child) ? pick(child, ['id', 'status', 'report', 'runIds']) : child);
  return typeof signal.content === 'string' ? JSON.stringify(result) : result;
}
function signalValue(value: unknown, taskId?: string | null): unknown {
  if (!record(value)) return value;
  const result = pick(value, ['id', 'version', 'contextId', 'source', 'type', 'content', 'attachments', 'status', 'runId', 'action', 'errorCode', 'createdAt']);
  if (record(value.output)) result.output = pick(value.output, ['kind', 'contextId']);
  // Do not stringify ordinary user text (including JSON formatting and whitespace).
  if ((value.type === 'external-event' && typeof value.source === 'string' && value.source.startsWith('task:')) || value.type === 'scheduled-task') result.content = sourceContent(value, taskId);
  return result;
}
function receiptValue(value: unknown): unknown {
  if (!record(value)) return value;
  return pick(value, ['id', 'status', 'taskId', 'contextId', 'source', 'type', 'content', 'attachments', 'output', 'runId', 'action', 'errorCode', 'createdAt']);
}
const eventKeys = ['seq', 'contextId', 'taskId', 'runId', 'kind', 'createdAt'] as const;

/** Known host event payloads are distinct from tool business results and report deliveries. */
export type ToolResultProjection = (toolName: string, value: unknown) => unknown;
export function publicTaskEvent(event: RuntimeEvent, toolName?: string, projectResult: ToolResultProjection = taskToolResult): RuntimeEvent {
  const result = pick(event as unknown as Row, eventKeys);
  const data = record(event.data) ? event.data : {};
  switch (event.kind) {
    case 'task_created': result.data = taskValue(event.data); break;
    case 'input': result.data = signalValue(event.data, event.taskId); break;
    case 'user_task_request': {
      const request = record(data.request) ? pick(data.request, ['title', 'content', 'contextId', 'workspaceId', 'parentId', 'returnContextId']) : data.request;
      if (record(request) && record(data.request) && record(data.request.grants)) request.grants = pick(data.request.grants, ['write', 'execute', 'mcp']);
      result.data = { input: signalValue(data.input), request }; break;
    }
    case 'task_state': result.data = pick(data, ['id', 'status', 'revision']); break;
    case 'task_supplement': result.data = pick(data, ['id', 'content', 'sourceSignalIds']); break;
    case 'task_attempt_requested': result.data = pick(data, ['action', 'previousReport', 'previousRuns']); break;
    case 'task_report': result.data = structuredClone(event.data); break;
    case 'delivery': result.data = pick(data, ['seq', 'id', 'kind', 'contextId', 'runId', 'signalIds', 'title', 'content', 'createdAt']); break;
    case 'tool_start': result.data = pick(data, ['type', 'toolCallId', 'toolName', 'args']); break;
    case 'tool_end':
    case 'tool_update': {
      const projected = pick(data, ['type', 'toolCallId', 'toolName', 'isError', 'denied']);
      const name = typeof data.toolName === 'string' ? data.toolName : toolName;
      for (const key of ['result', 'partialResult']) if (Object.hasOwn(data, key)) projected[key] = name ? projectResult(name, data[key]) : structuredClone(data[key]);
      result.data = projected; break;
    }
    case 'tool_approval_required': result.data = pick(data, ['type', 'toolCallId', 'toolName', 'args', 'status']); break;
    case 'approval_state': result.data = pick(data, ['id', 'status']); break;
    case 'agent_start': result.data = pick(data, ['type']); break;
    case 'agent_end': result.data = pick(data, ['type', 'reason']); break;
    case 'input_status': result.data = pick(data, ['id', 'status', 'runId', 'action', 'errorCode']); break;
    case 'command_exit': result.data = pick(data, ['type', 'toolCallId', 'exitCode', 'success']); break;
    case 'task_execution_error':
    case 'task_continuation_error':
    case 'snapshot_failed': result.data = pick(data, ['code']); break;
    default: result.data = null;
  }
  return result as unknown as RuntimeEvent;
}
type PublicRecoveryCleanup={runId:string;status:'complete'|'pending'|'blocked';attempts?:number;nextAttemptAt?:string};
export type PublicTaskDetails = PublicTask & { runs: (RunRecord | null | undefined)[]; events: RuntimeEvent[];resourceCleanup?:PublicRecoveryCleanup[] };
export function publicTaskDetails(task: PublicTask & { runs?: (RunRecord | null | undefined)[]; events?: RuntimeEvent[];resourceCleanup?:PublicRecoveryCleanup[] }, projectResult: ToolResultProjection = taskToolResult): PublicTaskDetails {
  const names = new Map<string, string>();
  for (const event of task.events ?? []) {
    if (event.kind !== 'tool_start' || !record(event.data)) continue;
    if (typeof event.data.toolCallId === 'string' && typeof event.data.toolName === 'string') names.set(JSON.stringify([event.runId, event.data.toolCallId]), event.data.toolName);
  }
  return { ...publicTask(task), runs: (task.runs ?? []).map(run => run ? pick(run as unknown as Row, ['id', 'contextId', 'status', 'errorCode', 'createdAt', 'finishedAt']) as unknown as RunRecord : run),
    events: (task.events ?? []).map(event => publicTaskEvent(event, record(event.data) ? names.get(JSON.stringify([event.runId, event.data.toolCallId])) : undefined, projectResult)),...(task.resourceCleanup?{resourceCleanup:task.resourceCleanup.map(row=>pick(row,['runId','status','attempts','nextAttemptAt']) as PublicRecoveryCleanup)}:{}) };
}

const taskTools = new Set(['task_list', 'task_get', 'task_create', 'task_message', 'task_control', 'task_report']);
/** Accepts raw or AI SDK json/text-wrapped results at the named host task tool boundary. */
export function taskToolResult<T>(toolName: string, value: T, projectResult: ToolResultProjection = taskToolResult): T {
  if (!taskTools.has(toolName)) return structuredClone(value);
  return encoded(value, decoded => {
    // Failure/denial envelopes describe the operation, rather than a returned
    // host task. Projecting them as tasks discards their type and error value.
    if (record(decoded) && ['error-text', 'error-json', 'execution-denied'].includes(String(decoded.type))) return structuredClone(decoded);
    if (record(decoded) && ['json', 'text'].includes(String(decoded.type)) && Object.hasOwn(decoded, 'value')) return { ...structuredClone(decoded), value: taskToolResult(toolName, decoded.value, projectResult) };
    if (record(decoded) && decoded.error === true) return structuredClone(decoded);
    if (toolName === 'task_list') {
      if (Array.isArray(decoded)) return decoded.map(taskValue);
      if (record(decoded) && Array.isArray(decoded.tasks)) return { tasks: decoded.tasks.map(taskValue) };
      return structuredClone(decoded);
    }
    if (toolName === 'task_get' && record(decoded)) return publicTaskDetails(decoded as unknown as TaskRecord, projectResult);
    if (toolName === 'task_message') return receiptValue(decoded);
    return taskValue(decoded);
  }) as T;
}

/** Clone protocol envelopes and project only task results, never args or opaque replay blocks. */
export function taskToolResults<T>(prompt: T, projectResult: ToolResultProjection = taskToolResult): T {
  const copy = structuredClone(prompt);
  if (!Array.isArray(copy)) return copy;
  const invocation = (value: unknown) => {
    if (!record(value) || typeof value.toolName !== 'string' || !taskTools.has(value.toolName)) return;
    for (const key of ['result', 'output']) if (Object.hasOwn(value, key)) value[key] = projectResult(value.toolName, value[key]);
  };
  for (const message of copy) {
    if (!record(message)) continue;
    const content = message.content;
    const collections = Array.isArray(content) ? [content] : record(content) ? [content.parts, content.content] : [];
    for (const parts of collections) if (Array.isArray(parts)) for (const part of parts) {
      if (!record(part)) continue;
      if (part.type === 'tool-result') invocation(part);
      if (part.type === 'tool-invocation') invocation(part.toolInvocation);
    }
    if (record(content) && Array.isArray(content.toolInvocations)) for (const call of content.toolInvocations) invocation(call);
  }
  return copy;
}
