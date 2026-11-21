import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers.js';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, Models } from '@earendil-works/pi-ai';
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { stream as azureResponsesStream } from '@earendil-works/pi-ai/api/azure-openai-responses';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createPiLanguageModel } from '../src/providers/bridge.js';

const model: Model<'anthropic-messages'> = { id: 'synthetic-model', name: 'Synthetic model', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: true, contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const provenance = { api: model.api, provider: model.provider, model: model.id };
const opaque = 'SYNTHETIC-OPAQUE-PAYLOAD';
const signed = 'SYNTHETIC-NON-JSON-SIGNATURE';
function message(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', ...provenance, content, timestamp: 1, stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function bridge(events: AssistantMessageEvent[], target: Model<Api> = model) {
  let captured: Context | undefined;
  const registry = { streamSimple(_model: Model<Api>, context: Context) {
    captured = context;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { for (const event of events) stream.push(event); stream.end(); });
    return stream;
  } } as Pick<Models, 'streamSimple'>;
  return { lm: createPiLanguageModel(registry, target), capture: () => captured! };
}
function textEvents(texts: string[], deltas: string[][]): AssistantMessageEvent[] {
  const m = message(texts.map(text => ({ type: 'text', text })));
  return [{ type: 'start', partial: m }, ...texts.flatMap((text, i): AssistantMessageEvent[] => [
    { type: 'text_start', contentIndex: i, partial: m },
    ...deltas[i]!.map(delta => ({ type: 'text_delta' as const, contentIndex: i, delta, partial: m })),
    { type: 'text_end', contentIndex: i, content: text, partial: m },
  ]), { type: 'done', reason: 'stop', message: m }];
}
async function parts(lm: LanguageModelV4, options: LanguageModelV4CallOptions = { prompt: [] }) {
  const result = await lm.doStream(options);
  const output = []; for await (const part of result.stream) output.push(part);
  return output;
}
for (const [name, deltas] of [['no deltas', []], ['prefix deltas', ['he']], ['full deltas', ['he', 'llo']]] as const) {
  test(`text_end completes authoritative text with ${name}`, async () => {
    const output = await parts(bridge(textEvents(['hello', ' world'], [[...deltas], []])).lm);
    assert.equal(output.filter(p => p.type === 'text-delta').map(p => p.delta).join(''), 'hello world');
    assert.equal(output.filter(p => p.type === 'text-end').length, 2);
  });
}
test('conflicting authoritative text fails explicitly rather than duplicating or swallowing it', async () => {
  await assert.rejects(() => parts(bridge(textEvents(['hello'], [['different']])).lm), /Conflicting Pi text completion/);
});
test('foreign history metadata is ignored while Pi metadata and current options remain validated', async () => {
  const fixture = bridge(textEvents(['ok'], [['ok']]));
  await fixture.lm.doGenerate({ prompt: [{ role: 'assistant', providerOptions: { openai: { itemId: 'msg_native' } }, content: [{ type: 'text', text: 'native history', providerOptions: { openai: { itemId: 'msg_native' } } }] }] });
  assert.equal(fixture.capture().messages[0]?.role, 'assistant');
  await assert.rejects(async () => fixture.lm.doGenerate({ prompt: [], providerOptions: { openai: { itemId: 'msg_native' } } }), /Unsupported provider options/);
  await assert.rejects(async () => fixture.lm.doGenerate({ prompt: [{ role: 'assistant', content: [{ type: 'text', text: 'bad', providerOptions: { pi: { misspelled: true } } }] }] }), /Unsupported Pi provider options/);
});
test('legacy unsigned provenance is not invented and cannot replay stale signatures', async () => {
  const fixture = bridge(textEvents(['ok'], [['ok']]));
  await fixture.lm.doGenerate({ prompt: [{ role: 'assistant', content: [
    { type: 'reasoning', text: 'old thinking', providerOptions: { pi: { thinkingSignature: signed } } },
    { type: 'text', text: 'old answer', providerOptions: { pi: { textSignature: 'old-text-id' } } },
  ] }] });
  const previous = fixture.capture().messages[0]; assert.equal(previous?.role, 'assistant');
  if (previous?.role !== 'assistant') assert.fail();
  assert.notEqual(previous.provider, model.provider);
  assert.notEqual(previous.model, model.id);
  assert.deepEqual(previous.content, [{ type: 'text', text: 'old answer' }]);
});

