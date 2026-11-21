import { createHash } from 'node:crypto';
import { isBase64String } from '../../base64.js';
import type { LanguageModelV2CallOptions, LanguageModelV3CallOptions, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { AppError } from '../../domain.js';
import { measureMemoryText } from './tokens.js';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';

/** 整理请求只携带最近一步推理；原始历史与供应商私有重放记录不变。 */
export function boundMemoryReasoningHistory(prompt: ProcessLLMRequestArgs['prompt']): ProcessLLMRequestArgs['prompt'] {
  const latest = prompt.findLastIndex(message => message.role === 'assistant');
  return prompt.flatMap((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [message];
    const lastReasoning = message.content.findLastIndex(part => part.type === 'reasoning');
    const content = message.content.filter((part, partIndex) => part.type !== 'reasoning' || (index === latest && partIndex === lastReasoning));
    return content.length ? [{ ...message, content }] : [];
  });
}

/** 完成的旧工具往返可退出临时窗口；最新候选和原始资料由宿主每步完整提供。 */
export function boundMemoryToolHistory(prompt: ProcessLLMRequestArgs['prompt'], retainedPairs = 4): ProcessLLMRequestArgs['prompt'] {
  if (!Number.isSafeInteger(retainedPairs) || retainedPairs < 1) throw new AppError('memory_request_budget_invalid', 409);
  const completed = prompt.flatMap(message => message.role === 'tool' && Array.isArray(message.content)
    ? message.content.flatMap(part => part.type === 'tool-result' ? [part.toolCallId] : []) : []);
  const completedIds = new Set(completed), retained = new Set(completed.slice(-retainedPairs));
  return prompt.flatMap(message => {
    if (!['assistant', 'tool'].includes(message.role) || !Array.isArray(message.content)) return [message];
    const content = message.content.filter(part => !['tool-call', 'tool-result'].includes(part.type)
      || !('toolCallId' in part) || !completedIds.has(part.toolCallId) || retained.has(part.toolCallId));
    return content.length ? [{ ...message, content } as typeof message] : [];
  });
}

export interface MemoryRequestLimits {
  requestTextTokens: number;
  outputReserve: number;
  toolResultTokens: number;
  toolHistoryTokens: number;
  maxCalls: number;
  mediaCount: number;
  mediaBytes: number;
}
/** 宿主内部编码上限，不是供应商窗口或媒体 Token 的精确值。 */
export const DEFAULT_MEMORY_REQUEST_LIMITS: Readonly<MemoryRequestLimits> = Object.freeze({
  requestTextTokens: 65_536, outputReserve: 8192, toolResultTokens: 2048,
  toolHistoryTokens: 65_536, maxCalls: 64, mediaCount: 4, mediaBytes: 8 * 1024 * 1024,
});
export interface MemoryMediaBinding {
  evidenceId: string; attachmentId: string; sha256: string; mediaType: string; bytes: number;
}
export interface MemoryRequestMeasurement {
  protocolVersion: 1;
  requestHash: string;
  textTokens: number;
  outputReserve: number;
  effectiveTextLimit: number;
  contextWindowKnown: boolean;
  exactForEncoding: true;
  exactForProvider: false;
  tokenizerId: string;
  tokenizerVersion: string;
  vocabularyHash: string;
  mediaCostKnown: false;
  mediaTokens: null;
  media: MemoryMediaBinding[];
  toolHistoryTokens: number;
  call: number;
}
type Request = LanguageModelV2CallOptions | LanguageModelV3CallOptions | LanguageModelV4CallOptions;
// 只适配调用入口，不重定义 SDK/Mastra 的返回合同，保留被包装模型的精确类型。
interface MemoryRequestModel {
  readonly specificationVersion: 'v2' | 'v3' | 'v4';
  doGenerate: (options: never) => unknown;
  doStream: (options: never) => unknown;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const count = (value: unknown) => measureMemoryText(JSON.stringify(value)).textTokens;
const fail = (code: string): never => { throw new AppError(code, 409); };
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) fail('memory_request_budget_invalid');
  return value;
}
function binary(value: unknown): Uint8Array {
  // V4 inline carrier 只解一层；旧入口仍可直接传 bytes/base64，不递归接受嵌套包装。
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
    const type = Object.getOwnPropertyDescriptor(value, 'type'), data = Object.getOwnPropertyDescriptor(value, 'data');
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 2 ||
      !type || !('value' in type) || type.value !== 'data' || !data || !('value' in data)) return fail('memory_request_media_unbound');
    value = data.value;
  }
  if (value instanceof Uint8Array) return value;
  if (!isBase64String(value)) return fail('memory_request_media_unbound');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('memory_request_media_unbound');
  return bytes;
}
function plain(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('memory_request_shape_invalid'); return value; }
  if (value === undefined) return null;
  if (typeof value !== 'object' || value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof URL || ancestors.has(value)) return fail('memory_request_shape_invalid');
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) result = value.map(item => plain(item, ancestors));
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('memory_request_shape_invalid');
    result = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, plain(item, ancestors)]));
  }
  ancestors.delete(value);
  return result;
}

