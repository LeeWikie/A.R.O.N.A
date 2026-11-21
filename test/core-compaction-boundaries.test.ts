import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { prepareCompaction } from '@earendil-works/pi-coding-agent';
import { Core } from '../src/core.js';
import { finished, removeTemp } from './helpers.js';

test('manual compaction can summarize an oversized completed first turn while retaining its assistant suffix', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-compaction-boundary-'));
  const prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt); prompts.push(prompt);
    const summary = !request.tools?.length;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'text' });
      controller.enqueue({ type: 'text-delta', id: 'text', delta: summary ? 'ORIGINAL_CONSTRAINT_CHECKPOINT' : 'RETAINED_ASSISTANT_SUFFIX ' + 'suffix detail '.repeat(400) });
      controller.enqueue({ type: 'text-end', id: 'text' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    core.configure('runtime', { autoCompaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 500 } });
    const input = await core.submitMessage({ content: 'ORIGINAL_CONSTRAINT ' + 'first turn details '.repeat(2500) });
    assert.equal((await finished(core, input.runId!))?.status, 'succeeded');
    const original = core.sessionGraph.records('main').map(row => JSON.stringify(row));
    const result = await core.compactContext('main', { inPlace: true, keepRecentTokens: 1000 });
    assert.equal(result.context.id, 'main');
    assert.ok(result.summarizedMessages > 0);
    for (const record of original) assert.ok(core.sessionGraph.records('main').some(row => JSON.stringify(row) === record));
    const followup = await core.submitMessage({ content: 'CONTINUE_AFTER_FIRST_TURN_COMPACTION' });
    assert.equal((await finished(core, followup.runId!))?.status, 'succeeded');
    assert.match(prompts.at(-1)!, /ORIGINAL_CONSTRAINT_CHECKPOINT/);
    assert.match(prompts.at(-1)!, /RETAINED_ASSISTANT_SUFFIX/);
    assert.doesNotMatch(prompts.at(-1)!, /first turn details first turn details/);
  } finally { await core.close(); await removeTemp(directory); }
});

test('an explicit recent-token budget is never silently reduced to force a manual checkpoint', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-compaction-explicit-budget-'));
  let requests = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => {
    requests++;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'text' });
      controller.enqueue({ type: 'text-delta', id: 'text', delta: 'SYNTHETIC_PUBLISHED_ANSWER' });
      controller.enqueue({ type: 'text-end', id: 'text' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    core.configure('runtime', { autoCompaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 } });
    for (const content of ['OLD_EXACT_BYTES ' + 'old payload '.repeat(3000), 'RECENT_KEEP']) {
      const receipt = await core.submitMessage({ content }); assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded');
    }
    const original = core.sessionGraph.records('main').map(row => JSON.stringify(row)), head = core.sessionGraph.head('main');
    assert.equal(prepareCompaction(core.sessionGraph.manager('main').getBranch(), { enabled: true, reserveTokens: 16384, keepRecentTokens: 1000 }), undefined);
    await assert.rejects(core.compactContext('main', { inPlace: true, keepRecentTokens: 1000 }), /compaction_not_needed/);
    assert.equal(requests, 2, 'no auxiliary request is made when the native budget retains the complete history');
    assert.deepEqual(core.sessionGraph.records('main').map(row => JSON.stringify(row)), original);
    assert.deepEqual(core.sessionGraph.head('main'), head);
  } finally { await core.close(); await removeTemp(directory); }
});