function sse(frames: Record<string, unknown>[]) {
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function anthropicFrames(kind: 'signed' | 'redacted' | 'tool' | 'text') {
  const blocks = kind === 'redacted' ? [{ type: 'redacted_thinking', data: opaque }, { type: 'text', text: 'valid answer' }]
    : kind === 'signed' ? [{ type: 'thinking', thinking: 'visible reasoning', signature: signed }, { type: 'text', text: 'valid answer' }]
    : kind === 'tool' ? [{ type: 'thinking', thinking: 'visible reasoning', signature: signed }, { type: 'tool_use', id: 'call_fixture', name: 'lookup', input: {} }]
    : [{ type: 'text', text: 'valid answer' }];
  return [
    { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...blocks.flatMap((content_block, index) => [{ type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
  ];
}
function realAnthropic(kinds: Array<'signed' | 'redacted' | 'tool' | 'text'>) {
  const requests: Record<string, unknown>[] = [];
  const contexts: Context[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sse(anthropicFrames(kinds.shift() ?? 'text'));
  };
  const registry = { streamSimple(target: Model<'anthropic-messages'>, context: Context) {
    contexts.push(structuredClone(context));
    return anthropicStream(target, normalizeContext(context), { apiKey: 'synthetic-not-real', fetch, env: {}, cacheRetention: 'none', maxRetries: 0 });
  } } as Pick<Models, 'streamSimple'>;
  return { lm: createPiLanguageModel(registry, model), requests, contexts };
}
function replay(content: Awaited<ReturnType<LanguageModelV4['doGenerate']>>['content']): LanguageModelV4CallOptions['prompt'] {
  return [{ role: 'assistant', content: content.map(part => {
    if (part.type === 'text' || part.type === 'reasoning') return { type: part.type, text: part.text, providerOptions: part.providerMetadata };
    throw new Error('Unexpected fixture content');
  }) }];
}
test('installed Anthropic redacted parser survives bridge, emits no opaque deltas and replays only metadata', async () => {
  const fixture = realAnthropic(['redacted', 'text']);
  const output = await parts(fixture.lm);
  assert.equal(output.filter(p => p.type === 'text-delta').map(p => p.delta).join(''), 'valid answer');
  assert.deepEqual(output.filter(p => p.type === 'reasoning-delta').map(p => p.delta), [''], 'only the empty SDK span-opening delta is permitted');
  const end = output.find(p => p.type === 'reasoning-end'); assert.ok(end);
  assert.equal(end.providerMetadata?.pi?.redacted, true);
  assert.equal(end.providerMetadata?.pi?.thinkingSignature, opaque);
  const prompt: LanguageModelV4CallOptions['prompt'] = [{ role: 'assistant', content: [{ type: 'reasoning', text: '', providerOptions: end.providerMetadata }, { type: 'text', text: 'valid answer', providerOptions: output.find(p => p.type === 'text-end')?.providerMetadata }] }, { role: 'user', content: [{ type: 'text', text: 'continue' }] }];
  await fixture.lm.doGenerate({ prompt });
  const body = fixture.requests[1] as { messages: Array<{ role: string; content: unknown[] }> };
  assert.deepEqual(body.messages.find(m => m.role === 'assistant')?.content[0], { type: 'redacted_thinking', data: opaque });
});
test('same-model Anthropic thinking survives Mastra tool continuation with its native metadata namespace', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const { createTool } = await import('@mastra/core/tools');
  const { z } = await import('zod');
  const fixture = realAnthropic(['tool', 'text']);
  const agent = new Agent({ id: 'provider-contract', name: 'fixture', instructions: 'Answer briefly', model: fixture.lm,
    tools: { lookup: createTool({ id: 'lookup', description: 'Synthetic lookup', inputSchema: z.object({}), execute: async () => 'tool result' }) } });
  const result = await agent.generate('question', { maxSteps: 3 });
  assert.equal(result.text, 'valid answer');
  assert.equal(fixture.requests.length, 2);
  const body = fixture.requests[1] as { messages: Array<{ role: string; content: unknown[] }> };
  assert.deepEqual(body.messages.find(m => m.role === 'assistant')?.content[0], { type: 'thinking', thinking: 'visible reasoning', signature: signed });
});
test('persisted provenance survives a storage restart and Anthropic to Responses reaches HTTP without parsing foreign signature', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const { Memory } = await import('@mastra/memory');
  const { LibSQLStore } = await import('@mastra/libsql');
  const root = await mkdtemp(join(tmpdir(), 'arona-provider-contract-'));
  let storage = new LibSQLStore({ id: 'fixture-store', url: `file:${join(root, 'fixture.db')}` });
  const memoryOptions = { lastMessages: 20, generateTitle: false as const, semanticRecall: false as const, workingMemory: { enabled: false } };
  const conversation = { memory: { thread: 'fixture-thread', resource: 'fixture-resource' } };
  try {
    const origin = realAnthropic(['signed']);
    const first = new Agent({ id: 'provider-contract', name: 'fixture', instructions: 'Answer briefly', model: origin.lm, memory: new Memory({ storage, options: memoryOptions }) });
    assert.equal((await first.generate('question', conversation)).text, 'valid answer');
    await storage.close();
    storage = new LibSQLStore({ id: 'fixture-store', url: `file:${join(root, 'fixture.db')}` });
    const target: Model<'openai-responses'> = { ...model, id: 'responses-model', api: 'openai-responses', provider: 'openai' };
    let calls = 0; let captured: Context | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { input: unknown[] };
      assert.ok(!JSON.stringify(body.input).includes(signed));
      return sse([{ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model: target.id, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }]);
    };
    const registry = { streamSimple(m: Model<'openai-responses'>, context: Context) { captured = structuredClone(context); return responsesStream(m, normalizeContext(context), { apiKey: 'synthetic-not-real', fetch, env: {}, maxRetries: 0 }); } } as Pick<Models, 'streamSimple'>;
    const second = new Agent({ id: 'provider-contract', name: 'fixture', instructions: 'Answer briefly', model: createPiLanguageModel(registry, target), memory: new Memory({ storage, options: memoryOptions }) });
    await second.generate('continue', conversation);
    assert.equal(calls, 1);
    const previous = captured?.messages.find(m => m.role === 'assistant'); assert.ok(previous);
    assert.deepEqual({ api: previous.api, provider: previous.provider, model: previous.model }, provenance);
    assert.deepEqual(previous.content, [{ type: 'text', text: 'valid answer' }]);
  } finally { await storage.close(); await removeTemp(root); }
});
test('native OpenAI SDK item IDs can cross into Pi history without becoming request options', async () => {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const native = createOpenAI({ apiKey: 'synthetic-not-real', baseURL: 'https://fixture.invalid', fetch: async () => Response.json({
    id: 'resp_native', created_at: 1, model: 'native-model', status: 'completed',
    output: [{ type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'native answer', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }) }).responses('native-model');
  const generated = await native.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'question' }] }] });
  const text = generated.content.find(p => p.type === 'text'); assert.equal(text?.providerMetadata?.openai?.itemId, 'msg_native');
  const fixture = bridge(textEvents(['ok'], [['ok']]));
  assert.equal((await fixture.lm.doGenerate({ prompt: replay(generated.content) })).content[0]?.type, 'text');
  const history = fixture.capture().messages[0]; assert.equal(history?.role, 'assistant');
  if (history?.role !== 'assistant') assert.fail();
  assert.deepEqual(history.content, [{ type: 'text', text: 'native answer' }]);
  assert.equal(history.model, '');
});
test('encrypted Responses reasoning stays in metadata and replays through the installed parser', async () => {
  const target: Model<'openai-responses'> = { ...model, api: 'openai-responses', provider: 'openai', id: 'responses-model' };
  const encrypted = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: opaque };
  const answer = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'valid answer', annotations: [] }] };
  const requests: Array<{ input: unknown[] }> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as { input: unknown[] });
    return sse([
      { type: 'response.output_item.added', output_index: 0, item: encrypted },
      { type: 'response.output_item.done', output_index: 0, item: encrypted },
      { type: 'response.output_item.added', output_index: 1, item: { ...answer, content: [] } },
      { type: 'response.output_item.done', output_index: 1, item: answer },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model: target.id, output: [encrypted, answer], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]);
  };
  const registry = { streamSimple(m: Model<'openai-responses'>, context: Context) { return responsesStream(m, normalizeContext(context), { apiKey: 'synthetic-not-real', fetch, env: {}, maxRetries: 0 }); } } as Pick<Models, 'streamSimple'>;
  const lm = createPiLanguageModel(registry, target);
  const output = await parts(lm);
  assert.deepEqual(output.filter(p => p.type === 'reasoning-delta').map(p => p.delta), [''], 'only the empty SDK span-opening delta is permitted');
  assert.equal(output.filter(p => p.type === 'text-delta').map(p => p.delta).join(''), 'valid answer');
  const end = output.find(p => p.type === 'reasoning-end'); assert.ok(end);
  assert.equal(end.providerMetadata?.pi?.thinkingSignature, JSON.stringify(encrypted));
  await lm.doGenerate({ prompt: [{ role: 'assistant', content: [{ type: 'reasoning', text: '', providerOptions: end.providerMetadata }, { type: 'text', text: 'valid answer', providerOptions: output.find(p => p.type === 'text-end')?.providerMetadata }] }] });
  assert.deepEqual(requests[1]?.input[0], encrypted);
});
test('redacted metadata survives Mastra streaming and storage restart without entering summary text', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const { Memory } = await import('@mastra/memory');
  const { LibSQLStore } = await import('@mastra/libsql');
  const { serializeConversation } = await import('../src/compaction.js');
  const root = await mkdtemp(join(tmpdir(), 'arona-provider-redacted-contract-'));
  let storage = new LibSQLStore({ id: 'fixture-redacted-store', url: `file:${join(root, 'fixture.db')}` });
  const memoryOptions = { lastMessages: 20, generateTitle: false as const, semanticRecall: false as const, workingMemory: { enabled: false } };
  const conversation = { memory: { thread: 'redacted-thread', resource: 'fixture-resource' } };
  try {
    const origin = realAnthropic(['redacted']);
    const first = new Agent({ id: 'redacted-contract', name: 'fixture', instructions: 'Answer briefly', model: origin.lm, memory: new Memory({ storage, options: memoryOptions }) });
    const result = await first.stream('question', conversation);
    const chunks = []; for await (const chunk of result.fullStream) chunks.push(chunk);
    assert.equal(await result.text, 'valid answer');
    for (const chunk of chunks) if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') assert.ok(!JSON.stringify(chunk).includes(opaque));
    await storage.close();
    storage = new LibSQLStore({ id: 'fixture-redacted-store', url: `file:${join(root, 'fixture.db')}` });
    const memory = new Memory({ storage, options: memoryOptions });
    const recalled = await memory.recall({ threadId: 'redacted-thread', resourceId: 'fixture-resource' });
    assert.ok(JSON.stringify(recalled.messages).includes(opaque));
    assert.ok(!serializeConversation(recalled.messages).includes(opaque));
    const target = realAnthropic(['text']);
    const second = new Agent({ id: 'redacted-contract', name: 'fixture', instructions: 'Answer briefly', model: target.lm, memory });
    assert.equal((await second.generate('continue', conversation)).text, 'valid answer');
    const body = target.requests[0] as { messages: Array<{ role: string; content: unknown[] }> };
    assert.deepEqual(body.messages.find(m => m.role === 'assistant')?.content[0], { type: 'redacted_thinking', data: opaque });
  } finally { await storage.close(); await removeTemp(root); }
});
test('direct round-trip metadata retains provenance and rejects conflicting part origins', async () => {
  const generated = await realAnthropic(['signed']).lm.doGenerate({ prompt: [] });
  const prompt = replay(generated.content);
  const fixture = bridge(textEvents(['ok'], [['ok']]));
  await fixture.lm.doGenerate({ prompt });
  const previous = fixture.capture().messages[0]; assert.equal(previous?.role, 'assistant');
  if (previous?.role !== 'assistant') assert.fail();
  assert.deepEqual({ api: previous.api, provider: previous.provider, model: previous.model }, provenance);
  assert.equal(previous.content[0]?.type === 'thinking' && previous.content[0].thinkingSignature, signed);
  const assistant = prompt[0]!; if (assistant.role !== 'assistant') assert.fail();
  const part = assistant.content[1]!;
  part.providerOptions = { pi: { provenance: { ...provenance, model: 'other-model' } } };
  await assert.rejects(async () => fixture.lm.doGenerate({ prompt }), /Conflicting Pi provenance/);
});

