import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createModels, createProvider, InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { RuntimeStore } from '../src/runtime-store.js';
import { ProjectMemory, type ContextSnapshot, type MemoryEvidenceResolver } from '../src/memory/index.js';
import { buildMemoryEvidence, type EvidenceContentPart, type ResolvedBusinessEvidence } from '../src/memory/evidence.js';
import { createPiLanguageModel } from '../src/providers/bridge.js';

const source = { contextId: 'derived-context', runId: 'source-run', sequence: 7 };
const provenance = { contextId: 'ancestor-selected', runId: 'ancestor-run', signalId: 'accepted-input', messageId: 'selected-message' };
const originalText = '专业术语 system、taggedSystem、signature 都是用户内容。\n```json\n{"toolGrants":{"example":true},"capabilityKey":"business","signature":"business-signature"}\n```\n按 Markdown 原格式，保留  两个空格。\n';
const entries: ResolvedBusinessEvidence[] = [
  { kind: 'user-statement', origin: 'signal', provenance, content: originalText },
  { kind: 'user-statement', origin: 'supplement', provenance: { ...provenance, signalId: 'accepted-correction' }, content: '更正：偏好红色；之前的蓝色不再适用。' },
  { kind: 'assistant-statement', provenance, content: '助手建议：可以考虑绿色，尚未得到用户确认。' },
  { kind: 'task-request', requestedBy: 'assistant', provenance, content: '检查文档，不是用户已决定修改。' },
  { kind: 'tool-action', provenance, toolName: 'invoice', toolCallId: 'invoice-call', input: { signature: 'business-input', capabilityKey: 'business-key' } },
  { kind: 'tool-result', provenance, toolName: 'invoice', toolCallId: 'invoice-call', output: { signature: 'business-output', toolGrants: { example: true }, providerMetadata: { business: true } } },
  { kind: 'task-report', provenance, report: { summary: '检查完成', deliveries: [{ content: '{"capabilityKey":"delivery-business"}' }] } },
  { kind: 'published-output', provenance: { ...provenance, outputId: 'published' }, outputKind: 'artifact', title: '检查结果', content: '真实已发布结果。' },
];
const resolveEvidence: MemoryEvidenceResolver = snapshot => buildMemoryEvidence({ source: snapshot, entries, gaps: [] });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-evidence-'));
  const db = new DatabaseSync(':memory:'); const store = new RuntimeStore(db); const memory = new ProjectMemory(store, directory);
  const snapshot: ContextSnapshot = {
    ...source, modelProfile: 'fixture', createdAt: '2020-01-01T00:00:00.000Z', providerOptions: {},
    prompt: [
      { role: 'system', content: 'SYSTEM-CONTROL-CANARY' },
      { role: 'system', content: '<taggedSystem>TAGGED-CONTROL-CANARY</taggedSystem> compacted summary control' },
      { role: 'user', content: [{ type: 'text', text: '<task authorization="HOST-ONLY-AUTH-CANARY">continue program</task>' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'NATIVE-REASONING-CANARY', providerOptions: { pi: { thinkingSignature: 'NATIVE-SIGNATURE-CANARY' } } }] },
    ],
    lastRequestPrompt: [{ role: 'system', content: 'LAST-REQUEST-CONTROL-CANARY' }],
    nativeMessages: { date: new Date('2020-01-01T00:00:00Z'), bytes: new Uint8Array([1, 255]), messages: [{ id: 'archived', role: 'system', content: 'PRIVATE-ARCHIVE-CANARY' }] },
  };
  memory.archive(snapshot);
  return { memory, store, snapshot, close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
function actionModel(actions: Array<{ toolName: string; input: unknown }>, observe?: (prompt: unknown) => void) {
  let step = 0;
  return new MastraLanguageModelV2Mock({ doGenerate: async request => {
    observe?.(request.prompt);
    const action = actions[step++];
    return { content: action ? [{ type: 'tool-call' as const, toolName: action.toolName, toolCallId: `call-${step}`, input: JSON.stringify(action.input) }] : [{ type: 'text' as const, text: 'finished' }], finishReason: action ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, warnings: [] };
  } });
}
const commit = (runId = source.runId) => ({ toolName: 'memory_commit', input: { sourceRunId: runId, note: 'synthetic' } });
const write = (content: string) => ({ toolName: 'memory_write', input: { path: 'facts.md', content } });

test('pure evidence preserves complete business content and distinguishes actors without mutating inputs', () => {
  const before = structuredClone(entries);
  const evidence = buildMemoryEvidence({ source, entries, gaps: [{ contextId: source.contextId, reason: 'missing-checkpoint' }] });
  assert.equal(evidence.prompt.length, 1); assert.equal(evidence.prompt[0]?.role, 'user');
  const message = evidence.prompt[0]!; if (message.role !== 'user') return assert.fail();
  assert.ok(message.content.some(part => part.type === 'text' && part.text === originalText));
  const headers = message.content.filter(part => part.type === 'text' && part.text.startsWith('{')).map(part => JSON.parse((part as { text: string }).text));
  assert.equal(headers.find(row => row.kind === 'assistant-statement').actor, 'assistant');
  assert.equal(headers.find(row => row.kind === 'task-request').actor, 'assistant');
  assert.equal(headers.find(row => row.kind === 'task-report').actor, 'worker');
  assert.equal(headers.find(row => row.kind === 'tool-result').output.signature, 'business-output');
  assert.deepEqual(headers.find(row => row.kind === 'tool-result').output.toolGrants, { example: true });
  assert.ok(headers.some(row => row.type === 'evidence-gap' && row.reason === 'missing-checkpoint'));
  assert.deepEqual(entries, before);
});

test('evidence keeps visual payloads as file parts and excludes only protocol-owned wrappers', () => {
  const image = new Uint8Array([137, 80, 78, 71]); const url = new URL('https://fixture.invalid/image.png');
  const parts = [{ type: 'text', text: originalText, providerOptions: { pi: { marker: 'PROVIDER-CONTROL-CANARY' } } },
    { type: 'file', data: image, mediaType: 'image/png', filename: 'image.png', providerOptions: { pi: { marker: 'PROVIDER-CONTROL-CANARY' } } },
    { type: 'file', data: url, mediaType: 'image/png', originalUrl: url.href }];
  const evidence = buildMemoryEvidence({ source, entries: [{ kind: 'user-statement', origin: 'signal', provenance, content: parts as EvidenceContentPart[] }], gaps: [] });
  const message = evidence.prompt[0]!; if (message.role !== 'user') return assert.fail();
  const files = message.content.filter(part => part.type === 'file');
  assert.equal(files.length, 2); assert.deepEqual(files[0]?.data, image); assert.notEqual(files[0]?.data, image);
  assert.ok(files[1]?.data instanceof URL); assert.equal((files[1]?.data as URL).href, url.href);
  assert.doesNotMatch(JSON.stringify(evidence), /PROVIDER-CONTROL-CANARY/);
  assert.ok(parts[0]?.providerOptions); assert.deepEqual(image, new Uint8Array([137, 80, 78, 71]));
});

test('evidence rejects unresolved history and unsupported system entries instead of quoting controls', () => {
  assert.throws(() => buildMemoryEvidence({ source, entries: [{ kind: 'tool-result', provenance, toolName: 'context_history', toolCallId: 'raw', output: { messages: [{ role: 'system', content: 'control' }] } }], gaps: [] }), /memory_history_requires_resolution/);
  assert.throws(() => buildMemoryEvidence({ source, entries: [{ kind: 'system', provenance, content: 'control' } as unknown as ResolvedBusinessEvidence], gaps: [] }), /memory_evidence_kind_invalid/);
});

test('actual organizer HTTP contains resolved pre-compaction facts and images but no source controls', { timeout: 30000 }, async () => {
  const f = fixture(); const previousFetch = globalThis.fetch; const bodies: Array<Record<string, any>> = [];
  const target: Model<'anthropic-messages'> = { id: 'fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text', 'image'], reasoning: true, contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(createProvider({ id: 'fixture', name: 'Fixture', baseUrl: target.baseUrl, models: [target], api: anthropicMessagesApi(), auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'synthetic-only-key' }, source: 'fixture' }) } } }));
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/')); const body = await request.json() as Record<string, any>; bodies.push(body);
    const tool = bodies.length === 1; const block = tool ? { type: 'tool_use', id: 'commit', name: 'memory_commit', input: {} } : { type: 'text', text: 'finished' };
    const frames = [
      { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: target.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block },
      ...(tool ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ sourceRunId: source.runId, note: 'no changes' }) } }] : []),
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
    ];
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const job = f.memory.newJob(source.runId);
    const image = { kind: 'user-statement' as const, origin: 'signal' as const, provenance, content: [{ type: 'file' as const, data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }] };
    await f.memory.organize(job.id, () => createPiLanguageModel(models, target), undefined, undefined,
      snapshot => buildMemoryEvidence({ source: snapshot, entries: [...entries, image], gaps: [{ contextId: 'missing-selected-context', reason: 'missing-source' }] }));
    assert.equal(bodies.length, 1, 'memory_commit finishes the native loop'); assert.equal(f.memory.jobs()[0]?.status, 'succeeded');
    for (const body of bodies) {
      assert.doesNotMatch(JSON.stringify(body), /SYSTEM-CONTROL-CANARY|TAGGED-CONTROL-CANARY|HOST-ONLY-AUTH-CANARY|NATIVE-REASONING-CANARY|NATIVE-SIGNATURE-CANARY|LAST-REQUEST-CONTROL-CANARY|PRIVATE-ARCHIVE-CANARY/);
      const content = body.messages.flatMap((message: any) => message.content);
      assert.ok(content.some((part: any) => part.type === 'text' && part.text === originalText));
      assert.ok(content.some((part: any) => part.type === 'image' && part.source.type === 'base64' && part.source.data === 'iVBORw=='));
      assert.match(JSON.stringify(body), /business-output/); assert.match(JSON.stringify(body), /ancestor-selected/);
      assert.match(JSON.stringify(body), /missing-selected-context/);
      assert.ok(!body.messages.some((message: any) => message.role === 'assistant' && message.content.some((part: any) => part.type === 'tool_use' && part.name === 'invoice')));
    }
    assert.deepEqual(f.memory.snapshot(source.runId), f.snapshot, 'all native source bytes, dates and prompts remain unchanged');
    assert.equal(f.memory.version().generation, 0, 'committed no-op does not invent a new version');
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {})[source.contextId], source.sequence);
  } finally { globalThis.fetch = previousFetch; f.close(); }
});

