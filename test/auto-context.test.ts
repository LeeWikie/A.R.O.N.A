import assert from 'node:assert/strict';
import test from 'node:test';
import { contextCheckpointMatches, contextPrefixHash, estimatePromptTokens, shouldCompactContext, splitContextPrompt, type ContextPrompt } from '../src/auto-context.js';

test('automatic threshold honors enablement, known capacity and the configured reserve', () => {
  assert.equal(shouldCompactContext(8000, 10_000, 2000), false);
  assert.equal(shouldCompactContext(8001, 10_000, 2000), true);
  assert.equal(shouldCompactContext(9000, 10_000, 2000, false), false);
  assert.equal(shouldCompactContext(9000, null, 2000), false);
});

test('compaction splits the model view without changing source records or moving system messages into the summary', () => {
  const prompt: ContextPrompt = [
    { role: 'system', content: 'Current policy' },
    { role: 'user', content: [{ type: 'text', text: 'Earlier request.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier response.' }] },
    { role: 'system', content: 'Current workspace instructions' },
    { role: 'user', content: [{ type: 'text', text: 'Latest request.' }] },
  ];
  const snapshot = structuredClone(prompt), split = splitContextPrompt(prompt, 0)!;
  assert.deepEqual(prompt, snapshot);
  assert.equal(split.cutIndex, 4); assert.equal(split.earlier.length, 2);
  assert.deepEqual(split.system.map(message => message.content), ['Current policy', 'Current workspace instructions']);
  assert.deepEqual(split.recent, [prompt[4]]);
  assert.equal(contextCheckpointMatches(prompt, split), true);
});

