import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evidenceRecordSchema, executionObservationSchema, memoryEntrySchema, memoryCandidateSchema,
  tokenMeasurementSchema, versionManifestSchema, resolveToolTerminal,
} from '../src/memory/v1/contracts.js';
import type { EvidenceRecord, MemoryEntry, MemoryCandidate, ExecutionObservation, TokenMeasurement, ToolTerminalEvidence } from '../src/memory/v1/contracts.js';
import { createDefaultMemoryContextPolicy, memoryContextPolicySchema } from '../src/memory/v1/policy.js';
import { evidenceIdempotencyKey, validateMemoryCandidate } from '../src/memory/v1/validate.js';

const at = '2025-03-01T00:00:00.000Z';
const later = '2025-03-02T00:00:00.000Z';
const digest = 'a'.repeat(64);
const ref = (evidenceId = 'e1', partKey = 'text') => ({ evidenceId, partKey });
function evidence(id = 'e1'): EvidenceRecord {
  return {
    schemaVersion: 1, id, kind: 'user-statement', actor: 'user',
    origin: { system: 'native', namespace: 'demo', sourceRef: 'source-1', contextRef: 'context-1', recordRef: `record-${id}`, lineageRoot: 'root-1', capture: 'native-snapshot' },
    occurredAt: at, receivedAt: later, visibleAfter: later, timeBasis: 'host-admission',
    contentRef: `content-${id}`, contentHash: digest, operationRef: null, derivedFrom: [], attachments: [],
    coverage: { status: 'complete', parts: [{ key: 'text', status: 'available', reason: null }] },
  };
}
function entry(): Extract<MemoryEntry, { format: 'reviewed' }> {
  return {
    id: 'entry-1', revision: 1, format: 'reviewed', text: '演示界面偏好紧凑列表。',
    nature: 'preference', certainty: 'reported', lifecycle: 'current',
    scope: { subjectId: 'entity-1', dimension: 'display', qualifier: '演示界面' }, validFrom: at, validTo: null,
    retention: { score: 2, rationale: '局部使用的呈现偏好' },
    protectionAssessment: { decision: 'ineligible', rationale: '普通偏好，不是持续操作约束', evidence: [ref()] }, protection: { mode: 'none' },
    followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] },
    evidence: [{ ref: ref(), role: 'supports', supportGroup: 'support-1' }],
    entityIds: ['entity-1'], primaryNodeId: 'node-1', relatedNodeIds: [], abstraction: 'episode', derivedFromEntryIds: [],
    placement: 'resident', detailRefs: [], replacedBy: [], createdInBatch: 'batch-1', updatedInBatch: 'batch-1',
  };
}
function candidate(withEntry = false): MemoryCandidate {
  return {
    batchId: 'batch-1', auditedAt: later, evidence: [evidence()], observations: [], previousEntries: [],
    entries: withEntry ? [entry()] : [],
    entities: withEntry ? [{ id: 'entity-1', kind: 'other', name: '演示主体', aliases: [], identityEvidence: [ref()] }] : [],
    relations: [], organizations: withEntry ? [{ id: 'node-1', title: '演示', parentId: null, entryIds: ['entry-1'] }] : [],
    coverage: [{ ref: ref(), decision: withEntry ? 'retained' : 'no-effective-new-information', entryIds: withEntry ? ['entry-1'] : [], rationale: '已检查输入' }],
    protectionChecks: [{ ref: ref(), decision: 'no-protectable-state', entryIds: [], rationale: '无新增操作状态' }],
    overrides: [], legacyCoverage: [],
  };
}
function protectedCandidate(): MemoryCandidate {
  const value = candidate(true), item = value.entries[0]!;
  if (item.format !== 'reviewed') throw Error('fixture');
  item.nature = 'fact'; item.text = '演示设备当前保持待机。';
  item.scope.dimension = 'mode'; item.scope.qualifier = '演示设备';
  item.retention.score = 1;
  item.protectionAssessment = { decision: 'eligible', rationale: '约束后续设备操作的当前状态', evidence: [ref()] };
  item.protection = { mode: 'state', stateKey: 'mode', value: 'standby', establishedBy: [ref()], overrideRule: '同一设备的新模式状态' };
  value.protectionChecks[0] = { ref: ref(), decision: 'mapped', entryIds: [item.id], rationale: '持续操作状态' };
  return value;
}
const unknown = () => ({ state: 'unknown' as const, evidence: [] });
function observation(): ExecutionObservation {
  return {
    id: 'observation-1', identity: { system: 'native', namespace: 'demo', sourceRef: 'source-1', contextRef: 'context-1', operationRef: 'operation-1' },
    request: unknown(), authorization: unknown(), execution: unknown(), terminalEvidence: [], toolTerminal: 'unknown', businessOutcome: unknown(),
  };
}
function measurement(): TokenMeasurement {
  return {
    basis: 'unavailable', scope: 'final-injection', inputHash: digest, tokenizerId: null, tokenizerVersion: null, vocabularyHash: null,
    modelId: null, textTokens: null, exactForEncoding: false, exactForProvider: false, mediaCostKnown: false, mediaTokens: null,
  };
}
const toolEnd = (fields = {}): ToolTerminalEvidence => ({ kind: 'tool-end', evidence: ref(), denied: false, isError: false, resultError: false, ...fields });
const exit = (exitCode: number, success = exitCode === 0): ToolTerminalEvidence => ({ kind: 'command-exit', evidence: ref(), exitCode, success });
function valid(value: unknown, coverageComplete = true) { assert.deepEqual(validateMemoryCandidate(value), { valid: true, coverageComplete, issues: [] }); }
function invalid(value: unknown, code?: string) {
  const result = validateMemoryCandidate(value); assert.equal(result.valid, false); assert.equal(result.coverageComplete, false);
  if (code) assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues));
}

test('strict 合同接受普通条目与完整 no-op，不修改输入', () => {
  for (const value of [candidate(), candidate(true), protectedCandidate()]) {
    const before = structuredClone(value); valid(value); assert.deepEqual(value, before);
  }
});

test('拒绝宿主证明、授权或额外顶层字段进入记录合同', () => {
  assert.equal(evidenceRecordSchema.safeParse({ ...evidence(), proofRef: 'not-authority' }).success, false);
  assert.equal(evidenceRecordSchema.safeParse({ ...evidence(), origin: { ...evidence().origin, signalId: 'not-authority' } }).success, false);
  assert.equal(memoryEntrySchema.safeParse({ ...entry(), toolGrants: {} }).success, false);
  assert.equal(memoryCandidateSchema.safeParse({ ...candidate(), nativeTaskId: 'not-authority' }).success, false);
});

