import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { Core } from '../src/core.js';
import { authenticatedApp, removeTemp } from './helpers.js';

for (const phase of ['provider', 'summary'] as const) test(`closing after a native ${phase} cancellation waits for the original workflow cleanup`, { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-native-cleanup-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const provider = fauxProvider({ provider: 'synthetic-native-cleanup', models: [{ id: 'model', reasoning: false, contextWindow: 40000, maxTokens: 2000 }] });
  let enterModel!: () => void, enterCleanup!: () => void, releaseCleanup!: () => void;
  const modelEntered = new Promise<void>(resolve => { enterModel = resolve; });
  const cleanupEntered = new Promise<void>(resolve => { enterCleanup = resolve; });
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let nativeRunId: string | undefined, cleanupFinished = false, closed = false;
  const nativeStorage = core.sessions.controller.getMastra()?.getStorage(); assert.ok(nativeStorage);
  const workflows = await nativeStorage.getStore('workflows'); assert.ok(workflows);
  const originalDelete = workflows.deleteWorkflowRunById.bind(workflows);
  workflows.deleteWorkflowRunById = async input => {
    if (input.runId === nativeRunId && input.workflowName === 'agentic-loop') {
      enterCleanup();
      await cleanupGate;
      const result = await originalDelete(input);
      cleanupFinished = true;
      return result;
    }
    return originalDelete(input);
  };
  let pages = 0, attachmentId: string | undefined;
  const respond: FauxResponseFactory = async (context, options) => {
    if (phase === 'summary' && getCurrentTools(context.messages).length) {
      assert.ok(attachmentId);
      const source = core.store.db.prepare("SELECT id FROM signals WHERE json_extract(body,'$.contextId')='main' AND status='accepted' ORDER BY rowid LIMIT 1").get(); assert.ok(source);
      const page = pages++;
      return fauxAssistantMessage([fauxToolCall('read_attachment', { id: attachmentId, signalIds: [String(source.id)], encoding: 'base64', byteOffset: page * 32768, maxBytes: 32768 }, { id: `cleanup-page-${page}` })], { stopReason: 'toolUse' });
    }
    enterModel();
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options?.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  };
  provider.setResponses(Array.from({ length: 20 }, () => respond));
  try {
    core.providerRegistry.setProvider(provider.provider);
    core.models.save({ id: 'default', name: 'Synthetic', providerId: provider.provider.id, modelId: 'model', defaultThinkingLevel: 'off' });
    if (phase === 'summary') {
      const bytes = Buffer.from(Array.from({ length: 6 * 32768 }, (_, index) => index % 251));
      attachmentId = (await core.assets.put(new Response(bytes).body, 'cleanup.bin', undefined, { purpose: 'client-shell-output' })).id;
      core.configure('runtime', { autoCompaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 5000 } });
    }
    const receipt = await core.submitMessage({ content: 'Wait for cancellation.', ...(attachmentId ? { attachments: [attachmentId] } : {}) });
    nativeRunId = receipt.runId!;
    await modelEntered;
    const interrupted = await authenticatedApp(core).request('/contexts/main/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRunId: nativeRunId }) });
    assert.equal(interrupted.status, 202);
    await cleanupEntered;
    const closing = core.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(closed, false, 'the database remains owned until the actual native cleanup finishes');
      assert.equal(cleanupFinished, false);
    } finally { releaseCleanup(); await closing; }
    assert.equal(cleanupFinished, true);
    assert.equal(closed, true);
  } finally { releaseCleanup(); if (!closed) await core.close(); await removeTemp(directory); }
});
