import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
import type { TokenMeasurement as ContractTokenMeasurement } from './contracts.js';

export interface MemoryTokenizerIdentity {
  readonly tokenizerId: 'js-tiktoken/cl100k_base';
  readonly tokenizerVersion: string;
  readonly encoding: 'cl100k_base';
  readonly vocabularyHash: string;
}

export interface MemoryTextOptions {
  /** 仅记录调用方给出的标识，不据此选择编码或推断模型精度。 */
  readonly modelId?: string | null;
}

export interface TokenMeasurement extends Readonly<ContractTokenMeasurement> {
  readonly basis: 'encoding';
  readonly scope: 'final-injection';
  readonly tokenizerId: MemoryTokenizerIdentity['tokenizerId'];
  readonly tokenizerVersion: string;
  readonly vocabularyHash: string;
  readonly inputHash: string;
  readonly textTokens: number;
  readonly exactForEncoding: true;
  readonly exactForProvider: false;
  readonly modelId: string | null;
  readonly mediaTokens: null;
  readonly mediaCostKnown: false;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// 从实际加载的包读取版本；不依赖工作目录、模型配置或外部服务。
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('js-tiktoken/lite')), 'utf8')) as { name?: unknown; version?: unknown };
if (packageMetadata.name !== 'js-tiktoken' || typeof packageMetadata.version !== 'string' || !packageMetadata.version) {
  throw new Error('memory_tokenizer_identity_invalid');
}

// 哈希覆盖实际编码资源：正则、完整 BPE 词表和按键排序的特殊标记映射。
// 序列化顺序固定，摘要为 UTF-8 JSON 的 SHA-256 小写十六进制值。
const vocabularyHash = sha256(JSON.stringify({
  pat_str: cl100kBase.pat_str,
  bpe_ranks: cl100kBase.bpe_ranks,
  special_tokens: Object.fromEntries(Object.entries(cl100kBase.special_tokens).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
}));
const identity: Readonly<MemoryTokenizerIdentity> = Object.freeze({
  tokenizerId: 'js-tiktoken/cl100k_base',
  tokenizerVersion: packageMetadata.version,
  encoding: 'cl100k_base',
  vocabularyHash,
});

// 导入后即同步就绪；词表随依赖安装，不执行初始化下载。
const encoder = new Tiktoken(cl100kBase);

export function getMemoryTokenizerIdentity(): Readonly<MemoryTokenizerIdentity> {
  return identity;
}

/** 计量调用方交付的完整最终字符串，不增删、规范化或拼接内容。 */
export function measureMemoryText(text: string, options: MemoryTextOptions = {}): TokenMeasurement {
  if (typeof text !== 'string') throw new TypeError('memory_text_invalid');
  const modelId = options.modelId ?? null;
  if (modelId !== null && (typeof modelId !== 'string' || modelId.length === 0)) throw new TypeError('memory_model_id_invalid');
  return {
    tokenizerId: identity.tokenizerId,
    tokenizerVersion: identity.tokenizerVersion,
    vocabularyHash: identity.vocabularyHash,
    basis: 'encoding',
    scope: 'final-injection',
    inputHash: sha256(text),
    // 两个空集合显式启用 ordinary text 行为：字面特殊标记不作为控制 token，也不拒绝。
    textTokens: encoder.encode(text, [], []).length,
    exactForEncoding: true,
    exactForProvider: false,
    modelId,
    mediaTokens: null,
    mediaCostKnown: false,
  };
}

export class MemoryTextBudgetExceededError extends RangeError {
  readonly code = 'memory_text_budget_exceeded';

  constructor(readonly budget: number, readonly measurement: TokenMeasurement) {
    super(`memory_text_budget_exceeded: ${measurement.textTokens} > ${budget}`);
    this.name = 'MemoryTextBudgetExceededError';
  }
}

/** budget 只约束此编码下的文本 token，不代表媒体或整个模型上下文的额度。 */
export function assertMemoryTextBudget(text: string, budget: number, options: MemoryTextOptions = {}): TokenMeasurement {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('memory_text_budget_invalid');
  const measurement = measureMemoryText(text, options);
  if (measurement.textTokens > budget) throw new MemoryTextBudgetExceededError(budget, measurement);
  return measurement;
}
