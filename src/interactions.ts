import { z } from 'zod';

export const questionPayloadSchema = z.object({
  question: z.string().min(1).max(64000),
  options: z.array(z.object({ label: z.string().min(1).max(4000), description: z.string().max(8000).optional() }).strict()).max(100).optional(),
  selectionMode: z.enum(['single_select', 'multi_select']).optional(),
}).strict();
export const planPayloadSchema = z.object({ path: z.string().min(1).max(4000), title: z.string().max(4000).optional(), plan: z.string().max(64000).optional() }).strict();
export type InteractionAnswer = string | string[] | { action: 'approved' | 'rejected'; feedback?: string };
// JSON can escape one UTF-16 code unit into six ASCII bytes. Include the
// bounded address and array/object punctuation in the transport allowance.
export const MAX_INTERACTION_ANSWER_REQUEST_BYTES=101*64000*6+8192;
export type InteractionAnswerStatus = 'pending' | 'delivering' | 'delivered' | 'blocked' | 'unknown' | 'cancelled';
export interface InteractionAnswerReceipt {
  id:string; interactionId:string; contextId:string; runId:string; toolCallId:string;
  status:InteractionAnswerStatus; savedAt:string; updatedAt:string; attempts:number;
  deliveredAt?:string; acknowledgementSeq?:number; errorCode?:string; retryable?:boolean;
  nextAttemptAt?:string; cancelRequestedAt?:string;
}
export interface InteractionAnswerPage {answers:InteractionAnswerReceipt[];nextCursor:number;hasMore:boolean}
export interface InteractionRecord {
  id: string; contextId: string; runId: string; toolCallId: string;
  toolName: 'ask_user' | 'submit_plan'; kind: 'question' | 'plan';
  payload: z.infer<typeof questionPayloadSchema> | z.infer<typeof planPayloadSchema>;
  status: 'pending' | 'answered' | 'cancelled' | 'interrupted'; createdAt: string; answerHash?: string;
}
export interface InteractionReference {
  interaction: Omit<InteractionRecord, 'answerHash'>;
  taskIds: string[];
  target?: { contextId: string; name: string; workspaceId: string };
  unavailable?: 'interaction_origin_unavailable' | 'interaction_destination_unavailable';
}
export function validateInteractionAnswer(record: InteractionRecord, input: unknown): InteractionAnswer | undefined {
  if (record.kind === 'plan') {
    const parsed = z.object({ action: z.enum(['approved', 'rejected']), feedback: z.string().max(64000).optional() }).strict().safeParse(input);
    return parsed.success ? parsed.data : undefined;
  }
  const payload = record.payload as z.infer<typeof questionPayloadSchema>;
  if (payload.selectionMode === 'multi_select') {
    const parsed = z.array(z.string().min(1).max(64000)).min(1).max(101).safeParse(input);
    return parsed.success && new Set(parsed.data).size === parsed.data.length ? parsed.data : undefined;
  }
  return typeof input === 'string' && input.length > 0 && input.length <= 64000 ? input : undefined;
}
