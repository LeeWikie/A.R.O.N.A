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
export type { TerminalSessionRequest, TerminalSessionReceipt, TerminalSessionResult } from './terminal-sessions.js';
export type { ProjectDirectory, ProjectPathRequest, ProjectPathSuggestions } from './project-paths.js';

/** Public conversation records are distinct from native model-message parts. */
export interface ConversationMessage {id:string;contextId:string;role:'user'|'assistant'|'event';content:string;createdAt:string;runId:string|null;status:string;kind:'message'|'artifact'|'event'|'control';replyDraftId?:string;originContextId?:string;originMessageId?:string;imported?:true;attachments?:string[];payloadRef?:{sha256:string;bytes:number;characters:number;attachmentCount:number;route:string}}
export interface PublicEvent {seq:number;contextId:string;runId:string|null;kind:string;data:unknown;createdAt:string}
export interface ConversationPage {messages:ConversationMessage[];nextCursor:string|null;hasMore:boolean}
export type SessionTreeEntry = import('@earendil-works/pi-coding-agent').SessionEntry;
export interface SessionTreeNode {entry:SessionTreeEntry;children:SessionTreeNode[];label?:string;labelTimestamp?:string}
export interface SessionTreeView {tree:SessionTreeNode[];leafId:string|null;currentContextId:string;rootContextId:string;revision:number;entryOrder?:string[]}
export interface SessionNavigationResult {context:import('./runtime-store.js').ContextRecord;draft?:string;selectedId:string|null;leafId:string|null;revision:number}
export interface SessionSummary {id:string;name:string;workspaceId:string;cwd:string;createdAt:string;updatedAt:string;messageCount:number;firstMessage:string;allMessagesText:string;parentContextId?:string;archived:boolean}
export interface SessionBrowserPage {sessions:SessionSummary[];nextCursor:string|null;hasMore:boolean;total:number}
/** Portable public conversation history; executable state and credentials are never included. */
export interface SessionArchive {
  format: 'shittimchest-session'; version: 1;
  context: { id: string; name: string; purpose: string; modelProfile: string; workspaceId: string; createdAt: string;thinkingLevel?:import('./models.js').ThinkingLevel;thinkingPreference?:import('./models.js').ThinkingLevel };
  messages: ConversationMessage[];
  continuation?: {
    messages: Array<{ id:string; role:'user'|'assistant'; createdAt:string; content:{format:2;parts:unknown[]} }>;
    publicMessageMap: Record<string,string>;
    checkpoint?: { summary:string; summarizedMessages:number };
    automaticCheckpoint?:{signature:string;summary:string;coveredMessages:number;prefixHash:string;createdAt:string};
    assets: Array<{id:string;name:string;mediaType:string;sha256:string;data:string;purpose?:'client-shell-output';originalAssetIds?:string[]}>;
    artifacts?:import('./session-artifacts.js').PortableSessionArtifact[];
    unavailableArtifacts?:import('./session-artifacts.js').UnavailableSessionArtifact[];
    graph?:{header:import('@earendil-works/pi-coding-agent').SessionHeader;leafId:string|null;entries:import('./session-graph.js').SessionGraphRecord[];sources:unknown[]};
  };
}
export type ApprovalScope = 'once' | 'task' | 'duty';
export type PublicApproval = Omit<import('./runtime-store.js').ApprovalRecord, 'capabilityKey'> & { allowedScopes?: ApprovalScope[];argsText?:string;argsDisplayNotice?:string };
export type InteractionAnswerReceipt=import('./interactions.js').InteractionAnswerReceipt;
export type InteractionAnswerPage=import('./interactions.js').InteractionAnswerPage;
export type InteractionReference=import('./interactions.js').InteractionReference;
export interface QueueWithdrawalResult {
  operationId:string;contextId:string;
  entries:Array<{id:string;revision:number}>;
  withdrawn:Array<import('./domain.js').SignalRecord&{revision:number}>;
  skipped:Array<{id:string;reason:'queued_message_not_found'|'revision_conflict'|'message_already_started'|'different_context'}>;
}
export interface QueueEditEntry {
  id:string;content:string;attachments:string[];sourceSignalIds:string[];removed:boolean;
  admittedSignalId?:string;
  originEntryId?:string;originRevision?:number;
  copiedFrom?:{draftId:string;revision:number;entryId:string;signalIds:string[]};
  captureDraftId?:string;captureInputDetached?:boolean;captureInputUnconfirmed?:boolean;
  selectedSkillName?:string;
  clearSkills?:boolean;
  localContextHash?:string;
  referenceContextHash?:string;
  rebasedFrom?:{draftId:string;revision:number;entryId:string;signalIds:string[]};
}
export interface QueueInputSource {workspaceId:string;directory:{path:string;dev:string;ino:string}}
export interface QueueEditAdmission {entryId:string;signalId:string;status:'pending'|'queued'|'accepted'|'started';errorCode?:string;partIndex?:number;partCount?:number}
export interface QueueLogicalInput {entryId:string;signalIds:string[];contentHash:string;attachmentIds:string[]}
export interface QueueEditSubmission {operationId:string;mode:'queue'|'steer';expectedRunId?:string;entries:QueueEditAdmission[];leaderSignalId?:string;runId?:string;inputPrepared?:boolean;groupReady?:boolean;revision?:number;logicalEntries?:QueueLogicalInput[]}
export interface QueueEditDocument {
  id:string;contextId:string;revision:number;status:'capturing'|'editing'|'submitting'|'submitted'|'blocked';
  entryCount:number;createdAt:string;updatedAt:string;skipped:QueueWithdrawalResult['skipped'];errorCode?:string;
  capturedDraftId?:string;capturedEntryId?:string;capturedInputDetached?:boolean;capturedInputUnconfirmed?:boolean;
  captures?:Array<{draftId:string;entryId:string;detached:boolean;unconfirmed:boolean}>;
  submission?:QueueEditSubmission;previousSubmissions?:QueueEditSubmission[];
  rebasedTo?:string;
  retainedVersionCount?:number;
}
export interface QueueEditPage {draft:QueueEditDocument;entries:QueueEditEntry[];nextCursor:number|null}
export interface QueueRetainedVersion {id:string;draftId:string;revision:number;entry:QueueEditEntry;createdAt:string;materialHash:string;materialCharacters:number}
export interface QueueEntryEdit {id:string;entryId:string;revision:number;partCount:number;receivedParts:number[];receivedContextParts?:number[];attachmentPartCount?:number;receivedAttachmentParts?:number[];status:'uploading'|'committed';result?:QueueEditDocument}
export interface SessionTransferJob {
 id:string;direction:'import'|'export';state:'uploading'|'uploaded'|'preparing'|'validating'|'publishing'|'ready'|'completed'|'failed'|'cancelled';
 partSize:number;partCount:number;bytes:number;sha256:string;receivedParts:number;receivedBytes:number;createdAt:string;updatedAt:string;
 format?:'pi'|'archive';contextId?:string;sourceRevision?:string;continuation?:boolean;errorCode?:string;retryable?:boolean;acknowledged?:boolean;cancelRequested?:boolean;waitingForCapacity?:boolean;readyAt?:string;
 result?:import('./runtime-store.js').ContextRecord;
 warnings?:Array<{code:'history_artifacts_unavailable';count:number}>;
}
export interface MessageQueueSummary {count:number;ids:string[];preview:Array<Pick<import('./domain.js').SignalRecord,'id'|'content'|'attachments'>>}
export interface TuiSnapshot {
  companion?:import('./companion-rhythm.js').CompanionRhythmView;
  protocolVersion:1;instanceId:string;storageId:string;watermark:number;selectedContextId:string;
  contexts:import('./runtime-store.js').ContextRecord[];tasks:unknown[];approvals:PublicApproval[];conversation:ConversationPage;
  runs:import('./domain.js').RunRecord[];models:unknown[];workspaces:unknown[];notifications:unknown[];drafts:unknown[];queuedMessages?:unknown[];toolActivity?:unknown[];thinking?:Array<{runId:string;createdAt:string;text:string}>;capacity?:import('./context-policy.js').ContextCapacity|null;
}

