import type { ConversationMessage } from '../protocol.js';
import type { RunRecord } from '../domain.js';

export interface TranscriptEntry<T> { message?: ConversationMessage; tool?: T; failedRun?: RunRecord }

/** Message order comes from Core; timestamps position only supplemental rows within their run. */
export function transcriptTimeline<T extends { runId?: string | null; startedAt?: string; afterMessageId?: string | null }>(messages: ConversationMessage[], tools: T[], failures: RunRecord[]): TranscriptEntry<T>[] {
  const first = new Map<string, number>(), last = new Map<string, number>();
  messages.forEach((message, index) => { if (message.runId) { if (!first.has(message.runId)) first.set(message.runId, index); last.set(message.runId, index); } });
  const groups = new Map<string, { items: Array<TranscriptEntry<T> & { at: string; order: number }>; next: number }>();
  const add = (runId: string, entry: TranscriptEntry<T>, at: string, order: number) => { const group = groups.get(runId) ?? { items: [], next: 0 }; group.items.push({ ...entry, at, order }); groups.set(runId, group); };
  const anchored = new Map<string | null, T[]>();
  tools.forEach((tool, index) => {
    if (tool.afterMessageId !== undefined) { const rows = anchored.get(tool.afterMessageId) ?? []; rows.push(tool); anchored.set(tool.afterMessageId, rows); }
    else add(tool.runId ?? '', { tool }, tool.startedAt ?? '', index);
  });
  failures.forEach((failedRun, index) => add(failedRun.id, { failedRun }, failedRun.finishedAt ?? failedRun.createdAt, tools.length + index));
  for (const { items } of groups.values()) items.sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order);
  const result: TranscriptEntry<T>[] = [];
  const flushAnchor = (id: string | null) => { for (const tool of anchored.get(id) ?? []) result.push({ tool }); anchored.delete(id); };
  flushAnchor(null);
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!, group = message.runId ? groups.get(message.runId) : undefined;
    if (group && first.get(message.runId!) !== index) while (group.next < group.items.length && group.items[group.next]!.at <= (message.createdAt ?? '')) result.push(group.items[group.next++]!);
    result.push({ message });
    flushAnchor(message.id);
    if (group && last.get(message.runId!) === index) { for (; group.next < group.items.length; group.next++) result.push(group.items[group.next]!); groups.delete(message.runId!); }
  }
  for (const { items, next } of groups.values()) for (let index = next; index < items.length; index++) result.push(items[index]!);
  for (const rows of anchored.values()) for (const tool of rows) result.push({ tool });
  return result;
}
