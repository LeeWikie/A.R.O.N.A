import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './domain.js';
import { validateTimezone } from './schedules.js';

const modelSchema = z.object({
  protocol: z.enum(['chat-completions', 'responses', 'messages']),
  baseURL: z.url().refine((s) => ['http:', 'https:'].includes(new URL(s).protocol)),
  modelId: z.string().trim().min(1),
  apiKey: z.string().min(1),
  authHeader: z.enum(['api-key', 'bearer']).default('api-key'),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).refine(model => model.protocol !== 'messages' || model.reasoningEffort === undefined);
export type ModelConfig = z.infer<typeof modelSchema>;
export interface Config {
  port: number;
  dataDir: string;
  model: ModelConfig;
  timezone: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const model = modelSchema.safeParse({
    protocol: env.ARONA_MODEL_PROTOCOL,
    baseURL: env.ARONA_MODEL_BASE_URL,
    modelId: env.ARONA_MODEL_ID,
    apiKey: env.ARONA_MODEL_API_KEY,
    authHeader: env.ARONA_MODEL_AUTH_HEADER,
    reasoningEffort: env.ARONA_MODEL_REASONING_EFFORT,
  });
  if (!model.success) throw new AppError('invalid_model_configuration');
  const url = new URL(model.data.baseURL);
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError('invalid_model_base_url');
  }
  const port = Number(env.ARONA_PORT ?? 4111);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('invalid_port');
  return {
    port,
    dataDir: path.resolve(env.ARONA_DATA_DIR || path.join(os.homedir(), '.arona')),
    model: model.data,
    timezone: validateTimezone(env.ARONA_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
  };
}
