import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const text = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(id).refine(value => new Set(value).size === value.length, '引用不能重复');
const timeRange = { validFrom: timestamp.nullable(), validTo: timestamp.nullable() };
function validRange(value: { validFrom: string | null; validTo: string | null }) {
  return value.validFrom === null || value.validTo === null || Date.parse(value.validFrom) < Date.parse(value.validTo);
}

export const evidenceReferenceSchema = z.strictObject({ evidenceId: id, partKey: id });
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
const references = z.array(evidenceReferenceSchema).refine(value => new Set(value.map(ref => JSON.stringify(ref))).size === value.length, '证据引用不能重复');
const nonemptyReferences = references.refine(value => value.length > 0, '需要证据引用');

const originCommon = { namespace: id, sourceRef: id, contextRef: id, recordRef: id, lineageRoot: id };
export const evidenceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), id,
  kind: z.enum(['user-statement', 'assistant-statement', 'task-request', 'authorization', 'execution-status', 'tool-action', 'tool-result', 'task-report', 'business-outcome', 'published-output']),
  actor: z.enum(['user', 'assistant', 'tool', 'worker', 'schedule', 'external']),
  origin: z.discriminatedUnion('system', [
    z.strictObject({ system: z.literal('native'), ...originCommon, capture: z.enum(['native-snapshot', 'admitted-records']) }),
    z.strictObject({ system: z.literal('import'), ...originCommon, capture: z.literal('historical-record') }),
  ]),
  occurredAt: timestamp.nullable(), receivedAt: timestamp, visibleAfter: timestamp,
  timeBasis: z.enum(['host-admission', 'source-metadata', 'unknown']),
  contentRef: id, contentHash: hash, operationRef: id.nullable(), derivedFrom: ids,
  attachments: z.array(z.strictObject({ sourceId: id, sha256: hash, mediaType: text, bytes: z.number().int().nonnegative(), derivedEvidenceIds: ids })),
  coverage: z.strictObject({
    status: z.enum(['complete', 'partial', 'unavailable']),
    parts: z.array(z.strictObject({ key: id, status: z.enum(['available', 'unavailable']), reason: text.nullable() })).min(1),
  }),
}).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((value.occurredAt === null) !== (value.timeBasis === 'unknown')) fail('发生时间未知时必须明确标记 unknown');
  if (Date.parse(value.visibleAfter) < Date.parse(value.receivedAt)) fail('可见时间不能早于接收时间');
  if (new Set(value.coverage.parts.map(part => part.key)).size !== value.coverage.parts.length) fail('证据部分不能重复');
  const available = value.coverage.parts.filter(part => part.status === 'available').length;
  const status = available === value.coverage.parts.length ? 'complete' : available === 0 ? 'unavailable' : 'partial';
  if (status !== value.coverage.status) fail('覆盖状态与部分可用性不一致');
  if (value.coverage.parts.some(part => part.status === 'unavailable' && part.reason === null)) fail('缺口需要原因');
  if (new Set(value.attachments.map(part => part.sourceId)).size !== value.attachments.length) fail('附件身份不能重复');
  if (value.kind === 'user-statement' && value.actor !== 'user') fail('用户陈述必须具有用户来源');
  if (value.kind === 'assistant-statement' && value.actor !== 'assistant') fail('助手陈述不能转换为用户陈述');
  if (['tool-action', 'tool-result'].includes(value.kind) && value.actor !== 'tool') fail('工具证据必须具有工具来源');
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export const toolTerminalEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tool-end'), evidence: evidenceReferenceSchema, denied: z.boolean(), isError: z.boolean(), resultError: z.boolean() }),
  z.strictObject({ kind: z.literal('command-exit'), evidence: evidenceReferenceSchema, exitCode: z.number().int(), success: z.boolean() }),
]);
export type ToolTerminalEvidence = z.infer<typeof toolTerminalEvidenceSchema>;
export type ToolTerminal = 'unknown' | 'finished' | 'failed' | 'denied';