test('双时间允许历史晚接收，未知发生时间不被补造', () => {
  const value = evidence(); assert.equal(evidenceRecordSchema.safeParse(value).success, true);
  value.occurredAt = null; value.timeBasis = 'unknown'; assert.equal(evidenceRecordSchema.safeParse(value).success, true);
  value.timeBasis = 'host-admission'; assert.equal(evidenceRecordSchema.safeParse(value).success, false);
  value.occurredAt = at; value.visibleAfter = at; assert.equal(evidenceRecordSchema.safeParse(value).success, false);
});

test('native-snapshot 与 admitted-records 共用合同而 import 不伪装 native', () => {
  const value = evidence();
  if (value.origin.system !== 'native') throw Error('fixture');
  value.origin.capture = 'admitted-records'; assert.equal(evidenceRecordSchema.safeParse(value).success, true);
  const imported = { ...value, origin: { ...value.origin, system: 'import', capture: 'historical-record' } };
  assert.equal(evidenceRecordSchema.safeParse(imported).success, true);
  assert.equal(evidenceRecordSchema.safeParse({ ...imported, origin: { ...imported.origin, capture: 'native-snapshot' } }).success, false);
});

test('来源幂等不依赖新 ID、接收时间、正文哈希或快照降级', () => {
  const a = evidence(), b = evidence(); b.id = 'retry'; b.receivedAt = later; b.contentHash = 'b'.repeat(64);
  if (b.origin.system !== 'native') throw Error('fixture'); b.origin.capture = 'admitted-records';
  assert.equal(evidenceIdempotencyKey(a), evidenceIdempotencyKey(b));
  const value = candidate(); value.evidence.push(b); invalid(value, 'duplicate-source');
});

test('相同文本的不同来源与 import 不被当作同一证据', () => {
  const a = evidence(), b = evidence('e2'); assert.notEqual(evidenceIdempotencyKey(a), evidenceIdempotencyKey(b));
  const c: EvidenceRecord = { ...a, origin: { ...a.origin, system: 'import', capture: 'historical-record' } };
  assert.notEqual(evidenceIdempotencyKey(a), evidenceIdempotencyKey(c));
});

test('部分覆盖状态与缺口理由一致', () => {
  const value = evidence(); value.coverage.parts.push({ key: 'image', status: 'unavailable', reason: '源文件缺失' });
  assert.equal(evidenceRecordSchema.safeParse(value).success, false);
  value.coverage.status = 'partial'; assert.equal(evidenceRecordSchema.safeParse(value).success, true);
  value.coverage.parts[1]!.reason = null; assert.equal(evidenceRecordSchema.safeParse(value).success, false);
});

test('缺附件部分保持 pending-source，不因文本 no-op 被消除', () => {
  const value = candidate(); value.evidence[0]!.coverage = { status: 'partial', parts: [{ key: 'text', status: 'available', reason: null }, { key: 'image', status: 'unavailable', reason: '等待恢复' }] };
  value.coverage.push({ ref: ref('e1', 'image'), decision: 'pending-source', entryIds: [], rationale: '等待来源' });
  value.protectionChecks.push({ ref: ref('e1', 'image'), decision: 'pending-review', entryIds: [], rationale: '内容尚不可判定' });
  valid(value, false); value.coverage[1]!.decision = 'no-effective-new-information'; invalid(value);
});

test('每批包括 no-op 必须有保护资格检查', () => {
  const value = candidate(); value.protectionChecks = []; invalid(value, 'unchecked-part');
});

test('尚未可见证据与悬空引用被拒绝', () => {
  const value = candidate(true); value.auditedAt = at; invalid(value, 'future-evidence');
  value.auditedAt = later; value.evidence[0]!.derivedFrom = ['absent']; invalid(value, 'evidence-reference');
});

for (const score of [0, 11, 1.5, null]) test(`保留分数拒绝非 1—10 整数 ${score}`, () => {
  assert.equal(memoryEntrySchema.safeParse({ ...entry(), retention: { score, rationale: '测试' } }).success, false);
});

test('评分与保护独立，低分仍必须保留当前状态', () => {
  const value = protectedCandidate(); valid(value);
  const current = value.entries[0]!; if (current.format !== 'reviewed') throw Error('fixture');
  current.placement = 'detail'; invalid(value, 'schema'); current.placement = 'retired'; invalid(value, 'schema');
});

test('保护资格不能默认 none 或省略评估', () => {
  const value = protectedCandidate(); const item = value.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture');
  item.protection = { mode: 'none' }; invalid(value, 'schema');
  const { protectionAssessment: _removed, ...missing } = entry(); assert.equal(memoryEntrySchema.safeParse(missing).success, false);
});

test('潜在重要状态可受保护待复核，也可保留阻塞而不造条目', () => {
  const value = protectedCandidate(); const item = value.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture');
  item.protectionAssessment.decision = 'pending-review'; item.protection = { mode: 'pending-review', reason: '需要复核约束范围' };
  value.protectionChecks[0]!.decision = 'pending-review'; value.coverage[0]!.decision = 'pending-review'; valid(value, false);
  item.placement = 'detail'; invalid(value, 'schema');
  const blocked = candidate(); blocked.protectionChecks[0]!.decision = 'pending-review'; blocked.coverage[0]!.decision = 'pending-review'; valid(blocked, false);
  blocked.coverage[0]!.decision = 'no-effective-new-information'; invalid(blocked, 'pending-review');
});

test('资格检查必须引用对应受保护条目与来源', () => {
  const value = protectedCandidate(); value.protectionChecks[0]!.entryIds = []; invalid(value, 'protection-check');
  value.protectionChecks[0]!.entryIds = ['entry-1']; value.protectionChecks[0]!.ref = ref('absent'); invalid(value, 'evidence-reference');
});

test('保护状态不能静默删除、解除或改变范围', () => {
  const value = protectedCandidate(); value.previousEntries = structuredClone(value.entries);
  value.entries = []; value.organizations[0]!.entryIds = []; value.coverage[0]!.entryIds = []; invalid(value, 'protection-regression');
  const changed = protectedCandidate(); changed.previousEntries = structuredClone(changed.entries);
  const item = changed.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture');
  item.scope.qualifier = '另一个设备'; item.revision++; invalid(changed, 'protection-regression');
});

