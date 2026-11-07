import { z } from 'zod';

export const taskLifecycleEventSchema = z.object({
  seq: z.number().int().positive(),
  contextId: z.string(),
  runId: z.string().nullable(),
  kind: z.enum(['agent_start', 'agent_end']),
  reason: z.enum(['complete', 'aborted', 'error', 'suspended']).optional(),
  createdAt: z.string(),
}).strict();
export type TaskLifecycleEvent = z.infer<typeof taskLifecycleEventSchema>;
export const taskLifecyclePageSchema = z.object({
  events: z.array(taskLifecycleEventSchema),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}).strict();
export type TaskLifecyclePage = z.infer<typeof taskLifecyclePageSchema>;

export const protocolHandshakeSchema = z.object({
  protocolVersion: z.literal(1),
  instanceId: z.string().uuid(),
  storageId: z.string().uuid(),
  capabilities: z.array(z.string()),
}).strict();
export type ProtocolHandshake = z.infer<typeof protocolHandshakeSchema>;

/** Public conversation records are distinct from native model-message parts. */
export interface ConversationMessage {id:string;contextId:string;role:'user'|'assistant'|'event';content:string;createdAt:string;runId:string|null;status:string;kind:'message'|'artifact'|'event'|'control';replyDraftId?:string;originContextId?:string;originMessageId?:string;attachments?:string[]}
export interface PublicEvent {seq:number;contextId:string;runId:string|null;kind:string;data:unknown;createdAt:string}
export interface ConversationPage {messages:ConversationMessage[];nextCursor:string|null;hasMore:boolean}
export interface TuiSnapshot {
  protocolVersion:1;instanceId:string;storageId:string;watermark:number;selectedContextId:string;
  contexts:import('./runtime-store.js').ContextRecord[];tasks:unknown[];approvals:unknown[];conversation:ConversationPage;
  runs:import('./domain.js').RunRecord[];models:unknown[];workspaces:unknown[];notifications:unknown[];drafts:unknown[];queuedMessages?:unknown[];toolActivity?:unknown[];thinking?:Array<{runId:string;createdAt:string;text:string}>;capacity?:import('./context-policy.js').ContextCapacity|null;
}
