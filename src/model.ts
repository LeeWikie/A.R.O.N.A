import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ModelConfig } from './config.js';

export function createModel(config: ModelConfig): LanguageModelV4 {
  if (config.protocol === 'messages') {
    const provider = createAnthropic({
      baseURL: config.baseURL,
      ...(config.authHeader === 'bearer'
        ? { authToken: config.apiKey }
        : { apiKey: config.apiKey }),
    });
    return provider(config.modelId);
  }
  const provider = createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  return config.protocol === 'chat-completions'
    ? provider.chat(config.modelId)
    : provider.responses(config.modelId);
}
