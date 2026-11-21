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
  requestAuth: z.enum(['api-key', 'bearer']).optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  contextWindow: z.number().int().positive().safe().optional(),
  maxTokens: z.number().int().positive().safe().optional(),
}).refine(model => model.protocol !== 'messages' || model.reasoningEffort === undefined);
export type ModelConfig = z.infer<typeof modelSchema>;
export interface Config {
  port: number; dataDir: string; model?: ModelConfig; timezone: string;
  concurrency: number; memoryEnabled: boolean; maxSteps: number; controlToken?: string;
  audio?: { executable: string; model: string; executableSha256: string; modelSha256: string; workingDirectory: string };
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const value = (name: string) => env[`SHITTIMCHEST_${name}`] ?? env[`ARONA_${name}`];
  let model: ModelConfig | undefined;
  if (['MODEL_PROTOCOL', 'MODEL_BASE_URL', 'MODEL_ID', 'MODEL_API_KEY'].some(name => value(name) !== undefined)) {
    const parsed = modelSchema.safeParse({ protocol: value('MODEL_PROTOCOL'), baseURL: value('MODEL_BASE_URL'), modelId: value('MODEL_ID'), apiKey: value('MODEL_API_KEY'), authHeader: value('MODEL_AUTH_HEADER'), requestAuth: value('MODEL_REQUEST_AUTH'), reasoningEffort: value('MODEL_REASONING_EFFORT'),
      contextWindow: value('MODEL_CONTEXT_WINDOW') === undefined ? undefined : Number(value('MODEL_CONTEXT_WINDOW')),
      maxTokens: value('MODEL_MAX_OUTPUT_TOKENS') === undefined ? undefined : Number(value('MODEL_MAX_OUTPUT_TOKENS')) });
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
  const dataDir = path.resolve(value('DATA_DIR') || path.join(os.homedir(), '.arona'));
  const audioValues = ['AUDIO_EXECUTABLE', 'AUDIO_MODEL', 'AUDIO_EXECUTABLE_SHA256', 'AUDIO_MODEL_SHA256'].map(value);
  let audio: Config['audio'];
  if (audioValues.some(item => item !== undefined)) {
    const parsed = z.object({ executable: z.string().min(1).refine(path.isAbsolute), model: z.string().min(1).refine(path.isAbsolute), executableSha256: z.string().regex(/^[a-f0-9]{64}$/), modelSha256: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse({ executable: audioValues[0], model: audioValues[1], executableSha256: audioValues[2], modelSha256: audioValues[3] });
    if (!parsed.success) throw new AppError('invalid_audio_configuration');
    audio = { ...parsed.data, workingDirectory: path.join(dataDir, 'audio-temporary') };
  }
  return { port, dataDir, model, ...(audio ? { audio } : {}),
    timezone: validateTimezone(value('TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone), concurrency, memoryEnabled: memory !== 'false', maxSteps, controlToken };
}