function overrideCandidate(): MemoryCandidate {
  const value = protectedCandidate(); const old = value.entries[0]!; if (old.format !== 'reviewed') throw Error('fixture');
  value.previousEntries = [structuredClone(old)];
  const replacement = structuredClone(old); replacement.id = 'entry-2'; replacement.validFrom = later;
  replacement.text = '演示设备当前运行。'; replacement.protection = { mode: 'state', stateKey: 'mode', value: 'running', establishedBy: [ref('e2')], overrideRule: '同一设备的新模式状态' };
  replacement.evidence[0]!.ref = ref('e2'); replacement.protectionAssessment.evidence = [ref('e2')];
  old.lifecycle = 'superseded'; old.replacedBy = [replacement.id]; old.revision = 2; old.placement = 'detail'; old.validTo = later;
  value.entries.push(replacement); value.organizations[0]!.entryIds.push(replacement.id);
  value.evidence.push(evidence('e2'));
  value.coverage.push({ ref: ref('e2'), decision: 'retained', entryIds: [replacement.id], rationale: '新状态' });
  value.protectionChecks.push({ ref: ref('e2'), decision: 'mapped', entryIds: [replacement.id], rationale: '新状态资格' });
  value.overrides.push({ oldEntryId: old.id, newEntryId: replacement.id, scope: structuredClone(old.scope), evidence: [ref('e2')], rationale: '互斥状态覆盖' });
  return value;
}

test('同主体同范围的新状态可显式覆盖，保留旧结束记录', () => valid(overrideCandidate()));
for (const field of ['subjectId', 'dimension', 'qualifier'] as const) test(`状态覆盖不能跨 ${field}`, () => {
  const value = overrideCandidate(); value.overrides[0]!.scope[field] = 'other'; invalid(value, 'state-scope');
});

test('状态覆盖拒绝旧证据重用、无有效时间或缺少旧结束记录', () => {
  const value = overrideCandidate(); value.overrides[0]!.evidence = [ref()]; invalid(value, 'state-evidence');
  const noTime = overrideCandidate(); const item = noTime.entries[1]!; if (item.format !== 'reviewed') throw Error('fixture'); item.validFrom = null; invalid(noTime, 'state-time');
  const noEnd = overrideCandidate(); noEnd.entries = noEnd.entries.slice(1); invalid(noEnd, 'state-override');
});

test('首次出现的受保护结束状态不能只用普通偏好伪造替代链', () => {
  const value = protectedCandidate();
  const ended = value.entries[0]!; if (ended.format !== 'reviewed') throw Error('fixture');
  ended.lifecycle = 'superseded'; ended.placement = 'detail'; ended.validTo = later; ended.replacedBy = ['entry-2'];
  const preference = entry(); preference.id = 'entry-2';
  value.entries.push(preference); value.organizations[0]!.entryIds.push(preference.id);
  invalid(value, 'state-override');
});

test('首次导入同批真实前后状态可通过显式覆盖合同结束旧状态', () => {
  const value = overrideCandidate(); value.previousEntries = [];
  for (const record of value.evidence) record.origin = { ...record.origin, system: 'import', capture: 'historical-record' };
  valid(value);
  value.overrides = []; invalid(value, 'state-override');
});

function pendingResolutionCandidate(decision: 'eligible' | 'ineligible') {
  const value = protectedCandidate();
  const item = value.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture');
  const pending = structuredClone(item);
  pending.protectionAssessment.decision = 'pending-review'; pending.protection = { mode: 'pending-review', reason: '约束资格待复核' };
  value.previousEntries = [pending]; item.revision++;
  item.protectionAssessment = { decision, evidence: [ref()], rationale: '复核已有来源后确定资格' };
  if (decision === 'ineligible') {
    item.protection = { mode: 'none' };
    value.protectionChecks[0] = { ref: ref(), decision: 'no-protectable-state', entryIds: [], rationale: '已复核为普通信息' };
  }
  return { ...value, protectionResolutions: [{ entryId: item.id, expectedRevision: pending.revision, scope: structuredClone(item.scope), decision, evidence: [ref()], rationale: '对已有证据进行资格复核，不声明新的外部事实' }] };
}

for (const decision of ['eligible', 'ineligible'] as const) test(`待复核资格可显式收敛为 ${decision}，允许重审已有证据`, () => {
  const value = pendingResolutionCandidate(decision); const before = structuredClone(value);
  valid(value); assert.deepEqual(value, before);
  assert.deepEqual(memoryCandidateSchema.parse(value).protectionResolutions, value.protectionResolutions);
  const { protectionResolutions: _removed, ...silent } = value; invalid(silent, 'protection-regression');
});

function historicalChainCandidate(): MemoryCandidate {
  const value = overrideCandidate(); value.previousEntries = [];
  for (const record of value.evidence) record.origin = { ...record.origin, system: 'import', capture: 'historical-record' };
  const middle = value.entries[1]!; if (middle.format !== 'reviewed') throw Error('fixture');
  const third = structuredClone(middle); third.id = 'entry-3'; third.validFrom = '2025-03-03T00:00:00.000Z';
  third.protection = { mode: 'state', stateKey: 'mode', value: 'paused', establishedBy: [ref('e3')], overrideRule: '同一设备的新模式状态' };
  third.evidence[0]!.ref = ref('e3'); third.protectionAssessment.evidence = [ref('e3')];
  middle.lifecycle = 'superseded'; middle.placement = 'detail'; middle.validTo = third.validFrom; middle.replacedBy = [third.id];
  value.auditedAt = third.validFrom; value.entries.push(third); value.evidence.push(evidence('e3')); value.organizations[0]!.entryIds.push(third.id);
  value.coverage.push({ ref: ref('e3'), decision: 'retained', entryIds: [third.id], rationale: '第三段状态' });
  value.protectionChecks.push({ ref: ref('e3'), decision: 'mapped', entryIds: [third.id], rationale: '第三段资格' });
  value.overrides.push({ oldEntryId: middle.id, newEntryId: third.id, scope: structuredClone(middle.scope), evidence: [ref('e3')], rationale: '后续状态覆盖' });
  return value;
}
function nextChainCandidate(previous = historicalChainCandidate()): MemoryCandidate {
  const value = structuredClone(previous);
  value.previousEntries = structuredClone(previous.entries);
  return value;
}
function removeChainEntries(value: MemoryCandidate, ids: string[]) {
  value.entries = value.entries.filter(item => !ids.includes(item.id));
  for (const node of value.organizations) node.entryIds = node.entryIds.filter(id => !ids.includes(id));
  for (const row of value.coverage) {
    row.entryIds = row.entryIds.filter(id => !ids.includes(id));
    if (!row.entryIds.length) row.decision = 'no-effective-new-information';
  }
  for (const check of value.protectionChecks) {
    check.entryIds = check.entryIds.filter(id => !ids.includes(id));
    if (!check.entryIds.length) check.decision = 'no-protectable-state';
  }
  value.overrides = value.overrides.filter(row => !ids.includes(row.oldEntryId));
}

