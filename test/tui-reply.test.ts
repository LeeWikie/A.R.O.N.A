import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import type { PublicEvent } from '../src/protocol.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('authorized streamed draft updates, commits without duplicate, or is removed on cancellation', async () => {
  const app = new TerminalApp({} as Client, 'main', new FakeTerminal());
  const state = app as unknown as { event: (event: PublicEvent) => void; transcript: { children: unknown[] }; drafts: Map<string, unknown>; seen: Set<string> };
  let seq = 0; const base = { draftId: 'draft-1', signalId: 'signal-1', contextId: 'main', runId: 'run-1' };
  const send = (kind: string, data: unknown) => state.event({ seq: ++seq, kind, data, contextId: 'main', runId: 'run-1', createdAt: '2026-01-01T00:00:00Z' });
  send('reply.start', base); send('reply.delta', { ...base, delta: 'first ' }); send('reply.delta', { ...base, delta: 'second' });
  assert.equal(state.drafts.size, 1); assert.equal(state.transcript.children.length, 1);
  const draft = [...state.drafts.values()][0] as { text: string }; assert.equal(draft.text, 'first second');
  send('reply.replace', { ...base, text: 'revised' }); assert.equal(draft.text, 'revised');
  send('reply.replace', { ...base, text: 'first second' });
  const output = { id: 'out-1', kind: 'message', contextId: 'main', runId: 'run-1', signalIds: ['signal-1'], content: 'first second', createdAt: '2026-01-01T00:00:00Z' };
  send('conversation', { id: 'output:out-1', contextId: 'main', role: 'assistant', content: output.content, createdAt: output.createdAt, runId: 'run-1', status: 'committed', kind: 'message', replyDraftId: 'draft-1' });
  assert.equal(state.drafts.size, 0); assert.equal(state.transcript.children.length, 3);
  send('reply.commit', { ...base, output });
  assert.equal(state.drafts.size, 0); assert.equal(state.seen.size, 1); assert.equal(state.transcript.children.length, 3);
  send('reply.start', { ...base, draftId: 'draft-2' }); send('reply.delta', { ...base, draftId: 'draft-2', delta: 'partial' });
  send('reply.cancel', { ...base, draftId: 'draft-2' }); assert.equal(state.drafts.size, 0); assert.equal(state.transcript.children.length, 3);
  assert.throws(() => send('reply.delta', { ...base, delta: 'orphan' }), /invalid_reply_event/);
  await app.stop();
});
