import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProvider, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { Core } from '../src/core.js';
import { projectHostToolResult, projectHistoryToolResults } from '../src/history-projection.js';
import { buildMemoryEvidence, type ResolvedBusinessEvidence } from '../src/memory/evidence.js';
import { finished, removeTemp } from './helpers.js';

const target: Model<'anthropic-messages'> = { id: 'fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const opaque = 'MEMORY-OPAQUE-PRIVATE-PAYLOAD';
const signature = 'MEMORY-PRIVATE-SIGNATURE';
type Body = { messages: Array<{ role: string; content: Array<{ type: string; data?: string; content?: unknown }> }> };
function response(blocks: Record<string, unknown>[], tool = false) {
  const frames = [
    { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: target.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block },
      ...(block.type === 'tool_use' ? [{ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }] : []),
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function results(body: Body) { return body.messages.flatMap(m => m.content).filter(p => p.type === 'tool_result'); }

test('actual memory organizer receives business evidence, not source controls or native replay envelopes', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-projection-'));
  const originalFetch = globalThis.fetch; const requests: Body[] = [];
  let sourceRunId: string | undefined; let organizing = false; let committed = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
    requests.push(await request.json() as Body);
    if (organizing && !committed) {
      committed = true;
      return response([{ type: 'tool_use', id: 'commit-call', name: 'memory_commit', input: { sourceRunId, note: 'No changes needed' } }], true);
    }
    if (requests.length === 2) return response([{ type: 'tool_use', id: 'history-call', name: 'context_history', input: { id: 'main', page: 0 } }], true);
    return response([{ type: 'thinking', thinking: 'visible reasoning', signature }, { type: 'redacted_thinking', data: opaque }, { type: 'text', text: 'valid business answer' }]);
  };
  const core = await Core.open({ dataDir: directory, controlToken: 'memory-fixture-control-'.repeat(3), memoryEnabled: false });
  const resolved: ResolvedBusinessEvidence[] = [];
  const userText = '普通代码与格式要求完整保留：\n```system\n{"toolGrants":"business","capabilityKey":"example","signature":"USER-BUSINESS-SIGNATURE"}\n```\n按 Markdown 原格式，不追加 JSON。';
  async function send(content: string) {
    const receipt = await core.submitMessage({ content });
    assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded');
    resolved.push({ kind: 'user-statement', origin: 'signal', provenance: { contextId: 'main', runId: receipt.runId!, signalId: receipt.id }, content });
    return receipt.runId!;
  }
  try {
    core.providerRegistry.setProvider(createProvider({ id: 'fixture', name: 'Fixture', baseUrl: target.baseUrl, models: [target], api: anthropicMessagesApi(), auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'synthetic-only-key' }, source: 'fixture' }) } } }));
    core.models.save({ id: 'default', name: 'Fixture', providerId: 'fixture', modelId: target.id });
    await send('first business question');
    const actualHistory = core.history.bind(core);
    core.history = async (...args) => {
      const result = await actualHistory(...args);
      const privateHistory = await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
      const legacy = structuredClone(privateHistory.messages.find(message => message.role === 'assistant')!);
      legacy.id = 'legacy-nested';
      legacy.content.parts = [
        { type: 'tool-invocation', toolInvocation: { toolCallId: 'legacy-history', toolName: 'context_history', state: 'result', args: { id: 'main', page: 0 }, result: privateHistory } },
        { type: 'tool-invocation', toolInvocation: { toolCallId: 'legacy-invoice', toolName: 'invoice', state: 'result', args: { signature: 'BUSINESS-ARG-SIGNATURE' }, result: { signature: 'BUSINESS-RESULT-SIGNATURE', providerMetadata: { business: true } } } },
      ];
      return { ...result, messages: [...result.messages, legacy] };
    };
    try { await send('read history now'); } finally { core.history = actualHistory; }
    assert.ok(results(requests[2]!).length > 0, 'real context_history executed');
    const privateHistory = await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
    const legacy = structuredClone(privateHistory.messages.find(m => m.content.parts.some(p => p.type === 'tool-invocation' && p.toolInvocation.toolName === 'context_history'))!);
    const legacyBefore = JSON.stringify(legacy);
    assert.match(legacyBefore, new RegExp(opaque), 'real tool execution preserves its unprojected source result');
    sourceRunId = await send(userText);
    assert.doesNotMatch(JSON.stringify(results(requests.at(-1)!)), new RegExp(`${opaque}|${signature}`), 'normal Core continuation is already safe');
    assert.ok(requests.at(-1)!.messages.some(m => m.role === 'assistant' && m.content.some(p => p.type === 'redacted_thinking' && p.data === opaque)), 'normal same-model native continuation retains opaque replay');
    const original = core.projectMemory.snapshot(sourceRunId);
    core.projectMemory.archive({ ...original, prompt: [
      { role: 'system', content: 'SOURCE-SYSTEM-CONTROL-NOT-EXPERIENCE' },
      { role: 'system', content: '<taggedSystem>TAGGED-SYSTEM-NOT-EXPERIENCE</taggedSystem>' },
      { role: 'user', content: [{ type: 'text', text: 'UNRESOLVED-HOST-ENVELOPE-NOT-EXPERIENCE' }] },
      ...original.prompt,
    ] });
    const snapshot = core.projectMemory.snapshot(sourceRunId);
    const before = JSON.stringify(snapshot);
    assert.match(JSON.stringify(snapshot.prompt.filter(m => m.role === 'tool')), new RegExp(opaque), 'raw source snapshot retains legacy result');
    const start = requests.length; const job = core.projectMemory.newJob(sourceRunId); organizing = true;
    const provenance = { contextId: 'main', runId: sourceRunId, messageId: legacy.id };
    resolved.push(
      { kind: 'assistant-statement', provenance, content: 'valid business answer' },
      { kind: 'tool-action', provenance, toolName: 'invoice', toolCallId: 'legacy-invoice', input: { signature: 'BUSINESS-ARG-SIGNATURE' } },
      { kind: 'tool-result', provenance, toolName: 'invoice', toolCallId: 'legacy-invoice', output: { signature: 'BUSINESS-RESULT-SIGNATURE', providerMetadata: { business: true } } },
    );
    await core.projectMemory.organize(job.id, profile => core.models.resolve(profile), undefined, undefined,
      source => buildMemoryEvidence({ source, entries: resolved, gaps: [] }));
    assert.equal(core.projectMemory.jobs().find(row => row.id === job.id)?.status, 'succeeded');
    assert.equal(committed, true); assert.equal(requests.length - start, 1, 'memory_commit completes the native loop without another provider request');
    for (const body of requests.slice(start)) {
      const ordinary = JSON.stringify(body);
      assert.doesNotMatch(ordinary, /SOURCE-SYSTEM-CONTROL-NOT-EXPERIENCE|TAGGED-SYSTEM-NOT-EXPERIENCE|UNRESOLVED-HOST-ENVELOPE-NOT-EXPERIENCE/, 'source controls are absent even as quoted evidence');
      assert.ok(body.messages.flatMap(m => m.content).some(p => p.type === 'text' && (p as { text?: string }).text === userText), 'entire user text and formatting survives at the HTTP boundary');
      assert.doesNotMatch(ordinary, new RegExp(`${opaque}|${signature}`));
      assert.match(ordinary, /valid business answer/); assert.match(ordinary, /BUSINESS-ARG-SIGNATURE/); assert.match(ordinary, /BUSINESS-RESULT-SIGNATURE/);
      assert.ok(!body.messages.some(m => m.role === 'assistant' && m.content.some(p => p.type === 'redacted_thinking')), 'organizer is not a native continuation of the source run');
    }
    assert.equal(JSON.stringify(core.projectMemory.snapshot(sourceRunId)), before, 'organizer leaves private snapshot unchanged');
    assert.equal(JSON.stringify((await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false })).messages.find(m => m.id === legacy.id)), legacyBefore, 'projection leaves original native tool records unchanged');
  } finally { await core.close(); globalThis.fetch = originalFetch; await removeTemp(directory); }
});