test('同批多段历史覆盖链可到达当前状态，任一环与悬空均被拒绝', () => {
  const value = historicalChainCandidate(); valid(value);
  const cycle = structuredClone(value); const last = cycle.entries[2]!; if (last.format !== 'reviewed') throw Error('fixture');
  last.lifecycle = 'superseded'; last.placement = 'detail'; last.replacedBy = ['entry-1'];
  cycle.overrides.push({ oldEntryId: last.id, newEntryId: 'entry-1', scope: structuredClone(last.scope), evidence: [ref()], rationale: '环引用不能成为结束链' });
  invalid(cycle, 'state-cycle');
  value.entries.pop(); value.organizations[0]!.entryIds.pop(); invalid(value, 'state-override');
});

test('跨版本不能删除最早结束记录及其覆盖边而只保留后半链', () => {
  const previous = historicalChainCandidate(); valid(previous);
  const value = nextChainCandidate(previous);
  removeChainEntries(value, ['entry-1']);
  invalid(value, 'state-history');
});

test('跨版本不能删除全部结束记录和覆盖边而只留下当前状态', () => {
  const previous = historicalChainCandidate(); valid(previous);
  const value = nextChainCandidate(previous);
  removeChainEntries(value, ['entry-1', 'entry-2']);
  invalid(value, 'state-history');
});

test('跨版本不能用修订把结束状态洗成普通 historical/ineligible/none', () => {
  const previous = historicalChainCandidate(); valid(previous);
  const value = nextChainCandidate(previous); value.overrides = [];
  for (const item of value.entries) {
    if (item.format !== 'reviewed' || item.lifecycle !== 'superseded') continue;
    item.revision++; item.lifecycle = 'historical'; item.protectionAssessment.decision = 'ineligible';
    item.protection = { mode: 'none' }; item.replacedBy = [];
    const check = value.protectionChecks.find(row => row.entryIds.includes(item.id))!;
    check.decision = 'no-protectable-state'; check.entryIds = [];
  }
  invalid(value, 'state-history');
});

for (const mutation of ['legacy', 'nature', 'certainty', 'subjectId', 'dimension', 'qualifier', 'stateKey', 'value', 'validFrom', 'validTo', 'replacedBy'] as const) test(`跨版本结束身份拒绝改写 ${mutation}`, () => {
  const value = nextChainCandidate(); const old = value.entries[0]!;
  if (old.format !== 'reviewed' || old.protection.mode !== 'state') throw Error('fixture');
  old.revision++;
  if (mutation === 'legacy') {
    value.entries[0] = { id: old.id, revision: old.revision, text: old.text, format: 'legacy-unreviewed', placement: 'resident', legacyRef: 'old-block', contentHash: digest, primaryNodeId: old.primaryNodeId, relatedNodeIds: [], entityIds: [] };
  }
  if (mutation === 'nature') old.nature = 'suggestion';
  if (mutation === 'certainty') old.certainty = 'inferred';
  if (mutation === 'subjectId') {
    old.scope.subjectId = 'entity-2'; old.entityIds.push('entity-2');
    value.entities.push({ id: 'entity-2', kind: 'other', name: '另一主体', aliases: [], identityEvidence: [ref()] });
  }
  if (mutation === 'dimension') old.scope.dimension = 'other';
  if (mutation === 'qualifier') old.scope.qualifier = '另一设备';
  if (mutation === 'stateKey') old.protection.stateKey = 'other-mode';
  if (mutation === 'value') old.protection.value = 'offline';
  if (mutation === 'validFrom') old.validFrom = '2025-02-28T00:00:00.000Z';
  if (mutation === 'validTo') old.validTo = '2025-03-03T00:00:00.000Z';
  if (mutation === 'replacedBy') {
    old.replacedBy = ['entry-3']; old.validTo = '2025-03-03T00:00:00.000Z';
    value.overrides[0]!.newEntryId = 'entry-3'; value.overrides[0]!.evidence = [ref('e3')];
  }
  invalid(value, 'state-history');
});

test('跨版本结束链连续两轮完整携带，正文评分和组织位置可调整', () => {
  const initial = historicalChainCandidate(); valid(initial);
  const second = nextChainCandidate(initial); valid(second);
  const third = nextChainCandidate(second);
  const old = third.entries[0]!; if (old.format !== 'reviewed') throw Error('fixture');
  old.revision++; old.text = '归纳后的旧设备模式记录。'; old.retention = { score: 1, rationale: '已结束，降低常驻价值' };
  old.relatedNodeIds = ['node-2'];
  third.organizations.push({ id: 'node-2', title: '归档视角', parentId: null, entryIds: [] });
  valid(third);
});

for (const placement of ['detail', 'retired'] as const) test(`跨版本结束记录可转入 ${placement}，审计链不必常驻`, () => {
  const initial = historicalChainCandidate();
  for (const item of initial.entries) if (item.format === 'reviewed' && item.lifecycle === 'superseded') item.placement = 'resident';
  valid(initial);
  const second = nextChainCandidate(initial);
  for (const item of second.entries) if (item.format === 'reviewed' && item.lifecycle === 'superseded') { item.placement = placement; item.revision++; }
  valid(second); valid(nextChainCandidate(second));
});

