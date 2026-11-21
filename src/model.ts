import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { ModelConfig } from './config.js';
import { AppError } from './domain.js';
import { MIN_ANSWER_TOKENS } from '@earendil-works/pi-ai/api/simple-options';

/** Apply the configured model ceiling to every caller, including summaries. */
function outputCeiling(model: LanguageModelV4, maximum: number | undefined, protocol: ModelConfig['protocol']): LanguageModelV4 {
  if (maximum === undefined && protocol !== 'messages') return model;
  const bounded = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => {
    const ceiling = maximum === undefined ? options.maxOutputTokens : Math.min(options.maxOutputTokens ?? maximum, maximum);
    if (ceiling === undefined) return options;
    const anthropic = options.providerOptions?.anthropic;
    const thinking = anthropic?.thinking;
    if (protocol === 'messages' && thinking && typeof thinking === 'object' && 'type' in thinking && thinking.type === 'enabled') {
      // The native SDK adds this budget to maxOutputTokens. Keep both within
      // the shared response limit used by context and request accounting.
      const requested = 'budgetTokens' in thinking && typeof thinking.budgetTokens === 'number' ? thinking.budgetTokens : 1024;
      const budget = Math.min(requested, ceiling - MIN_ANSWER_TOKENS);
      if (budget < 1024) throw new AppError('model_thinking_output_capacity', 409);
      return { ...options, maxOutputTokens: ceiling - budget,
        ...(budget === requested ? {} : { providerOptions: { ...options.providerOptions, anthropic: { ...anthropic, thinking: { ...thinking, budgetTokens: budget } } } }) };
    }
    return options.maxOutputTokens === ceiling ? options : { ...options, maxOutputTokens: ceiling };
  };
  const doStream: LanguageModelV4['doStream'] = options => model.doStream(bounded(options));
  const doGenerate: LanguageModelV4['doGenerate'] = options => model.doGenerate(bounded(options));
  return new Proxy(model, { get(target, property) {
    if (property === 'doStream') return doStream;
    if (property === 'doGenerate') return doGenerate;
    return Reflect.get(target, property, target);
  } });
}

const apiKeyFetch = (requestFetch: typeof globalThis.fetch): typeof globalThis.fetch => (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.delete('Authorization');
  return requestFetch(input, { ...init, headers, redirect: 'error' });
};

export function createModel(config: ModelConfig, requestFetch?: typeof globalThis.fetch): LanguageModelV4 {
  if (config.protocol === 'messages') {
    const provider = createAnthropic({
      baseURL: config.baseURL,
      ...(requestFetch ? { fetch: requestFetch } : {}),
      ...((config.requestAuth ?? config.authHeader) === 'bearer'
        ? { authToken: config.apiKey }
        : { apiKey: config.apiKey }),
    });
    return outputCeiling(provider(config.modelId), config.maxTokens, config.protocol);
  }
  const provider = createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey,
    // Existing profiles used Bearer for these protocols. The optional explicit
    // scheme extends that contract without reinterpreting saved legacy fields.
    ...(requestFetch ? { fetch: requestFetch } : {}),
    ...(config.requestAuth === 'api-key' ? { headers: { 'api-key': config.apiKey }, fetch: apiKeyFetch(requestFetch ?? ((...args) => globalThis.fetch(...args))) } : {}) });
  const model = config.protocol === 'chat-completions'
    ? provider.chat(config.modelId)
    : provider.responses(config.modelId);
  return outputCeiling(model, config.maxTokens, config.protocol);
}
