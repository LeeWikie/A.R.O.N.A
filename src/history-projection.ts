import { publicTaskDetails, taskToolResult, taskToolResults } from './task-view.js';

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/** Public history is data, never a provider replay envelope. Only protocol-owned locations
 * are removed: a tool's business arguments/results may legitimately contain signature keys. */
function stripProtocol(value: RecordValue) {
  delete value.providerMetadata; delete value.providerOptions;
}
function reasoningDetails(value: unknown) {
  if (!Array.isArray(value)) return value;
  return value.filter(detail => !record(detail) || !['redacted', 'redacted_thinking', 'redacted-reasoning'].includes(String(detail.type))).map(detail => {
    if (!record(detail)) return detail;
    stripProtocol(detail); delete detail.signature; delete detail.thinkingSignature;
    return detail;
  });
}
function invocation(value: unknown) {
  if (!record(value)) return;
  stripProtocol(value);
  if (typeof value.toolName !== 'string') return;
  for (const key of ['result', 'output']) if (key in value) value[key] = value.toolName === 'context_history' ? historyResult(value[key]) : projectHostToolResult(value.toolName, value[key]);
}
function parts(value: unknown) {
  if (!Array.isArray(value)) return value;
  return value.filter(part => !record(part) || !['redacted_thinking', 'redacted-reasoning'].includes(String(part.type))).map(part => {
    if (!record(part)) return part;
    const metadata = part.providerMetadata ?? part.providerOptions;
    const hidden = record(metadata) && ((record(metadata.pi) && metadata.pi.redacted === true) || (record(metadata.anthropic) && metadata.anthropic.redactedData !== undefined));
    stripProtocol(part);
    // These are content protocol fields, not arbitrary business JSON fields.
    if (['text', 'reasoning', 'thinking', 'tool-call', 'tool-invocation', 'tool-result'].includes(String(part.type))) {
      for (const key of ['textSignature', 'thinkingSignature', 'thoughtSignature', 'signature', 'encrypted_content']) delete part[key];
    }
    if (part.type === 'reasoning' || part.type === 'thinking') {
      part.details = reasoningDetails(part.details);
      if (hidden) { for (const key of ['text', 'reasoning', 'thinking']) if (key in part) part[key] = ''; part.details = []; }
    }
    if (part.type === 'error') part.error = { name: 'ExecutionError', message: 'model_execution_failed' };
    if (part.type === 'tool-invocation') invocation(part.toolInvocation);
    if (part.type === 'tool-result' && typeof part.toolName === 'string') {
      for (const key of ['result', 'output']) if (key in part) part[key] = part.toolName === 'context_history' ? historyResult(part[key]) : projectHostToolResult(part.toolName, part[key]);
    }
    return part;
  });
}
function message(value: unknown) {
  if (!record(value) || !['user', 'signal', 'assistant', 'system', 'tool'].includes(String(value.role))) return value;
  stripProtocol(value);
  if (record(value.content)) {
    const content = value.content; stripProtocol(content);
    content.parts = parts(content.parts);
    content.content = parts(content.content);
    if (Array.isArray(content.toolInvocations)) for (const call of content.toolInvocations) invocation(call);
    content.reasoning = reasoningDetails(content.reasoning);
  } else if (Array.isArray(value.content)) value.content = parts(value.content);
  return value;
}
/** Called only on the result of context_history, including historical nested results. */
function historyResult(value: unknown): unknown {
  if (typeof value === 'string') {
    let decoded: unknown;
    try { decoded = JSON.parse(value); } catch (error) { if (error instanceof SyntaxError) return value; throw error; }
    return JSON.stringify(historyResult(decoded));
  }
  if (!record(value)) return value;
  if (Array.isArray(value.messages)) value.messages = value.messages.map(message);
  // AI SDK tool outputs wrap the page in json/text output values.
  if ((value.type === 'json' || value.type === 'text') && 'value' in value) value.value = historyResult(value.value);
  // Mastra/MCP tool results serialize the page into text content blocks.
  if (Array.isArray(value.content)) for (const part of value.content) {
    if (record(part) && part.type === 'text' && typeof part.text === 'string') part.text = historyResult(part.text);
  }
  return value;
}
/** Combined host tool boundary, including task event results containing context_history. */
export function projectHostToolResult<T>(toolName: string, value: T): T {
  return (toolName === 'context_history' ? historyResult(structuredClone(value)) : taskToolResult(toolName, value, projectHostToolResult)) as T;
}
export function publicTaskHistoryDetails(task: Parameters<typeof publicTaskDetails>[0]) {
  return publicTaskDetails(task, projectHostToolResult);
}
export function publicHistory<T>(page: T): T { return historyResult(structuredClone(page)) as T; }
export function publicHistoryMessages<T>(messages: readonly T[]): T[] { return structuredClone([...messages]).map(value => message(value) as T); }

/** Preserve outer replay metadata; project only host tools' ordinary result data. */
export function projectHistoryToolResults<T>(prompt: T): T {
  const copy = taskToolResults(prompt, projectHostToolResult);
  if (!Array.isArray(copy)) return copy;
  for (const entry of copy) {
    if (!record(entry) || entry.role !== 'tool' || !Array.isArray(entry.content)) continue;
    for (const part of entry.content) if (record(part) && part.type === 'tool-result' && part.toolName === 'context_history') {
      if ('output' in part) part.output = historyResult(part.output);
      if ('result' in part) part.result = historyResult(part.result);
    }
  }
  return copy;
}