test('跨版本第三轮可继续覆盖 C 到 D，并保留此前结束链', () => {
  const initial = historicalChainCandidate(); valid(initial);
  const second = nextChainCandidate(initial); valid(second);
  const third = nextChainCandidate(second), old = third.entries[2]!;
  if (old.format !== 'reviewed' || old.protection.mode !== 'state') throw Error('fixture');
  const next = structuredClone(old); next.id = 'entry-4'; next.validFrom = '2025-03-04T00:00:00.000Z'; next.text = '设备当前已关闭。';
  if (next.protection.mode !== 'state') throw Error('fixture');
  next.protection.value = 'offline'; next.protection.establishedBy = [ref('e4')];
  next.evidence[0]!.ref = ref('e4'); next.protectionAssessment.evidence = [ref('e4')];
  old.revision++; old.lifecycle = 'superseded'; old.placement = 'retired'; old.validTo = next.validFrom; old.replacedBy = [next.id];
  third.auditedAt = next.validFrom; third.entries.push(next); third.organizations[0]!.entryIds.push(next.id); third.evidence.push(evidence('e4'));
  third.coverage.push({ ref: ref('e4'), decision: 'retained', entryIds: [next.id], rationale: '第四段状态' });
  third.protectionChecks.push({ ref: ref('e4'), decision: 'mapped', entryIds: [next.id], rationale: '第四段资格' });
  third.overrides.push({ oldEntryId: old.id, newEntryId: next.id, scope: structuredClone(old.scope), evidence: [ref('e4')], rationale: '新证据结束当前状态' });
  valid(third); valid(nextChainCandidate(third));
  const missing = structuredClone(third); missing.overrides.shift(); invalid(missing, 'state-override');
  const future = structuredClone(third); future.evidence[3]!.visibleAfter = '2025-03-05T00:00:00.000Z'; invalid(future, 'future-evidence');
});

test('跨版本保护延续不阻止普通低保留历史条目淘汰和删除', () => {
  const initial = historicalChainCandidate(), ordinary = entry();
  ordinary.id = 'ordinary'; ordinary.lifecycle = 'historical'; ordinary.placement = 'detail'; ordinary.retention.score = 1;
  initial.entries.push(ordinary); initial.organizations[0]!.entryIds.push(ordinary.id); initial.coverage[0]!.entryIds.push(ordinary.id); valid(initial);
  const retired = nextChainCandidate(initial), next = retired.entries[3]!;
  if (next.format !== 'reviewed') throw Error('fixture');
  next.revision++; next.placement = 'retired'; retired.coverage[0]!.decision = 'retired-with-reason';
  retired.coverage[0]!.rationale = '普通历史价值不足，保留来源和旧版本'; valid(retired);
  const removed = nextChainCandidate(retired); removeChainEntries(removed, [ordinary.id]); valid(removed);
});

for (const mutation of ['scope', 'stateKey', 'sameValue', 'time', 'evidence', 'unavailable', 'future', 'extraTarget'] as const) test(`首次历史结束链拒绝伪造 ${mutation}`, () => {
  const value = overrideCandidate(); value.previousEntries = [];
  const old = value.entries[0]!, next = value.entries[1]!;
  if (old.format !== 'reviewed' || next.format !== 'reviewed' || next.protection.mode !== 'state') throw Error('fixture');
  if (mutation === 'scope') next.scope.qualifier = '另一设备';
  if (mutation === 'stateKey') next.protection.stateKey = 'another-mode';
  if (mutation === 'sameValue') next.protection.value = 'standby';
  if (mutation === 'time') old.validTo = '2025-03-03T00:00:00.000Z';
  if (mutation === 'evidence') value.overrides[0]!.evidence = [ref()];
  if (mutation === 'unavailable') {
    value.evidence[1]!.coverage = { status: 'unavailable', parts: [{ key: 'text', status: 'unavailable', reason: '等待来源' }] };
    value.coverage[1]!.decision = 'pending-source';
  }
  if (mutation === 'future') value.evidence[1]!.visibleAfter = '2025-03-03T00:00:00.000Z';
  if (mutation === 'extraTarget') old.replacedBy.push('absent');
  invalid(value);
});

for (const mutation of ['revision', 'decision', 'scope', 'entryId', 'evidence', 'unavailable', 'future', 'missing', 'duplicate', 'lifecycle', 'placement'] as const) test(`资格复核拒绝 ${mutation}`, () => {
  const value = pendingResolutionCandidate('ineligible');
  const resolution = value.protectionResolutions[0]!, next = value.entries[0]!;
  if (next.format !== 'reviewed') throw Error('fixture');
  if (mutation === 'revision') resolution.expectedRevision++;
  if (mutation === 'decision') resolution.decision = 'eligible';
  if (mutation === 'scope') resolution.scope.qualifier = '另一范围';
  if (mutation === 'entryId') resolution.entryId = 'absent';
  if (mutation === 'evidence') resolution.evidence = [ref('absent')];
  if (mutation === 'unavailable') value.evidence[0]!.coverage = { status: 'unavailable', parts: [{ key: 'text', status: 'unavailable', reason: '等待来源' }] };
  if (mutation === 'future') value.evidence[0]!.visibleAfter = '2025-03-03T00:00:00.000Z';
  if (mutation === 'missing') resolution.evidence = [];
  if (mutation === 'duplicate') value.protectionResolutions.push(structuredClone(resolution));
  if (mutation === 'lifecycle') next.lifecycle = 'historical';
  if (mutation === 'placement') next.placement = 'retired';
  invalid(value);
});

test('复核记录必须与实际同一条目、范围和评估来源对应，不是任意 mode 豁免', () => {
  const value = pendingResolutionCandidate('ineligible');
  const old = value.previousEntries[0]!, next = value.entries[0]!;
  if (old.format !== 'reviewed' || next.format !== 'reviewed') throw Error('fixture');
  next.scope.qualifier = '另一范围'; invalid(value, 'protection-resolution');
  next.scope = structuredClone(old.scope);
  value.evidence.push(evidence('e2'));
  value.coverage.push({ ref: ref('e2'), decision: 'no-effective-new-information', entryIds: [], rationale: '无新增' });
  value.protectionChecks.push({ ref: ref('e2'), decision: 'no-protectable-state', entryIds: [], rationale: '普通输入' });
  value.protectionResolutions[0]!.evidence = [ref('e2')]; invalid(value, 'protection-resolution');
  value.protectionResolutions[0]!.evidence = [ref()];
  old.protectionAssessment.decision = 'eligible'; old.protection = { mode: 'state', stateKey: 'mode', value: 'standby', establishedBy: [ref()], overrideRule: '同一设备的新模式状态' };
  invalid(value, 'protection-resolution');
});