/** 按持久化顺序输入已校验事件；沿用工具活动的拒绝优先、失败优先及首个有效退出记录规则。 */
export function resolveToolTerminal(input: readonly ToolTerminalEvidence[]): ToolTerminal {
  const events = z.array(toolTerminalEvidenceSchema).parse(input);
  if (events.some(event => event.kind === 'tool-end' && event.denied)) return 'denied';
  const exit = events.find(event => event.kind === 'command-exit');
  if (events.some(event => event.kind === 'tool-end' && (event.isError || event.resultError)) ||
      (exit?.kind === 'command-exit' && (exit.exitCode !== 0 || !exit.success))) return 'failed';
  return events.length ? 'finished' : 'unknown';
}
function observationState<T extends readonly [string, ...string[]]>(states: T) {
  return z.strictObject({ state: z.enum(states), evidence: references }).refine(value => value.state === 'unknown' ? value.evidence.length === 0 : value.evidence.length > 0, '已知状态需要证据，缺失保持 unknown');
}
export const executionObservationSchema = z.strictObject({
  id,
  identity: z.strictObject({ system: z.enum(['native', 'import']), namespace: id, sourceRef: id, contextRef: id, operationRef: id }),
  request: observationState(['unknown', 'requested']),
  authorization: observationState(['unknown', 'granted', 'denied']),
  execution: observationState(['unknown', 'started', 'completed']),
  terminalEvidence: z.array(toolTerminalEvidenceSchema),
  toolTerminal: z.enum(['unknown', 'finished', 'failed', 'denied']),
  businessOutcome: observationState(['unknown', 'confirmed-success', 'confirmed-failure']),
}).superRefine((value, ctx) => {
  if (resolveToolTerminal(value.terminalEvidence) !== value.toolTerminal) ctx.addIssue({ code: 'custom', message: '终态与结构化证据不一致' });
  if (value.businessOutcome.state === 'confirmed-success' && (value.toolTerminal === 'denied' || value.toolTerminal === 'failed' || value.authorization.state === 'denied')) {
    ctx.addIssue({ code: 'custom', message: '同一操作的失败或拒绝不能升级为成功结果' });
  }
});
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;

