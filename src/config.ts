import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './domain.js';
import { validateTimezone } from './schedules.js';

const modelSchema = z.object({
  protocol: z.enum(['chat-completions', 'responses', 'messages']),
  baseURL: z.url().refine(s => ['http:', 'https:'].includes(new URL(s).protocol)),
  modelId: z.string().trim().min(1), apiKey: z.string().min(1),
  authHeader: z.enum(['api-key', 'bearer']).default('api-key'),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).refine(model => model.protocol !== 'messages' || model.reasoningEffort === undefined);
export type ModelConfig = z.infer<typeof modelSchema>;
export interface Config {
  port: number; dataDir: string; model?: ModelConfig; timezone: string;
  concurrency: number; memoryEnabled: boolean; maxSteps: number; controlToken?: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const value = (name: string) => env[`SHITTIMCHEST_${name}`] ?? env[`ARONA_${name}`];
  let model: ModelConfig | undefined;
  if (['MODEL_PROTOCOL', 'MODEL_BASE_URL', 'MODEL_ID', 'MODEL_API_KEY'].some(name => value(name) !== undefined)) {
    const parsed = modelSchema.safeParse({ protocol: value('MODEL_PROTOCOL'), baseURL: value('MODEL_BASE_URL'), modelId: value('MODEL_ID'), apiKey: value('MODEL_API_KEY'), authHeader: value('MODEL_AUTH_HEADER'), reasoningEffort: value('MODEL_REASONING_EFFORT') });
    if (!parsed.success) throw new AppError('invalid_model_configuration');
    const url = new URL(parsed.data.baseURL);
    if (url.username || url.password || url.search || url.hash) throw new AppError('invalid_model_base_url');
    model = parsed.data;
  }
  const port = Number(value('PORT') ?? 4111);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('invalid_port');
  const concurrency = Number(value('CONCURRENCY') ?? 4), maxSteps = Number(value('MAX_STEPS') ?? 64);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new AppError('invalid_concurrency');
  if (!Number.isInteger(maxSteps) || maxSteps < 4 || maxSteps > 512) throw new AppError('invalid_step_budget');
  const memory = value('MEMORY_ENABLED'); if (memory !== undefined && memory !== 'true' && memory !== 'false') throw new AppError('invalid_memory_configuration');
  const controlToken = value('CONTROL_TOKEN'); if (controlToken !== undefined && controlToken.length < 32) throw new AppError('control_token_too_short');
  return { port, dataDir: path.resolve(value('DATA_DIR') || path.join(os.homedir(), '.arona')), model,
    timezone: validateTimezone(value('TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone), concurrency, memoryEnabled: memory !== 'false', maxSteps, controlToken };
}
