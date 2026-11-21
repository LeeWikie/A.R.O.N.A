import { createHash } from 'node:crypto';
import { AppError } from '../../domain.js';
import type { EvidenceGap, EvidenceSource, ResolvedBusinessEvidence } from '../evidence.js';
import { evidenceRecordSchema, executionObservationSchema, resolveToolTerminal } from './contracts.js';
import type { EvidenceRecord, EvidenceReference, ExecutionObservation, ToolTerminalEvidence } from './contracts.js';
import { evidenceIdempotencyKey } from './validate.js';
import type { LedgerPartBinding } from './ledger.js';

export interface NativeSourceLocation {
  contextId: string;
  runId: string | null;
  recordId: string;
  receivedAt: string;
  visibleAfter: string;
}
export interface NativeSourceAttachment {
  id: string;
  metadata?: { sha256: string; mediaType: string; bytes: number; name?: string };
  bytes?: Uint8Array;
}
export interface NativeSourceEntry {
  business: ResolvedBusinessEvidence;
  location: NativeSourceLocation;
  /** 来自受理账本的原文，不使用附件说明、执行信封或模型 prompt。 */
  original?: { text: string; attachments: readonly NativeSourceAttachment[] };
}
export interface NativeOperationEvent {
  seq: number;
  contextId: string;
  runId: string;
  toolCallId: string;
  receivedAt: string;
  kind: 'tool_start' | 'tool_end' | 'command_exit' | 'approval_state';
  /** 已按类别白名单投影，不携带审批 capabilityKey、执行绑定或原始 envelope。 */
  data: Record<string, unknown>;
}
export interface PreparedSourceContent {
  codec: 'utf8' | 'json-utf8';
  body: Uint8Array;
  attachments: { sourceId: string; bytes: Uint8Array }[];
  /** 保留原始附件顺序和重复引用；同一存储附件只建立一个内容槽。 */
  attachmentOrder: string[];
  /** 缺少附件元数据时无法绑定存储槽；宿主必须等待补源，不能登记为已覆盖。 */
  partBindings: LedgerPartBinding[] | null;
}
export interface PreparedMemorySource {
  source: EvidenceSource;
  records: EvidenceRecord[];
  observations: ExecutionObservation[];
  contents: Map<string, PreparedSourceContent>;
  gaps: EvidenceGap[];
  canonicalRefs: Map<string, NativeSourceLocation & { canonicalIdentity: string }>;
  attachmentRefs: Map<string, { assetId: string; name: string | null }>;
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hostId = (prefix: string, value: unknown) => `${prefix}:${digest(JSON.stringify(value))}`;
function utf8(text: string): Uint8Array {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) throw new AppError('memory_source_invalid_utf8', 409);
  return new Uint8Array(bytes);
}
function jsonBytes(value: unknown): Uint8Array {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return { codec: 'base64', bytes: Buffer.from(item).toString('base64') };
    if (item instanceof URL) return { codec: 'url', value: item.href };
    return item;
  });
  if (text === undefined) throw new AppError('memory_source_content_unavailable', 409);
  return utf8(text);
}
const unknownState = () => ({ state: 'unknown' as const, evidence: [] });
const ref = (record: EvidenceRecord): EvidenceReference => ({ evidenceId: record.id, partKey: 'body' });

