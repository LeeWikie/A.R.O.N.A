import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createProvider, type Model, type Context, type Models } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { contextThinking, publicEventPage } from '../src/event-stream.js';
import { publicHistory, projectHistoryToolResults } from '../src/history-projection.js';
import { createPiLanguageModel } from '../src/providers/bridge.js';
import { serializeConversation, type NativeMessage } from '../src/compaction.js';
import { finished, removeTemp } from './helpers.js';

const target: Model<'anthropic-messages'> = { id: 'fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const opaque = 'OPAQUE-HISTORY-PRIVATE-PAYLOAD'; const signature = 'HISTORY-PRIVATE-SIGNATURE';
const controlToken = 'fixture-control-token-'.repeat(3);
function response(blocks: unknown[], tool = false) {
  const blockFrames = blocks.flatMap((value, index) => {
    const block = value as { type: string; text?: string; thinking?: string; signature?: string; input?: unknown };
    const start = block.type === 'text' ? { ...block, text: '' } : block.type === 'thinking' ? { ...block, thinking: '', signature: '' } : block;
    const deltas = block.type === 'tool_use' ? [{ type: 'input_json_delta', partial_json: JSON.stringify(block.input) }]
      : block.type === 'text' ? [{ type: 'text_delta', text: block.text }]
      : block.type === 'thinking' ? [{ type: 'thinking_delta', thinking: block.thinking }, { type: 'signature_delta', signature: block.signature }] : [];
    return [{ type: 'content_block_start', index, content_block: start }, ...deltas.map(delta => ({ type: 'content_block_delta', index, delta })), { type: 'content_block_stop', index }];
  });
  const frames = [
    { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: target.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...blockFrames,
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
async function send(core: Core, content: string) {
  const receipt = await core.submitMessage({ content }); assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded'); return receipt.runId!;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function deadline<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('fixture_deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

test('Pi opaque replay remains protocol-only through HTTP history, real context_history and summary rendering', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-history-projection-')); const requests: Record<string, unknown>[] = [];
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(await request.json() as Record<string, unknown>);
    if (++calls === 2) return response([{ type: 'tool_use', id: 'history-call', name: 'context_history', input: { id: 'main', page: 0 } }], true);
    return response([{ type: 'thinking', thinking: 'visible reasoning', signature }, { type: 'redacted_thinking', data: opaque }, { type: 'text', text: 'valid business answer' }]);
  };
  const registry = { streamSimple(model: Model<'anthropic-messages'>, context: Context, options: { signal?: AbortSignal }) { return anthropicStream(model, normalizeContext(context), { apiKey: 'synthetic-key', fetch, env: {}, cacheRetention: 'none', maxRetries: 0, signal: options.signal }); } } as Pick<Models, 'streamSimple'>;
  const core = await Core.open({ dataDir: directory, controlToken, model: createPiLanguageModel(registry, target), memoryEnabled: false });
  try {
    const first = await send(core, 'first business question');
    const privateBefore = core.projectMemory.snapshot(first).nativeMessages;
    assert.match(JSON.stringify(privateBefore), new RegExp(opaque));
    const http = await createApp(core).request('/contexts/main/history', { headers: { Authorization: `Bearer ${core.controlToken}` } });
    assert.equal(http.status, 200); const page = await http.json();
    assert.doesNotMatch(JSON.stringify(page), new RegExp(`${opaque}|${signature}`));
    assert.match(JSON.stringify(page), /valid business answer/);
    const actualHistory = core.history.bind(core);
    core.history = async (...args) => {
      const page = await actualHistory(...args);
      const privateHistory = await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
      const legacy = structuredClone(privateHistory.messages.find(message => message.role === 'assistant')!);
      legacy.id = 'legacy-nested';
      legacy.content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'legacy-history', toolName: 'context_history', state: 'result', args: { id: 'main', page: 0 }, result: privateHistory } }];
      return { ...page, messages: [...page.messages, legacy] };
    };
    let last: string;
    try { last = await send(core, 'read history now'); } finally { core.history = actualHistory; }
    assert.equal(requests.length, 3);
    const replay = requests[2]!.messages as { role: string; content: { type: string; data?: string; signature?: string; content?: unknown }[] }[];
    assert.ok(replay.some(m => m.role === 'assistant' && m.content.some(p => p.type === 'redacted_thinking' && p.data === opaque)), 'native protocol replays opaque intact');
    const results = replay.flatMap(m => m.content).filter(p => p.type === 'tool_result');
    assert.ok(results.length > 0, 'real context_history was executed');
    assert.doesNotMatch(JSON.stringify(results), new RegExp(`${opaque}|${signature}`));
    assert.match(JSON.stringify(results), /valid business answer/);
    const native = core.projectMemory.snapshot(last).nativeMessages as { messages: NativeMessage[] };
    assert.doesNotMatch(serializeConversation(native.messages), new RegExp(`${opaque}|${signature}`));
    const privateAfter = await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
    assert.match(JSON.stringify(privateAfter), new RegExp(opaque), 'safe history never rewrites native storage');
    const legacy = structuredClone(privateAfter.messages.find(m => m.content.parts.some(p => p.type === 'tool-invocation' && p.toolInvocation.toolName === 'context_history'))!);
    const legacyBefore = JSON.stringify(legacy);
    assert.match(legacyBefore, new RegExp(opaque), 'actual tool producer preserves the older unprojected result');
    const followup = await send(core, 'continue with the older history result');
    const oldReplay = requests.at(-1)!.messages as typeof replay;
    const oldResults = oldReplay.flatMap(m => m.content).filter(p => p.type === 'tool_result');
    assert.ok(oldResults.length > 0); assert.doesNotMatch(JSON.stringify(oldResults), new RegExp(`${opaque}|${signature}`));
    assert.match(JSON.stringify(oldResults), /valid business answer/);
    const oldNative = core.projectMemory.snapshot(followup).nativeMessages as { messages: NativeMessage[] };
    assert.doesNotMatch(serializeConversation(oldNative.messages), new RegExp(`${opaque}|${signature}`));
    assert.match(JSON.stringify((await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false })).messages.find(m => m.id === legacy.id)), new RegExp(opaque), 'older tool history is projected without editing stored messages');
    assert.equal(JSON.stringify((await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false })).messages.find(m => m.id === legacy.id)), legacyBefore, 'native source result remains byte-for-byte unchanged');
    const safe = await core.history('main'); safe.messages[0]!.content.parts.length = 0;
    assert.ok((await core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false })).messages[0]!.content.parts.length > 0, 'safe page is a detached clone');
  } finally { await core.close(); await removeTemp(directory); }
});

