import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { LanguageModelV2CallOptions, LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4FilePart, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { MemoryRequestBudget, assertMemoryModelObject } from '../src/memory/v1/request-budget.js';

const request = (text = '合成请求'): LanguageModelV2CallOptions => ({ prompt: [{ role: 'user', content: [{ type: 'text', text }] }] });
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
const call = (id: string, value: string): LanguageModelV2CallOptions => ({ prompt: [
  { role: 'assistant', content: [{ type: 'tool-call', toolName: 'synthetic', toolCallId: id, input: { value } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolName: 'synthetic', toolCallId: id, output: { type: 'json', value: { ok: true, value } } }] },
] });

test('实际 Agent 多步入口计入说明、schema、工具参数、回执和独立 review', async () => {
  const budget = new MemoryRequestBudget(); let steps = 0, toolExecutions = 0;
  const captured: LanguageModelV2CallOptions[] = [];
  const raw = new MastraLanguageModelV2Mock({ doGenerate: async options => {
    captured.push(options); steps++;
    if (!options.tools?.length || steps > 2) return finish('合成结束');
    return { content: [{ type: 'tool-call' as const, toolName: 'synthetic', toolCallId: `tool-${steps}`, input: JSON.stringify({ value: `合成值${steps}` }) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  const model = budget.wrap(raw);
  const writer = new Agent({ id: 'bounded-writer', name: '合成写者', model, instructions: '合成说明必须计入请求。', tools: {
    synthetic: createTool({ id: 'synthetic', description: '合成工具 schema 不能免于计量', inputSchema: z.object({ value: z.string().describe('完整参数') }), execute: async value => { toolExecutions++; return { ...value, reply: '实际工具回执' }; } }),
  } });
  await writer.generate('合成资料', { maxSteps: 4 });
  const reviewer = new Agent({ id: 'bounded-review', name: '合成独立复核', model, instructions: '独立无工具复核' });
  await reviewer.generate('检查本次候选', { maxSteps: 1 });
  assert.equal(toolExecutions, 2); assert.equal(captured.length, 4);
  const receipts = budget.receipts(); assert.equal(receipts.length, captured.length);
  assert.ok(captured[0]!.prompt.some(row => row.role === 'system' && row.content.includes('合成说明')));
  assert.ok(JSON.stringify(captured[0]!.tools).includes('完整参数'));
  assert.ok(JSON.stringify(captured[2]!.prompt).includes('实际工具回执'));
  assert.equal(captured.at(-1)!.tools?.length ?? 0, 0);
  assert.ok(receipts[2]!.toolHistoryTokens > receipts[1]!.toolHistoryTokens);
  assert.equal(receipts.at(-1)!.toolHistoryTokens, receipts[2]!.toolHistoryTokens, '无工具 review 不清空历史累计');
  for (let i = 0; i < receipts.length; i++) {
    assert.equal(captured[i]!.maxOutputTokens, receipts[i]!.outputReserve);
    assert.ok(receipts[i]!.textTokens + receipts[i]!.outputReserve <= receipts[i]!.effectiveTextLimit);
    assert.equal(receipts[i]!.exactForProvider, false); assert.equal(receipts[i]!.contextWindowKnown, false);
    assert.equal(receipts[i]!.mediaCostKnown, false); assert.equal(receipts[i]!.mediaTokens, null);
    assert.match(receipts[i]!.requestHash, /^[a-f0-9]{64}$/);
  }
});

test('工具结果过大在下一次真实模型调用之前拒绝', async () => {
  const budget = new MemoryRequestBudget({ limits: { toolResultTokens: 100 } }); let actualCalls = 0;
  const raw = new MastraLanguageModelV2Mock({ doGenerate: async () => {
    actualCalls++;
    return { content: [{ type: 'tool-call' as const, toolName: 'large', toolCallId: 'large-1', input: '{}' }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  const agent = new Agent({ id: 'large-receipt', name: '合成大回执', model: budget.wrap(raw), instructions: '测试', tools: {
    large: createTool({ id: 'large', description: '合成工具', inputSchema: z.object({}), execute: async () => ({ content: ' word'.repeat(1000) }) }),
  } });
  await assert.rejects(agent.generate('检查回执', { maxSteps: 3 }));
  assert.equal(actualCalls, 1); assert.equal(budget.receipts().length, 1);
});

test('最终 SDK 入口而非初始提示计量，schema 和错误历史同受总限额', () => {
  const budget = new MemoryRequestBudget({ limits: { requestTextTokens: 600, outputReserve: 64 } });
  const small = budget.check(request()); assert.ok(small.measurement.textTokens < 100);
  const schema: LanguageModelV2CallOptions = { ...request(), tools: [{ type: 'function', name: 'tool', description: ' word'.repeat(700), inputSchema: { type: 'object' } }] };
  assert.throws(() => budget.check(schema), /memory_request_text_capacity/);
  const error = request(); error.prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'failed', toolName: 'tool', output: { type: 'error-text', value: ' error'.repeat(700) } }] });
  assert.throws(() => budget.check(error), /memory_request_text_capacity/);
  assert.equal(budget.receipts().length, 1, '拒绝请求不能登记为实际曝光');
});

test('纠正循环不能通过丢弃历史或重新包装模型重置累计预算', () => {
  const budget = new MemoryRequestBudget({ limits: { toolHistoryTokens: 160 } });
  const first = budget.check(call('one', 'word '.repeat(20))).measurement;
  const repeated = budget.check(call('one', 'word '.repeat(20))).measurement;
  assert.equal(repeated.toolHistoryTokens, first.toolHistoryTokens, '相同历史不能重复计费');
  budget.check(request('修正初始提示不含工具历史'));
  assert.throws(() => budget.check(call('two', 'word '.repeat(20))), /memory_request_tool_history_capacity/);
  assert.equal(budget.receipts().at(-1)!.toolHistoryTokens, first.toolHistoryTokens);
  assert.throws(() => budget.check(call('one', '修改旧调用参数')), /memory_request_tool_history_conflict/);
});

test('较小可信窗口与 maxOutput 优先，未知窗口只记内部编码上限', () => {
  const known = new MemoryRequestBudget({ contextWindow: 200, maxOutputTokens: 50 });
  const measured = known.check(request()); assert.equal(measured.maxOutputTokens, 50); assert.equal(measured.measurement.effectiveTextLimit, 200); assert.equal(measured.measurement.contextWindowKnown, true);
  assert.throws(() => known.check(request(' word'.repeat(180))), /memory_request_text_capacity/);
  assert.throws(() => known.check({ ...request(), maxOutputTokens: 51 }), /memory_request_output_capacity/);
  const unknown = new MemoryRequestBudget().check(request()).measurement;
  assert.equal(unknown.contextWindowKnown, false); assert.equal(unknown.exactForProvider, false);
});

test('图片原 bytes 与合法 base64 走独立媒体上限，不按字节数组或编码字符串算正文', () => {
  const bytes = Buffer.alloc(1024 * 1024, 0x7a), binding = { evidenceId: 'e', attachmentId: 'image', sha256: sha(bytes), mediaType: 'image/png', bytes: bytes.length };
  const budget = new MemoryRequestBudget({ supportedMediaTypes: ['image/png'], limits: { requestTextTokens: 1024, outputReserve: 64 } });
  for (const data of [new Uint8Array(bytes), bytes.toString('base64')]) {
    const input = request(); input.prompt.push({ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data }] });
    const measured = budget.check(input, [binding]).measurement;
    assert.ok(measured.textTokens < 256); assert.equal(measured.media[0]!.bytes, bytes.length);
    assert.equal(measured.mediaCostKnown, false); assert.equal(measured.mediaTokens, null);
  }
});

test('未知/篡改媒体、URL、未绑定来源与能力不符全部拒绝', () => {
  const bytes = new Uint8Array([1, 2, 3]), binding = { evidenceId: 'e', attachmentId: 'image', sha256: sha(bytes), mediaType: 'image/png', bytes: bytes.length };
  const budget = new MemoryRequestBudget({ supportedMediaTypes: ['image/png'] });
  const media = (data: Uint8Array | URL | string): LanguageModelV2CallOptions => ({ prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data }] }] });
  assert.throws(() => budget.check(media(bytes)), /memory_request_media_unbound/);
  assert.throws(() => budget.check(media(new URL('https://example.invalid/private')), [binding]), /memory_request_media_unbound/);
  assert.throws(() => budget.check(media('AQID!'), [binding]), /memory_request_media_unbound/);
  assert.throws(() => budget.check(media(new Uint8Array([2, 3, 4])), [binding]), /memory_request_media_unbound/);
  assert.throws(() => new MemoryRequestBudget().check(media(bytes), [binding]), /memory_request_media_unbound/);
  assert.equal(budget.receipts().length, 0);
});

test('媒体数量及原字节有独立上限', () => {
  const bytes = new Uint8Array([1, 2, 3]), binding = { evidenceId: 'e', attachmentId: 'image', sha256: sha(bytes), mediaType: 'image/png', bytes: bytes.length };
  const input: LanguageModelV2CallOptions = { prompt: [{ role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'file' as const, mediaType: 'image/png', data: bytes })) }] };
  assert.throws(() => new MemoryRequestBudget({ supportedMediaTypes: ['image/png'] }).check(input, [binding]), /memory_request_media_capacity/);
  assert.throws(() => new MemoryRequestBudget({ supportedMediaTypes: ['image/png'], limits: { mediaBytes: 2 } }).check({ prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: bytes }] }] }, [binding]), /memory_request_media_capacity/);
});