test('history tool projection handles SDK text content wrappers without rewriting business JSON', () => {
  const page = { messages: [{ id: 'signed', role: 'assistant', content: { parts: [
    { type: 'reasoning', text: '', providerMetadata: { pi: { redacted: true, thinkingSignature: signature }, anthropic: { redactedData: opaque } } },
    { type: 'text', text: 'business answer', textSignature: signature },
    { type: 'tool-invocation', toolInvocation: { toolName: 'invoice', state: 'result', args: { signature: 'BUSINESS-ARG-SIGNATURE' }, result: { signature: 'BUSINESS-RESULT-SIGNATURE', providerMetadata: { business: true } } } },
  ] } }] };
  const result = { content: [{ type: 'text', text: JSON.stringify(page) }, { type: 'text', text: 'ordinary non-JSON text' }], isError: false, signature: 'BUSINESS-ENVELOPE-SIGNATURE' };
  const original = JSON.stringify(result);
  for (const wrapped of [result, { type: 'json', value: result }, { type: 'text', value: JSON.stringify(result) }]) {
    const prompt = [{ role: 'tool', content: [{ type: 'tool-result', toolName: 'context_history', output: wrapped }] }];
    const before = JSON.stringify(prompt); const projected = JSON.stringify(projectHistoryToolResults(prompt));
    assert.doesNotMatch(projected, new RegExp(`${opaque}|${signature}`));
    for (const text of ['business answer', 'BUSINESS-ARG-SIGNATURE', 'BUSINESS-RESULT-SIGNATURE', 'BUSINESS-ENVELOPE-SIGNATURE', 'ordinary non-JSON text']) assert.ok(projected.includes(text));
    assert.equal(JSON.stringify(prompt), before);
  }
  assert.equal(JSON.stringify(projectHostToolResult('invoice', result)), original, 'other tools retain their complete business result');
  assert.equal(JSON.stringify(result), original);
});