export const memoryScopeSchema = z.strictObject({ subjectId: id, dimension: id, qualifier: text });
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const protectionAssessmentSchema = z.strictObject({
  decision: z.enum(['eligible', 'ineligible', 'pending-review']), rationale: text, evidence: nonemptyReferences,
});
export type ProtectionAssessment = z.infer<typeof protectionAssessmentSchema>;
export const protectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('state'), stateKey: id, value: text, establishedBy: nonemptyReferences, overrideRule: text }),
  z.strictObject({ mode: z.literal('pending-review'), reason: text }),
]);
export type Protection = z.infer<typeof protectionSchema>;
const entryCommon = {
  id, revision: z.number().int().positive(), text,
  primaryNodeId: id, relatedNodeIds: ids, entityIds: ids,
};
const reviewedMemoryEntrySchema = z.strictObject({
  ...entryCommon, format: z.literal('reviewed'),
  nature: z.enum(['fact', 'intent', 'preference', 'commitment', 'suggestion', 'inference', 'action', 'result']),
  certainty: z.enum(['reported', 'observed', 'inferred', 'unknown']),
  lifecycle: z.enum(['current', 'historical', 'superseded', 'unresolved']),
  scope: memoryScopeSchema, ...timeRange,
  retention: z.strictObject({ score: z.number().int().min(1).max(10), rationale: text }),
  protectionAssessment: protectionAssessmentSchema, protection: protectionSchema,
  followup: z.strictObject({ attention: z.enum(['normal', 'reduced', 'none']), outcome: z.enum(['unknown', 'confirmed-success', 'confirmed-failure']), outcomeEvidence: references }),
  evidence: z.array(z.strictObject({ ref: evidenceReferenceSchema, role: z.enum(['supports', 'corrects', 'contradicts', 'context']), supportGroup: id })).min(1),
  abstraction: z.enum(['episode', 'summary', 'profile']), derivedFromEntryIds: ids,
  placement: z.enum(['resident', 'detail', 'retired']), detailRefs: ids, replacedBy: ids,
  createdInBatch: id, updatedInBatch: id,
}).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!validRange(value)) fail('有效期必须正向');
  const expected = { eligible: 'state', ineligible: 'none', 'pending-review': 'pending-review' }[value.protectionAssessment.decision];
  if (value.protection.mode !== expected) fail('保护状态必须匹配资格评估');
  if ((value.protection.mode === 'pending-review' || (value.protection.mode === 'state' && ['current', 'unresolved'].includes(value.lifecycle))) && value.placement !== 'resident') fail('当前保护状态与待复核状态必须常驻');
  if (value.protection.mode === 'state' && !['current', 'unresolved', 'superseded'].includes(value.lifecycle)) fail('保护状态只能由显式覆盖结束');
  if (value.protection.mode === 'pending-review' && !['current', 'unresolved'].includes(value.lifecycle)) fail('待复核状态不能通过生命周期切换逃避保护');
  if (value.lifecycle === 'superseded' && value.replacedBy.length === 0) fail('被覆盖条目需要替代引用');
  if ((value.followup.outcome === 'unknown') !== (value.followup.outcomeEvidence.length === 0)) fail('确认结果必须引用证据，未知不冒充确认');
  if (value.relatedNodeIds.includes(value.primaryNodeId)) fail('主要正文节点不能重复列为相关节点');
});
const legacyMemoryEntrySchema = z.strictObject({
  ...entryCommon, format: z.literal('legacy-unreviewed'), placement: z.literal('resident'),
  legacyRef: id, contentHash: hash,
});
export const memoryEntrySchema = z.discriminatedUnion('format', [reviewedMemoryEntrySchema, legacyMemoryEntrySchema]);
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export const entitySchema = z.strictObject({ id, kind: z.enum(['person', 'organization', 'topic', 'other']), name: text, aliases: z.array(text), identityEvidence: nonemptyReferences });
export type Entity = z.infer<typeof entitySchema>;
export const entityRelationSchema = z.strictObject({ id, subjectId: id, objectId: id, kind: text, entryId: id, ...timeRange }).refine(validRange, '关系有效期必须正向');
export type EntityRelation = z.infer<typeof entityRelationSchema>;
export const organizationNodeSchema = z.strictObject({ id, title: text, parentId: id.nullable(), entryIds: ids });
export type OrganizationNode = z.infer<typeof organizationNodeSchema>;

export const tokenMeasurementSchema = z.strictObject({
  basis: z.enum(['unavailable', 'encoding', 'heuristic', 'provider-count', 'provider-usage']),
  scope: z.enum(['final-injection', 'request']), inputHash: hash,
  tokenizerId: text.nullable(), tokenizerVersion: text.nullable(), vocabularyHash: hash.nullable(), modelId: text.nullable(),
  textTokens: z.number().int().nonnegative().nullable(), exactForEncoding: z.boolean(), exactForProvider: z.boolean(),
  mediaCostKnown: z.boolean(), mediaTokens: z.number().int().nonnegative().nullable(),
}).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((value.basis === 'unavailable') !== (value.textTokens === null)) fail('未测量不能填写 Token 数');
  if (value.exactForEncoding && (value.basis !== 'encoding' || !value.tokenizerId || !value.tokenizerVersion || !value.vocabularyHash)) fail('编码精确值需要实际编码器、版本和词表');
  if (value.basis === 'encoding' && !value.exactForEncoding) fail('实际编码计数必须有完整编码依据');
  if (value.exactForProvider && (!['provider-count', 'provider-usage'].includes(value.basis) || !value.modelId)) fail('不能把本地编码或估算冒充供应商精确计数');
  if (value.basis === 'provider-usage' && value.scope !== 'request') fail('完整请求用量不能冒充记忆注入用量');
  if (value.mediaCostKnown !== (value.mediaTokens !== null)) fail('媒体未知成本必须保留 null');
});
export type TokenMeasurement = z.infer<typeof tokenMeasurementSchema>;