test('显式 32 次调用总上限跨 generate/stream，不接受取消请求或非法额度', async () => {
  let calls = 0;
  const raw = new MastraLanguageModelV2Mock({ doGenerate: async () => { calls++; return finish('合成'); }, doStream: async () => { calls++; return { stream: new ReadableStream({ start(c) { c.close(); } }) }; } });
  const budget = new MemoryRequestBudget({ limits: { maxCalls: 32 } }), model = budget.wrap(raw);
  const sdkRequest = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: '合成请求' }] }] };
  for (let i = 0; i < 32; i++) { if (i % 2) await model.doStream(sdkRequest); else await model.doGenerate(sdkRequest); }
  assert.throws(() => model.doGenerate(sdkRequest), /memory_request_step_capacity/); assert.equal(calls, 32);
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => new MemoryRequestBudget().check({ ...request(), abortSignal: aborted.signal }));
  for (const value of [0, -1, 1.5, Number.NaN, Infinity]) assert.throws(() => new MemoryRequestBudget({ limits: { requestTextTokens: value } }), /memory_request_budget_invalid/);
});

test('单对象超限拒绝而非截断；非媒体二进制不能绕过正文预算', () => {
  const value = { content: ' word'.repeat(1000) }, original = structuredClone(value);
  assert.throws(() => assertMemoryModelObject(value, 100), /memory_model_object_capacity/); assert.deepEqual(value, original);
  assert.throws(() => assertMemoryModelObject({ hidden: new Uint8Array([1, 2, 3]) }, 1000), /memory_request_shape_invalid/);
});