test('资格确实收敛后的普通信息可在后续批次按覆盖理由淘汰', () => {
  const resolved = pendingResolutionCandidate('ineligible'); valid(resolved);
  const { protectionResolutions: _audit, ...value } = structuredClone(resolved);
  value.previousEntries = structuredClone(value.entries);
  const next = value.entries[0]!; if (next.format !== 'reviewed') throw Error('fixture');
  next.revision++; next.placement = 'retired';
  value.coverage[0]!.decision = 'retired-with-reason'; value.coverage[0]!.rationale = '资格已收敛且当前保留价值不足，来源与历史仍保留';
  valid(value);
  value.coverage[0]!.decision = 'no-effective-new-information'; invalid(value, 'retirement-coverage');
});

test('首次导入同一可用来源中的前后状态不必伪造独立新事实', () => {
  const value = overrideCandidate(); value.previousEntries = [];
  const next = value.entries[1]!; if (next.format !== 'reviewed' || next.protection.mode !== 'state') throw Error('fixture');
  next.evidence[0]!.ref = ref(); next.protectionAssessment.evidence = [ref()]; next.protection.establishedBy = [ref()];
  value.overrides[0]!.evidence = [ref()];
  value.protectionChecks[0]!.entryIds.push(next.id);
  value.evidence.pop(); value.coverage.pop(); value.protectionChecks.pop(); value.coverage[0]!.entryIds.push(next.id);
  valid(value);
  value.previousEntries = structuredClone(value.entries);
  valid(value);
});

test('结束链不能以尚未生效、已过期或 unresolved 替代状态收尾', () => {
  for (const mutation of ['future', 'expired', 'unresolved'] as const) {
    const value = overrideCandidate(); value.previousEntries = [];
    const next = value.entries[1]!; if (next.format !== 'reviewed') throw Error('fixture');
    if (mutation === 'future') value.auditedAt = at;
    if (mutation === 'expired') { next.validTo = '2025-03-03T00:00:00.000Z'; value.auditedAt = next.validTo; }
    if (mutation === 'unresolved') next.lifecycle = 'unresolved';
    invalid(value, mutation === 'unresolved' ? 'state-override' : 'state-time');
  }
});

test('pending-review 自身不能通过生命期、归档或虚构结束引用逃避保护', () => {
  for (const mutation of ['lifecycle', 'placement', 'superseded'] as const) {
    const resolved = pendingResolutionCandidate('eligible');
    const { protectionResolutions: _removed, ...value } = resolved;
    value.entries = structuredClone(value.previousEntries);
    value.protectionChecks[0]!.decision = 'pending-review'; value.coverage[0]!.decision = 'pending-review';
    const next = value.entries[0]!; if (next.format !== 'reviewed') throw Error('fixture');
    next.revision++;
    if (mutation === 'lifecycle') next.lifecycle = 'historical';
    if (mutation === 'placement') next.placement = 'detail';
    if (mutation === 'superseded') { next.lifecycle = 'superseded'; next.replacedBy = ['absent']; }
    invalid(value, 'schema');
  }
});

test('资格复核拒绝额外字段、空理由、空来源和错误目标修订', () => {
  const value = pendingResolutionCandidate('eligible');
  invalid({ ...value, protectionResolutions: [{ ...value.protectionResolutions[0], bypassProtection: true }] }, 'schema');
  invalid({ ...value, protectionResolutions: [{ ...value.protectionResolutions[0], rationale: '' }] }, 'schema');
  invalid({ ...value, protectionResolutions: [{ ...value.protectionResolutions[0], evidence: [] }] }, 'schema');
  value.entries[0]!.revision++;
  invalid(value, 'protection-resolution');
});

test('资格收敛到 state 后仍不能静默淘汰，显式新状态覆盖可以继续', () => {
  const resolved = pendingResolutionCandidate('eligible'); valid(resolved);
  const changed = candidate(true); changed.previousEntries = structuredClone(resolved.entries);
  changed.entries[0]!.revision = 3; changed.entries[0]!.placement = 'retired';
  changed.coverage[0]!.decision = 'retired-with-reason'; invalid(changed, 'protection-regression');
  const replaced = overrideCandidate(); replaced.previousEntries = structuredClone(resolved.entries);
  replaced.entries[0]!.revision = 3; valid(replaced);
});

test('legacy 联合不捏造评分，完整保留且不能默认改成 detail', () => {
  const legacy = { id: 'legacy-1', revision: 1, text: '旧正文完整保留。\n第二行。\n', format: 'legacy-unreviewed' as const, placement: 'resident' as const, legacyRef: 'old-block', contentHash: digest, primaryNodeId: 'node-1', relatedNodeIds: [], entityIds: [] };
  assert.equal(memoryEntrySchema.safeParse(legacy).success, true);
  assert.equal(memoryEntrySchema.safeParse({ ...legacy, retention: { score: 1, rationale: '没有评估' } }).success, false);
  assert.equal(memoryEntrySchema.safeParse({ ...legacy, placement: 'detail' }).success, false);
  const value = candidate(); value.previousEntries = [legacy]; invalid(value, 'legacy-loss');
  value.entries = [structuredClone(legacy)]; value.organizations = [{ id: 'node-1', title: '旧内容', parentId: null, entryIds: ['legacy-1'] }]; valid(value);
  value.entries[0]!.text = '删改后的内容'; value.entries[0]!.revision++; invalid(value, 'legacy-loss');
});

test('工具终态缺失保持 unknown，完成不等于业务成功', () => {
  assert.equal(resolveToolTerminal([]), 'unknown'); assert.equal(resolveToolTerminal([toolEnd()]), 'finished');
  const value = observation(); value.terminalEvidence = [toolEnd()]; value.toolTerminal = 'finished';
  assert.equal(executionObservationSchema.parse(value).businessOutcome.state, 'unknown');
});
for (const [name, events, state] of [
  ['非零退出', [toolEnd(), exit(9)], 'failed'],
  ['success=false', [toolEnd(), exit(0, false)], 'failed'],
  ['结构化 resultError', [toolEnd({ resultError: true }), exit(0)], 'failed'],
  ['结构化 isError', [toolEnd({ isError: true }), exit(0)], 'failed'],
  ['denied 优先', [toolEnd({ denied: true }), exit(9)], 'denied'],
  ['首个有效退出', [exit(0), exit(9)], 'finished'],
] as const) test(`结构化终态优先级：${name}`, () => assert.equal(resolveToolTerminal(events), state));

