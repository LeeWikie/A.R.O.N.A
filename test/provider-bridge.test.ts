import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Models, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiLanguageModel } from '../src/providers/bridge.js';

const model: Model<'test'> = { id: 'm', name: 'M', provider: 'test', api: 'test', baseUrl: 'http://localhost', input: ['text', 'image'], reasoning: true, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function message(): AssistantMessage { return { role: 'assistant', content: [{ type: 'thinking', thinking: 'why', thinkingSignature: 'sig' }, { type: 'text', text: 'hello' }, { type: 'toolCall', id: 'c', name: 'lookup', arguments: { n: 1 }, thoughtSignature: 'ts' }], api: 'test', provider: 'test', model: 'm', timestamp: 1, stopReason: 'toolUse', usage: { input: 10, cacheRead: 3, cacheWrite: 2, output: 7, reasoning: 2, totalTokens: 22, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; }
function fixture(events: AssistantMessageEvent[]) {
  let captured: { context: Context; options?: SimpleStreamOptions } | undefined;
  const models = { streamSimple(_model: Model<string>, context: Context, options?: SimpleStreamOptions) {
    captured = { context, options };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { for (const event of events) stream.push(event); if (!events.some(e => e.type === 'done' || e.type === 'error')) stream.end(); });
    return stream;
  } } as Pick<Models, 'streamSimple'>;
  return { lm: createPiLanguageModel(models, model), capture: () => captured };
}
function events(): AssistantMessageEvent[] {
  const m = message();
  return [ { type: 'start', partial: m }, { type: 'thinking_start', contentIndex: 0, partial: m }, { type: 'thinking_delta', contentIndex: 0, delta: 'why', partial: m }, { type: 'thinking_end', contentIndex: 0, content: 'why', partial: m }, { type: 'text_start', contentIndex: 1, partial: m }, { type: 'text_delta', contentIndex: 1, delta: 'hello', partial: m }, { type: 'text_end', contentIndex: 1, content: 'hello', partial: m }, { type: 'toolcall_start', contentIndex: 2, partial: m }, { type: 'toolcall_delta', contentIndex: 2, delta: '{"n":1}', partial: m }, { type: 'toolcall_end', contentIndex: 2, toolCall: m.content[2] as Extract<AssistantMessage['content'][number], {type: 'toolCall'}>, partial: m }, { type: 'done', reason: 'toolUse', message: m } ];
}

test('streams content and translates usage, signatures and tool calls', async () => {
  const { lm } = fixture(events());
  const result = await lm.doStream({ prompt: [] });
  const parts = []; for await (const part of result.stream) parts.push(part);
  assert.deepEqual(parts.map(p => p.type), ['stream-start', 'response-metadata', 'reasoning-start', 'reasoning-delta', 'reasoning-end', 'text-start', 'text-delta', 'text-end', 'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call', 'finish']);
  assert.deepEqual(parts.find(p => p.type === 'reasoning-end')?.providerMetadata, { pi: { thinkingSignature: 'sig' } });
  const call = parts.find(p => p.type === 'tool-call'); assert.equal(call?.input, '{"n":1}');
  const finish = parts.find(p => p.type === 'finish'); assert.equal(finish?.finishReason.unified, 'tool-calls'); assert.deepEqual(finish?.usage.inputTokens, { total: 15, noCache: 10, cacheRead: 3, cacheWrite: 2 }); assert.equal(finish?.usage.outputTokens.reasoning, 2);
});

test('generates and converts conversation, images, tools and reasoning options', async () => {
  const { lm, capture } = fixture(events());
  const result = await lm.doGenerate({ prompt: [ { role: 'system', content: 'system' }, { role: 'user', content: [{ type: 'text', text: 'question' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1, 2]) } }] }, { role: 'assistant', content: [{ type: 'reasoning', text: 'why', providerOptions: { pi: { thinkingSignature: 'sig' } } }, { type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: { n: 1 } }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'lookup', output: { type: 'error-json', value: { error: 'bad' } } }] } ], tools: [{ type: 'function', name: 'lookup', strict: false, inputSchema: { type: 'object' } }], maxOutputTokens: 42, providerOptions: { pi: { reasoning: 'high' } } });
  assert.equal(result.content[0]?.type, 'reasoning'); assert.equal(result.content[1]?.type, 'text'); assert.equal(result.content[2]?.type, 'tool-call');
  const captured = capture()!; assert.equal(captured.options?.reasoning, 'high'); assert.equal(captured.options?.maxTokens, 42); assert.equal(captured.context.tools?.[0]?.name, 'lookup');
  const user = captured.context.messages[1]; assert.equal(user?.role, 'user'); if (user?.role === 'user' && Array.isArray(user.content)) assert.deepEqual(user.content[1], { type: 'image', data: 'AQI=', mimeType: 'image/png' });
  const assistant = captured.context.messages[2]; if (assistant?.role === 'assistant') assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'why', thinkingSignature: 'sig' }); else assert.fail();
  const tool = captured.context.messages[3]; if (tool?.role === 'toolResult') { assert.equal(tool.isError, true); assert.equal(tool.content[0]?.type, 'text'); } else assert.fail();
});

