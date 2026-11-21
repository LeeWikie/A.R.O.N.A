import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { AppError } from '../domain.js';

export type EvidenceSource = Readonly<{ contextId: string; runId: string; sequence: number }>;
export type EvidenceProvenance = Readonly<{
  contextId: string; runId: string; messageId?: string; signalId?: string;
  taskId?: string; eventId?: string; outputId?: string;
}>;
type UserPart = Extract<ProcessLLMRequestArgs['prompt'][number], { role: 'user' }>['content'][number];
/** Images use the installed SDK's file part with an image mediaType. */
export type EvidenceContentPart = UserPart extends infer P ? P extends UserPart ? Omit<P, 'providerOptions'> : never : never;
export type EvidenceContent = string | readonly EvidenceContentPart[];
type Located = Readonly<{ provenance: EvidenceProvenance }>;
/** These are resolved business records, not native messages or execution envelopes.
 * Tool results/reports must already use the public business DTO. Context history must
 * be resolved to individual entries by its message identities, not passed as raw history. */
export type ResolvedBusinessEvidence = Located & (
  | Readonly<{ kind: 'user-statement'; origin: 'signal' | 'task-request' | 'supplement'; content: EvidenceContent }>
  | Readonly<{ kind: 'assistant-statement'; content: string }>
  | Readonly<{ kind: 'task-request'; requestedBy: 'user' | 'assistant' | 'schedule' | 'external'; content: EvidenceContent }>
  | Readonly<{ kind: 'tool-action'; toolName: string; toolCallId: string; input: unknown }>
  | Readonly<{ kind: 'tool-result'; toolName: string; toolCallId: string; output: unknown }>
  | Readonly<{ kind: 'task-report'; report: unknown }>
  | Readonly<{ kind: 'published-output'; outputKind: 'message' | 'artifact'; title?: string | null; content: EvidenceContent }>
);
export type EvidenceGap = Readonly<{
  contextId: string; runId?: string; messageId?: string;
  reason: 'unresolved-origin' | 'missing-source' | 'missing-checkpoint' | 'unresolved-history';
}>;
/** 宿主解析后的业务资料；与模型 prompt 的封装格式无关。 */
export interface ResolvedMemoryEvidence {
  readonly source: EvidenceSource;
  readonly entries: readonly ResolvedBusinessEvidence[];
  readonly gaps: readonly EvidenceGap[];
}
export interface MemoryEvidence {
  readonly source: EvidenceSource;
  readonly prompt: ProcessLLMRequestArgs['prompt'];
}

function provenance(value: EvidenceProvenance): EvidenceProvenance {
  return {
    contextId: value.contextId, runId: value.runId,
    ...(value.messageId === undefined ? {} : { messageId: value.messageId }),
    ...(value.signalId === undefined ? {} : { signalId: value.signalId }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.eventId === undefined ? {} : { eventId: value.eventId }),
    ...(value.outputId === undefined ? {} : { outputId: value.outputId }),
  };
}
function contentParts(value: EvidenceContent): UserPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return value.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type !== 'file') throw new AppError('memory_evidence_content_invalid');
    return {
      type: 'file', data: part.data instanceof URL ? new URL(part.data.href) : structuredClone(part.data), mediaType: part.mediaType,
      ...(part.filename === undefined ? {} : { filename: part.filename }),
      ...(part.originalUrl === undefined ? {} : { originalUrl: part.originalUrl }),
    };
  });
}
const text = (value: unknown): UserPart => ({ type: 'text', text: JSON.stringify(value) });

/** Pure evidence construction: no prompt parsing, I/O, keyword filtering or truncation. */
export function buildMemoryEvidence(input: ResolvedMemoryEvidence): MemoryEvidence {
  const source = { contextId: input.source.contextId, runId: input.source.runId, sequence: input.source.sequence };
  const content: UserPart[] = [text({ type: 'business-evidence', source })];
  for (const entry of input.entries) {
    const location = provenance(entry.provenance);
    switch (entry.kind) {
      case 'user-statement':
        content.push(text({ kind: entry.kind, actor: 'user', origin: entry.origin, provenance: location }), ...contentParts(entry.content)); break;
      case 'assistant-statement':
        content.push(text({ kind: entry.kind, actor: 'assistant', provenance: location }), ...contentParts(entry.content)); break;
      case 'task-request':
        content.push(text({ kind: entry.kind, actor: entry.requestedBy, provenance: location }), ...contentParts(entry.content)); break;
      case 'tool-action':
        content.push(text({ kind: entry.kind, actor: 'assistant', provenance: location, toolName: entry.toolName, toolCallId: entry.toolCallId, input: entry.input })); break;
      case 'tool-result':
        if (entry.toolName === 'context_history') throw new AppError('memory_history_requires_resolution');
        content.push(text({ kind: entry.kind, actor: 'tool', provenance: location, toolName: entry.toolName, toolCallId: entry.toolCallId, output: entry.output })); break;
      case 'task-report':
        content.push(text({ kind: entry.kind, actor: 'worker', provenance: location, report: entry.report })); break;
      case 'published-output':
        content.push(text({ kind: entry.kind, actor: 'assistant', provenance: location, outputKind: entry.outputKind, title: entry.title }), ...contentParts(entry.content)); break;
      default: throw new AppError('memory_evidence_kind_invalid');
    }
  }
  for (const gap of input.gaps) content.push(text({
    type: 'evidence-gap', contextId: gap.contextId, reason: gap.reason,
    ...(gap.runId === undefined ? {} : { runId: gap.runId }),
    ...(gap.messageId === undefined ? {} : { messageId: gap.messageId }),
  }));
  return { source, prompt: [{ role: 'user', content }] };
}
