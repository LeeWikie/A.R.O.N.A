import { createDefaultMemoryContextPolicy, memoryContextPolicySchema } from './policy.js';
import type { MemoryContextPolicy } from './policy.js';
import { getMemoryTokenizerIdentity } from './tokens.js';

export type PreparedMemoryContextPolicy = Readonly<{
  schemaVersion: MemoryContextPolicy['schemaVersion'];
  revision: MemoryContextPolicy['revision'];
  recent: Readonly<MemoryContextPolicy['recent']>;
  resident: Readonly<MemoryContextPolicy['resident']>;
  organization: Readonly<MemoryContextPolicy['organization']>;
  tokenizer: Readonly<Extract<MemoryContextPolicy['tokenizer'], { readiness: 'ready' }>>;
}>;

/** 根据实际本地资源校验配置并返回独立、不可变的策略快照。 */
export function resolveMemoryContextPolicy(configuration: unknown = createDefaultMemoryContextPolicy()): PreparedMemoryContextPolicy {
  const policy = memoryContextPolicySchema.parse(configuration);
  const identity = getMemoryTokenizerIdentity();
  if (policy.tokenizer.readiness === 'ready'
    && (policy.tokenizer.version !== identity.tokenizerVersion || policy.tokenizer.vocabularyHash !== identity.vocabularyHash)) {
    throw new Error('memory_tokenizer_identity_mismatch');
  }
  return Object.freeze({
    ...policy,
    recent: Object.freeze(policy.recent),
    resident: Object.freeze(policy.resident),
    organization: Object.freeze(policy.organization),
    tokenizer: Object.freeze({
      implementation: policy.tokenizer.implementation,
      encoding: identity.encoding,
      readiness: 'ready' as const,
      version: identity.tokenizerVersion,
      vocabularyHash: identity.vocabularyHash,
      exactForProvider: false as const,
    }),
  });
}