/** 只适配宿主已核实的业务记录；不读取 prompt、不调度模型、不登记或发布版本。 */
export function prepareNativeMemorySource(input: {
  namespace: string;
  source: EvidenceSource;
  entries: readonly NativeSourceEntry[];
  events: readonly NativeOperationEvent[];
  gaps: readonly EvidenceGap[];
}): PreparedMemorySource {
  const result: PreparedMemorySource = {
    source: { contextId: input.source.contextId, runId: input.source.runId, sequence: input.source.sequence },
    records: [], observations: [], contents: new Map(), gaps: [...new Map(input.gaps.map(gap => [JSON.stringify(gap), gap])).values()], canonicalRefs: new Map(), attachmentRefs: new Map(),
  };
  const operations = new Map<string, ExecutionObservation>();
  function identity(location: NativeSourceLocation) {
    return {
      system: 'native' as const, namespace: input.namespace,
      sourceRef: hostId('source', location.recordId.startsWith('signal:') ? [location.contextId, location.recordId] : [location.contextId, location.runId]),
      contextRef: hostId('context', location.contextId),
    };
  }
  function operation(location: NativeSourceLocation, toolCallId: string) {
    const base = identity(location);
    const operationRef = hostId('operation', [input.namespace, location.contextId, location.runId, toolCallId]);
    let observation = operations.get(operationRef);
    if (!observation) {
      observation = { id: hostId('observation', operationRef), identity: { ...base, operationRef }, request: unknownState(), authorization: unknownState(), execution: unknownState(), terminalEvidence: [], toolTerminal: 'unknown', businessOutcome: unknownState() };
      operations.set(operationRef, observation);
    }
    return observation;
  }
  function add(location: NativeSourceLocation, kind: EvidenceRecord['kind'], actor: EvidenceRecord['actor'], body: Uint8Array, codec: PreparedSourceContent['codec'], operationRef: string | null, attachments: readonly NativeSourceAttachment[] = [], capture: 'native-snapshot' | 'admitted-records' = 'native-snapshot') {
    const base = identity(location);
    const id = hostId('evidence', [input.namespace, location.contextId, location.recordId]);
    const contentRef = hostId('content', id);
    const parts: EvidenceRecord['coverage']['parts'] = [{ key: 'body', status: 'available', reason: null }];
    const bytes: PreparedSourceContent['attachments'] = [];
    const bound: LedgerPartBinding[] = [{ partKey: 'body', slots: [{ kind: 'body', ref: contentRef }] }];
    const attachmentRecords: EvidenceRecord['attachments'] = [];
    for (const attachment of new Map(attachments.map(item => [item.id, item])).values()) {
      const sourceId = hostId('asset', [input.namespace, attachment.id]);
      result.attachmentRefs.set(sourceId, { assetId: attachment.id, name: attachment.metadata?.name ?? null });
      const available = !!attachment.metadata && !!attachment.bytes && attachment.metadata.bytes === attachment.bytes.byteLength && attachment.metadata.sha256 === digest(attachment.bytes);
      parts.push({ key: sourceId, status: available ? 'available' : 'unavailable', reason: available ? null : '原始附件不可用或校验不一致' });
      if (attachment.metadata) attachmentRecords.push({ sourceId, sha256: attachment.metadata.sha256, mediaType: attachment.metadata.mediaType, bytes: attachment.metadata.bytes, derivedEvidenceIds: [] });
      // 缺失部分仍绑定到原始存储槽；内容缺失不能被伪造空 bytes 代替。
      bound.push({ partKey: sourceId, slots: [{ kind: 'attachment', ref: sourceId }] });
      if (available) bytes.push({ sourceId, bytes: new Uint8Array(attachment.bytes!) });
    }
    const record = evidenceRecordSchema.parse({
      schemaVersion: 1, id, kind, actor,
      origin: { ...base, recordRef: hostId('record', location.recordId), lineageRoot: hostId('root', [location.contextId, location.recordId]), capture },
      occurredAt: null, receivedAt: location.receivedAt, visibleAfter: location.visibleAfter, timeBasis: 'unknown',
      contentRef, contentHash: digest(body), operationRef, derivedFrom: [], attachments: attachmentRecords,
      coverage: { status: parts.every(part => part.status === 'available') ? 'complete' : 'partial', parts },
    });
    const existing = result.records.find(item => item.id === record.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new AppError('memory_source_identity_conflict', 409);
      return existing;
    }
    result.records.push(record);
    result.contents.set(contentRef, { codec, body: new Uint8Array(body), attachments: bytes, attachmentOrder: attachments.map(item => hostId('asset', [input.namespace, item.id])), partBindings: attachments.some(item => !item.metadata) ? null : bound });
    result.canonicalRefs.set(id, { ...location, canonicalIdentity: evidenceIdempotencyKey(record) });
    return record;
  }
  for (const { business: entry, location, original } of input.entries) {
    const tool = entry.kind === 'tool-action' || entry.kind === 'tool-result' ? operation(location, entry.toolCallId) : undefined;
    let kind: EvidenceRecord['kind'] = entry.kind;
    let actor: EvidenceRecord['actor']; let body: Uint8Array; let codec: PreparedSourceContent['codec'] = 'json-utf8';
    switch (entry.kind) {
      case 'user-statement':
        if (!original) throw new AppError('memory_source_original_required', 409);
        actor = 'user'; body = utf8(original.text); codec = 'utf8'; break;
      case 'assistant-statement': actor = 'assistant'; body = utf8(entry.content); codec = 'utf8'; break;
      case 'task-request': actor = entry.requestedBy; body = original ? utf8(original.text) : jsonBytes({ content: entry.content }); codec = original ? 'utf8' : 'json-utf8'; break;
      // 调用请求来自助手；合同中的 tool-action 只允许工具主体，不能为通过 schema 改写主体。
      case 'tool-action': kind = 'task-request'; actor = 'assistant'; body = jsonBytes({ type: 'tool-request', toolName: entry.toolName, toolCallId: entry.toolCallId, input: entry.input }); break;
      case 'tool-result': actor = 'tool'; body = jsonBytes({ type: 'tool-result', toolName: entry.toolName, toolCallId: entry.toolCallId, output: entry.output }); break;
      case 'task-report': actor = 'worker'; body = jsonBytes({ type: 'task-report', report: entry.report }); break;
      case 'published-output': actor = 'assistant'; body = jsonBytes({ outputKind: entry.outputKind, title: entry.title, content: entry.content }); break;
    }
    // 持久化报告和发布输出来自宿主账本，不冒充仍存在的原生消息部件。
    const capture = entry.provenance.eventId || entry.provenance.outputId ? 'admitted-records' : 'native-snapshot';
    const record = add(location, kind, actor, body, codec, tool?.identity.operationRef ?? null, original?.attachments, capture);
    if (entry.kind === 'tool-action' && !tool!.request.evidence.some(item => item.evidenceId === record.id)) tool!.request = { state: 'requested', evidence: [...tool!.request.evidence, ref(record)] };
  }
  // 不同上下文、run 或 toolCall 不能互相补终态；缺 native 部件时可由宿主受理运行中的 start 恢复请求。
  for (const event of [...input.events].sort((a, b) => a.seq - b.seq)) {
    const operationRef = hostId('operation', [input.namespace, event.contextId, event.runId, event.toolCallId]);
    const location: NativeSourceLocation = { contextId: event.contextId, runId: event.runId, recordId: `event:${event.seq}`, receivedAt: event.receivedAt, visibleAfter: event.receivedAt };
    let observation = operations.get(operationRef);
    if (event.kind === 'tool_start') {
      if (!observation && typeof event.data.toolName === 'string') {
        observation = operation(location, event.toolCallId);
        const record = add(location, 'task-request', 'assistant', jsonBytes({ type: 'tool-request', toolName: event.data.toolName, toolCallId: event.toolCallId, input: event.data.args }), 'json-utf8', operationRef, [], 'admitted-records');
        observation.request = { state: 'requested', evidence: [ref(record)] };
      }
      continue; // 调用事件可能早于输入校验，不能证明开始执行。
    }
    if (!observation) continue;
    if (event.kind === 'approval_state') {
      if (event.data.status !== 'approved' && event.data.status !== 'declined') continue;
      const record = add(location, 'authorization', 'external', jsonBytes({ status: event.data.status }), 'json-utf8', operationRef, [], 'admitted-records');
      if (event.data.status === 'declined') observation.authorization = { state: 'denied', evidence: [...observation.authorization.evidence, ref(record)] };
      else if (observation.authorization.state !== 'denied') observation.authorization = { state: 'granted', evidence: [...observation.authorization.evidence, ref(record)] };
      continue;
    }
    let terminal: Omit<Extract<ToolTerminalEvidence, { kind: 'tool-end' }>, 'evidence'> | Omit<Extract<ToolTerminalEvidence, { kind: 'command-exit' }>, 'evidence'>;
    if (event.kind === 'tool_end') terminal = { kind: 'tool-end', denied: event.data.denied === true, isError: event.data.isError === true, resultError: event.data.resultError === true };
    else {
      if (typeof event.data.exitCode !== 'number' || !Number.isInteger(event.data.exitCode) || typeof event.data.success !== 'boolean') continue;
      terminal = { kind: 'command-exit', exitCode: event.data.exitCode, success: event.data.success };
    }
    const record = add(location, 'tool-result', 'tool', jsonBytes(terminal), 'json-utf8', operationRef, [], 'admitted-records');
    observation.terminalEvidence.push({ ...terminal, evidence: ref(record) });
    if (terminal.kind === 'command-exit' && observation.execution.state === 'unknown') observation.execution = { state: 'completed', evidence: [ref(record)] };
  }
  for (const observation of operations.values()) {
    observation.toolTerminal = resolveToolTerminal(observation.terminalEvidence);
    result.observations.push(executionObservationSchema.parse(observation));
  }
  return result;
}