for (const kind of ['text', 'thinking'] as const) {
  for (const [name, prefix, deltas] of [
    ['prefilled prefix and suffix delta', 'he', ['llo']],
    ['prefilled repeated prefix', 'ha', ['ha']],
    ['complete deltas', '', ['he', 'llo']],
    ['no deltas', '', []],
    ['prefilled complete body', 'hello', []],
  ] as const) {
    test(`${kind} start supports ${name} across multiple snapshot blocks`, async () => {
      const expected = name === 'prefilled repeated prefix' ? 'haha' : 'hello';
      const content = (text: string): AssistantMessage['content'] => kind === 'text' ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: text }];
      const events: AssistantMessageEvent[] = [];
      const final = message([...content(expected), ...content(' world')]);
      let body = prefix;
      events.push({ type: `${kind}_start`, contentIndex: 0, partial: message(content(body)) });
      for (const delta of deltas) {
        body += delta;
        events.push({ type: `${kind}_delta`, contentIndex: 0, delta, partial: message(content(body)) });
      }
      events.push({ type: `${kind}_end`, contentIndex: 0, content: expected, partial: message(content(expected)) });
      events.push({ type: `${kind}_start`, contentIndex: 1, partial: message([...content(expected), ...content(' world')]) });
      events.push({ type: `${kind}_end`, contentIndex: 1, content: ' world', partial: structuredClone(final) });
      events.push({ type: 'done', reason: 'stop', message: final });
      const output = await parts(bridge(events).lm);
      const deltaType = kind === 'text' ? 'text-delta' : 'reasoning-delta';
      assert.equal(output.flatMap(p => p.type === deltaType && 'delta' in p ? [p.delta] : []).join(''), expected + ' world');
      assert.equal(output.filter(p => p.type === (kind === 'text' ? 'text-end' : 'reasoning-end')).length, 2);
      const starts = output.findIndex(p => p.type === (kind === 'text' ? 'text-start' : 'reasoning-start'));
      if (prefix) assert.deepEqual(output[starts + 1], { type: deltaType, id: '0', delta: prefix });
    });
  }
  test(`${kind} prefilled prefix still rejects conflicting final content`, async () => {
    const initial = message(kind === 'text' ? [{ type: 'text', text: 'prefix' }] : [{ type: 'thinking', thinking: 'prefix' }]);
    const final = message(kind === 'text' ? [{ type: 'text', text: 'different' }] : [{ type: 'thinking', thinking: 'different' }]);
    await assert.rejects(() => parts(bridge([
      { type: `${kind}_start`, contentIndex: 0, partial: initial },
      { type: `${kind}_end`, contentIndex: 0, content: 'different', partial: final },
      { type: 'done', reason: 'stop', message: final },
    ]).lm), /Conflicting Pi (text|reasoning) completion/);
  });
}