test('相同图片 bytes 的不同来源由真实绑定头消歧，错误头不能借同 hash 越权', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const bindings = ['one', 'two'].map(evidenceId => ({ evidenceId, attachmentId: 'image', sha256: sha(bytes), mediaType: 'image/png', bytes: bytes.length }));
  const budget = new MemoryRequestBudget({ supportedMediaTypes: ['image/png'] });
  const media = (ids: string[]): LanguageModelV2CallOptions => ({ prompt: ids.map(evidenceId => ({ role: 'user', content: [
    { type: 'text', text: JSON.stringify({ evidenceId, attachmentId: 'image' }) }, { type: 'file', mediaType: 'image/png', data: bytes },
  ] })) });
  const measurement = budget.check(media(['one', 'two']), bindings).measurement;
  assert.deepEqual(measurement.media.map(row => row.evidenceId), ['one', 'two']);
  assert.equal(measurement.media.reduce((sum, row) => sum + row.bytes, 0), 6);
  assert.throws(() => budget.check(media(['unknown']), bindings), /memory_request_media_unbound/);
  const noHeader: LanguageModelV2CallOptions = { prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: bytes }] }] };
  assert.throws(() => budget.check(noHeader, bindings), /memory_request_media_unbound/);
});

const v4Usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const v4Finish = { unified: 'stop' as const, raw: 'synthetic-stop' };
function nativeV4() {
  const captured: { method: 'generate' | 'stream'; request: LanguageModelV4CallOptions }[] = [];
  // 私有字段同时验证 wrap 没有把原模型 this 替换为 Proxy。
  class NativeModel implements LanguageModelV4 {
    readonly specificationVersion = 'v4' as const;
    readonly provider = 'synthetic'; readonly modelId = 'synthetic-v4'; readonly supportedUrls = {};
    #calls = 0;
    async doGenerate(request: LanguageModelV4CallOptions) {
      this.#calls++; captured.push({ method: 'generate', request });
      return { content: [{ type: 'text' as const, text: '合成 V4 完成' }], finishReason: v4Finish, usage: v4Usage, warnings: [] };
    }
    async doStream(request: LanguageModelV4CallOptions) {
      this.#calls++; captured.push({ method: 'stream', request });
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text' });
        controller.enqueue({ type: 'text-delta', id: 'text', delta: '合成 V4 流' });
        controller.enqueue({ type: 'text-end', id: 'text' });
        controller.enqueue({ type: 'finish', finishReason: v4Finish, usage: v4Usage }); controller.close();
      } }) };
    }
  }
  return { raw: new NativeModel(), captured };
}
function v4Media(data: LanguageModelV4FilePart['data'], evidenceId = 'v4-evidence', mediaType = 'image/png', files = 1): LanguageModelV4CallOptions {
  return { prompt: [{ role: 'user', content: [
    { type: 'text', text: JSON.stringify({ evidenceId, attachmentId: 'v4-image' }) },
    ...Array.from({ length: files }, () => ({ type: 'file' as const, mediaType, data })),
  ] }] };
}