test('old nested context_history results are projected before summaries without stripping business signature keys', () => {
  const native: NativeMessage = { id: 'signed', role: 'assistant', content: { parts: [{ type: 'reasoning', text: '', providerMetadata: { pi: { thinkingSignature: opaque, redacted: true }, anthropic: { redactedData: opaque } } }, { type: 'text', text: 'business body', providerMetadata: { pi: { textSignature: signature } } }] } };
  const nested: NativeMessage = { id: 'history-result', role: 'assistant', content: { parts: [{ type: 'tool-invocation', toolInvocation: { toolName: 'context_history', state: 'result', result: { messages: [native] } } }] } };
  const messages: NativeMessage[] = [{ id: 'outer', role: 'assistant', content: { parts: [
    { type: 'tool-invocation', toolInvocation: { toolName: 'context_history', state: 'result', result: { messages: [nested] } } },
    { type: 'tool-invocation', toolInvocation: { toolName: 'read_invoice', state: 'result', args: { signature: 'BUSINESS-ARG-SIGNATURE' }, result: { signature: 'BUSINESS-RESULT-SIGNATURE', providerMetadata: { business: true } } } },
  ] } }];
  const original = JSON.stringify(messages); const summary = serializeConversation(messages);
  assert.doesNotMatch(summary, new RegExp(`${opaque}|${signature}`)); assert.match(summary, /business body/);
  assert.match(summary, /BUSINESS-ARG-SIGNATURE/); assert.match(summary, /BUSINESS-RESULT-SIGNATURE/); assert.match(summary, /providerMetadata/);
  assert.equal(JSON.stringify(messages), original, 'serializer must not edit private history');
});