for (const api of ['openai-responses', 'azure-openai-responses'] as const) {
  test(`${api} staged installed parser backfills final encrypted metadata before one end and HTTP replay`, async () => {
    const target: Model<typeof api> = { ...model, api, provider: api === 'openai-responses' ? 'openai' : 'azure-openai-responses', id: 'responses-model' };
    const provisional = { type: 'reasoning', id: 'rs_staged', summary: [{ type: 'summary_text', text: 'visible summary' }] };
    const encrypted = { ...provisional, encrypted_content: opaque };
    const answer = { type: 'message', id: 'msg_staged', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'valid answer', annotations: [] }] };
    const requests: Array<{ input: unknown[] }> = [];
    let release!: () => void;
    const terminal = new Promise<void>(resolve => { release = resolve; });
    let ended!: () => void;
    const itemEnded = new Promise<void>(resolve => { ended = resolve; });
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as { input: unknown[] });
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ async start(controller) {
        const send = (frame: Record<string, unknown>) => controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
        send({ type: 'response.output_item.added', output_index: 0, item: provisional });
        send({ type: 'response.output_item.done', output_index: 0, item: provisional });
        if (requests.length === 1) await terminal;
        send({ type: 'response.output_item.added', output_index: 1, item: { ...answer, content: [] } });
        send({ type: 'response.output_item.done', output_index: 1, item: answer });
        send({ type: 'response.completed', response: { id: 'resp_staged', status: 'completed', model: target.id, output: [encrypted, answer], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
    const registry = { streamSimple(m: Model<typeof api>, context: Context) {
      const source = api === 'openai-responses'
        ? responsesStream(m as Model<'openai-responses'>, normalizeContext(context), { apiKey: 'synthetic-not-real', fetch, env: {}, maxRetries: 0 })
        : azureResponsesStream(m as Model<'azure-openai-responses'>, normalizeContext(context), { apiKey: 'synthetic-not-real', fetch, env: {}, maxRetries: 0 });
      // Snapshot before forwarding, then pause before response.completed. This prevents
      // shared partial-message references from accidentally hiding early metadata copies.
      return { async *[Symbol.asyncIterator]() {
        for await (const event of source) {
          yield structuredClone(event);
          if (event.type === 'thinking_end') ended();
        }
      } };
    } } as unknown as Pick<Models, 'streamSimple'>;
    const lm = createPiLanguageModel(registry, target);
    const observed: Awaited<ReturnType<typeof parts>> = [];
    const pending = (async () => {
      const { stream } = await lm.doStream({ prompt: [] });
      for await (const part of stream) observed.push(structuredClone(part));
      return observed;
    })();
    await itemEnded;
    try {
      assert.ok(observed.some(p => p.type === 'reasoning-start'));
      assert.equal(observed.filter(p => p.type === 'reasoning-end').length, 0);
      assert.ok(!JSON.stringify(observed).includes(opaque));
    } finally { release(); }
    const output = await pending;
    assert.equal(output.filter(p => p.type === 'reasoning-end').length, 1);
    const end = output.find(p => p.type === 'reasoning-end'); assert.ok(end);
    assert.equal(end.providerMetadata?.pi?.thinkingSignature, JSON.stringify(encrypted));
    for (const p of output) if (p.type === 'text-delta' || p.type === 'reasoning-delta') assert.ok(!p.delta.includes(opaque));
    assert.equal(output.filter(p => p.type === 'reasoning-delta').map(p => p.delta).join(''), 'visible summary');
    await lm.doGenerate({ prompt: [{ role: 'assistant', content: [
      { type: 'reasoning', text: 'visible summary', providerOptions: end.providerMetadata },
      { type: 'text', text: 'valid answer', providerOptions: output.find(p => p.type === 'text-end')?.providerMetadata },
    ] }] });
    assert.deepEqual(requests[1]?.input[0], encrypted);
  });
}

test('every completed block takes final snapshot metadata while generated tool order stays intact', async () => {
  const early = message([
    { type: 'text', text: 'before', textSignature: 'old-text' },
    { type: 'thinking', thinking: 'visible', thinkingSignature: 'old-thinking' },
    { type: 'toolCall', id: 'call-final', name: 'lookup', arguments: {}, thoughtSignature: 'old-tool' },
    { type: 'text', text: 'after', textSignature: 'old-after' },
  ]);
  const final = message([
    { type: 'text', text: 'before', textSignature: 'final-text' },
    { type: 'thinking', thinking: 'visible', thinkingSignature: 'final-thinking' },
    { type: 'toolCall', id: 'call-final', name: 'lookup', arguments: {}, thoughtSignature: 'final-tool' },
    { type: 'text', text: 'after', textSignature: 'final-after' },
  ]);
  const call = early.content[2]; if (call?.type !== 'toolCall') assert.fail();
  const generated = await bridge([
    { type: 'text_start', contentIndex: 0, partial: structuredClone(early) },
    { type: 'text_end', contentIndex: 0, content: 'before', partial: structuredClone(early) },
    { type: 'thinking_start', contentIndex: 1, partial: structuredClone(early) },
    { type: 'thinking_end', contentIndex: 1, content: 'visible', partial: structuredClone(early) },
    { type: 'toolcall_start', contentIndex: 2, partial: structuredClone(early) },
    { type: 'toolcall_end', contentIndex: 2, toolCall: call, partial: structuredClone(early) },
    { type: 'text_start', contentIndex: 3, partial: structuredClone(early) },
    { type: 'text_end', contentIndex: 3, content: 'after', partial: structuredClone(early) },
    { type: 'done', reason: 'stop', message: final },
  ]).lm.doGenerate({ prompt: [] });
  assert.deepEqual(generated.content.map(p => p.type), ['text', 'reasoning', 'tool-call', 'text']);
  assert.deepEqual(generated.content.map(p => p.providerMetadata?.pi), [
    { provenance, textSignature: 'final-text' }, { provenance, thinkingSignature: 'final-thinking' },
    { provenance, thoughtSignature: 'final-tool' }, { provenance, textSignature: 'final-after' },
  ]);
  assert.equal(generated.content[1]?.providerMetadata?.anthropic?.signature, 'final-thinking');
  assert.ok(!JSON.stringify(generated).includes('old-'));
});

for (const kind of ['text', 'thinking'] as const) {
  test(`installed Anthropic parser combines a prefilled ${kind} prefix with later deltas`, async () => {
    const fetch: typeof globalThis.fetch = async () => sse([
      { type: 'message_start', message: { id: 'prefill-fixture', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: kind === 'text' ? { type: 'text', text: 'he' } : { type: 'thinking', thinking: 'he', signature: signed } },
      { type: 'content_block_delta', index: 0, delta: kind === 'text' ? { type: 'text_delta', text: 'llo' } : { type: 'thinking_delta', thinking: 'llo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
    ]);
    const registry = { streamSimple(target: Model<'anthropic-messages'>, context: Context) {
      return anthropicStream(target, normalizeContext(context), { apiKey: 'synthetic-not-real', fetch, env: {}, cacheRetention: 'none', maxRetries: 0 });
    } } as Pick<Models, 'streamSimple'>;
    const generated = await createPiLanguageModel(registry, model).doGenerate({ prompt: [] });
    const first = generated.content[0];
    assert.equal(first?.type, kind === 'text' ? 'text' : 'reasoning');
    assert.ok(first?.type === 'text' || first?.type === 'reasoning');
    assert.equal(first.text, 'hello');
  });
  test(`${kind} prefilled initial body is available before completion`, async () => {
    const source = createAssistantMessageEventStream();
    const registry = { streamSimple() { return source; } } as Pick<Models, 'streamSimple'>;
    const { stream } = await createPiLanguageModel(registry, model).doStream({ prompt: [] });
    const reader = stream.getReader();
    assert.equal((await reader.read()).value?.type, 'stream-start');
    const initial = message(kind === 'text' ? [{ type: 'text', text: 'he' }] : [{ type: 'thinking', thinking: 'he' }]);
    source.push({ type: `${kind}_start`, contentIndex: 0, partial: initial });
    assert.equal((await reader.read()).value?.type, kind === 'text' ? 'text-start' : 'reasoning-start');
    assert.deepEqual((await reader.read()).value, { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: '0', delta: 'he' });
    const final = message(kind === 'text' ? [{ type: 'text', text: 'hello' }] : [{ type: 'thinking', thinking: 'hello', thinkingSignature: signed }]);
    source.push({ type: `${kind}_delta`, contentIndex: 0, delta: 'llo', partial: final });
    assert.deepEqual((await reader.read()).value, { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: '0', delta: 'llo' });
    source.push({ type: `${kind}_end`, contentIndex: 0, content: 'hello', partial: final });
    source.push({ type: 'done', reason: 'stop', message: final });
    assert.equal((await reader.read()).value?.type, kind === 'text' ? 'text-end' : 'reasoning-end');
    assert.equal((await reader.read()).value?.type, 'finish');
    assert.equal((await reader.read()).done, true);
  });
}

test('redacted initial body and later deltas remain opaque until final metadata', async () => {
  const initial = message([{ type: 'thinking', thinking: opaque, redacted: true, thinkingSignature: 'old-opaque' }]);
  const final = message([{ type: 'thinking', thinking: opaque + '-suffix', redacted: true, thinkingSignature: opaque }]);
  const output = await parts(bridge([
    { type: 'thinking_start', contentIndex: 0, partial: initial },
    { type: 'thinking_delta', contentIndex: 0, delta: '-suffix', partial: structuredClone(final) },
    { type: 'thinking_end', contentIndex: 0, content: opaque + '-suffix', partial: structuredClone(final) },
    { type: 'done', reason: 'stop', message: final },
  ]).lm);
  assert.deepEqual(output.filter(p => p.type === 'reasoning-delta').map(p => p.delta), [''], 'only the empty SDK span-opening delta is permitted');
  assert.equal(output.find(p => p.type === 'reasoning-end')?.providerMetadata?.pi?.thinkingSignature, opaque);
  assert.equal(output.filter(p => p.type === 'reasoning-end').length, 1);
  assert.ok(!JSON.stringify(output.filter(p => p.type !== 'reasoning-end')).includes(opaque));
});

for (const kind of ['text', 'thinking'] as const) {
  test(`${kind} conflicting terminal message cannot replace the completed body`, async () => {
    const early = message(kind === 'text' ? [{ type: 'text', text: 'hello' }] : [{ type: 'thinking', thinking: 'hello' }]);
    const final = message(kind === 'text' ? [{ type: 'text', text: 'different' }] : [{ type: 'thinking', thinking: 'different' }]);
    await assert.rejects(() => parts(bridge([
      { type: `${kind}_start`, contentIndex: 0, partial: early },
      { type: `${kind}_end`, contentIndex: 0, content: 'hello', partial: structuredClone(early) },
      { type: 'done', reason: 'stop', message: final },
    ]).lm), /Conflicting Pi final (text|reasoning)/);
  });
}

function prefillFrames(kind: 'text' | 'thinking', prefix: string, deltas: readonly string[]) {
  return [
    { type: 'message_start', message: { id: 'registry-prefill', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: kind === 'text' ? { type: 'text', text: prefix } : { type: 'thinking', thinking: prefix, signature: signed } },
    ...deltas.map(delta => ({ type: 'content_block_delta', index: 0, delta: kind === 'text' ? { type: 'text_delta', text: delta } : { type: 'thinking_delta', thinking: delta } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: opaque } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: ' tail' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
  ];
}
async function actualRegistry() {
  const { createModels, createProvider, InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  const { anthropicMessagesApi } = await import('@earendil-works/pi-ai/api/anthropic-messages.lazy');
  const provider = createProvider({ id: model.provider, name: 'Fixture', baseUrl: model.baseUrl, models: [model], api: anthropicMessagesApi(), auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'synthetic-only-key' }, source: 'fixture' }) } } });
  const registry = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } }); registry.setProvider(provider);
  return { registry, provider };
}
function scheduledSse(frames: Record<string, unknown>[], delivery: 'batched' | 'per-frame' | 'mixed') {
  const encoder = new TextEncoder(); let index = 0;
  return new Response(new ReadableStream({ async pull(controller) {
    if (delivery !== 'batched') await new Promise<void>(resolve => setImmediate(resolve));
    const count = delivery === 'batched' ? frames.length : delivery === 'mixed' ? 3 : 1;
    for (let n = 0; n < count && index < frames.length; n++) {
      const frame = frames[index++]!; controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
    }
    if (index === frames.length) controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
for (const kind of ['text', 'thinking'] as const) for (const delivery of ['batched', 'per-frame', 'mixed'] as const) {
  for (const [variant, prefix, deltas] of [
    ['multiple suffix deltas', 'prefix ', ['s', 'uf', 'fix']],
    ['full deltas', '', ['pre', 'fix ', 's', 'uf', 'fix']],
    ['no deltas', 'prefix suffix', []],
    ['repeated prefix', 'ha', ['ha']],
  ] as const) test(`actual Pi registry and Core accept ${delivery} prefilled ${kind}: ${variant}`, { timeout: 30000 }, async () => {
    const { Core } = await import('../src/core.js');
    const { finished, removeTemp } = await import('./helpers.js');
    const directory = await mkdtemp(join(tmpdir(), 'arona-registry-prefill-'));
    const originalFetch = globalThis.fetch; const requests: Array<{ messages: Array<{ role: string; content: Array<{ type: string; data?: string }> }> }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/')); requests.push(await request.json() as typeof requests[number]);
      return scheduledSse(prefillFrames(kind, prefix, deltas), delivery);
    };
    const { registry, provider } = await actualRegistry(); const expected = prefix + deltas.join('');
    const direct = await registry.streamSimple(model, { messages: [] }).result();
    const first = direct.content[0]; assert.ok(first?.type === 'text' || first?.type === 'thinking');
    assert.equal(first.type === 'text' ? first.text : first.thinking, expected, 'installed registry accepts the SSE');
    const core = await Core.open({ dataDir: directory, controlToken: 'prefill-fixture-control-'.repeat(3), memoryEnabled: false });
    try {
      core.providerRegistry.setProvider(provider); core.models.save({ id: 'default', name: 'Fixture', providerId: model.provider, modelId: model.id });
      const receipt = await core.submitMessage({ content: 'fixture question' });
      const run = await finished(core, receipt.runId!); assert.equal(run?.status, 'succeeded', 'actual Core must not reject valid prefill');
      const snapshot = core.projectMemory.snapshot(receipt.runId!); assert.ok(JSON.stringify(snapshot.nativeMessages).includes(expected));
      const generated = await createPiLanguageModel(registry, model).doGenerate({ prompt: [] });
      assert.deepEqual(generated.content.map(p => p.type), [kind === 'text' ? 'text' : 'reasoning', 'reasoning', 'text']);
      const body = generated.content[0]; assert.ok(body?.type === 'text' || body?.type === 'reasoning'); assert.equal(body.text, expected);
      assert.equal(generated.content[1]?.providerMetadata?.pi?.thinkingSignature, opaque);
      for (const part of generated.content) if (part.type === 'text' || part.type === 'reasoning') assert.ok(!part.text.includes(opaque));
      await createPiLanguageModel(registry, model).doGenerate({ prompt: replay(generated.content) });
      assert.ok(requests.at(-1)?.messages.some(m => m.role === 'assistant' && m.content.some(p => p.type === 'redacted_thinking' && p.data === opaque)));
    } finally { await core.close(); globalThis.fetch = originalFetch; await removeTemp(directory); }
  });
}

for (const kind of ['text', 'thinking'] as const) test(`actual lazy registry streams visible ${kind} before HTTP completion`, { timeout: 15000 }, async () => {
  const { until } = await import('./helpers.js');
  const originalFetch = globalThis.fetch; const { registry } = await actualRegistry();
  let release!: () => void; const terminal = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (input, init) => {
    assert.ok(new Request(input, init).url.startsWith('https://fixture.invalid/'));
    const frames = prefillFrames(kind, 'prefix ', ['s', 'uf', 'fix']); const encoder = new TextEncoder(); let index = 0;
    return new Response(new ReadableStream({ async pull(controller) {
      if (index === 3) await terminal;
      const frame = frames[index++]!; controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
      if (index === frames.length) controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const output: Awaited<ReturnType<typeof parts>> = [];
  const pending = (async () => {
    const { stream } = await createPiLanguageModel(registry, model).doStream({ prompt: [] });
    for await (const part of stream) output.push(part);
  })();
  const deltaType = kind === 'text' ? 'text-delta' : 'reasoning-delta';
  const visible = () => output.flatMap(p => p.type === deltaType && 'delta' in p ? [p.delta] : []).join('');
  try {
    await until(visible, text => text === 'prefix s', 3000);
    assert.ok(!output.some(p => p.type === 'finish'), 'first delta is visible while provider completion is blocked');
    release(); await pending; assert.equal(visible(), kind === 'text' ? 'prefix suffix tail' : 'prefix suffix');
    assert.equal(output.filter(p => p.type === 'reasoning-end').at(-1)?.providerMetadata?.pi?.thinkingSignature, opaque);
  } finally { release(); await pending; globalThis.fetch = originalFetch; }
});

for (const kind of ['text', 'thinking'] as const) test(`${kind} ignores stale partial prefixes but rejects divergent snapshots and invalid delta evidence`, async () => {
  const content = (body: string) => message(kind === 'text' ? [{ type: 'text', text: body }] : [{ type: 'thinking', thinking: body }]);
  const final = content('prefix suffix');
  const events: AssistantMessageEvent[] = [
    { type: `${kind}_start`, contentIndex: 0, partial: content('prefix s') },
    { type: `${kind}_delta`, contentIndex: 0, delta: 's', partial: content('prefix ') },
    { type: `${kind}_delta`, contentIndex: 0, delta: 'uf', partial: final },
    { type: `${kind}_delta`, contentIndex: 0, delta: 'fix', partial: content('prefix suf') },
    { type: `${kind}_end`, contentIndex: 0, content: 'prefix suffix', partial: final },
    { type: 'done', reason: 'stop', message: final },
  ];
  const output = await parts(bridge(events).lm);
  assert.equal(output.flatMap(p => p.type === (kind === 'text' ? 'text-delta' : 'reasoning-delta') && 'delta' in p ? [p.delta] : []).join(''), 'prefix suffix');
  const divergent = structuredClone(events); (divergent[2] as Extract<AssistantMessageEvent, { type: 'text_delta' | 'thinking_delta' }>).partial = content('divergent');
  await assert.rejects(() => parts(bridge(divergent).lm), /Conflicting Pi (text|reasoning) completion/);
  const invalid = structuredClone(events); (invalid[2] as Extract<AssistantMessageEvent, { type: 'text_delta' | 'thinking_delta' }>).delta = 'not-the-body';
  await assert.rejects(() => parts(bridge(invalid).lm), /Conflicting Pi (text|reasoning) completion/);
});

for (const api of ['openai-responses', 'azure-openai-responses'] as const) test(`actual ${api} registry and Core retain terminal-only encrypted content after restart`, { timeout: 30000 }, async () => {
  const { createProvider } = await import('@earendil-works/pi-ai');
  const { openAIResponsesApi } = await import('@earendil-works/pi-ai/api/openai-responses.lazy');
  const { azureOpenAIResponsesApi } = await import('@earendil-works/pi-ai/api/azure-openai-responses.lazy');
  const { Core } = await import('../src/core.js'); const { finished, removeTemp } = await import('./helpers.js');
  const { serializeConversation } = await import('../src/compaction.js');
  const target: Model<typeof api> = { ...model, api, provider: api === 'openai-responses' ? 'openai' : 'azure-openai-responses', id: 'responses-model' };
  const provisional = { type: 'reasoning', id: 'rs_registry', summary: [{ type: 'summary_text', text: 'visible summary' }] };
  const encrypted = { ...provisional, encrypted_content: opaque };
  const answer = { type: 'message', id: 'msg_registry', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'valid answer', annotations: [] }] };
  const provider = createProvider({ id: target.provider, name: 'Fixture', baseUrl: target.baseUrl, models: [target], api: api === 'openai-responses' ? openAIResponsesApi() : azureOpenAIResponsesApi(), auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'synthetic-only-key' }, source: 'fixture' }) } } });
  const directory = await mkdtemp(join(tmpdir(), 'arona-registry-encrypted-')); const originalFetch = globalThis.fetch;
  const requests: Array<{ input: unknown[] }> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/')); requests.push(await request.json() as typeof requests[number]);
    return scheduledSse([
      { type: 'response.output_item.added', output_index: 0, item: provisional },
      { type: 'response.output_item.done', output_index: 0, item: provisional },
      { type: 'response.output_item.added', output_index: 1, item: { ...answer, content: [] } },
      { type: 'response.output_item.done', output_index: 1, item: answer },
      { type: 'response.completed', response: { id: 'resp_registry', status: 'completed', model: target.id, output: [encrypted, answer], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ], 'per-frame');
  };
  let core: Awaited<ReturnType<typeof Core.open>> | undefined;
  try {
    for (let pass = 0; pass < 2; pass++) {
      core = await Core.open({ dataDir: directory, controlToken: 'encrypted-fixture-control-'.repeat(3), memoryEnabled: false });
      core.providerRegistry.setProvider(provider); core.models.save({ id: 'default', name: 'Fixture', providerId: target.provider, modelId: target.id });
      const receipt = await core.submitMessage({ content: pass ? 'continue after restart' : 'first question' });
      assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded');
      const native = core.projectMemory.snapshot(receipt.runId!).nativeMessages as { messages: import('../src/compaction.js').NativeMessage[] };
      assert.ok(JSON.stringify(native).includes(opaque)); assert.ok(!serializeConversation(native.messages).includes(opaque));
      assert.ok(!JSON.stringify(await core.history('main')).includes(opaque));
      if (pass) assert.deepEqual(requests.at(-1)?.input.find(item => (item as { type: string }).type === 'reasoning'), encrypted);
      await core.close(); core = undefined;
    }
  } finally { await core?.close(); globalThis.fetch = originalFetch; await removeTemp(directory); }
});

for (const [api, body, finalBody] of [
  ['openai-responses', 'body  ', 'body'],
  ['openai-responses', 'body\n\n\n\n', 'body'],
  ['azure-openai-responses', 'body\n\n ', 'body'],
  ['openai-responses', 'body\t', 'body'],
  ['azure-openai-responses', 'first\n\nsecond', 'firstsecond'],
  ['openai-responses', 'original\n\n', 'replacement'],
  ['azure-openai-responses', 'body \t\n\n', 'body'],
  ['anthropic-messages', 'body\n\n', 'body'],
] as const) test(`${api} must not normalize real body whitespace conflicts`, async () => {
  const initial = message([{ type: 'thinking', thinking: body }]);
  const final = message([{ type: 'thinking', thinking: finalBody }]);
  await assert.rejects(() => parts(bridge([
    { type: 'thinking_start', contentIndex: 0, partial: initial },
    { type: 'thinking_delta', contentIndex: 0, delta: body, partial: initial },
    { type: 'thinking_end', contentIndex: 0, content: finalBody, partial: final },
    { type: 'done', reason: 'stop', message: final },
  ], { ...model, api }).lm), /Conflicting Pi reasoning completion/);
});

for (const api of ['openai-responses', 'azure-openai-responses'] as const) {
  for (const [name, signature, native] of [
    ['encrypted item', JSON.stringify({ type: 'reasoning', id: 'rs_identity', encrypted_content: opaque, summary: [] }), { itemId: 'rs_identity', reasoningEncryptedContent: opaque }],
    ['identity only', JSON.stringify({ type: 'reasoning', id: 'rs_identity', summary: [] }), { itemId: 'rs_identity' }],
    ['null encrypted content', JSON.stringify({ type: 'reasoning', id: 'rs_identity', encrypted_content: null }), { itemId: 'rs_identity', reasoningEncryptedContent: null }],
    ['non-JSON signature', signed, undefined],
    ['non-object signature', 'null', undefined],
    ['array signature', '[]', undefined],
    ['missing identity', JSON.stringify({ type: 'reasoning', encrypted_content: opaque }), undefined],
    ['empty identity', JSON.stringify({ type: 'reasoning', id: '', encrypted_content: opaque }), undefined],
    ['non-reasoning identity', JSON.stringify({ type: 'message', id: 'msg_identity', encrypted_content: opaque }), undefined],
    ['invalid encrypted content', JSON.stringify({ type: 'reasoning', id: 'rs_identity', encrypted_content: {} }), { itemId: 'rs_identity' }],
  ] as const) test(`${api} mirrors only real native reasoning metadata: ${name}`, async () => {
    const final = { ...message([{ type: 'thinking', thinking: '', thinkingSignature: signature }]), api };
    const generated = await bridge([
      { type: 'thinking_start', contentIndex: 0, partial: final },
      { type: 'thinking_end', contentIndex: 0, content: '', partial: final },
      { type: 'done', reason: 'stop', message: final },
    ], { ...model, api }).lm.doGenerate({ prompt: [] });
    const metadata = generated.content[0]?.providerMetadata; const namespace = api === 'openai-responses' ? 'openai' : 'azure';
    assert.deepEqual(metadata?.[namespace], native);
    assert.equal(metadata?.[namespace === 'openai' ? 'azure' : 'openai'], undefined);
    assert.equal(metadata?.anthropic, undefined);
    assert.deepEqual(metadata?.pi, { provenance: { ...provenance, api }, thinkingSignature: signature });
  });
  for (const body of ['body\n\n', 'body\n\n\n\n', 'body \t', 'first\n\nsecond  ']) {
    test(`${api} preserves authoritative business whitespace ${JSON.stringify(body)}`, async () => {
      const final = message([{ type: 'thinking', thinking: body }]);
      const output = await parts(bridge([
        { type: 'thinking_start', contentIndex: 0, partial: final },
        { type: 'thinking_delta', contentIndex: 0, delta: body, partial: final },
        { type: 'thinking_end', contentIndex: 0, content: body, partial: final },
        { type: 'done', reason: 'stop', message: final },
      ], { ...model, api }).lm);
      assert.equal(output.flatMap(p => p.type === 'reasoning-delta' ? [p.delta] : []).join(''), body);
    });
  }
}
