// Summarization prompts, conversation serialization and the recent-token budget follow Pi coding-agent
// core/compaction/{compaction,utils}.ts, commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in tui/upstream/LICENSE.
// Adapted: the source context is never rewritten; the summary seeds a new derived context.
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { publicHistoryMessages } from './history-projection.js';
import { AppError } from './domain.js';

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages. Write the summary in the language the user used.`;

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const TOOL_RESULT_MAX_CHARS = 2000;

export async function completedCompactionSummary(output: { text: Promise<string>; finishReason: Promise<string | undefined>; toolCalls: Promise<readonly unknown[]>; error?: Error }, emptyCode: string, signal?: AbortSignal) {
  const text = await output.text;
  const finishReason = await output.finishReason;
  const toolCalls = await output.toolCalls;
  signal?.throwIfAborted();
  if (output.error) throw output.error;
  if (finishReason === 'length') throw new AppError('compaction_summary_truncated', 502);
  if (finishReason === 'aborted' || finishReason === 'abort') throw new AppError('compaction_cancelled', 409);
  if (finishReason === 'error' || finishReason === 'content-filter' || finishReason === 'tool-calls') throw new AppError('compaction_summary_incomplete', 502);
  if (toolCalls.length) throw new AppError('compaction_summary_incomplete', 502);
  const summary = text.trim();
  if (!summary) throw new AppError(emptyCode, 502);
  return summary;
}

type Part = { type?: string; text?: string; toolInvocation?: { toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; state?: string }; [key: string]: unknown };
export type NativeMessage = { id: string; role?: string; content?: { parts?: Part[] } };

function truncateForSummary(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}
function text(message: NativeMessage) { return (message.content?.parts ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!).join('\n'); }

/** Pi serializeConversation over Mastra stored messages: user text, assistant text, tool calls, truncated tool results. */
export function serializeConversation(messages: readonly NativeMessage[]) {
  const parts: string[] = [];
  for (const message of publicHistoryMessages(messages)) {
    const body = text(message);
    if (message.role === 'user' || message.role === 'signal') { if (body) parts.push(`[User]: ${body}`); continue; }
    if (message.role !== 'assistant') continue;
    const calls: string[] = []; const results: string[] = [];
    for (const part of message.content?.parts ?? []) {
      const call = part.type === 'tool-invocation' ? part.toolInvocation : undefined; if (!call) continue;
      const args = call.args && typeof call.args === 'object' ? Object.entries(call.args as Record<string, unknown>).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ') : '';
      calls.push(`${call.toolName ?? 'tool'}(${args})`);
      if (call.result !== undefined) results.push(truncateForSummary(typeof call.result === 'string' ? call.result : JSON.stringify(call.result), TOOL_RESULT_MAX_CHARS));
    }
    if (body) parts.push(`[Assistant]: ${body}`);
    if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`);
    for (const result of results) parts.push(`[Tool result]: ${result}`);
  }
  return parts.join('\n\n');
}

/** Budget the private native payload, never the lossy summary rendering. Opaque metadata stays opaque. */
export function estimateMessageTokens(message: NativeMessage) {
  let tokens = 8;
  for (const part of message.content?.parts ?? []) {
    const serialized = JSON.stringify(part);
    const estimate = estimateTextTokens(serialized);
    // A short media reference is not a cheap text block; payload tokenization is provider-dependent.
    tokens += ['image', 'file', 'audio', 'video'].includes(part.type ?? '') ? Math.max(4096, estimate) : estimate;
  }
  return tokens;
}

/**
 * Index of the first message to keep verbatim: walk back from the newest message until the budget is
 * reached, then move to the next user turn start so a turn is never split (Pi findCutPoint, turn-aligned).
 * Returns 0 when everything fits (nothing to summarize) and never returns past the last user turn.
 */
export function findCutPoint(messages: readonly NativeMessage[], keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS) {
  const starts = messages.flatMap((message, index) => message.role === 'user' || message.role === 'signal' ? [index] : []);
  if (starts.length < 2) return 0;
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    total += estimateMessageTokens(messages[index]!);
    if (total >= keepRecentTokens) return starts.find(start => start > index) ?? starts.at(-1)!;
  }
  return 0;
}
