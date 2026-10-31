import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export class AppError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

export const contextIdSchema = z.string().min(1).max(128).regex(/^[\w.-]+$/);
export const signalSchema = z.object({
  id: z.string().uuid().default(randomUUID),
  contextId: contextIdSchema.default('main'),
  source: z.string().trim().min(1).max(128),
  type: z.enum(['user-message', 'external-event']),
  content: z.string().min(1).max(64_000),
  output: z.object({
    kind: z.enum(['message', 'artifact']),
    contextId: contextIdSchema.optional(),
  }).strict().optional(),
}).strict().transform((signal) => ({
  ...signal,
  output: {
    kind: signal.output?.kind ?? (signal.type === 'user-message' ? 'message' : 'artifact'),
    contextId: signal.output?.contextId ?? signal.contextId,
  },
}));

export type SignalInput = z.output<typeof signalSchema>;
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
