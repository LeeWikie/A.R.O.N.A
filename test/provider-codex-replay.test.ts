import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers.js';
import { zstdDecompressSync } from 'node:zlib';
import { Agent } from '@mastra/core/agent';
import { MessageList } from '@mastra/core/agent/message-list';
import { RequestContext } from '@mastra/core/request-context';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { Model, Models } from '@earendil-works/pi-ai';
import { stream as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createPiLanguageModel } from '../src/providers/bridge.js';
import { completeHistory } from '../src/context-history.js';

const opaque = 'SYNTHETIC-CODEX-ENCRYPTED-HISTORY';
const reasoning = { type: 'reasoning', id: 'rs_synthetic', summary: [], encrypted_content: opaque };
const provenance = { api: 'openai-codex-responses', provider: 'openai-codex', model: 'synthetic-codex' } as const;
const model: Model<'openai-codex-responses'> = { ...provenance, id: provenance.model, name: 'Synthetic Codex', baseUrl: 'https://fixture.invalid/backend-api', input: ['text'], reasoning: true,
  contextWindow: 64000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const token = `aaa.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64')}.bbb`;
function fixture(onlyReasoning = false) {
  const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
    let bytes = Buffer.from(await request.arrayBuffer());
    if (request.headers.get('content-encoding') === 'zstd') bytes = zstdDecompressSync(bytes);
    requests.push(JSON.parse(bytes.toString('utf8')));
    const answer = { type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] };
    const frames = onlyReasoning ? [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: reasoning.id, summary: [] } },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', model: model.id, output: [reasoning], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ] : [
      { type: 'response.output_item.added', output_index: 0, item: { ...answer, content: [] } },
      { type: 'response.output_item.done', output_index: 0, item: answer },
      { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', model: model.id, output: [answer], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const registry: Pick<Models, 'streamSimple'> = { streamSimple(target, context, options) {
    return codexStream(target as Model<'openai-codex-responses'>, normalizeContext(context), { ...options, apiKey: token, fetch, transport: 'sse', maxRetries: 0 });
  } };
  return { lm: createPiLanguageModel(registry, model), requests };
}

test('native Codex terminal-only encrypted reasoning remains in the actual next request after message storage conversion', async () => {
  const first = fixture(true), generated = await first.lm.doGenerate({ prompt: [] });
  const block = generated.content[0]; assert.equal(block?.type, 'reasoning');
  assert.ok(block && 'providerMetadata' in block);
  const list = new MessageList({ threadId: 'synthetic', resourceId: 'synthetic' });
  list.add([{ role: 'assistant', content: [{ type: 'reasoning', text: '', providerOptions: block.providerMetadata }] }, { role: 'user', content: 'continue' }], 'memory');
  const prompt = await list.get.all.aiV5.llmPrompt({ targetProvider: model.provider });
  assert.equal(prompt[0]?.role, 'assistant', 'a valid opaque-only turn must not silently disappear');
  const next = fixture();
  const agent = new Agent({ id: 'codex-replay-fixture', name: 'Synthetic', instructions: 'Answer the synthetic question.', model: next.lm });
  await agent.generate(prompt);
  assert.deepEqual(next.requests[0]?.input.find(part => part.type === 'reasoning'), reasoning);
  assert.ok(!JSON.stringify(generated.content.map(part => 'text' in part ? part.text : '')).includes(opaque));
});

test('legacy Codex encrypted history survives native durable recall and is repaired only for the model view', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arona-codex-recall-'));
  const url = `file:${join(directory, 'memory.sqlite')}`;
  let storage = new LibSQLStore({ id: 'codex-history', url });
  const legacy = new MessageList({ threadId: 'synthetic', resourceId: 'synthetic' });
  legacy.add([{ role: 'assistant', content: [{ type: 'reasoning', text: '', providerOptions: { pi: { provenance, thinkingSignature: JSON.stringify(reasoning) } } }] }], 'memory');
  try {
    let memory = new Memory({ storage, options: { lastMessages: false, semanticRecall: false, workingMemory: { enabled: false } } });
    await memory.createThread({ threadId: 'synthetic', resourceId: 'synthetic' });
    await memory.saveMessages({ messages: legacy.get.all.db() });
    await storage.close(); storage = new LibSQLStore({ id: 'codex-history-reopen', url });
    memory = new Memory({ storage, options: { lastMessages: false, semanticRecall: false, workingMemory: { enabled: false } } });
    const before = (await memory.recall({ threadId: 'synthetic', page: 0, perPage: 100 })).messages;
    const raw = JSON.stringify(before[0]?.content);
    const next = fixture();
    const agent = new Agent({ id: 'codex-history-fixture', name: 'Synthetic', instructions: 'Answer the synthetic question.', model: next.lm, memory, inputProcessors: [completeHistory(memory)] });
    const requestContext = new RequestContext(); requestContext.set('controller', { threadId: 'synthetic' });
    await agent.generate('continue', { memory: { thread: 'synthetic', resource: 'synthetic' }, requestContext });
    assert.deepEqual(next.requests[0]?.input.find(part => part.type === 'reasoning'), reasoning);
    const after = (await memory.recall({ threadId: 'synthetic', page: 0, perPage: 100 })).messages.find(message => message.id === before[0]?.id);
    assert.equal(JSON.stringify(after?.content), raw, 'request-only repair does not rewrite the original stored record');
  } finally { await storage.close(); await removeTemp(directory); }
});
