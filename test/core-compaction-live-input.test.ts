import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { Core } from '../src/core.js';
import { authenticatedApp, finished, removeTemp, until } from './helpers.js';

for (const mode of ['steer','queue','switch-and-queue','cancel'] as const) test(`an in-flight native summary preserves ${mode} input and its original sources`, { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-summary-live-input-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const provider = fauxProvider({ provider: 'synthetic-live-compaction', models: [
    { id: 'original-model', reasoning: true, contextWindow: 40000, maxTokens: 2000 },
    { id: 'next-model', reasoning: true, contextWindow: 60000, maxTokens: 3000 },
  ] });
  let pages = 0, summaries = 0, release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const observed: Array<{summary:boolean;model:string;reasoning:unknown;prompt:string}> = [];
  try {
    const bytes = Buffer.from(Array.from({ length: 6 * 32768 }, (_, index) => index % 251));
    const asset = await core.assets.put(new Response(bytes).body, 'live-turn.bin', undefined, { purpose: 'client-shell-output' });
    provider.setResponses(Array.from({ length: 40 }, () => async (context, options, _state, model) => {
      const prompt = JSON.stringify(context.messages), summary = !getCurrentTools(context.messages).length;
      observed.push({ summary, model: model.id, reasoning: options?.reasoning, prompt });
      if (summary) {
        summaries++;
        if (summaries === 1) {
          entered();
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(options?.signal?.reason ?? new DOMException('Summary cancelled', 'AbortError'));
            if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
            held.then(resolve, reject);
          });
        }
        return fauxAssistantMessage('CHECKPOINT_OF_COMPLETED_READS_ONLY');
      }
      if (pages < 6) {
        const source = core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.contextId')='main' AND status='accepted' AND json_extract(body,'$.content') LIKE 'Inspect six original%' ORDER BY rowid LIMIT 1").get(); assert.ok(source);
        const index = pages++;
        return fauxAssistantMessage([fauxToolCall('read_attachment', { id: asset.id, signalIds: [String(source.id)], encoding: 'base64', byteOffset: index * 32768, maxBytes: 32768 }, { id: `read-once-${index}` })], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('The original reads are complete.');
    }));
    core.providerRegistry.setProvider(provider.provider);
    core.models.save({ id: 'default', name: 'Original model', providerId: provider.provider.id, modelId: 'original-model', defaultThinkingLevel: 'low' });
    core.models.save({ id: 'next', name: 'Next model', providerId: provider.provider.id, modelId: 'next-model', defaultThinkingLevel: 'high' });
    core.configure('runtime', { autoCompaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 5000 } });
    const original = await core.submitMessage({ content: 'Inspect six original byte pages exactly once.', attachments: [asset.id] });
    await ready;
    assert.equal(pages, 3);
    const acceptedBefore = core.store.getSignal(original.id);
    if (mode === 'cancel') {
      const response = await authenticatedApp(core).request('/contexts/main/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRunId: original.runId }) });
      assert.equal(response.status, 202);
      assert.equal((await finished(core, original.runId!))?.status, 'interrupted');
      assert.equal(pages, 3);
      assert.equal(core.sessionGraph.records('main').filter(row => row.entry.type === 'compaction').length, 0);
      assert.equal(core.runtime.setting('auto-context:main', null), null);
    } else {
      if (mode === 'switch-and-queue') await core.switchModel('main', 'next', 'high');
      const lateText = `LATE_${mode.toUpperCase()}_SOURCE`, late = await core.submitMessage({ content: lateText, mode: mode === 'steer' ? 'steer' : 'queue', ...(mode === 'steer' ? { expectedRunId: original.runId! } : {}) });
      if (mode === 'steer') assert.equal(late.runId, original.runId);
      release();
      assert.equal((await finished(core, original.runId!))?.status, 'succeeded');
      if (mode !== 'steer') {
        const admitted = await until(() => core.store.getSignal(late.id), value => value?.status === 'accepted'); assert.ok(admitted?.runId);
        assert.equal((await finished(core, admitted.runId))?.status, 'succeeded');
      }
      assert.equal(pages, 6);
      assert.equal(core.store.getSignal(late.id)?.content, lateText);
      assert.equal(core.runtime.events('main', 0, 2000).filter(event => event.kind === 'input' && (event.data as {id?:string}).id === late.id).length, 1);
      assert.ok(observed.some(row => !row.summary && row.prompt.split(lateText).length===2), 'the late accepted source reaches a primary request exactly once');
      assert.equal(observed.find(row=>row.summary)?.prompt.includes(lateText),false,'the already captured summary prefix excludes the later source');
      const completed = core.runtime.events('main', 0, 2000).filter(event => event.kind === 'tool_end' && /^read-once-/.test(String((event.data as {toolCallId?:string}).toolCallId)));
      assert.equal(completed.length, 6);
      assert.equal(new Set(completed.map(event => (event.data as {toolCallId:string}).toolCallId)).size, 6);
      if (mode === 'switch-and-queue') {
        const future = observed.findIndex(row => !row.summary && row.model === 'next-model'); assert.ok(future > 0);
        assert.ok(observed.slice(0, future).every(row => row.model === 'original-model' && row.reasoning === 'low'));
        assert.ok(observed.slice(future).every(row => row.model === 'next-model' && row.reasoning === 'high'));
      }
    }
    const after = core.store.getSignal(original.id); assert.equal(after?.content, acceptedBefore?.content); assert.equal(after?.nativeSignalId, acceptedBefore?.nativeSignalId); assert.equal(after?.runId, acceptedBefore?.runId);
    assert.equal(core.runtime.approvals().length, 0);
  } finally { release(); await core.close(); await removeTemp(directory); }
});
