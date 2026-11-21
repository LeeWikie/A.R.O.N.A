import assert from 'node:assert/strict';
import type { MemoryCandidate } from '../src/memory/v1/contracts.js';
import { memoryReviewCategories } from '../src/memory/v1/review.js';

export function requestObjects(value: unknown): Record<string, any>[] {
  if (typeof value === 'string') { try { return requestObjects(JSON.parse(value)); } catch { return []; } }
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, any>, ...Object.values(value).flatMap(requestObjects)];
}

function userEnvelopes(prompt: unknown): Record<string, any>[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.filter(message => message.role === 'user').flatMap(message => {
    const texts = typeof message.content === 'string' ? [message.content]
      : Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text) : [];
    return texts.flatMap((text: string) => { try { return [JSON.parse(text)]; } catch { return []; } });
  });
}

export function currentMemoryView(prompt: unknown): { draftRevision: number; candidate: MemoryCandidate; inheritedCounts?: Record<string, number> } {
  // 只读取本次实际 user 任务，不递归把历史业务正文或过期 inspect 冒充宿主投影。
  const view = userEnvelopes(prompt).find(row => row.memoryWorkingSetTask === true && row.candidate && typeof row.draftRevision === 'number');
  assert.ok(view, '必须读取真实请求中的候选投影');
  assert.equal(view.projectionVersion, 2);
  assert.equal(view.completeCandidate, false);
  return view as ReturnType<typeof currentMemoryView>;
}

export function scopedReview(prompt: unknown, verdict: 'pass' | 'reject' | 'insufficient-evidence' = 'pass', issues: unknown[] = []) {
  const envelope = userEnvelopes(prompt).find(row => row.scope && typeof row.scope.scopeHash === 'string' && row.proposal);
  assert.ok(envelope, '复核范围必须来自实际请求，而非格式示例或宿主外部状态');
  return { schemaVersion: 2, scopeHash: envelope.scope.scopeHash, verdict,
    checks: Object.fromEntries(memoryReviewCategories.map(category => [category, true])), issues };
}

type Action = { name: string; input: Record<string, unknown> };
/** 仅通过真实 page/open 工具逐步读取旧域；open 回执后下一请求才允许写入。 */
export function workingSetReader() {
  let pending: { collection: string; cursor?: string; handles: string[] } | undefined;
  const opened = new Set<string>();
  return (prompt: unknown): Action | undefined => {
    const view = currentMemoryView(prompt);
    const hidden = view.inheritedCounts ?? {};
    const collection = ['entries', 'entities', 'organizations', ...Object.keys(hidden)]
      .find(name => (hidden[name] ?? 0) > 0);
    if (!collection) { pending = undefined; return; }
    const last = Array.isArray(prompt) ? prompt.at(-1) : undefined;
    const page = last?.role === 'tool' ? requestObjects(last).find(row => Array.isArray(row.items) && 'nextCursor' in row) : undefined;
    if (page && pending) {
      pending.handles.push(...page.items.filter((item: any) => !opened.has(item.handle)).map((item: any) => item.handle));
      pending.cursor = page.nextCursor ?? undefined;
    }
    if (pending && pending.collection !== collection) pending = undefined;
    if (pending?.handles.length && !pending.cursor) {
      const handle = pending.handles.shift()!;
      opened.add(handle);
      return { name: 'memory_working_set_open', input: { expectedDraftRevision: view.draftRevision, handle } };
    }
    if (!pending) pending = { collection, handles: [] };
    return { name: 'memory_working_set_page', input: { expectedDraftRevision: view.draftRevision, collection, ...(pending.cursor ? { cursor: pending.cursor } : {}) } };
  };
}