const publicToolTextSchema=z.object({text:z.string(),characters:z.number().int().nonnegative(),lines:z.number().int().nonnegative(),truncated:z.boolean().optional()});
export const toolActivityViewSchema=z.object({
 contextId:z.string().min(1),runId:z.string().min(1).nullable(),toolCallId:z.string().min(1),nativeMessageId:z.string().min(1).optional(),toolName:z.string().min(1),state:z.enum(['running','finished','failed','denied']),
 args:z.unknown().optional(),progress:z.unknown().optional(),summary:z.unknown().optional(),output:publicToolTextSchema.optional(),diff:publicToolTextSchema.optional(),
 resultContent:z.array(z.discriminatedUnion('type',[z.object({type:z.literal('text'),text:z.string()}),z.object({type:z.literal('image'),data:z.string(),mimeType:z.string().min(1)})])).optional(),
 afterMessageId:z.string().nullable().optional(),entryId:z.string().min(1).optional(),resultEntryId:z.string().min(1).optional(),resultEventSeq:z.number().int().positive().optional(),exitCode:z.number().optional(),startedAt:z.string().optional(),updatedAt:z.string().optional(),legacy:z.boolean().optional(),originContextId:z.string().optional(),
});
export type ToolActivityView=z.infer<typeof toolActivityViewSchema>;
export const toolResultIdentitySchema=z.object({runId:z.string().min(1).nullable(),toolCallId:z.string().min(1),nativeMessageId:z.string().min(1).optional(),entryId:z.string().min(1).optional()}).strict();
export type ToolResultIdentity=z.infer<typeof toolResultIdentitySchema>;
export const toolResultViewSchema=z.object({contextId:z.string().min(1),storageId:z.string().min(1),instanceId:z.string().min(1),revision:z.number().int().nonnegative(),leafId:z.string().nullable(),availability:z.enum(['pending','available','unavailable']),tool:toolActivityViewSchema.nullable()}).strict().refine(row=>row.availability==='available'?Boolean(row.tool&&(row.tool.resultEntryId||row.tool.resultEventSeq)&&Array.isArray(row.tool.resultContent)):row.tool===null);
export type ToolResultView=z.infer<typeof toolResultViewSchema>;
