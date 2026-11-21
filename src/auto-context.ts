import { createHash } from 'node:crypto';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';

export type ContextPrompt = ProcessLLMRequestArgs['prompt'];

/** Threshold rule used by Pi's compaction.shouldCompact (v1.5.1). */
export function shouldCompactContext(inputTokens: number, contextWindow: number | null, reserveTokens: number, enabled = true): boolean {
  return enabled && contextWindow !== null && Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(inputTokens) && inputTokens > contextWindow - Math.max(0, reserveTokens);
}

export function estimatePromptTokens(prompt: ContextPrompt): number {
  let tokens = 0;
  for (const message of prompt) {
    tokens += 4;
    if (typeof message.content === 'string') { tokens += estimateTextTokens(message.content); continue; }
    for (const part of message.content) {
      // The estimate is intentionally heuristic; never expand binary media into a JSON byte array.
      if (part.type === 'file') tokens += 1200;
      else tokens += estimateTextTokens(JSON.stringify(part));
    }
  }
  return tokens;
}

export interface ContextPromptSplit {
  /** Index into the original prompt; source records remain unchanged. */
  cutIndex: number;
  /** Original system messages, in their original order. */
  system: ContextPrompt;
  earlier: ContextPrompt;
  recent: ContextPrompt;
  coveredMessages: number;
  prefixHash: string;
}

/** Chooses message boundaries without orphaning a retained tool result or a pending tool call. */
export function splitContextPrompt(prompt: ContextPrompt, keepRecentTokens = 20_000): ContextPromptSplit | null {
  if (!Number.isFinite(keepRecentTokens) || keepRecentTokens < 0) throw new RangeError('invalid_recent_token_budget');
  const pending = new Map<string, number>();
  const pairs: Array<{ call: number; result: number }> = [];
  const orphanResults: number[] = [];
  const system: ContextPrompt = [];
  for (let index = 0; index < prompt.length; index++) {
    const message = prompt[index]!;
    if (message.role === 'system') { system.push(message); continue; }
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        // Reuse after a completed pair is valid; concurrent reuse is ambiguous.
        if (pending.has(part.toolCallId)) return null;
        pending.set(part.toolCallId, index);
      }
      if (part.type === 'tool-result') {
        const call = pending.get(part.toolCallId);
        if (call === undefined) orphanResults.push(index);
        else { pairs.push({ call, result: index }); pending.delete(part.toolCallId); }
      }
    }
  }
  const allowed = (cut: number) => {
    const start = prompt[cut];
    if (!start || !['user', 'assistant'].includes(start.role)) return false;
    if (pairs.some(pair => pair.call < cut && pair.result >= cut)) return false;
    if ([...pending.values()].some(call => call < cut)) return false;
    if (orphanResults.some(result => result >= cut)) return false;
    return true;
  };
  let total = 0, candidate = 0;
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]!.role !== 'system') total += estimatePromptTokens([prompt[index]!]);
    if (total >= keepRecentTokens) { candidate = total > keepRecentTokens ? index + 1 : index; break; }
  }
  const lastUserIndex = prompt.findLastIndex(message => message.role === 'user');
  if (lastUserIndex < 0) return null;
  candidate = Math.min(candidate, lastUserIndex);
  for (let cut = candidate; cut > 0; cut--) {
    if (!allowed(cut)) continue;
    const earlier = prompt.slice(0, cut).filter(message => message.role !== 'system');
    if (!earlier.length) continue;
    const recent = prompt.slice(cut).filter(message => message.role !== 'system');
    return { cutIndex: cut, system, earlier, recent, coveredMessages: earlier.length, prefixHash: contextPrefixHash(earlier) };
  }
  return null;
}

export function contextPrefixHash(prompt: ContextPrompt): string {
  const providerOptions = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const fields = Object.fromEntries(Object.entries(value));
    if (fields.mastra && typeof fields.mastra === 'object' && !Array.isArray(fields.mastra)) {
      const metadata = Object.fromEntries(Object.entries(fields.mastra).filter(([key]) => key !== 'createdAt'));
      if (Object.keys(metadata).length) fields.mastra = metadata; else delete fields.mastra;
    }
    return Object.keys(fields).length ? fields : undefined;
  };
  const envelope = (value: object): unknown => Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
    if (key !== 'providerOptions') return [[key, field]];
    const normalized = providerOptions(field); return normalized === undefined ? [] : [[key, normalized]];
  }));
  const canonical = (value: unknown): unknown => {
    if (value instanceof URL) return value.href;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof ArrayBuffer) return { bytes: value.byteLength, sha256: createHash('sha256').update(new Uint8Array(value)).digest('hex') };
    if (ArrayBuffer.isView(value)) return { bytes: value.byteLength, sha256: createHash('sha256').update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).digest('hex') };
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, canonical(field)]));
    return value;
  };
  const messages = prompt.filter(message => message.role !== 'system').map(message => envelope({ ...message,
    content: typeof message.content === 'string' ? message.content : message.content.map(part => envelope(part)),
  }));
  return createHash('sha256').update(JSON.stringify(canonical(messages))).digest('hex');
}

/** Rejects a checkpoint after history edits instead of silently omitting different source messages. */
export function contextCheckpointMatches(prompt: ContextPrompt, checkpoint: { coveredMessages: number; prefixHash: string }): boolean {
  if (!Number.isSafeInteger(checkpoint.coveredMessages) || checkpoint.coveredMessages < 1) return false;
  const conversation = prompt.filter(message => message.role !== 'system');
  return conversation.length >= checkpoint.coveredMessages && contextPrefixHash(conversation.slice(0, checkpoint.coveredMessages)) === checkpoint.prefixHash;
}
