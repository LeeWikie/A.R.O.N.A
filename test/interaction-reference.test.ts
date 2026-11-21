import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import type { InteractionReference } from '../src/interactions.js';
import { authenticatedApp, removeTemp, until } from './helpers.js';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-interaction-reference-')); let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => { calls++; return { stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'tool-call', toolCallId: 'synthetic-original-question', toolName: 'ask_user', input: JSON.stringify({ question: 'Synthetic original question?', options: [{ label: 'Original A' }, { label: 'Canonical B' }] }) });
    c.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } }); c.close();
  } }) }; } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false }); const app = authenticatedApp(core);
  return { core, calls: () => calls, question: async (contextId: string) => (await until(() => core.interactions(contextId), rows => rows.some(row => row.status === 'pending'))).find(row => row.status === 'pending')!,
    read: (id: string, runId: string) => app.request(`/interactions/${id}/reference?expectedRunId=${encodeURIComponent(runId)}`), async close() { await core.close(); await removeTemp(directory); } };
}

test('an original Main question has a read-only exact reference and an archived destination is not silently replaced', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const target = f.core.createConversationContext({ name: 'Original conversation' }); const receipt = await f.core.submitMessage({ contextId: target.id, content: 'Synthetic question request' }); const question = await f.question(target.id);
    const result = await f.read(question.id, receipt.runId!); assert.equal(result.status, 200); const reference = await result.json() as InteractionReference;
    assert.deepEqual(reference.interaction, question); assert.deepEqual(reference.taskIds, []); assert.equal(reference.target?.contextId, target.id); assert.equal(f.calls(), 1); assert.equal(f.core.interactionAnswers().length, 0);
    assert.equal((await f.read(question.id, 'another-run')).status, 409); assert.equal((await f.read('not-an-interaction', receipt.runId!)).status, 404);
    await f.core.cancelInteraction(question.id, question.runId);
    await until(() => { try { return f.core.archiveContext(target.id, true); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'context_busy') return undefined; throw error; } }, Boolean);
    const closed = await (await f.read(question.id, receipt.runId!)).json() as InteractionReference;
    assert.equal(closed.target, undefined); assert.equal(closed.unavailable, 'interaction_destination_unavailable'); assert.equal(closed.interaction.id, question.id); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('a real worker question follows its original parent chain to the original Main without answering, resuming or granting anything', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const target = f.core.createConversationContext({ name: 'Original dispatch conversation' });
    const parent = await f.core.submitTask({ title: 'Synthetic parent', content: 'Ask a synthetic question', returnContextId: target.id }, 'reference-parent'); await f.question(parent.contextId);
    const child = await f.core.submitTask({ title: 'Synthetic child', content: 'Ask another synthetic question', parentId: parent.id, returnContextId: parent.contextId }, 'reference-child'); const question = await f.question(child.contextId);
    const reference = await (await f.read(question.id, question.runId)).json() as InteractionReference;
    assert.equal(reference.target?.contextId, target.id); assert.deepEqual(reference.taskIds, [child.id, parent.id]); assert.equal(reference.interaction.contextId, child.contextId); assert.equal(f.calls(), 2); assert.equal(f.core.interactionAnswers().length, 0);
    const before = f.core.runtime.task(parent.id);
    f.core.runtime.updateTask(parent.id, { returnContextId: 'main' });
    const changed = await (await f.read(question.id, question.runId)).json() as InteractionReference;
    assert.equal(changed.target, undefined); assert.equal(changed.unavailable, 'interaction_origin_unavailable'); assert.equal(f.calls(), 2);
    f.core.runtime.updateTask(parent.id, { returnContextId: before.returnContextId });
    const records = f.core.runtime.setting<Array<Record<string, unknown>>>('interactions', []);
    f.core.runtime.setSetting('interactions', records.map(row => row.id === question.id ? { ...row, contextId: 'main' } : row));
    assert.equal((await f.read(question.id, question.runId)).status, 409); f.core.runtime.setSetting('interactions', records);
  } finally { await f.close(); }
});