for (const method of ['doGenerate', 'doStream'] as const) test(`原生 V4 wrap.${method} 传递合法 tagged bytes/base64，真实计量绑定与独立媒体成本`, async () => {
  const bytes = new Uint8Array(128 * 1024).fill(0x7a);
  const binding = { evidenceId: 'v4-evidence', attachmentId: 'v4-image', sha256: sha(bytes), bytes: bytes.byteLength, mediaType: 'image/png' };
  const budget = new MemoryRequestBudget({ supportedMediaTypes: ['image/png'], limits: { requestTextTokens: 1024, outputReserve: 64 } });
  const { raw, captured } = nativeV4(), model = budget.wrap(raw, { mediaBindings: () => [binding] });
  const hashes: string[] = [];
  for (const data of [bytes, Buffer.from(bytes).toString('base64')]) {
    const carrier: LanguageModelV4FilePart['data'] = { type: 'data', data }, input = v4Media(carrier);
    if (method === 'doGenerate') assert.equal((await model.doGenerate(input)).content[0]!.type, 'text');
    else {
      const { stream } = await model.doStream(input), parts: LanguageModelV4StreamPart[] = [];
      for await (const part of stream) parts.push(part);
      assert.deepEqual(parts.map(part => part.type), ['text-start', 'text-delta', 'text-end', 'finish']);
    }
    const actual = captured.at(-1)!;
    assert.equal(actual.method, method === 'doGenerate' ? 'generate' : 'stream');
    assert.strictEqual(actual.request.prompt, input.prompt);
    assert.strictEqual((actual.request.prompt[0]!.content[1] as LanguageModelV4FilePart).data, carrier, '不得把 V4 carrier 改为 V2 bytes 或 hash 占位对象');
    assert.equal(actual.request.maxOutputTokens, 64);
    const receipt = budget.receipts().at(-1)!; hashes.push(receipt.requestHash);
    assert.deepEqual(receipt.media, [binding]); assert.ok(receipt.textTokens < 256);
    assert.equal(receipt.mediaCostKnown, false); assert.equal(receipt.mediaTokens, null);
  }
  assert.equal(captured.length, 2); assert.equal(budget.receipts().length, 2);
  assert.equal(hashes[0], hashes[1], '相同原 bytes 不因合法载体不同而改变绑定计量');
});

