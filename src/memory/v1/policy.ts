import { z } from 'zod';

const tokenizerConfiguration = {
  implementation: z.literal('js-tiktoken'), encoding: z.literal('cl100k_base'), exactForProvider: z.literal(false),
};

// ready 只描述声明的资源身份；是否匹配本机编码器须由宿主绑定检查。
const tokenizerPolicySchema = z.discriminatedUnion('readiness', [
  z.strictObject({ ...tokenizerConfiguration, readiness: z.literal('pending-dependency'), version: z.null(), vocabularyHash: z.null() }),
  z.strictObject({ ...tokenizerConfiguration, readiness: z.literal('ready'), version: z.string().min(1), vocabularyHash: z.string().regex(/^[a-f0-9]{64}$/) }),
]);

export const memoryContextPolicySchema = z.strictObject({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  recent: z.strictObject({
    days: z.number().int().positive(), textTokens: z.number().int().positive(), maxImages: z.number().int().nonnegative(),
    timeBasis: z.literal('occurred-at-else-received-at'), overflow: z.literal('whole-records-newest-first'),
  }),
  resident: z.strictObject({ textTokens: z.number().int().positive(), injection: z.literal('all'), protectedOverflow: z.literal('block-publication') }),
  organization: z.strictObject({ softTriggerRatio: z.number().positive().max(1), maxCapacityCorrections: z.number().int().positive() }),
  tokenizer: tokenizerPolicySchema,
});
export type MemoryContextPolicy = z.infer<typeof memoryContextPolicySchema>;

/** 返回独立配置对象；配置预算不代表已经完成编码计量或运行时接线。 */
export function createDefaultMemoryContextPolicy(): MemoryContextPolicy {
  return memoryContextPolicySchema.parse({
    schemaVersion: 1, revision: 1,
    recent: { days: 7, textTokens: 4096, maxImages: 4, timeBasis: 'occurred-at-else-received-at', overflow: 'whole-records-newest-first' },
    resident: { textTokens: 8192, injection: 'all', protectedOverflow: 'block-publication' },
    organization: { softTriggerRatio: 0.8, maxCapacityCorrections: 3 },
    tokenizer: { implementation: 'js-tiktoken', encoding: 'cl100k_base', readiness: 'pending-dependency', version: null, vocabularyHash: null, exactForProvider: false },
  });
}
