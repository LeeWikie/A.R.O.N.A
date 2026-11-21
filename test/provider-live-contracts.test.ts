import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, createProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy';
import { Core } from '../src/core.js';
import { createPiLanguageModel } from '../src/providers/bridge.js';
import { contextThinking, publicEventPage, snapshot } from '../src/event-stream.js';
import { serializeConversation } from '../src/compaction.js';
import { finished, until, removeTemp } from './helpers.js';

const opaque = 'SYNTHETIC-LIVE-OPAQUE-NOT-PUBLIC';
const signature = 'SYNTHETIC-LIVE-SIGNATURE';
const base: Model<Api> = { id: 'fixture-model', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Frame = Record<string, unknown>;
const encode = (f: Frame) => new TextEncoder().encode(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
function registry(model: Model<Api>) {
  const provider = createProvider({ id: model.provider, name: 'Fixture', baseUrl: model.baseUrl, models: [model], api: model.api === 'anthropic-messages' ? anthropicMessagesApi() : model.api === 'openai-responses' ? openAIResponsesApi() : azureOpenAIResponsesApi(), auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'synthetic-only-key' }, source: 'fixture' }) } } });
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } }); models.setProvider(provider);
  return { models, provider };
}
async function openCore(model: Model<Api>) {
  const directory = await mkdtemp(join(tmpdir(), 'arona-live-contract-'));
  const core = await Core.open({ dataDir: directory, controlToken: 'synthetic-live-control-'.repeat(3), memoryEnabled: false });
  const { models, provider } = registry(model); core.providerRegistry.setProvider(provider);
  core.models.save({ id: 'default', name: 'Fixture', providerId: model.provider, modelId: model.id, ...(model.api === 'anthropic-messages' ? {} : { defaultThinkingLevel: 'medium' as const }) });
  return { core, models, async close() { await core.close(); await removeTemp(directory); } };
}
function responsesFrames(model: Model<Api>, partDone: boolean, conflict: boolean): Frame[] {
  const initial = { type: 'reasoning', id: 'rs_live', summary: [] };
  const reasoning = { ...initial, summary: [{ type: 'summary_text', text: conflict ? 'DIFFERENT authoritative body' : 'visible summary' }] };
  const encrypted = { ...reasoning, encrypted_content: opaque };
  const answer = { type: 'message', id: 'msg_live', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ordinary answer', annotations: [] }] };
  return [
    { type: 'response.created', response: { id: 'resp_live', status: 'in_progress', model: model.id } },
    { type: 'response.output_item.added', output_index: 0, item: initial },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    ...['visible ', 'summary'].map(delta => ({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta })),
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'visible summary' },
    ...(partDone ? [{ type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: 'visible summary' } }] : []),
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...answer, content: [] } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'ordinary answer' },
    { type: 'response.output_item.done', output_index: 1, item: answer },
    { type: 'response.completed', response: { id: 'resp_live', status: 'completed', model: model.id, output: [encrypted, answer], usage: { input_tokens: 2, output_tokens: 5, total_tokens: 7 } } },
  ];
}
function scheduled(frames: Frame[], delivery: 'batched' | 'delayed') {
  let index = 0;
  return new Response(new ReadableStream({ async pull(c) {
    if (delivery === 'delayed') await delay(2);
    const count = delivery === 'batched' ? frames.length : 1;
    for (let n = 0; n < count && index < frames.length; n++) c.enqueue(encode(frames[index++]!));
    if (index === frames.length) c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
for (const api of ['openai-responses', 'azure-openai-responses'] as const) for (const delivery of ['batched', 'delayed'] as const) for (const mode of ['part-done', 'no-part-done', 'conflict'] as const) {
  test(`lazy Responses summary/Core ${api}/${delivery}/${mode}`, { timeout: 15000 }, async () => {
    const model = { ...base, api, provider: `fixture-${api}` }; const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
      const body = await request.json() as { reasoning?: { effort: string; summary: string } };
      assert.equal(body.reasoning?.effort, 'medium'); assert.equal(body.reasoning.summary, 'auto');
      return scheduled(responsesFrames(model, mode !== 'no-part-done', mode === 'conflict'), delivery);
    };
    const app = await openCore(model);
    try {
      const direct = await app.models.streamSimple(model, { messages: [] }, { reasoning: 'medium' }).result();
      const first = direct.content[0]; assert.equal(first?.type === 'thinking' && first.thinking, mode === 'conflict' ? 'DIFFERENT authoritative body' : 'visible summary');
      const generate = async () => createPiLanguageModel(app.models, model).doGenerate({ prompt: [], providerOptions: { pi: { reasoning: 'medium' } } });
      if (mode === 'conflict') await assert.rejects(generate, /Conflicting Pi reasoning completion/);
      else { const generated = await generate(); const part = generated.content[0]; assert.ok(part?.type === 'reasoning'); assert.equal(part.text, 'visible summary'); assert.ok(String(part.providerMetadata?.pi?.thinkingSignature).includes(opaque)); }
      const receipt = await app.core.submitMessage({ content: 'Summary fixture' });
      assert.equal((await finished(app.core, receipt.runId!))?.status, mode === 'conflict' ? 'failed' : 'succeeded');
      assert.ok(!JSON.stringify(await app.core.history('main')).includes(opaque));
    } finally { await app.close(); globalThis.fetch = original; }
  });
}

for (const kind of ['text', 'thinking'] as const) for (const preceding of ['none', 'opaque', 'empty'] as const) for (const delivery of ['batched', 'per-frame'] as const) {
  test(`lazy bridge and Core stream ${kind} after ${preceding}/${delivery} before completion`, { timeout: 15000 }, async () => {
    const prefix = 'safe visible prefix '.repeat(7); const expected = prefix + 'suffix';
    const frames: Frame[] = [{ type: 'message_start', message: { id: 'live_core', type: 'message', role: 'assistant', model: base.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
    let index = 0;
    if (preceding !== 'none') { frames.push({ type: 'content_block_start', index, content_block: preceding === 'opaque' ? { type: 'redacted_thinking', data: opaque } : { type: 'thinking', thinking: '', signature } }, { type: 'content_block_stop', index }); index++; }
    frames.push({ type: 'content_block_start', index, content_block: { type: kind, [kind]: prefix, ...(kind === 'thinking' ? { signature } : {}) } }, { type: 'content_block_delta', index, delta: kind === 'text' ? { type: 'text_delta', text: 's' } : { type: 'thinking_delta', thinking: 's' } });
    const gateIndex = frames.length;
    for (const delta of ['uf', 'fix']) frames.push({ type: 'content_block_delta', index, delta: kind === 'text' ? { type: 'text_delta', text: delta } : { type: 'thinking_delta', thinking: delta } });
    frames.push({ type: 'content_block_stop', index }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' });
    const original = globalThis.fetch; let gate = deferred(); let entered = deferred();
    const requests: Array<{ messages: Array<{ role: string; content: Array<{ type: string; data?: string; thinking?: string; text?: string }> }> }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/')); requests.push(await request.json() as typeof requests[number]);
      let cursor = 0; const hold = gate; const reached = entered;
      return new Response(new ReadableStream({ async pull(c) {
        if (cursor === gateIndex) { reached.resolve(); await hold.promise; }
        if (delivery === 'per-frame') await new Promise<void>(r => setImmediate(r));
        const end = delivery === 'per-frame' ? cursor + 1 : cursor < gateIndex ? gateIndex : frames.length;
        while (cursor < end) c.enqueue(encode(frames[cursor++]!));
        if (cursor === frames.length) c.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
    const app = await openCore(base); const parts: LanguageModelV4StreamPart[] = []; let streamError: unknown;
    const collect = async () => { try { const { stream } = await createPiLanguageModel(app.models, base).doStream({ prompt: [] }); for await (const part of stream) parts.push(structuredClone(part)); } catch (e) { streamError = e; } };
    const deltaType = kind === 'text' ? 'text-delta' : 'reasoning-delta';
    const visible = () => parts.flatMap(p => p.type === deltaType ? [p.delta] : []).join('');
    const pending = collect();
    try {
      await entered.promise; await delay(80); const early = visible(); const finishedEarly = parts.some(p => p.type === 'finish');
      gate.resolve(); await pending; assert.equal(streamError, undefined); assert.equal(visible(), expected);
      assert.equal(early, prefix + 's'); assert.equal(finishedEarly, false);
      assert.ok(!JSON.stringify(parts.filter(p => p.type.endsWith('-delta'))).includes(opaque));
      assert.equal(parts.filter(p => p.type === 'reasoning-end').length, (preceding === 'none' ? 0 : 1) + (kind === 'thinking' ? 1 : 0));
      gate = deferred(); entered = deferred();
      const receipt = await app.core.submitMessage({ content: 'Live stream fixture' }); await entered.promise; await delay(100);
      const body = () => app.core.runtime.events('main', 0, 1000).flatMap(e => {
        const data = e.data as { event?: { type?: string; delta?: string } }; return e.kind === 'message_update' && data.event?.type === deltaType ? [data.event.delta ?? ''] : [];
      }).join('');
      const before = body(); const publicBefore = contextThinking(app.core, 'main').map(p => p.text).join('');
      assert.equal(app.core.store.getRun(receipt.runId!)?.status, 'running');
      gate.resolve(); assert.equal((await finished(app.core, receipt.runId!))?.status, 'succeeded');
      assert.equal(before, prefix + 's'); assert.equal(body(), expected); if (kind === 'thinking') assert.equal(publicBefore, prefix);
      const snapshot = app.core.projectMemory.snapshot(receipt.runId!);
      const native = snapshot.nativeMessages as { messages: import('../src/compaction.js').NativeMessage[] };
      const assistant = native.messages.findLast(m => m.role === 'assistant'); assert.ok(assistant);
      const serialized = JSON.stringify(assistant); assert.ok(serialized.includes(expected));
      assert.ok(!serializeConversation(native.messages).includes(opaque));
      assert.ok(!JSON.stringify(await app.core.history('main')).includes(opaque));
      assert.ok(!JSON.stringify(contextThinking(app.core, 'main')).includes(opaque));
      const raw = await app.core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
      const output = raw.messages.filter(m => m.role === 'assistant').flatMap(m => m.content.parts ?? []).filter(p => p.type === 'text' || p.type === 'reasoning');
      assert.deepEqual(output.map(p => p.type), [...(preceding === 'none' ? [] : ['reasoning']), kind === 'text' ? 'text' : 'reasoning']);
      if (preceding === 'opaque') assert.ok(serialized.includes(opaque));
      const next = await app.core.submitMessage({ content: 'Same-model continuation' }); assert.equal((await finished(app.core, next.runId!))?.status, 'succeeded');
      const replay = requests.at(-1)!.messages.find(m => m.role === 'assistant')?.content; assert.ok(replay);
      assert.deepEqual(replay.map(p => p.type), [...(preceding === 'none' ? [] : [preceding === 'opaque' ? 'redacted_thinking' : 'thinking']), kind]);
      if (preceding === 'opaque') assert.equal(replay[0]?.data, opaque);
    } finally { gate.resolve(); await pending; await app.close(); globalThis.fetch = original; }
  });
}

for (const api of ['openai-responses', 'azure-openai-responses'] as const) for (const delivery of ['batched', 'delayed'] as const) {
  test(`Responses ${api}/${delivery} preserves internal separators and body whitespace`, async () => {
    const model = { ...base, api, provider: `fixture-${api}` }; const original = globalThis.fetch;
    const texts = ['first summary', 'second summary  ']; const expected = texts.join('\n\n');
    globalThis.fetch = async (input, init) => {
      assert.ok(new Request(input, init).url.startsWith('https://fixture.invalid/'));
      const frames = responsesFrames(model, true, false);
      const item = { type: 'reasoning', id: 'rs_live', summary: texts.map(text => ({ type: 'summary_text', text })) };
      frames.splice(2, 5, ...texts.flatMap((text, summary_index) => [
        { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index, part: { type: 'summary_text', text: '' } },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index, delta: text },
        { type: 'response.reasoning_summary_part.done', output_index: 0, summary_index, part: { type: 'summary_text', text } },
      ]));
      for (const frame of frames) if (frame.type === 'response.output_item.done' && frame.output_index === 0) frame.item = item;
      const completed = frames.at(-1)!.response as { output: unknown[] }; completed.output[0] = { ...item, encrypted_content: opaque };
      return scheduled(frames, delivery);
    };
    try {
      const { models } = registry(model); const { stream } = await createPiLanguageModel(models, model).doStream({ prompt: [], providerOptions: { pi: { reasoning: 'medium' } } });
      const parts: LanguageModelV4StreamPart[] = []; for await (const part of stream) parts.push(structuredClone(part));
      assert.equal(parts.flatMap(p => p.type === 'reasoning-delta' ? [p.delta] : []).join(''), expected);
      assert.equal(parts.filter(p => p.type === 'reasoning-end').length, 1);
      assert.ok(String(parts.find(p => p.type === 'reasoning-end')?.providerMetadata?.pi?.thinkingSignature).includes(opaque));
    } finally { globalThis.fetch = original; }
  });
}

for (const api of ['openai-responses', 'azure-openai-responses'] as const) for (const kind of ['thinking', 'text'] as const) for (const delivery of ['batched', 'per-frame'] as const) {
  test(`Responses reasoning-only replay/Core ${api}/${kind}/${delivery}`, { timeout: 20000 }, async () => {
    const model = { ...base, api, provider: `fixture-${api}` }; const { provider, models } = registry(model);
    const prefix = 'safe visible prefix '.repeat(7); const expected = prefix + 'suffix';
    const empty = { type: 'reasoning', id: 'rs_empty', summary: [] };
    const encrypted = { ...empty, encrypted_content: opaque };
    const visible = kind === 'thinking'
      ? { type: 'reasoning', id: 'rs_visible', summary: [{ type: 'summary_text', text: expected }] }
      : { type: 'message', id: 'msg_visible', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: expected, annotations: [] }] };
    const delta = (text: string): Frame => kind === 'thinking'
      ? { type: 'response.reasoning_summary_text.delta', output_index: 1, summary_index: 0, delta: text }
      : { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: text };
    const frames: Frame[] = [
      { type: 'response.created', response: { id: 'resp_order', model: model.id, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: empty },
      { type: 'response.output_item.done', output_index: 0, item: empty },
      { type: 'response.output_item.added', output_index: 1, item: kind === 'thinking' ? { ...visible, summary: [] } : { ...visible, content: [] } },
      ...(kind === 'thinking' ? [{ type: 'response.reasoning_summary_part.added', output_index: 1, summary_index: 0, part: { type: 'summary_text', text: '' } }] : []),
      delta(prefix), delta('s'),
    ];
    const gateIndex = frames.length;
    frames.push(delta('uf'), delta('fix'));
    if (kind === 'thinking') frames.push({ type: 'response.reasoning_summary_part.done', output_index: 1, summary_index: 0, part: { type: 'summary_text', text: expected } });
    frames.push({ type: 'response.output_item.done', output_index: 1, item: visible });
    const terminalIndex = frames.length;
    frames.push({ type: 'response.completed', response: { id: 'resp_order', model: model.id, status: 'completed', output: [encrypted, visible], usage: { input_tokens: 1, output_tokens: 5, total_tokens: 6 } } });
    let gate = deferred(); let reached = deferred(); let terminal = deferred(); let terminalReached = deferred();
    const original = globalThis.fetch;
    const requests: Array<{ input: Array<{ type: string; role?: string; id?: string }> }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
      requests.push(await request.json() as typeof requests[number]);
      const hold = gate; const entered = reached; const terminalHold = terminal; const ended = terminalReached; let cursor = 0;
      return new Response(new ReadableStream({ async pull(c) {
        if (cursor === gateIndex) { entered.resolve(); await hold.promise; }
        if (cursor === terminalIndex) { ended.resolve(); await terminalHold.promise; }
        if (delivery === 'per-frame') await new Promise<void>(r => setImmediate(r));
        const boundary = cursor < gateIndex ? gateIndex : cursor < terminalIndex ? terminalIndex : frames.length;
        const end = delivery === 'per-frame' ? cursor + 1 : boundary;
        while (cursor < end) c.enqueue(encode(frames[cursor++]!));
        if (cursor === frames.length) c.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
    const assertPublic = async (core: Core, runId: string) => {
      const native = core.projectMemory.snapshot(runId).nativeMessages as { messages: import('../src/compaction.js').NativeMessage[] };
      assert.ok(JSON.stringify(native).includes(opaque));
      for (const value of [serializeConversation(native.messages), await core.history('main'), contextThinking(core, 'main'), publicEventPage(core, 0), snapshot(core)]) assert.ok(!JSON.stringify(value).includes(opaque));
    };
    const directory = await mkdtemp(join(tmpdir(), 'arona-reasoning-only-'));
    let core: Core | undefined; const contexts: Context[] = [];
    const open = async () => {
      const app = await Core.open({ dataDir: directory, controlToken: 'synthetic-reasoning-control-'.repeat(3), memoryEnabled: false });
      app.providerRegistry.setProvider(provider);
      app.models.save({ id: 'default', name: 'Fixture', providerId: model.provider, modelId: model.id, defaultThinkingLevel: 'medium' });
      const streamSimple = app.providerRegistry.streamSimple.bind(app.providerRegistry);
      app.providerRegistry.streamSimple = (target, context, options) => { contexts.push(structuredClone(context)); return streamSimple(target, context, options); };
      return app;
    };
    const parts: LanguageModelV4StreamPart[] = [];
    const collect = async () => {
      const { stream } = await createPiLanguageModel(models, model).doStream({ prompt: [], providerOptions: { pi: { reasoning: 'medium' } } });
      for await (const part of stream) parts.push(structuredClone(part));
    };
    const pending = collect(); const deltaType = kind === 'thinking' ? 'reasoning-delta' : 'text-delta';
    const body = () => parts.flatMap(p => p.type === deltaType ? [p.delta] : []).join('');
    try {
      await reached.promise; await until(body, text => text === prefix + 's');
      assert.equal(body().length, 141); assert.ok(!parts.some(p => p.type.endsWith('-end') || p.type === 'finish'));
      gate.resolve(); await terminalReached.promise; await until(body, text => text === expected);
      assert.ok(!parts.some(p => p.type === 'reasoning-end' || p.type === 'finish')); assert.ok(!JSON.stringify(parts).includes(opaque));
      const early = JSON.stringify(parts); const count = parts.length;
      terminal.resolve(); await pending; assert.equal(JSON.stringify(parts.slice(0, count)), early);
      const end = parts.find(p => p.type === 'reasoning-end' && p.id === '0'); assert.ok(end?.type === 'reasoning-end');
      assert.equal(end.providerMetadata?.pi?.thinkingSignature, JSON.stringify(encrypted));
      assert.equal(parts.filter(p => p.type === 'reasoning-end' && p.id === '0').length, 1);
      assert.deepEqual(parts.flatMap(p => p.type === 'reasoning-delta' && p.id === '0' ? [p.delta] : []), ['']);
      assert.ok(!JSON.stringify(parts.filter(p => p.type.endsWith('-delta'))).includes(opaque));
      gate = deferred(); reached = deferred(); terminal = deferred(); terminalReached = deferred();
      core = await open(); const app = core;
      const receipt = await app.submitMessage({ content: 'Reasoning-only storage fixture' });
      const coreBody = () => app.runtime.events('main', 0, 1000).flatMap(e => {
        const data = e.data as { event?: { type?: string; delta?: string } };
        return e.runId === receipt.runId && e.kind === 'message_update' && data.event?.type === deltaType ? [data.event.delta ?? ''] : [];
      }).join('');
      await reached.promise; await until(coreBody, text => text === prefix + 's'); assert.equal(coreBody().length, 141);
      if (kind === 'thinking') await until(() => contextThinking(app, 'main').map(p => p.text).join(''), text => text === prefix);
      gate.resolve(); await terminalReached.promise; await until(coreBody, text => text === expected);
      assert.equal(app.store.getRun(receipt.runId!)?.status, 'running'); assert.ok(!JSON.stringify(publicEventPage(app, 0)).includes(opaque));
      terminal.resolve(); assert.equal((await finished(app, receipt.runId!))?.status, 'succeeded'); await assertPublic(app, receipt.runId!);
      const raw = await app.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
      const stored = raw.messages.filter(m => m.role === 'assistant').flatMap(m => m.content.parts ?? []);
      assert.deepEqual(stored.map(p => p.type), ['reasoning', kind === 'thinking' ? 'reasoning' : 'text']);
      const storedEmpty = stored[0]; assert.ok(storedEmpty?.type === 'reasoning'); assert.equal(storedEmpty.reasoning, '');
      const assertReplay = () => {
        const previous = contexts.at(-1)!.messages.find(m => m.role === 'assistant'); assert.ok(previous);
        assert.deepEqual({ api: previous.api, provider: previous.provider, model: previous.model }, { api, provider: model.provider, model: model.id });
        assert.deepEqual(previous.content.map(p => p.type), ['thinking', kind]);
        const first = previous.content[0]; assert.ok(first?.type === 'thinking'); assert.equal(first.thinking, ''); assert.equal(first.thinkingSignature, JSON.stringify(encrypted));
        const replay = requests.at(-1)!.input.filter(p => p.type === 'reasoning' || p.type === 'message' && p.role === 'assistant');
        assert.deepEqual(replay.slice(0, 2), [encrypted, visible]);
      };
      const immediate = await app.submitMessage({ content: 'Immediate continuation' });
      assert.equal((await finished(app, immediate.runId!))?.status, 'succeeded'); assertReplay(); await assertPublic(app, immediate.runId!);
      await app.close(); core = undefined; core = await open();
      const restarted = await core.submitMessage({ content: 'Continuation after restart' });
      assert.equal((await finished(core, restarted.runId!))?.status, 'succeeded'); assertReplay(); await assertPublic(core, restarted.runId!);
    } finally {
      gate.resolve(); terminal.resolve(); await pending; await core?.close(); globalThis.fetch = original; await removeTemp(directory);
    }
  });
}

for (const api of ['openai-responses', 'azure-openai-responses'] as const) for (const delivery of ['batched', 'delayed'] as const) for (const chunking of ['single', 'split'] as const) for (const keep of [false, true]) {
  test(`Responses unconfirmed LF follows authoritative end ${api}/${delivery}/${chunking}/keep=${keep}`, { timeout: 15000 }, async () => {
    const model = { ...base, api, provider: `fixture-${api}` }; const { models } = registry(model);
    const expected = 'visible summary' + (keep ? '\n\n' : '');
    const initial = { type: 'reasoning', id: 'rs_whitespace', summary: [] };
    const final = { ...initial, summary: [{ type: 'summary_text', text: expected }] };
    // No part.done: the public Pi contract cannot distinguish these raw LF from
    // the same pair emitted by its summary-part separator. Neither is published
    // until *_end confirms it; other body conflicts must still fail closed.
    const frames: Frame[] = [
      { type: 'response.output_item.added', output_index: 0, item: initial },
      { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
      ...(chunking === 'single' ? ['visible summary\n\n'] : ['visible summary', '\n\n']).map(delta => ({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta })),
    ];
    const boundary = frames.length;
    frames.push({ type: 'response.output_item.done', output_index: 0, item: final },
      { type: 'response.completed', response: { id: 'resp_whitespace', model: model.id, status: 'completed', output: [{ ...final, encrypted_content: opaque }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    const original = globalThis.fetch; let gated = true; const hold = deferred(); const reached = deferred();
    globalThis.fetch = async (input, init) => {
      assert.ok(new Request(input, init).url.startsWith('https://fixture.invalid/')); let cursor = 0;
      return new Response(new ReadableStream({ async pull(c) {
        if (gated && cursor === boundary) { reached.resolve(); await hold.promise; }
        if (delivery === 'delayed') await delay(2);
        const end = delivery === 'delayed' ? cursor + 1 : cursor < boundary ? boundary : frames.length;
        while (cursor < end) c.enqueue(encode(frames[cursor++]!));
        if (cursor === frames.length) c.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
    const parts: LanguageModelV4StreamPart[] = [];
    const pending = (async () => { const { stream } = await createPiLanguageModel(models, model).doStream({ prompt: [] }); for await (const part of stream) parts.push(part); })();
    const body = () => parts.flatMap(p => p.type === 'reasoning-delta' ? [p.delta] : []).join('');
    let app: Awaited<ReturnType<typeof openCore>> | undefined;
    try {
      await reached.promise; await until(body, text => text === 'visible summary');
      assert.ok(!parts.some(p => p.type === 'reasoning-end' || p.type === 'finish'));
      hold.resolve(); await pending; assert.equal(body(), expected); gated = false;
      const generated = await createPiLanguageModel(models, model).doGenerate({ prompt: [] });
      const reasoning = generated.content[0]; assert.ok(reasoning?.type === 'reasoning'); assert.equal(reasoning.text, expected);
      app = await openCore(model); const receipt = await app.core.submitMessage({ content: 'Authoritative whitespace fixture' });
      assert.equal((await finished(app.core, receipt.runId!))?.status, 'succeeded');
      const raw = await app.core.memory.recall({ threadId: 'main', page: 0, perPage: 100, hideSignals: false });
      assert.deepEqual(raw.messages.filter(m => m.role === 'assistant').flatMap(m => m.content.parts ?? []).flatMap(p => p.type === 'reasoning' ? [p.reasoning] : []), [expected]);
      const streamed = app.core.runtime.events('main', 0, 1000).flatMap(e => {
        const data = e.data as { event?: { type?: string; delta?: string } };
        return e.runId === receipt.runId && e.kind === 'message_update' && data.event?.type === 'reasoning-delta' ? [data.event.delta ?? ''] : [];
      }).join('');
      assert.equal(streamed, expected); assert.equal(contextThinking(app.core, 'main').map(p => p.text).join(''), expected);
      assert.ok(!JSON.stringify(await app.core.history('main')).includes(opaque));
    } finally { hold.resolve(); await pending; await app?.close(); globalThis.fetch = original; }
  });
}

for (const api of ['openai-responses', 'azure-openai-responses'] as const) test(`Responses native replay metadata stays out of real context_history output ${api}`, { timeout: 15000 }, async () => {
  const model = { ...base, api, provider: `fixture-${api}` };
  const empty = { type: 'reasoning', id: 'rs_history_empty', summary: [] };
  const encrypted = { ...empty, encrypted_content: opaque };
  const visible = { type: 'reasoning', id: 'rs_history_visible', summary: [{ type: 'summary_text', text: 'visible history reasoning' }] };
  const call = { type: 'function_call', id: 'fc_history', call_id: 'call_history', name: 'context_history', arguments: JSON.stringify({ id: 'main', page: 0 }) };
  const answer = { type: 'message', id: 'msg_history_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'history read', annotations: [] }] };
  const original = globalThis.fetch; const requests: Array<{ input: Array<{ type: string; id?: string; output?: string }> }> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith('https://fixture.invalid/'));
    requests.push(await request.json() as typeof requests[number]);
    const output = requests.length === 1 ? [encrypted, visible] : requests.length === 2 ? [call] : [answer];
    const streamed = requests.length === 1 ? [empty, visible] : output;
    return scheduled([
      ...streamed.flatMap((item, output_index) => [
        { type: 'response.output_item.added', output_index, item: item.type === 'function_call' ? { ...item, arguments: '' } : item },
        { type: 'response.output_item.done', output_index, item },
      ]),
      { type: 'response.completed', response: { id: `resp_history_${requests.length}`, model: model.id, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ], 'batched');
  };
  const app = await openCore(model);
  try {
    const first = await app.core.submitMessage({ content: 'History metadata fixture' }); assert.equal((await finished(app.core, first.runId!))?.status, 'succeeded');
    const read = await app.core.submitMessage({ content: 'Read history' }); assert.equal((await finished(app.core, read.runId!))?.status, 'succeeded');
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2]!.input.find(p => p.type === 'reasoning' && p.id === encrypted.id), encrypted);
    const results = requests[2]!.input.filter(p => p.type === 'function_call_output'); assert.equal(results.length, 1);
    assert.ok(!JSON.stringify(results).includes(opaque)); assert.ok(JSON.stringify(results).includes('visible history reasoning'));
    const native = app.core.projectMemory.snapshot(read.runId!).nativeMessages as { messages: import('../src/compaction.js').NativeMessage[] };
    assert.ok(JSON.stringify(native).includes(opaque)); assert.ok(!serializeConversation(native.messages).includes(opaque));
    assert.ok(!JSON.stringify(await app.core.history('main')).includes(opaque));
  } finally { await app.close(); globalThis.fetch = original; }
});