for (const provider of ['sdk', 'pi'] as const) test(`close cancels pending ${provider} summarization before draining branch operations`, { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-compact-shutdown-')); const originalFetch = globalThis.fetch;
  const entered = deferred(); const caller = new AbortController(); let aborted = false; let pending = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
    const payload = JSON.stringify(await request.json());
    if (payload.includes('context checkpoint summary')) {
      pending = true; entered.resolve();
      await new Promise<never>((_, reject) => { const cancel = () => { aborted = true; reject(request.signal.reason); }; if (request.signal.aborted) cancel(); else request.signal.addEventListener('abort', cancel, { once: true }); });
    }
    return response([{ type: 'text', text: 'ordinary answer' }]);
  };
  const core = await Core.open({ dataDir: directory, controlToken, memoryEnabled: false, modelConfig: { protocol: 'messages', baseURL: 'https://fixture.invalid/v1', modelId: target.id, apiKey: 'synthetic-only-key', authHeader: 'api-key' } });
  try {
    if (provider === 'pi') {
      core.providerRegistry.setProvider(createProvider({ id: 'fixture', name: 'Fixture', baseUrl: target.baseUrl, models: [target], api: anthropicMessagesApi(), auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'synthetic-only-key' }, source: 'fixture' }) } } }));
      core.models.save({ id: 'default', name: 'Fixture', providerId: 'fixture', modelId: target.id });
    }
    await send(core, 'early '.repeat(3000)); await send(core, 'tail');
    const before = await core.history('main', 0, 100);
    const result = core.compactContext('main', { id: 'history.shutdown', keepRecentTokens: 100 }, caller.signal);
    const rejected = assert.rejects(result, /abort|core_stopping/i); await deadline(entered.promise, 3000);
    assert.equal(pending, true); await deadline(core.close(), 3000); await rejected; assert.equal(aborted, true);
    const reopened = await Core.open({ dataDir: directory, controlToken, memoryEnabled: false });
    try {
      assert.equal(reopened.runtime.context('history.shutdown'), undefined);
      assert.equal(await reopened.memory.getThreadById({ threadId: 'history.shutdown' }), null);
      assert.deepEqual((await reopened.history('main', 0, 100)).messages, before.messages);
    } finally { await reopened.close(); }
  } finally { caller.abort(new DOMException('fixture caller cleanup', 'AbortError')); await core.close(); globalThis.fetch = originalFetch; await removeTemp(directory); }
});

