import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { finished, removeTemp } from './helpers.js';

async function fixture(options: { reason?: 'stop' | 'length' | 'error' | 'content-filter' | 'tool-calls'; text?: string; tool?: boolean; hold?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-summary-completion-'));
  const summaryRequests: string[] = [];
  let summaryStarted!: () => void;
  const started = new Promise<void>(resolve => { summaryStarted = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt);
    const summary = !request.tools?.length;
    if (summary) {
      summaryRequests.push(prompt); summaryStarted();
      if (options.hold) await new Promise<never>((_resolve, reject) => {
        const aborted = () => reject(request.abortSignal?.reason ?? new DOMException('Summary cancelled', 'AbortError'));
        if (request.abortSignal?.aborted) aborted(); else request.abortSignal?.addEventListener('abort', aborted, { once: true });
      });
    }
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'text' });
      controller.enqueue({ type: 'text-delta', id: 'text', delta: summary ? options.text ?? 'PARTIAL_SUMMARY_WITHOUT_FINAL_CONSTRAINT' : 'complete' });
      controller.enqueue({ type: 'text-end', id: 'text' });
      if (summary && options.tool) controller.enqueue({ type: 'tool-call', toolCallId: 'unexpected-summary-tool', toolName: 'summary_cannot_execute', input: '{}' });
      controller.enqueue({ type: 'finish', finishReason: summary ? options.reason ?? 'length' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false, modelConfig: {
    protocol: 'responses', baseURL: 'http://example.invalid/v1', modelId: 'synthetic', apiKey: 'fixture-only', authHeader: 'bearer', contextWindow: 8000,
  } });
  core.configure('runtime', { autoCompaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 500 } });
  const send = async (content: string) => {
    const receipt = await core.submitMessage({ content });
    return finished(core, receipt.runId!);
  };
  await send('ORIGINAL_REQUIRED_CONSTRAINT ' + 'old details '.repeat(3500));
  await send('RECENT_ORIGINAL_REQUEST ' + 'recent retained details '.repeat(150));
  return { core, summaryRequests, started, send, async close() { await core.close(); await removeTemp(directory); } };
}

for (const inPlace of [true, false]) {
  test(`a length-limited ${inPlace ? 'same-session' : 'derived-session'} summary cannot publish a checkpoint`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
      const before = f.core.sessionGraph.records('main').map(row => JSON.stringify(row));
      const head = f.core.sessionGraph.head('main');
      await assert.rejects(f.core.compactContext('main', { inPlace, keepRecentTokens: 500 }), /compaction_summary_truncated/);
      assert.equal(f.summaryRequests.length, 1);
      assert.deepEqual(f.core.sessionGraph.records('main').map(row => JSON.stringify(row)), before);
      assert.deepEqual(f.core.sessionGraph.head('main'), head);
      assert.equal(f.core.runtime.contexts().length, 1);
      assert.equal(f.core.runtime.setting('auto-context:main', null), null);
    } finally { await f.close(); }
  });
}

test('a length-limited automatic summary keeps the original history available and fails the active request', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const before = f.core.sessionGraph.records('main').map(row => JSON.stringify(row));
    f.core.configure('runtime', { autoCompaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 500 } });
    assert.equal((await f.send('CURRENT_EXACT_REQUEST'))?.status, 'failed');
    assert.equal(f.summaryRequests.length, 1);
    assert.equal(f.core.runtime.setting('auto-context:main', null), null);
    assert.equal(f.core.sessionGraph.records('main').filter(row => row.entry.type === 'compaction').length, 0);
    const after = f.core.sessionGraph.records('main').map(row => JSON.stringify(row));
    for (const original of before) assert.ok(after.includes(original));
    assert.match(JSON.stringify((await f.core.history('main')).messages), /ORIGINAL_REQUIRED_CONSTRAINT/);
  } finally { await f.close(); }
});

test('a length-limited branch summary cannot move the cursor or change the selected model', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const target = f.core.sessionGraph.records('main').find(row => row.entry.type === 'message' && row.entry.message.role === 'user')!;
    const before = f.core.sessionGraph.records('main').map(row => JSON.stringify(row));
    const head = f.core.sessionGraph.head('main');
    const model = await f.core.modelState('main');
    await assert.rejects(f.core.navigateSession('main', { targetId: target.entry.id, summarize: true }), /compaction_summary_truncated/);
    assert.equal(f.summaryRequests.length, 1);
    assert.deepEqual(f.core.sessionGraph.records('main').map(row => JSON.stringify(row)), before);
    assert.deepEqual(f.core.sessionGraph.head('main'), head);
    assert.deepEqual(await f.core.modelState('main'), model);
    assert.equal(f.core.runtime.setting('session-navigation-pending:main', null), null);
  } finally { await f.close(); }
});

for (const options of [{ reason: 'error' }, { reason: 'content-filter' }, { reason: 'tool-calls' }, { reason: 'stop', tool: true }, { reason: 'stop', text: '' }] as const) {
  test(`a summary ending with ${options.reason}${'tool' in options ? ' and an unexpected tool call' : 'text' in options ? ' and no text' : ''} does not replace the original working set`, { timeout: 30_000 }, async () => {
    const f = await fixture(options);
    try {
      const head = f.core.sessionGraph.head('main');
      const records = f.core.sessionGraph.records('main').map(row => JSON.stringify(row));
      await assert.rejects(f.core.compactContext('main', { inPlace: true, keepRecentTokens: 500 }));
      assert.equal(f.summaryRequests.length, 1);
      assert.deepEqual(f.core.sessionGraph.head('main'), head);
      assert.deepEqual(f.core.sessionGraph.records('main').map(row => JSON.stringify(row)), records);
      assert.equal(f.core.runtime.events('main', 0, 1000).filter(row => row.kind === 'compaction_state' && (row.data as { state?: string }).state === 'finished').length, 0);
    } finally { await f.close(); }
  });
}

test('cancelling an in-flight summary preserves the cursor, original sources and active selection', { timeout: 30_000 }, async () => {
  const f = await fixture({ hold: true });
  try {
    const controller = new AbortController();
    const head = f.core.sessionGraph.head('main');
    const records = f.core.sessionGraph.records('main').map(row => JSON.stringify(row));
    const operation = f.core.compactContext('main', { inPlace: true, keepRecentTokens: 500 }, controller.signal);
    await f.started;
    controller.abort();
    await assert.rejects(operation, /compaction_cancelled/);
    assert.deepEqual(f.core.sessionGraph.head('main'), head);
    assert.deepEqual(f.core.sessionGraph.records('main').map(row => JSON.stringify(row)), records);
    assert.equal(f.summaryRequests.length, 1);
  } finally { await f.close(); }
});