test('rejects unsupported options, prompt parts and provider failures', async () => {
  const { lm } = fixture([]);
  await assert.rejects(async () => lm.doGenerate({ prompt: [], topP: 0.5 }), /Unsupported option/);
  await assert.rejects(async () => lm.doGenerate({ prompt: [], providerOptions: { pi: { reasoning: 'invalid' } } }), /Unsupported Pi reasoning/);
  await assert.rejects(async () => lm.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'AA==' } }] }] }), /Unsupported user file/);
  await assert.rejects(async () => lm.doGenerate({ prompt: [] }), /without completion/);
  const m = message(); m.errorMessage = 'provider failure'; m.stopReason = 'error';
  await assert.rejects(async () => fixture([{ type: 'error', reason: 'error', error: m }]).lm.doGenerate({ prompt: [] }), /Pi provider error/);
});

test('emits incrementally and propagates cancellation and abort', async () => {
  const source = createAssistantMessageEventStream(); let signal: AbortSignal | undefined;
  const models = { streamSimple(_model: Model<string>, _context: Context, options?: SimpleStreamOptions) { signal = options?.signal; return source; } } as Pick<Models, 'streamSimple'>;
  const lm = createPiLanguageModel(models, model); const ac = new AbortController();
  const result = await lm.doStream({ prompt: [], abortSignal: ac.signal }); const reader = result.stream.getReader();
  assert.equal((await reader.read()).value?.type, 'stream-start');
  const m = message(); source.push({ type: 'start', partial: m }); assert.equal((await reader.read()).value?.type, 'response-metadata');
  ac.abort(); await assert.rejects(() => reader.read(), { name: 'AbortError' }); assert.equal(signal?.aborted, true);
  const result2 = await lm.doStream({ prompt: [] }); const reader2 = result2.stream.getReader(); await reader2.read(); await reader2.cancel(); assert.equal(signal?.aborted, true);
});

test('runs a Mastra agent against the Pi bridge', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const m = message(); m.content = [{ type: 'text', text: 'hello' }]; m.stopReason = 'stop';
  const { lm, capture } = fixture([{ type: 'start', partial: m }, { type: 'text_start', contentIndex: 0, partial: m }, { type: 'text_delta', contentIndex: 0, delta: 'hello', partial: m }, { type: 'text_end', contentIndex: 0, content: 'hello', partial: m }, { type: 'done', reason: 'stop', message: m }]);
  const agent = new Agent({ id: 'bridge-test', name: 'bridge test', instructions: 'Answer briefly', model: lm });
  const result = await agent.generate('Hi');
  assert.equal(result.text, 'hello');
  assert.ok(capture()?.context.messages.some(msg => msg.role === 'user'));
});

test('accepts Mastra message metadata without losing Pi signatures or tool results', async () => {
  const { lm, capture } = fixture(events());
  const meta = { createdAt: 123, author: { id: 'user', name: 'User' }, future: { value: true } };
  await lm.doGenerate({ prompt: [
    { role: 'assistant', providerOptions: { mastra: meta }, content: [
      { type: 'reasoning', text: 'why', providerOptions: { mastra: meta, pi: { thinkingSignature: 'sig' } } },
      { type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: { n: 1 }, providerOptions: { mastra: meta, pi: { thoughtSignature: 'ts' } } },
    ] },
    { role: 'tool', providerOptions: { mastra: meta }, content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'lookup', providerOptions: { mastra: meta }, output: { type: 'text', value: 'ok' } }] },
  ] });
  const messages = capture()!.context.messages;
  const assistant = messages[0]; assert.equal(assistant?.role, 'assistant');
  if (assistant?.role === 'assistant') {
    assert.equal(assistant.content[0]?.type === 'thinking' && assistant.content[0].thinkingSignature, 'sig');
    assert.equal(assistant.content[1]?.type === 'toolCall' && assistant.content[1].thoughtSignature, 'ts');
  }
  assert.equal(messages[1]?.role, 'toolResult');
  assert.equal(capture()!.options?.reasoning, undefined);
  await assert.rejects(async () => lm.doGenerate({ prompt: [], providerOptions: { pi: { reasoning: 'off' } } }), /Unsupported Pi reasoning/);
});