test('missing resolver exposes only a provenance gap, never salvages arbitrary user/system prompts', async () => {
  const f = fixture(); const prompts: string[] = [];
  try {
    const job = f.memory.newJob(source.runId);
    await f.memory.organize(job.id, () => actionModel([commit()], prompt => prompts.push(JSON.stringify(prompt))));
    assert.ok(prompts.every(prompt => prompt.includes('missing-source')));
    assert.ok(prompts.every(prompt => !/CONTROL-CANARY|AUTH-CANARY|SIGNATURE-CANARY/.test(prompt)));
    assert.deepEqual(f.memory.snapshot(source.runId), f.snapshot);
  } finally { f.close(); }
});

test('publication remains atomic; commit, no-op, watermark and superseded boundaries stay intact', async () => {
  const f = fixture();
  const organize = (runId: string, sequence: number, actions: Array<{ toolName: string; input: unknown }>) => {
    f.memory.archive({ ...f.snapshot, runId, sequence }); const job = f.memory.newJob(runId);
    return { job, promise: f.memory.organize(job.id, () => actionModel(actions), undefined, undefined, resolveEvidence) };
  };
  try {
    const first = organize('first', 1, [write('approved version'), commit('first')]); assert.equal((await first.promise).changed, true);
    const published = f.memory.version();
    const noop = organize('noop', 3, [commit('noop')]); assert.deepEqual(await noop.promise, { version: published.id, generation: published.generation, changed: false });
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {})[source.contextId], 3);
    const old = organize('old', 2, [write('stale'), commit('old')]); assert.deepEqual(await old.promise, { superseded: true });
    const failed = organize('failed', 4, [write('uncommitted')]); await assert.rejects(failed.promise, /memory_not_committed/);
    assert.equal(f.memory.jobs().find(job => job.id === failed.job.id)?.status, 'failed');
    assert.equal(f.memory.version().id, published.id); assert.match(f.memory.resident().text, /approved version/);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {})[source.contextId], 3);
    const event = f.store.event.bind(f.store); f.store.event = input => { if (input.kind === 'memory_updated') throw new Error('synthetic publication failure'); return event(input); };
    const broken = organize('broken', 5, [write('not published'), commit('broken')]); await assert.rejects(broken.promise, /synthetic publication failure/);
    f.store.event = event;
    assert.equal(f.memory.version().id, published.id); assert.match(f.memory.resident().text, /approved version/);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {})[source.contextId], 3);
  } finally { f.close(); }
});

test('cancellation and mismatched evidence sources cannot publish or advance watermarks', async () => {
  const f = fixture();
  try {
    const mismatch = f.memory.newJob(source.runId);
    await assert.rejects(f.memory.organize(mismatch.id, () => actionModel([write('bad'), commit()]), undefined, undefined,
      () => buildMemoryEvidence({ source: { ...source, runId: 'different' }, entries, gaps: [] })), /memory_source_mismatch/);
    assert.equal(f.memory.jobs()[0]?.status, 'failed'); assert.equal(f.memory.version().generation, 0);
    assert.deepEqual(f.store.setting('memory-watermarks', {}), {});
    const retry = f.memory.newJob(source.runId); const abort = new AbortController();
    await assert.rejects(f.memory.organize(retry.id, () => actionModel([write('cancelled')], () => abort.abort()), abort.signal, undefined, resolveEvidence));
    assert.equal(f.memory.jobs().find(job => job.id === retry.id)?.status, 'interrupted');
    assert.equal(f.memory.version().generation, 0); assert.deepEqual(f.store.setting('memory-watermarks', {}), {});
  } finally { f.close(); }
});