test('执行缺证据不能填已授权或执行成功，失败不能升级为成功', () => {
  const value = observation(); value.authorization = { state: 'granted', evidence: [] }; assert.equal(executionObservationSchema.safeParse(value).success, false);
  value.authorization = unknown(); value.terminalEvidence = [exit(8)]; value.toolTerminal = 'finished'; assert.equal(executionObservationSchema.safeParse(value).success, false);
  value.toolTerminal = 'failed'; value.businessOutcome = { state: 'confirmed-success', evidence: [ref()] }; assert.equal(executionObservationSchema.safeParse(value).success, false);
});

test('结构化终态不允许任意正文、非整数退出码或未知字段', () => {
  assert.throws(() => resolveToolTerminal([{ ...exit(0), text: '成功' } as unknown as ToolTerminalEvidence]));
  assert.throws(() => resolveToolTerminal([exit(1.5)]));
});

test('执行观察合并不能跨 context、operation 或来源系统', () => {
  const value = candidate(); value.evidence[0]!.kind = 'tool-result'; value.evidence[0]!.actor = 'tool'; value.evidence[0]!.operationRef = 'operation-1';
  const item = observation(); item.terminalEvidence = [exit(5)]; item.toolTerminal = 'failed'; value.observations = [item]; valid(value);
  item.identity.contextRef = 'other'; invalid(value, 'operation-scope'); item.identity.contextRef = 'context-1';
  item.identity.operationRef = 'other'; invalid(value, 'operation-scope'); item.identity.operationRef = 'operation-1';
  item.identity.system = 'import'; invalid(value, 'operation-scope');
});

test('import 只在自身来源范围内报告历史执行', () => {
  const value = candidate(); const record = value.evidence[0]!; record.kind = 'tool-result'; record.actor = 'tool'; record.operationRef = 'operation-1';
  record.origin = { ...record.origin, system: 'import', capture: 'historical-record' };
  const item = observation(); item.identity.system = 'import'; item.toolTerminal = 'finished'; item.terminalEvidence = [exit(0)]; value.observations = [item]; valid(value);
});

test('confirmed 结果需要对应业务观察与可用来源，而非任意工具完成', () => {
  const value = candidate(true); const record = value.evidence[0]!; record.operationRef = 'operation-1';
  const item = value.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture');
  item.nature = 'result'; item.followup.outcome = 'confirmed-success'; item.followup.outcomeEvidence = [ref()]; invalid(value, 'outcome-evidence');
  const observed = observation(); observed.businessOutcome = { state: 'confirmed-success', evidence: [ref()] }; value.observations = [observed]; valid(value);
  record.kind = 'tool-result'; record.actor = 'tool'; invalid(value, 'business-evidence');
});

test('请求、授权与执行证据种类各自校验，不由调用推导授权', () => {
  const value = candidate(); value.evidence[0]!.operationRef = 'operation-1';
  const item = observation(); item.request = { state: 'requested', evidence: [ref()] }; value.observations = [item]; valid(value);
  item.authorization = { state: 'granted', evidence: [ref()] }; invalid(value, 'execution-evidence');
});

test('组织无环且正文只有主要节点一份，相关组织不复制正文', () => {
  const value = candidate(true); value.organizations[0]!.parentId = 'node-1'; invalid(value, 'organization-cycle');
  value.organizations[0]!.parentId = null;
  value.organizations.push({ id: 'node-2', title: '另一个组织视角', parentId: null, entryIds: [] });
  value.entries[0]!.relatedNodeIds = ['node-2']; valid(value);
  value.organizations[1]!.entryIds = ['entry-1']; invalid(value, 'primary-body');
});

test('关系必须使用存在实体、主要条目与相同有效期', () => {
  const value = candidate(true); value.entities.push({ id: 'entity-2', kind: 'other', name: '另一个演示主体', aliases: [], identityEvidence: [ref()] });
  value.entries[0]!.entityIds.push('entity-2');
  value.relations.push({ id: 'relation-1', subjectId: 'entity-1', objectId: 'entity-2', kind: '关联', entryId: 'entry-1', validFrom: at, validTo: null }); valid(value);
  value.relations[0]!.validFrom = later; invalid(value, 'relation-scope');
});

test('修订只在实质变更时递增，组织重排不更换条目身份', () => {
  const value = candidate(true); value.previousEntries = structuredClone(value.entries); valid(value);
  value.entries[0]!.text = '演示界面偏好宽松列表。'; invalid(value, 'revision'); value.entries[0]!.revision++; valid(value);
});

test('计数未知诚实保留，heuristic 不可冒充实际编码', () => {
  const value = measurement(); assert.equal(tokenMeasurementSchema.safeParse(value).success, true);
  value.basis = 'heuristic'; value.textTokens = 12; assert.equal(tokenMeasurementSchema.safeParse(value).success, true);
  value.exactForEncoding = true; assert.equal(tokenMeasurementSchema.safeParse(value).success, false);
});

test('实际编码需要身份、版本、词表，不能标为 provider 精确', () => {
  const value = measurement(); value.basis = 'encoding'; value.textTokens = 32; value.exactForEncoding = true;
  assert.equal(tokenMeasurementSchema.safeParse(value).success, false);
  value.tokenizerId = 'synthetic-encoder'; value.tokenizerVersion = 'test-1'; value.vocabularyHash = digest; assert.equal(tokenMeasurementSchema.safeParse(value).success, true);
  value.exactForProvider = true; assert.equal(tokenMeasurementSchema.safeParse(value).success, false);
});

test('供应商完整请求 usage 不可归为记忆用量，媒体未知不能填零', () => {
  const value = measurement(); value.basis = 'provider-usage'; value.modelId = 'test-model'; value.textTokens = 42; value.exactForProvider = true;
  assert.equal(tokenMeasurementSchema.safeParse(value).success, false);
  value.scope = 'request'; assert.equal(tokenMeasurementSchema.safeParse(value).success, true);
  value.mediaTokens = 0; assert.equal(tokenMeasurementSchema.safeParse(value).success, false);
});

