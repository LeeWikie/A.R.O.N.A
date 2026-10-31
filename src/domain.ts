import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export class AppError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

export const contextIdSchema = z.string().min(1).max(128).regex(/^[\w.-]+$/);
const signalFields = z.object({
  id: z.string().uuid().default(randomUUID),
  contextId: contextIdSchema.default('main'),
  source: z.string().trim().min(1).max(128),
  content: z.string().min(1).max(64_000),
  output: z.object({
    kind: z.enum(['message', 'artifact', 'both']),
    contextId: contextIdSchema.optional(),
  }).strict().optional(),
}).strict();
const normalizeSignal = <T extends z.infer<typeof signalFields> & { type: 'user-message' | 'external-event' | 'scheduled-task' }>(signal: T) => ({
  ...signal,
  output: {
    kind: signal.output?.kind ?? (signal.type === 'user-message' ? 'message' : 'artifact'),
    contextId: signal.output?.contextId ?? signal.contextId,
  },
});
export const signalSchema = signalFields.extend({ type: z.enum(['user-message', 'external-event']) }).transform(normalizeSignal);
export const scheduledSignalSchema = signalFields.extend({ type: z.literal('scheduled-task') }).transform(normalizeSignal);

export type SignalInput = z.output<typeof signalSchema> | z.output<typeof scheduledSignalSchema>;
export type SignalRecord = SignalInput & {
  status: 'received' | 'accepted' | 'rejected' | 'interrupted';
  nativeSignalId: string | null;
  runId: string | null;
  action: 'wake' | 'deliver' | null;
  errorCode: string | null;
  createdAt: string;
};
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export interface RunRecord {
  id: string;
  contextId: string;
  status: RunStatus;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface OutputRecord {
  seq: number;
  id: string;
  kind: 'message' | 'artifact';
  contextId: string;
  runId: string;
  signalIds: string[];
  title: string | null;
  content: string;
  createdAt: string;
}
