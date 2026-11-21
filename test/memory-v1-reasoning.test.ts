import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { boundMemoryReasoningHistory, boundMemoryToolHistory, MemoryRequestBudget } from '../src/memory/v1/request-budget.js';

test('整理临时投影保留最后推理与全部工具往返，原始重放不变', () => {
  const prompt: ProcessLLMRequestArgs['prompt'] = [
    { role: 'user', content: [{ type: 'text', text: '资料' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '旧推理', providerOptions: { openai: { reasoningEncryptedContent: 'old-opaque' } } }, { type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'one', toolName: 'inspect', output: { type: 'json', value: { ok: true } } }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '中间推理', providerOptions: { openai: { reasoningEncryptedContent: 'intermediate-opaque' } } }, { type: 'reasoning', text: '最新推理', providerOptions: { openai: { reasoningEncryptedContent: 'new-opaque' } } }, { type: 'tool-call', toolCallId: 'two', toolName: 'ready', input: {} }] },
  ];
  const before = structuredClone(prompt), projected = boundMemoryReasoningHistory(prompt);
  assert.deepEqual(prompt, before);
  assert.equal(projected[1]!.content.length, 1);
  assert.deepEqual(projected[2], prompt[2]);
  assert.deepEqual(projected[3]!.content, prompt[3]!.content.slice(1));
  assert.ok(!JSON.stringify(projected).includes('intermediate-opaque'));
  assert.ok(!JSON.stringify(projected).includes('old-opaque'));
  assert.ok(JSON.stringify(prompt).includes('old-opaque'));
});

test('临时窗口成对移除已完成旧工具，原件保留且累计费用不会因窗口缩小重置', () => {
  const prompt: ProcessLLMRequestArgs['prompt'] = [{ role: 'user', content: [{ type: 'text', text: '完整业务资料必须保留' }] }];
  const budget = new MemoryRequestBudget();
  for (let i = 0; i < 12; i++) {
    prompt.push({ role: 'assistant', content: [{ type: 'reasoning', text: `private-${i}` }, { type: 'tool-call', toolName: 'read', toolCallId: `call-${i}`, input: { i } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolName: 'read', toolCallId: `call-${i}`, output: { type: 'json', value: { chunk: '资料'.repeat(100) } } }] });
    const request = boundMemoryReasoningHistory(boundMemoryToolHistory(prompt, 4));
    budget.check({ prompt: request });
  }
  const before = structuredClone(prompt), selected = boundMemoryReasoningHistory(boundMemoryToolHistory(prompt));
  const calls = selected.flatMap(m => m.role === 'assistant' ? m.content.flatMap(p => p.type === 'tool-call' ? [p.toolCallId] : []) : []);
  const results = selected.flatMap(m => m.role === 'tool' ? m.content.flatMap(p => p.type === 'tool-result' ? [p.toolCallId] : []) : []);
  assert.deepEqual(calls, ['call-8', 'call-9', 'call-10', 'call-11']); assert.deepEqual(results, calls);
  assert.deepEqual(prompt, before); assert.deepEqual(selected[0], prompt[0]);
  const receipts = budget.receipts(); assert.ok(receipts[11]!.toolHistoryTokens > receipts[3]!.toolHistoryTokens * 2);
  assert.ok(selected.every(m => typeof m.content === 'string' || m.content.length > 0));
  const first = boundMemoryToolHistory(prompt.slice(0, 3), 1), second = boundMemoryToolHistory(prompt.slice(0, 5), 1);
  const probe = new MemoryRequestBudget(); const measured = probe.check({ prompt: first });
  const limited = new MemoryRequestBudget({ limits: { toolHistoryTokens: measured.measurement.toolHistoryTokens * 2 - 1 } });
  limited.check({ prompt: first }); assert.throws(() => limited.check({ prompt: second }), /memory_request_tool_history_capacity/);
});
