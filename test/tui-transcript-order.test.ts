import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationMessage } from '../src/protocol.js';
import type { RunRecord } from '../src/domain.js';
import { transcriptTimeline } from '../src/tui/transcript-order.js';

const message = (id: string, runId: string | null, role: 'user' | 'assistant', createdAt: string): ConversationMessage => ({ id, runId, role, createdAt, contextId: 'main', kind: 'message', status: role === 'user' ? 'accepted' : 'committed', content: id });

test('Core message order survives reversed source timestamps while supplemental tool rows stay inside their actual run', () => {
  const messages = [message('first-user', 'first', 'user', '2026-01-03'), message('first-answer', 'first', 'assistant', '2026-01-04'), message('second-user', 'second', 'user', '2026-01-01'), message('second-answer', 'second', 'assistant', '2026-01-02')];
  const tools = [{ id: 'second-tool', runId: 'second', startedAt: '2026-01-01T12:00:00' }, { id: 'first-tool', runId: 'first', startedAt: '2026-01-03T12:00:00' }];
  const timeline = transcriptTimeline(messages, tools, []);
  assert.deepEqual(timeline.map(entry => entry.message?.id ?? entry.tool?.id), ['first-user', 'first-tool', 'first-answer', 'second-user', 'second-tool', 'second-answer']);
  assert.deepEqual(timeline.flatMap(entry => entry.message ? [entry.message] : []), messages);
});

test('a run failure follows its source user, and a backward tool timestamp cannot precede the source input', () => {
  const input = message('source-user', 'run', 'user', '2026-01-05');
  const failure: RunRecord = { id: 'run', contextId: 'main', status: 'failed', errorCode: 'model_timeout', createdAt: '2026-01-04', finishedAt: '2026-01-06' };
  const timeline = transcriptTimeline([input], [{ id: 'tool', runId: 'run', startedAt: '2026-01-01' }], [failure]);
  assert.equal(timeline[0]?.message, input); assert.equal(timeline[1]?.tool?.id, 'tool'); assert.equal(timeline[2]?.failedRun, failure);
});

test('native graph tool anchors take precedence over timestamps and work without a live run identity', () => {
  const messages = [message('user', null, 'user', '2026-01-05'), message('answer', null, 'assistant', '2026-01-01')];
  const tools = [{ id: 'before-user', runId: null, startedAt: '2030', afterMessageId: null }, { id: 'after-user', runId: null, startedAt: '1900', afterMessageId: 'user' }];
  assert.deepEqual(transcriptTimeline(messages, tools, []).map(entry => entry.message?.id ?? entry.tool?.id), ['before-user', 'user', 'after-user', 'answer']);
});