for (const provider of ['sdk', 'pi-derived'] as const) test(`independent ${provider} summarizer captures its request key before rotation and before any public reasoning`, { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-compact-secret-')); const originalFetch = globalThis.fetch;
  const requested = deferred(); const release = deferred();
  const name = 'SHITTIM_COMPACT_SYNTHETIC_SECRET'; const stored = 'fixture-private-compaction-old-key';
  const used = provider === 'pi-derived' ? Buffer.from(stored).toString('base64') : stored;
  let followup = false; let header = '';
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
    const summary = JSON.stringify(await request.json()).includes('context checkpoint summary');
    if (summary) { header = request.headers.get('x-api-key')!; requested.resolve(); await release.promise; }
    return response([...(summary || followup ? [{ type: 'thinking', thinking: `ordinary ${used} safe ending`, signature }] : []), { type: 'text', text: summary ? 'checkpoint summary' : 'ordinary answer' }]);
  };
  const core = await Core.open({ dataDir: directory, controlToken, memoryEnabled: false, modelConfig: { protocol: 'messages', baseURL: 'https://fixture.invalid/v1', modelId: target.id, apiKey: 'synthetic-seed-only-key', authHeader: 'api-key' } });
  try {
    await send(core, 'early '.repeat(3000)); await send(core, 'tail');
    if (provider === 'pi-derived') {
      core.providerRegistry.setProvider(createProvider({ id: 'fixture', name: 'Fixture', baseUrl: target.baseUrl, models: [target], api: anthropicMessagesApi(), auth: { apiKey: { name: 'Fixture', resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: Buffer.from(credential.key).toString('base64') }, source: 'fixture' } : undefined } } }));
      await core.credentials.providerStore.modify('fixture', async () => ({ type: 'api_key', key: stored }));
      core.models.save({ id: 'default', name: 'Fixture', providerId: 'fixture', modelId: target.id });
    } else {
      core.credentials.set(name, stored);
      core.models.save({ id: 'default', name: 'Fixture', protocol: 'messages', baseURL: 'https://fixture.invalid/v1', modelId: target.id, apiKeyEnv: name, thinking: {} });
    }
    const result = core.compactContext('main', { id: 'history.secretcompact', keepRecentTokens: 100 }); await deadline(requested.promise, 3000);
    assert.equal(header, used);
    if (provider === 'pi-derived') await core.credentials.providerStore.modify('fixture', async () => ({ type: 'api_key', key: 'fixture-private-compaction-new-key' }));
    else core.credentials.set(name, 'fixture-private-compaction-new-key');
    release.resolve(); await result;
    assert.ok(core.redactionValues(1).includes(used), 'actual independent summary request key retained privately');
    followup = true; await send(core, 'follow up after key rotation');
    assert.equal(contextThinking(core, 'main').at(-1)?.text, 'ordinary [hidden] safe ending');
    assert.doesNotMatch(JSON.stringify(publicEventPage(core, 0, undefined, 1000)), new RegExp(used));
  } finally { release.resolve(); await core.close(); globalThis.fetch = originalFetch; await removeTemp(directory); }
});

test('history projection handles legacy protocol fields and JSON text outputs while preserving business data', () => {
  const page = { messages: [{ id: 'legacy', role: 'assistant', content: {
    format: 2, providerMetadata: { anthropic: { signature } }, metadata: { signature: 'BUSINESS-METADATA' },
    parts: [
      { type: 'text', text: 'business text', textSignature: signature, providerMetadata: { pi: { textSignature: signature } } },
      { type: 'reasoning', reasoning: 'visible reasoning', details: [{ type: 'text', text: 'visible reasoning', signature }, { type: 'redacted', data: opaque }] },
      { type: 'data-invoice', data: { signature: 'BUSINESS-DATA' }, signature: 'BUSINESS-PART' },
      { type: 'error', error: { name: 'ProviderError', message: 'private error', responseBody: opaque } },
    ],
    content: [{ type: 'thinking', thinking: 'visible legacy thinking', signature }, { type: 'redacted_thinking', data: opaque }],
    toolInvocations: [{ toolName: 'read_invoice', result: { signature: 'BUSINESS-TOOL', providerMetadata: { ledger: true } } }],
  } }] };
  const original = JSON.stringify(page); const safe = publicHistory(page);
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(`${opaque}|${signature}|private error`));
  for (const business of ['BUSINESS-METADATA', 'BUSINESS-DATA', 'BUSINESS-PART', 'BUSINESS-TOOL', 'business text', 'visible reasoning', 'visible legacy thinking']) assert.ok(JSON.stringify(safe).includes(business));
  const prompt = [{ role: 'tool', content: [{ type: 'tool-result', toolName: 'context_history', providerOptions: { pi: { thoughtSignature: 'OUTER-REPLAY-SIGNATURE' } }, output: { type: 'text', value: JSON.stringify(page) } }] }];
  const projected = projectHistoryToolResults(prompt);
  assert.doesNotMatch(projected[0]!.content[0]!.output.value, new RegExp(`${opaque}|${signature}`));
  assert.equal(projected[0]!.content[0]!.providerOptions.pi.thoughtSignature, 'OUTER-REPLAY-SIGNATURE');
  assert.equal(JSON.stringify(page), original);
  assert.equal(prompt[0]!.content[0]!.output.value, original);
});