test('a tool-call/result pair and pending parallel calls are never split across the retained boundary', () => {
  const prompt: ContextPrompt = [
    { role: 'user', content: [{ type: 'text', text: 'Earlier turn' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'read', input: {} }, { type: 'tool-call', toolCallId: 'b', toolName: 'read', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'read', output: { type: 'text', value: 'First result' } }] },
    { role: 'user', content: [{ type: 'text', text: 'Supplement while tools run' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'read', output: { type: 'text', value: 'Second result' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] },
  ];
  const split = splitContextPrompt(prompt, estimatePromptTokens(prompt.slice(3)))!;
  assert.equal(split.cutIndex, 1, 'retains the pair before the intervening user supplement');
  const pending = structuredClone(prompt); pending.splice(4, 1);
  assert.equal(splitContextPrompt(pending, 0)?.cutIndex, 1, 'a pending call cannot be dropped when later messages exist');
});

test('an orphaned tool result and a single indivisible turn cannot be compacted by discarding protocol state', () => {
  const prompt: ContextPrompt = [{ role: 'user', content: [{ type: 'text', text: 'Only request' }] }];
  assert.equal(splitContextPrompt(prompt, 20_000), null);
  prompt.push({ role: 'assistant', content: [{ type: 'text', text: 'Earlier response' }] }, { role: 'user', content: [{ type: 'text', text: 'Latest' }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'missing', toolName: 'read', output: { type: 'text', value: 'Orphan' } }] });
  assert.equal(splitContextPrompt(prompt, 0), null);
});

test('checkpoint reuse requires the same covered source prefix and ignores unrelated system updates', () => {
  const old: ContextPrompt = [{ role: 'system', content: 'Old settings' }, { role: 'user', content: [{ type: 'text', text: 'Original' }] }];
  const checkpoint = { coveredMessages: 1, prefixHash: contextPrefixHash(old) };
  const current: ContextPrompt = [{ role: 'system', content: 'New settings' }, ...old.slice(1), { role: 'user', content: [{ type: 'text', text: 'Later' }] }];
  assert.equal(contextCheckpointMatches(current, checkpoint), true);
  current[1] = { role: 'user', content: [{ type: 'text', text: 'Edited original' }] };
  assert.equal(contextCheckpointMatches(current, checkpoint), false);
  assert.equal(contextCheckpointMatches(old, { ...checkpoint, coveredMessages: 2 }), false);
});

test('an oversized old turn can be summarized while small recent turns and the current request remain', () => {
  const prompt: ContextPrompt = [
    { role: 'system', content: 'Current policy' },
    { role: 'user', content: [{ type: 'text', text: 'Old material '.repeat(6000) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Old response.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Recent request.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Recent response.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Current request must remain verbatim.' }] },
  ];
  const split = splitContextPrompt(prompt, 500)!;
  assert.ok(split); assert.ok(split.earlier.some(message => typeof message.content !== 'string' && message.content.some(part => part.type === 'text' && part.text.startsWith('Old material'))));
  assert.deepEqual(split.recent.at(-1), prompt.at(-1)); assert.ok(estimatePromptTokens(split.recent) < 500);
});

test('tool call identifiers may be reused after completion without pairing results to another turn', () => {
  const prompt: ContextPrompt = [
    { role: 'user', content: [{ type: 'text', text: 'Earlier request' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read', output: { type: 'text', value: 'Old result' } }] },
    { role: 'user', content: [{ type: 'text', text: 'Current request' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read', output: { type: 'text', value: 'Current result' } }] },
  ];
  const split = splitContextPrompt(prompt, estimatePromptTokens(prompt.slice(4)))!;
  assert.equal(split.cutIndex, 3);
  assert.equal(split.recent[0]?.role, 'user', 'the current user request remains verbatim');
  const ambiguous = structuredClone(prompt); ambiguous.splice(2, 1);
  assert.equal(splitContextPrompt(ambiguous, 0), null);
});

test('media estimates never serialize binary payloads into a huge JSON byte array', () => {
  const bytes = new Uint8Array(2_000_000);
  Object.defineProperty(bytes, 'toJSON', { value() { throw new Error('binary_payload_serialized'); } });
  const prompt: ContextPrompt = [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: bytes }] }];
  assert.equal(estimatePromptTokens(prompt), 1204);
  assert.equal(typeof contextPrefixHash(prompt), 'string');
});

test('checkpoint hashes ignore object key order introduced by native workflow serialization', () => {
  const first: ContextPrompt = [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: { a: 1, b: { c: 2, d: 3 } } }] }];
  const reordered: ContextPrompt = [{ content: [{ input: { b: { d: 3, c: 2 }, a: 1 }, toolName: 'read', toolCallId: 'c', type: 'tool-call' }], role: 'assistant' }];
  assert.equal(contextPrefixHash(first), contextPrefixHash(reordered));
  reordered[0] = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: { a: 1, b: { c: 2, d: 4 } } }] };
  assert.notEqual(contextPrefixHash(first), contextPrefixHash(reordered));
});

test('only SDK envelope timestamps are ignored; business timestamps stay part of the checkpoint identity', () => {
  const first: ContextPrompt = [{ role: 'assistant', providerOptions: { mastra: { createdAt: 100 } }, content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: { createdAt: 42, providerOptions: { mastra: { createdAt: 7 } } }, providerOptions: { mastra: { createdAt: 100 } } }] }];
  const repackaged: ContextPrompt = [{ role: 'assistant', providerOptions: {}, content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: { createdAt: 42, providerOptions: { mastra: { createdAt: 7 } } }, providerOptions: { mastra: { createdAt: 200 } } }] }];
  assert.equal(contextPrefixHash(first), contextPrefixHash(repackaged));
  const changed: ContextPrompt = [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: { createdAt: 43, providerOptions: { mastra: { createdAt: 7 } } } }] }];
  assert.notEqual(contextPrefixHash(first), contextPrefixHash(changed));
  const nestedChanged: ContextPrompt = [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: { createdAt: 42, providerOptions: { mastra: { createdAt: 8 } } } }] }];
  assert.notEqual(contextPrefixHash(first), contextPrefixHash(nestedChanged));
});