/** 每次真实 SDK 入口计量。一个实例跨 writer 修正和独立 review 共用，不因 generate 重置。 */
export class MemoryRequestBudget {
  readonly #limits: Readonly<MemoryRequestLimits>;
  readonly #contextWindow?: number;
  readonly #maxOutput?: number;
  readonly #history = new Map<string, string>();
  readonly #receipts: MemoryRequestMeasurement[] = [];
  readonly #supportedMediaTypes: ReadonlySet<string>;
  #calls = 0;
  #toolHistoryTokens = 0;
  constructor(options: {
    limits?: Partial<MemoryRequestLimits>;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportedMediaTypes?: readonly string[];
  } = {}) {
    this.#limits = Object.freeze({ ...DEFAULT_MEMORY_REQUEST_LIMITS, ...options.limits });
    Object.values(this.#limits).forEach(positive);
    this.#contextWindow = options.contextWindow === undefined ? undefined : positive(options.contextWindow);
    this.#maxOutput = options.maxOutputTokens === undefined ? undefined : positive(options.maxOutputTokens);
    this.#supportedMediaTypes = new Set(options.supportedMediaTypes ?? []);
  }
  receipts(): readonly MemoryRequestMeasurement[] { return structuredClone(this.#receipts); }

  check(request: Request, bindings: readonly MemoryMediaBinding[] = []): { measurement: MemoryRequestMeasurement; maxOutputTokens: number } {
    request.abortSignal?.throwIfAborted();
    if (this.#calls >= this.#limits.maxCalls) fail('memory_request_step_capacity');
    const reserve = Math.min(this.#limits.outputReserve, this.#maxOutput ?? Infinity);
    const maxOutputTokens = request.maxOutputTokens === undefined ? reserve : positive(request.maxOutputTokens);
    if (maxOutputTokens > reserve) fail('memory_request_output_capacity');
    const media: MemoryMediaBinding[] = [];
    const history = new Map(this.#history);
    let historyTokens = this.#toolHistoryTokens;
    const prompt = request.prompt.map(message => {
      if (message.role === 'system') return plain(message);
      return plain({ ...message, content: message.content.map(part => {
        if (part.type === 'file') {
          const bytes = binary(part.data), sha256 = hash(bytes);
          const headers = message.content.flatMap(item => {
            if (item.type !== 'text') return [];
            try {
              const value: unknown = JSON.parse(item.text);
              if (value && typeof value === 'object' && 'evidenceId' in value && 'attachmentId' in value && typeof value.evidenceId === 'string' && typeof value.attachmentId === 'string') return [{ evidenceId: value.evidenceId, attachmentId: value.attachmentId }];
            } catch { /* 普通正文不是媒体绑定头。 */ }
            return [];
          });
          if (headers.length > 1) return fail('memory_request_media_unbound');
          const header = headers[0];
          const matches = bindings.filter(row => row.sha256 === sha256 && row.bytes === bytes.byteLength && row.mediaType === part.mediaType &&
            (!header || (row.evidenceId === header.evidenceId && row.attachmentId === header.attachmentId)));
          if (matches.length !== 1 || !this.#supportedMediaTypes.has(part.mediaType)) return fail('memory_request_media_unbound');
          media.push({ ...matches[0]! });
          const { data: _data, ...fileHeader } = part;
          return { ...fileHeader, data: { sha256, bytes: bytes.byteLength } };
        }
        if (part.type === 'tool-result' || part.type === 'tool-call') {
          const text = JSON.stringify(plain(part)), identity = `${part.type}:${part.toolCallId}`;
          const previous = history.get(identity);
          if (previous !== undefined && previous !== hash(text)) fail('memory_request_tool_history_conflict');
          const size = measureMemoryText(text).textTokens;
          if (part.type === 'tool-result' && size > this.#limits.toolResultTokens) fail('memory_request_tool_result_capacity');
          if (previous === undefined) { history.set(identity, hash(text)); historyTokens += size; }
        }
        return part;
      }) });
    });
    if (historyTokens > this.#limits.toolHistoryTokens) throw Object.assign(new AppError('memory_request_tool_history_capacity', 409), { tokens: historyTokens, limit: this.#limits.toolHistoryTokens });
    if (media.length > this.#limits.mediaCount || media.reduce((total, row) => total + row.bytes, 0) > this.#limits.mediaBytes) fail('memory_request_media_capacity');
    // headers 与 AbortSignal 不是模型文本；其他请求选项（含工具 schema、provider 说明）全部参与编码。
    const { prompt: _prompt, abortSignal: _signal, headers: _headers, ...options } = request;
    const normalized = JSON.stringify(plain({ ...options, maxOutputTokens, prompt }));
    const measured = measureMemoryText(normalized);
    const effectiveTextLimit = Math.min(this.#limits.requestTextTokens, this.#contextWindow ?? Infinity);
    if (measured.textTokens + maxOutputTokens > effectiveTextLimit) throw Object.assign(new AppError('memory_request_text_capacity', 409), {
      textTokens: measured.textTokens, outputReserve: maxOutputTokens, limit: effectiveTextLimit,
      promptTokens: count(prompt), toolsTokens: count(request.tools ?? []), optionsTokens: count(options),
    });
    const measurement: MemoryRequestMeasurement = {
      protocolVersion: 1, requestHash: hash(normalized), textTokens: measured.textTokens, outputReserve: maxOutputTokens,
      effectiveTextLimit, contextWindowKnown: this.#contextWindow !== undefined, exactForEncoding: true, exactForProvider: false,
      tokenizerId: measured.tokenizerId, tokenizerVersion: measured.tokenizerVersion, vocabularyHash: measured.vocabularyHash,
      mediaCostKnown: false, mediaTokens: null, media, toolHistoryTokens: historyTokens, call: this.#calls + 1,
    };
    // 不可通过删掉下一次请求中的历史重置累计消耗；失败 gate 不登记曝光或成功调用。
    this.#history.clear(); for (const [id, value] of history) this.#history.set(id, value);
    this.#toolHistoryTokens = historyTokens; this.#calls++; this.#receipts.push(measurement);
    return { measurement: structuredClone(measurement), maxOutputTokens };
  }

  wrap<T extends MemoryRequestModel>(model: T, input: {
    mediaBindings?: () => readonly MemoryMediaBinding[];
    onRequest?: (measurement: MemoryRequestMeasurement) => void;
    onFailure?: (error: unknown) => void;
  } = {}): T {
    if (model.specificationVersion !== 'v2' && model.specificationVersion !== 'v3' && model.specificationVersion !== 'v4') fail('memory_request_model_unsupported');
    const budget = this;
    return new Proxy(model, { get(target, key) {
      if (key === 'doGenerate' || key === 'doStream') return (request: Request) => {
        let checked: ReturnType<MemoryRequestBudget['check']>;
        try {
          checked = budget.check(request, input.mediaBindings?.() ?? []);
          input.onRequest?.(checked.measurement);
        } catch (error) { input.onFailure?.(error); throw error; }
        // 使用实际请求克隆；不在模型对象上写入字段，也不丢失模型私有 this 状态。
        const invoke = target[key] as (request: Request) => unknown;
        return invoke.call(target, { ...request, maxOutputTokens: checked.maxOutputTokens });
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}

/** 单对象拒绝，不截断 JSON 或把局部文本标为完整结果。 */
export function assertMemoryModelObject(value: unknown, textTokens: number): void {
  const budget = positive(textTokens), measured = count(plain(value));
  if (measured > budget) throw Object.assign(new AppError('memory_model_object_capacity', 409), { textTokens: measured, budget });
}
