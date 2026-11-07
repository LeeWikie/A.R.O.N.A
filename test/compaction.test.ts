import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { findCutPoint, serializeConversation, type NativeMessage } from '../src/compaction.js';
import { conversationPage } from '../src/event-stream.js';
import { finished, removeTemp } from './helpers.js';

const user = (id: string, text: string): NativeMessage => ({ id, role: 'user', content: { parts: [{ type: 'text', text }] } });
const assistant = (id: string, text: string, call?: { toolName: string; args: unknown; result?: unknown }): NativeMessage => ({ id, role: 'assistant', content: { parts: [
  ...(call ? [{ type: 'tool-invocation', toolInvocation: { ...call, state: 'result' } }] : []), { type: 'text', text },
] } });

test('serialization follows Pi: user, assistant, tool calls, truncated tool results', () => {
  const text = serializeConversation([user('u', 'read it'), assistant('a', 'done', { toolName: 'read', args: { path: 'a.txt' }, result: 'x'.repeat(2500) })]);
  assert.match(text, /^\[User\]: read it/);
  assert.match(text, /\[Assistant\]: done/);
  assert.match(text, /\[Assistant tool calls\]: read\(path="a\.txt"\)/);
  assert.match(text, /\[Tool result\]: x{2000}\n\n\[\.\.\. 500 more characters truncated\]/);
});

test('cut point keeps recent turns whole and never cuts when everything fits', () => {
  const long = 'word '.repeat(4000);
  const messages = [user('u1', long), assistant('a1', long), user('u2', long), assistant('a2', long), user('u3', 'short'), assistant('a3', 'short')];
  const cut = findCutPoint(messages, 6000);
  assert.equal(messages[cut]?.role, 'user', 'cut lands on a turn start');
  assert.ok(cut > 0 && cut < messages.length);
  assert.equal(findCutPoint(messages.slice(4), 6000), 0, 'a single turn is never cut');
  assert.equal(findCutPoint([user('a', 'hi'), assistant('b', 'hi'), user('c', 'hi')], 6000), 0, 'short history needs no compaction');
});

test('compaction summarizes earlier turns into a derived context and leaves the source intact', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-compact-'));
  const prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt); prompts.push(prompt);
    const reply = prompt.includes('context checkpoint summary') ? '## Goal\n- Fixture goal' : 'ok';
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: reply }); c.enqueue({ type: 'text-end', id: 't' });
      c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    await assert.rejects(core.compactContext('main'), /branch_requires_complete_run/);
    const big = 'detail '.repeat(3000);
    for (const content of [`first ${big}`, `second ${big}`, 'third short']) { const signal = await core.submitMessage({ content }); await finished(core, signal.runId!); }
    const before = conversationPage(core, 'main').messages.length;
    const result = await core.compactContext('main', { keepRecentTokens: 1000, instructions: 'focus on fixtures' });
    assert.equal(result.summary, '## Goal\n- Fixture goal');
    assert.ok(result.summarizedMessages > 0 && result.keptMessages > 0);
    const summaryPrompt = prompts.find(prompt => prompt.includes('context checkpoint summary'))!;
    assert.ok(summaryPrompt.includes('first detail') && summaryPrompt.includes('focus on fixtures'));
    assert.equal(conversationPage(core, 'main').messages.length, before, 'source history unchanged');
    const derived = result.context;
    assert.equal(derived.parentContextId, 'main');
    const history = conversationPage(core, derived.id).messages.map(message => message.content);
    assert.ok(history.includes('third short')); assert.ok(!history.some(content => content.startsWith('first ')), 'summarized turns are not copied verbatim');
    const instructions = (core as unknown as { instructions(role: 'main', id: string): string }).instructions('main', derived.id);
    assert.match(instructions, /较早对话的结构化摘要/); assert.match(instructions, /Fixture goal/);
    assert.doesNotMatch((core as unknown as { instructions(role: 'main', id: string): string }).instructions('main', 'main'), /Fixture goal/);
    const next = await core.submitMessage({ contextId: derived.id, content: 'continue' }); await finished(core, next.runId!);
    assert.ok(prompts.at(-1)!.includes('Fixture goal'), 'the summary reaches the next model request');
  } finally { await core.close(); await removeTemp(directory); }
});
