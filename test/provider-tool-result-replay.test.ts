import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { Model } from '@earendil-works/pi-ai';
import { convertModelPromptToPi, piToolResultMetadata } from '../src/providers/bridge.js';

const model: Model<'test'> = { id: 'm', name: 'M', provider: 'test', api: 'test', baseUrl: 'https://fixture.invalid', input: ['text', 'image'], reasoning: false, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

test('failed tool results retain both image content and failure state through replay', () => {
  const input: LanguageModelV4CallOptions = { prompt: [{ role: 'tool', content: [{
    type: 'tool-result', toolCallId: 'call', toolName: 'screenshot',
    providerOptions: piToolResultMetadata(true),
    output: { type: 'content', value: [{ type: 'text', text: 'The page could not finish loading.' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQI=' } }] },
  }] }] };
  const result = convertModelPromptToPi(input, model, { transform: false }).messages[0];
  assert.equal(result?.role, 'toolResult');
  if (result?.role !== 'toolResult') assert.fail();
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'The page could not finish loading.' }, { type: 'image', mimeType: 'image/png', data: 'AQI=' }]);
});

test('tool error metadata is restricted to tool results and validates all fields', () => {
  for (const input of [
    { prompt: [{ role: 'assistant', content: [{ type: 'text', text: 'answer', providerOptions: piToolResultMetadata(true) }] }] },
    { prompt: [{ role: 'user', content: [{ type: 'text', text: 'question', providerOptions: piToolResultMetadata(true) }] }] },
    { prompt: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'read', providerOptions: { pi: { isError: 'true' } }, output: { type: 'text', value: 'failure' } }] }] },
    { prompt: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'read', providerOptions: { pi: { isError: true, arbitrary: true } }, output: { type: 'text', value: 'failure' } }] }] },
  ] as LanguageModelV4CallOptions[]) {
    assert.throws(() => convertModelPromptToPi(input, model, { transform: false }), /Unsupported Pi/);
  }
});

test('a denied execution replays as an actual Pi failure result without a tool effect', () => {
  for (const reason of [undefined, 'The user declined this operation.']) {
    const prompt: LanguageModelV4CallOptions = { prompt: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'denied-original-id', toolName: 'write', output: { type: 'execution-denied', ...(reason === undefined ? {} : { reason }) } }] }] };
    const original = structuredClone(prompt);
    const result = convertModelPromptToPi(prompt, model, { transform: false }).messages[0];
    assert.equal(result?.role, 'toolResult');
    if (result?.role !== 'toolResult') assert.fail();
    assert.equal(result.toolCallId, 'denied-original-id'); assert.equal(result.toolName, 'write'); assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: reason ?? 'Tool execution was blocked' }]);
    assert.deepEqual(prompt, original);
  }
});