for (const method of ['doGenerate', 'doStream'] as const) test(`原生 V4 wrap.${method} 在实际模型前拒绝非法载体、篡改绑定和媒体超限`, () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const binding = { evidenceId: 'v4-evidence', attachmentId: 'v4-image', sha256: sha(bytes), bytes: bytes.byteLength, mediaType: 'image/png' };
  const cyclic: Record<string, unknown> = { type: 'data' }; cyclic.data = cyclic;
  const invalid: unknown[] = [
    { type: 'url', url: new URL('https://example.invalid/image.png') },
    { type: 'reference', reference: { synthetic: 'file-id' } }, { type: 'text', text: 'AQID' },
    { type: 'wrong', data: bytes }, { data: bytes }, { type: 'data', data: bytes, extra: true },
    { type: 'data', data: bytes, url: new URL('https://example.invalid/image.png') },
    { type: 'data', data: { type: 'data', data: bytes } }, cyclic, null, {}, [],
    Object.create({ type: 'data', data: bytes }),
    { type: 'data', data: bytes, [Symbol('extra')]: true },
    Object.defineProperty({ type: 'data', data: bytes }, 'extra', { value: true }),
    { type: 'data', get data() { throw new Error('不得执行载体 getter'); } },
    { get type() { throw new Error('不得执行标签 getter'); }, data: bytes },
    { type: 'data', data: new URL('https://example.invalid/image.png') },
    { type: 'data', data: 'https://example.invalid/image.png' }, { type: 'data', data: 'AQID!' },
    { type: 'data', data: 'data:image/png;base64,AQID' }, { type: 'data', data: new ArrayBuffer(3) },
    { type: 'data', data: new Uint8Array([3, 2, 1]) }, { type: 'data', data: new Uint8Array([1, 2]) },
  ];
  for (const carrier of invalid) {
    const budget = new MemoryRequestBudget({ supportedMediaTypes: ['image/png'] }), { raw, captured } = nativeV4();
    const model = budget.wrap(raw, { mediaBindings: () => [binding] });
    assert.throws(() => model[method](v4Media(carrier as LanguageModelV4FilePart['data'])), /memory_request_media_unbound/);
    assert.equal(captured.length, 0); assert.equal(budget.receipts().length, 0);
  }
  const carrier = { type: 'data' as const, data: bytes };
  const negatives = [
    { request: v4Media(carrier, 'wrong-evidence'), bindings: [binding], code: 'unbound' },
    { request: v4Media(carrier, 'v4-evidence', 'image/jpeg'), bindings: [binding], code: 'unbound' },
    { request: v4Media(carrier), bindings: [{ ...binding, sha256: '0'.repeat(64) }], code: 'unbound' },
    { request: v4Media(carrier), bindings: [{ ...binding, bytes: 2 }], code: 'unbound' },
    { request: v4Media(carrier), bindings: [{ ...binding, attachmentId: 'wrong-image' }], code: 'unbound' },
    { request: v4Media(carrier), bindings: [], code: 'unbound' },
    { request: v4Media(carrier), bindings: [binding], supported: [], code: 'unbound' },
    { request: v4Media(carrier, 'v4-evidence', 'image/png', 5), bindings: [binding], code: 'capacity' },
    { request: v4Media(carrier), bindings: [binding], limits: { mediaBytes: 2 }, code: 'capacity' },
    { request: v4Media(carrier, 'v4-evidence', 'image/png', 2), bindings: [binding], limits: { mediaBytes: 5 }, code: 'capacity' },
  ];
  for (const item of negatives) {
    const budget = new MemoryRequestBudget({ supportedMediaTypes: item.supported ?? ['image/png'], limits: item.limits }), { raw, captured } = nativeV4();
    const model = budget.wrap(raw, { mediaBindings: () => item.bindings });
    assert.throws(() => model[method](item.request), new RegExp(`memory_request_media_${item.code}`));
    assert.equal(captured.length, 0); assert.equal(budget.receipts().length, 0);
  }
});

// Mastra 可把 V4 file.data 归一为旧版入口形状；预算两侧都必须保留原件。
test('实际 Mastra Agent 的 V4 图片归一链保持可用，原件与预算媒体回执一致', async () => {
  const bytes = new Uint8Array([1, 2, 3]), binding = { evidenceId: 'v4-evidence', attachmentId: 'v4-image', sha256: sha(bytes), bytes: 3, mediaType: 'image/png' };
  const { raw, captured } = nativeV4(), budget = new MemoryRequestBudget({ supportedMediaTypes: ['image/png'] });
  const selected = await new Agent({ id: 'synthetic-v4-selected', name: 'Synthetic V4 selected', instructions: '', model: raw }).getModel();
  assert.equal(selected.specificationVersion, 'v4');
  const agent = new Agent({ id: 'synthetic-v4-budget', name: 'Synthetic V4 budget', instructions: '核对合成图片。',
    model: budget.wrap(selected, { mediaBindings: () => [binding] }),
    inputProcessors: [{ id: 'synthetic-v4-media', processLLMRequest: args => ({ prompt: [...args.prompt, { role: 'user' as const, content: [
      { type: 'text' as const, text: JSON.stringify({ evidenceId: binding.evidenceId, attachmentId: binding.attachmentId }) },
      { type: 'file' as const, data: bytes, mediaType: 'image/png' },
    ] }] }) }],
  });
  const result = await agent.generate('合成资料核对。');
  assert.ok(result.text.includes('合成 V4')); assert.equal(captured.length, 1);
  assert.deepEqual(budget.receipts()[0]!.media, [binding]);
  const files = captured[0]!.request.prompt.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(part => part.type === 'file'));
  assert.equal(files.length, 1);
  const data = files[0]!.data;
  assert.equal(data.type, 'data');
  if (data.type !== 'data') throw new Error('inline V4 carrier required');
  assert.deepEqual(Buffer.from(data.data), Buffer.from(bytes));
});
