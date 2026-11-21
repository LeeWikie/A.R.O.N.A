import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { LibSQLStore } from '@mastra/libsql';
import { removeTemp } from './helpers.js';

const common = createRequire(import.meta.url)('@mastra/core/agent') as typeof import('@mastra/core/agent');
for (const [entry, NativeAgent] of [['esm', Agent], ['cjs', common.Agent]] as const) {
  for (const outcome of ['error', 'cancel'] as const) test(`native ${entry} shutdown drains the original ${outcome} workflow cleanup`, { timeout: 15000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-native-drain-'));
    const storage = new LibSQLStore({ id: 'native-drain', url: 'file:' + path.join(directory, 'history.sqlite') });
    const abort = new AbortController();
    let enterModel!: () => void, finishModel!: () => void, enterCleanup!: () => void, finishCleanup!: () => void;
    const modelEntered = new Promise<void>(resolve => { enterModel = resolve; });
    const modelGate = new Promise<void>(resolve => { finishModel = resolve; });
    const cleanupEntered = new Promise<void>(resolve => { enterCleanup = resolve; });
    const cleanupGate = new Promise<void>(resolve => { finishCleanup = resolve; });
    let cleanupFinished = false, shutdownFinished = false;
    const model = new MastraLanguageModelV2Mock({ doStream: async () => {
      enterModel(); await modelGate; throw new Error('SYNTHETIC_NATIVE_EXECUTION_FAILED');
    } });
    const agent = new NativeAgent({ id: 'native-drain', name: 'Synthetic native drain', instructions: 'Wait for the synthetic result.', model });
    const mastra = new Mastra({ agents: { agent }, storage });
    await storage.init();
    const workflows = await storage.getStore('workflows'); assert.ok(workflows);
    const remove = workflows.deleteWorkflowRunById.bind(workflows);
    workflows.deleteWorkflowRunById = async input => {
      if (input.workflowName === 'agentic-loop') { enterCleanup(); await cleanupGate; }
      const result = await remove(input);
      if (input.workflowName === 'agentic-loop') cleanupFinished = true;
      return result;
    };
    try {
      const output = await agent.stream('Wait.', { abortSignal: abort.signal });
      const consuming = output.consumeStream();
      await modelEntered;
      if (outcome === 'cancel') abort.abort(new DOMException('Cancelled', 'AbortError'));
      finishModel();
      await cleanupEntered;
      const shutdown = mastra.shutdown().then(() => { shutdownFinished = true; });
      try {
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(shutdownFinished, false, 'a terminal error chunk is not native resource completion');
        assert.equal(cleanupFinished, false);
      } finally { finishCleanup(); await shutdown; await consuming; }
      assert.equal(cleanupFinished, true);
    } finally { finishModel(); finishCleanup(); if (!shutdownFinished) await mastra.shutdown(); await storage.close(); await removeTemp(directory); }
  });
}
