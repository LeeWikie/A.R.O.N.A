import assert from 'node:assert/strict';
import test from 'node:test';
import { compact, compactWithCompletion, prepareCompaction, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type Usage } from '@earendil-works/pi-ai';

const model = fauxProvider().getModel();
const usage: Usage = { input: 101, output: 11, cacheRead: 17, cacheWrite: 19, totalTokens: 148, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const assistant = (text: string) => ({ ...fauxAssistantMessage(text), api: model.api, provider: model.provider, model: model.id, usage });
const call = (id: string, name: string, args: object) => ({ ...assistant(''), content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse' });
const result = (id: string, name: string, text: string) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: 1 });
function entries(messages: unknown[]): SessionEntry[] {
  return messages.map((message, index) => ({ type: 'message', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp: new Date(1_000 + index * 100).toISOString(), message })) as SessionEntry[];
}
const cases: Array<{ name: string; entries: SessionEntry[]; keep: number }> = [
  { name: 'single completed turn', entries: entries([user('first details '.repeat(300)), assistant('retained suffix '.repeat(100))]), keep: 100 },
  { name: 'history and split prefix', entries: entries([user('old details '.repeat(300)), assistant('old answer'), user('current details '.repeat(300)), assistant('current suffix '.repeat(100))]), keep: 100 },
  { name: 'paired oversized tool result', entries: entries([user('old history'), assistant('old answer'), user('read large file'), call('read-call', 'read', { path: 'large.txt' }), result('read-call', 'read', 'x'.repeat(8_000))]), keep: 1_000 },
  { name: 'file operations', entries: entries([user('old details '.repeat(300)), call('read', 'read', { path: 'read.ts' }), result('read', 'read', 'read bytes'), call('edit', 'edit', { path: 'changed.ts', oldText: 'before', newText: 'after' }), result('edit', 'edit', 'changed'), user('recent'), assistant('suffix')]), keep: 20 },
];
const previous = entries([user('old raw history '.repeat(300)), assistant('old raw answer'), user('previously retained '.repeat(300)), assistant('retained answer')]);
previous.push({ type: 'compaction', id: 'previous-compaction', parentId: 'entry-3', timestamp: new Date(1_800).toISOString(), summary: 'PREVIOUS_SUMMARY', firstKeptEntryId: 'entry-2', tokensBefore: 7_000, details: { readFiles: ['previous-read.ts'], modifiedFiles: ['previous-edit.ts'] } });
previous.push({ type: 'message', id: 'later-user', parentId: 'previous-compaction', timestamp: new Date(1_900).toISOString(), message: user('additional retained source '.repeat(300)) } as SessionEntry);
previous.push({ type: 'message', id: 'later-answer', parentId: 'later-user', timestamp: new Date(2_000).toISOString(), message: assistant('latest suffix') } as SessionEntry);
cases.push({ name: 'previous summary and inherited files', entries: previous, keep: 50 });
const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'timestamp').map(([key, item]) => [key, normalize(item)])) : value;

for (const item of cases) test(`the native completion delegate preserves ${item.name} without a model descriptor`, async () => {
  const originalBytes = JSON.stringify(item.entries), plan = prepareCompaction(item.entries, { enabled: true, reserveTokens: 1_024, keepRecentTokens: item.keep });
  assert.ok(plan);
  const nativePrompts: unknown[] = [], delegatedPrompts: unknown[] = [];
  const original = await compact(plan, model, undefined, undefined, 'Preserve the exact constraint.', undefined, undefined, (_model, context) => {
    const index = nativePrompts.push(normalize(context)), stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: { ...fauxAssistantMessage(`SUMMARY_${index}`), usage } }); stream.end(); });
    return stream;
  });
  const kinds: string[] = [];
  const delegated = await compactWithCompletion(plan, async ({ kind, context }) => {
    kinds.push(kind); const index = delegatedPrompts.push(normalize(context));
    return { text: `SUMMARY_${index}`, usage };
  }, { customInstructions: 'Preserve the exact constraint.' });
  assert.deepEqual(delegatedPrompts, nativePrompts);
  assert.deepEqual(delegated, original);
  assert.equal(JSON.stringify(item.entries), originalBytes);
  if (plan.isSplitTurn && plan.messagesToSummarize.length) {
    assert.deepEqual(kinds, ['history', 'turn-prefix']);
    assert.equal(delegated.usage?.totalTokens, usage.totalTokens * 2);
  }
  if (item.name.startsWith('previous')) {
    assert.match(JSON.stringify(delegatedPrompts), /PREVIOUS_SUMMARY/);
    assert.deepEqual(delegated.details, { readFiles: ['previous-read.ts'], modifiedFiles: ['previous-edit.ts'] });
  }
});

test('native delegated compaction never returns a checkpoint after cancellation or a failed first summary', async () => {
  const item = cases[2]!, plan = prepareCompaction(item.entries, { enabled: true, reserveTokens: 1_024, keepRecentTokens: item.keep });
  assert.ok(plan?.isSplitTurn && plan.messagesToSummarize.length);
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(compactWithCompletion(plan, async () => { calls++; controller.abort(new Error('summary_cancelled')); return { text: 'partial', usage }; }, { signal: controller.signal }), /summary_cancelled/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(compactWithCompletion(plan, async () => { calls++; throw new Error('summary_failed'); }), /summary_failed/);
  assert.equal(calls, 1);
});
