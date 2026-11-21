import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { finished, removeTemp, until } from './helpers.js';

test('native long reply and unspaced Chinese reasoning reach a real client before model completion, then commit exactly once', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-public-core-capacity-'));
  const reply = 'PUBLIC_REPLY_START\n' + '持续可见的回复内容。'.repeat(160000) + '\nPUBLIC_REPLY_END\n';
  const thinking = '持续显示的中文思考。'.repeat(12000);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    controller.enqueue({ type: 'reasoning-start', id: 'reasoning' }); controller.enqueue({ type: 'reasoning-delta', id: 'reasoning', delta: thinking }); controller.enqueue({ type: 'reasoning-end', id: 'reasoning' });
    controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: reply });
    void gate.then(() => { controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); });
  } }) }) });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false, modelConfig: { protocol: 'responses', baseURL: 'https://fixture.invalid/v1', apiKey: 'fixture-key-never-present-in-response-301', authHeader: 'bearer', modelId: 'fixture', contextWindow: 100000000, maxTokens: 4096 } });
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: createApp(core).fetch }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), controller = new AbortController();
  let ready!: () => void; const opened = new Promise<void>(resolve => { ready = resolve; }); let visible = '', visibleThinking = '';
  const reading = (async () => {
    for await (const frame of client.events({ after: 0, contextId: 'main', signal: controller.signal })) {
      if (frame.type === 'checkpoint') { ready(); continue; }
      const data = frame.event.data as { delta?: string; text?: string };
      if (frame.event.kind === 'reply.delta') visible += data.delta;
      if (frame.event.kind === 'reply.replace') visible = data.text!;
      if (frame.event.kind === 'thinking') visibleThinking += data.delta;
      if (visible === reply && visibleThinking === thinking) return;
    }
  })();
  try {
    await opened;
    const receipt = await core.submitMessage({ content: 'Produce the synthetic streaming response' });
    await until(() => visible === reply && visibleThinking === thinking, Boolean, 20000);
    await reading;
    assert.equal(core.store.getRun(receipt.runId!)!.status, 'running'); assert.equal(core.store.outputsForSignal(receipt.id).length, 0);
    const snapshot = await client.snapshot('main'); assert.equal((snapshot.drafts[0] as { text: string }).text, reply); assert.equal(snapshot.thinking?.[0]?.text, thinking);
    release(); assert.equal((await finished(core, receipt.runId!))!.status, 'succeeded');
    const page = await client.conversation('main'); assert.equal(page.messages.filter(row => row.role === 'assistant').length, 1); assert.equal(page.messages.find(row => row.role === 'assistant')!.content, reply);
  } finally {
    release(); controller.abort(); await reading.catch(() => {});
    if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
  }
});