const relativeFile = z.string().min(1).refine(value => !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && !value.includes(':') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), '需要版本内相对文件路径');
export const versionManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), id, parentVersionId: id.nullable(), generation: z.number().int().positive(),
  auditedAt: timestamp, policyRevision: z.number().int().positive(),
  residentInjection: z.literal('all'),
  files: z.array(z.strictObject({ path: relativeFile, layer: z.enum(['raw', 'detail', 'resident', 'metadata']), sha256: hash, entryIds: ids })),
  measurement: tokenMeasurementSchema,
}).superRefine((value, ctx) => {
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) ctx.addIssue({ code: 'custom', message: '同一文件只能属于一个分层' });
  const residentIds = value.files.filter(file => file.layer === 'resident').flatMap(file => file.entryIds);
  if (new Set(residentIds).size !== residentIds.length) ctx.addIssue({ code: 'custom', message: '常驻条目只能有一个主正文' });
  if (value.measurement.scope !== 'final-injection') ctx.addIssue({ code: 'custom', message: '版本容量需要最终注入串的计数' });
});
export type VersionManifest = z.infer<typeof versionManifestSchema>;

export const coverageDecisionSchema = z.strictObject({
  ref: evidenceReferenceSchema,
  decision: z.enum(['retained', 'merged', 'no-effective-new-information', 'retired-with-reason', 'pending-source', 'pending-review']),
  entryIds: ids, rationale: text,
});
export type CoverageDecision = z.infer<typeof coverageDecisionSchema>;
export const protectionCheckSchema = z.strictObject({
  ref: evidenceReferenceSchema, decision: z.enum(['no-protectable-state', 'mapped', 'pending-review']), entryIds: ids, rationale: text,
});
export type ProtectionCheck = z.infer<typeof protectionCheckSchema>;
export const stateOverrideSchema = z.strictObject({
  oldEntryId: id, newEntryId: id, scope: memoryScopeSchema, evidence: nonemptyReferences, rationale: text,
});
export type StateOverride = z.infer<typeof stateOverrideSchema>;

export const protectionResolutionSchema = z.strictObject({
  entryId: id, expectedRevision: z.number().int().positive(), scope: memoryScopeSchema,
  decision: z.enum(['eligible', 'ineligible']), evidence: nonemptyReferences, rationale: text,
});
export type ProtectionResolution = z.infer<typeof protectionResolutionSchema>;

/** 记录由宿主分配身份与审计字段；通过解析不代表获得发布、执行或来源授权。 */
export const memoryCandidateSchema = z.strictObject({
  batchId: id, auditedAt: timestamp,
  evidence: z.array(evidenceRecordSchema), observations: z.array(executionObservationSchema),
  previousEntries: z.array(memoryEntrySchema), entries: z.array(memoryEntrySchema),
  entities: z.array(entitySchema), relations: z.array(entityRelationSchema), organizations: z.array(organizationNodeSchema),
  coverage: z.array(coverageDecisionSchema), protectionChecks: z.array(protectionCheckSchema), overrides: z.array(stateOverrideSchema),
  protectionResolutions: z.array(protectionResolutionSchema).optional(),
  legacyCoverage: z.array(z.strictObject({ legacyEntryId: id, replacementEntryIds: ids.refine(value => value.length > 0, '完整承接需要替代条目'), evidence: nonemptyReferences, rationale: text })),
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