test('显式 manifest 分离原始、详细与常驻，拒绝路径逃逸与重复层级', () => {
  const value = { schemaVersion: 1, id: 'version-1', parentVersionId: null, generation: 1, auditedAt: later, policyRevision: 1, residentInjection: 'all', measurement: measurement(), files: [
    { path: 'resident/one.md', layer: 'resident', sha256: digest, entryIds: ['entry-1'] },
    { path: 'detail/one.md', layer: 'detail', sha256: digest, entryIds: ['entry-1'] },
    { path: 'raw/index.json', layer: 'raw', sha256: digest, entryIds: [] },
  ] };
  assert.equal(versionManifestSchema.safeParse(value).success, true);
  for (const path of ['../outside', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a/./b']) {
    const changed = structuredClone(value); changed.files[0]!.path = path; assert.equal(versionManifestSchema.safeParse(changed).success, false);
  }
  value.files[1]!.path = value.files[0]!.path; assert.equal(versionManifestSchema.safeParse(value).success, false);
});

test('默认 policy 是可调选择，编码器尚未就绪且不共享可变对象', () => {
  const value = createDefaultMemoryContextPolicy();
  assert.equal(value.recent.days, 7); assert.equal(value.recent.textTokens, 4096); assert.equal(value.recent.maxImages, 4);
  assert.equal(value.resident.textTokens, 8192); assert.equal(value.resident.injection, 'all');
  assert.equal(value.organization.softTriggerRatio, 0.8); assert.equal(value.organization.maxCapacityCorrections, 3);
  assert.equal(value.tokenizer.readiness, 'pending-dependency'); assert.equal(value.tokenizer.exactForProvider, false);
  value.recent.days = 2; assert.equal(createDefaultMemoryContextPolicy().recent.days, 7);
  assert.equal(memoryContextPolicySchema.safeParse({ ...value, tokenizer: { ...value.tokenizer, readiness: 'ready' } }).success, false);
  assert.equal(memoryContextPolicySchema.safeParse({ ...value, resident: { ...value.resident, injection: 'on-demand' } }).success, false);
});

test('同一操作不得拆成两个观察绕过终态归并', () => {
  const value = candidate(); value.observations = [observation(), { ...observation(), id: 'observation-2' }]; invalid(value, 'duplicate-operation');
});

test('待复核条目不能伪装已完成资格映射或历史条目', () => {
  const value = protectedCandidate(); const item = value.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture');
  item.protectionAssessment.decision = 'pending-review'; item.protection = { mode: 'pending-review', reason: '需要复核' };
  invalid(value, 'protection-check'); value.protectionChecks[0]!.decision = 'pending-review'; value.coverage[0]!.decision = 'pending-review'; valid(value, false);
  item.lifecycle = 'historical'; invalid(value, 'schema');
});

test('覆盖后的旧状态保留原身份和连续有效期', () => {
  const value = overrideCandidate(); const old = value.entries[0]!; if (old.format !== 'reviewed') throw Error('fixture');
  old.validTo = '2025-03-03T00:00:00.000Z'; invalid(value, 'state-history');
});

test('主体范围不能引用未关联的实体', () => {
  const value = candidate(true); const item = value.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture');
  item.scope.subjectId = 'absent'; invalid(value, 'entry-scope');
});

test('重复身份、覆盖决定与保护检查均被拒绝', () => {
  const duplicate = candidate(true); duplicate.entries.push(structuredClone(duplicate.entries[0]!)); invalid(duplicate, 'duplicate-id');
  const coverage = candidate(); coverage.coverage.push(structuredClone(coverage.coverage[0]!)); invalid(coverage, 'duplicate-coverage');
  const checks = candidate(); checks.protectionChecks.push(structuredClone(checks.protectionChecks[0]!)); invalid(checks, 'duplicate-check');
});

test('legacy 转换必须显式映射到常驻承接条目，不由评分代替复核', () => {
  const value = candidate(true); value.previousEntries = [{ id: 'legacy-1', revision: 1, text: '旧区块正文。', format: 'legacy-unreviewed', placement: 'resident', legacyRef: 'old-block', contentHash: digest, primaryNodeId: 'node-1', relatedNodeIds: [], entityIds: [] }];
  value.legacyCoverage = [{ legacyEntryId: 'legacy-1', replacementEntryIds: ['entry-1'], evidence: [ref()], rationale: '显式承接映射，语义完整性另行复核' }]; valid(value);
  const item = value.entries[0]!; if (item.format !== 'reviewed') throw Error('fixture'); item.placement = 'detail'; invalid(value, 'legacy-coverage');
});

test('manifest 不能重复主正文或使用完整请求计数代替注入计数', () => {
  const value = { schemaVersion: 1, id: 'version-1', parentVersionId: null, generation: 1, auditedAt: later, policyRevision: 1, residentInjection: 'all', measurement: measurement(), files: [
    { path: 'resident/one.md', layer: 'resident', sha256: digest, entryIds: ['entry-1'] },
    { path: 'resident/two.md', layer: 'resident', sha256: digest, entryIds: ['entry-1'] },
  ] };
  assert.equal(versionManifestSchema.safeParse(value).success, false);
  value.files.pop(); value.measurement.scope = 'request'; assert.equal(versionManifestSchema.safeParse(value).success, false);
});


test('结构合法与覆盖完成分开，待复核不能被误判为已处理 no-op', () => {
  assert.equal(validateMemoryCandidate(candidate()).coverageComplete, true);
  const blocked = candidate(); blocked.protectionChecks[0]!.decision = 'pending-review'; blocked.coverage[0]!.decision = 'pending-review';
  const result = validateMemoryCandidate(blocked); assert.equal(result.valid, true); assert.equal(result.coverageComplete, false);
});

test('调用请求或工具结束不证明实际执行，进程退出与专门执行状态才可承接', () => {
  const value = candidate(); const record = value.evidence[0]!;
  record.kind = 'tool-action'; record.actor = 'tool'; record.operationRef = 'operation-1';
  const item = observation(); item.execution = { state: 'started', evidence: [ref()] }; value.observations = [item]; invalid(value, 'execution-evidence');
  record.kind = 'tool-result'; item.terminalEvidence = [toolEnd()]; item.toolTerminal = 'finished'; invalid(value, 'execution-evidence');
  item.terminalEvidence = [exit(7)]; item.toolTerminal = 'failed'; item.execution = { state: 'completed', evidence: [ref()] }; valid(value);
  record.kind = 'execution-status'; item.terminalEvidence = []; item.toolTerminal = 'unknown'; valid(value);
});
