import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryWorkspace, MemoryWorkspaceError } from '../src/memory/v1/workspace.js';
import type { MemoryEntryInput, MemoryWorkspaceOptions } from '../src/memory/v1/workspace.js';
import type { EvidenceRecord, MemoryEntry } from '../src/memory/v1/contracts.js';
import { validateMemoryCandidate } from '../src/memory/v1/validate.js';

const at = '2026-01-01T00:00:00.000Z', later = '2026-01-02T00:00:00.000Z';
const ref = (id = 'e1') => ({ evidenceId: id, partKey: 'text' });
function evidence(id: string): EvidenceRecord {
  return {
    schemaVersion: 1, id, kind: 'user-statement', actor: 'user',
    origin: { system: 'native', namespace: 'test', sourceRef: 'source', contextRef: 'context', recordRef: id, lineageRoot: id, capture: 'native-snapshot' },
    occurredAt: at, receivedAt: at, visibleAfter: at, timeBasis: 'host-admission', contentRef: id, contentHash: 'a'.repeat(64), operationRef: null,
    derivedFrom: [], attachments: [], coverage: { status: 'complete', parts: [{ key: 'text', status: 'available', reason: null }] },
  };
}
function input(id = 'e1'): MemoryEntryInput {
  return {
    text: '合成展台采用紧凑列表。', nature: 'preference', certainty: 'reported', lifecycle: 'current',
    scope: { subjectId: 'subject', dimension: 'display', qualifier: '合成展台' }, validFrom: at, validTo: null,
    retention: { score: 2, rationale: '局部显示用途' },
    protectionAssessment: { decision: 'ineligible', evidence: [ref(id)], rationale: '普通呈现偏好' }, protection: { mode: 'none' },
    followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: ref(id), role: 'supports' }],
    primaryNodeId: 'root', relatedNodeIds: [], entityIds: ['subject'], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [],
  };
}
function options(previousEntries: MemoryEntry[] = []): MemoryWorkspaceOptions {
  let next = 0;
  return {
    baseVersion: previousEntries.length ? 'v0' : null, batchId: 'batch', auditedAt: later,
    previousEntries, evidence: [evidence('e1'), evidence('e2')], observations: [],
    entities: [{ id: 'subject', kind: 'other', name: '合成展台', aliases: [], identityEvidence: [ref()] }],
    organizations: [{ id: 'root', title: '展台', parentId: null, entryIds: previousEntries.map(entry => entry.id) }],
    supportGroups: [{ ref: ref(), group: 'same-origin' }, { ref: ref('e2'), group: 'same-origin' }],
    clock: () => later, createId: kind => `${kind}-${++next}`,
  };
}
function prior(value: MemoryEntryInput = input()): MemoryEntry {
  return { ...value, format: 'reviewed', id: 'old', revision: 4, createdInBatch: 'previous', updatedInBatch: 'previous', evidence: value.evidence.map(row => ({ ...row, supportGroup: 'same-origin' })) };
}
function protectedInput(id = 'e1', pending = false): MemoryEntryInput {
  const value = input(id);
  value.nature = 'fact'; value.text = `合成设备状态 ${id}`; value.scope.dimension = 'mode';
  value.protectionAssessment = { decision: pending ? 'pending-review' : 'eligible', evidence: [ref(id)], rationale: '持续使用的设备模式' };
  value.protection = pending ? { mode: 'pending-review', reason: '资格有待核对' } : { mode: 'state', stateKey: 'mode', value: id, establishedBy: [ref(id)], overrideRule: '同一设备的新模式' };
  return value;
}
function failureUnchanged(workspace: MemoryWorkspace, run: () => unknown) {
  const before = workspace.export(); assert.throws(run); assert.deepEqual(workspace.export(), before);
}

test('宿主基线、来源及导出快照隔离；工具不能提交身份、审计或来源分组', () => {
  const config = options([prior()]), workspace = new MemoryWorkspace(config);
  config.previousEntries[0]!.text = '外部改写'; config.evidence[0]!.contentRef = '伪造';
  assert.notEqual(workspace.export().candidate.previousEntries[0]!.text, '外部改写');
  assert.equal(workspace.export().candidate.evidence[0]!.contentRef, 'e1');
  const exported = workspace.export(); assert.ok(Object.isFrozen(exported.candidate.entries));
  assert.throws(() => { exported.candidate.entries[0]!.text = '外部改写'; });
  failureUnchanged(workspace, () => workspace.createEntry(0, { ...input(), id: 'forged' } as MemoryEntryInput, '测试拒绝'));
  failureUnchanged(workspace, () => workspace.createEntry(0, { ...input(), evidence: [{ ref: ref(), role: 'supports', supportGroup: 'fake' }] } as unknown as MemoryEntryInput, '测试拒绝'));
  assert.equal(workspace.export().candidate.previousEntries[0]!.revision, 4);
});

test('同条候选多次编辑只增加一个持久修订；草稿代数拒绝并发陈旧更新', () => {
  const workspace = new MemoryWorkspace(options([prior()]));
  const first = workspace.updateEntry(0, 'old', 4, { ...input(), text: '合成条目第一版' }, '压缩表达');
  assert.equal(first.result.revision, 5);
  const second = workspace.updateEntry(1, 'old', 5, { ...input(), text: '合成条目第二版' }, '保留条件');
  assert.equal(second.result.revision, 5); assert.equal(second.draftRevision, 2);
  failureUnchanged(workspace, () => workspace.updateEntry(1, 'old', 5, input(), '陈旧草稿'));
  failureUnchanged(workspace, () => workspace.updateEntry(2, 'old', 4, input(), '陈旧条目'));
  failureUnchanged(workspace, () => workspace.updateEntry(2, 'old', 5, { ...input(), primaryNodeId: 'missing' }, '无效引用'));
  assert.equal(validateMemoryCandidate(workspace.export().candidate).valid, true);
  assert.equal(workspace.export().audit.length, 2);
  const change = workspace.export().audit[1]!.changes.find(row => row.collection === 'entries')!;
  assert.equal(change.identity, 'old'); assert.deepEqual(change.fields, ['text']);
  assert.notEqual(change.beforeHash, change.afterHash);
});

test('新条目宿主分配稳定身份；修改返回值与同源新证据不增加独立佐证', () => {
  const workspace = new MemoryWorkspace(options());
  const created = workspace.createEntry(0, input(), '记录局部偏好');
  assert.equal(created.result.id, 'entry-1'); assert.equal(created.result.revision, 1);
  assert.throws(() => { created.result.text = '篡改'; });
  const edited = input(); edited.evidence.push({ ref: ref('e2'), role: 'supports' });
  const updated = workspace.updateEntry(1, created.result.id, 1, edited, '补充来源');
  assert.equal(updated.result.revision, 1);
  assert.equal(new Set(updated.result.evidence.map(row => row.supportGroup)).size, 1);
  failureUnchanged(workspace, () => workspace.createEntry(2, input(), '重复命题'));
});

test('普通淘汰保留可审计正文和显式覆盖理由，不隐含业务成功', () => {
  const workspace = new MemoryWorkspace(options([prior()]));
  failureUnchanged(workspace, () => workspace.updateEntry(0, 'old', 4, { ...input(), placement: 'retired' }, '绕过淘汰'));
  const result = workspace.retireEntry(0, 'old', 4, '局部安排已经失去用途');
  assert.equal(result.result.placement, 'retired'); assert.equal(result.result.followup.outcome, 'unknown');
  assert.equal(workspace.export().candidate.coverage[0]!.decision, 'retired-with-reason');
  const failed = input(); failed.followup = { attention: 'none', outcome: 'confirmed-success', outcomeEvidence: [ref()] };
  failureUnchanged(workspace, () => workspace.createEntry(1, failed, '无业务观察'));
});

test('当前保护和 pending 不能普通淘汰、改生命周期或静默降级', () => {
  for (const pending of [false, true]) {
    const value = protectedInput('e1', pending), workspace = new MemoryWorkspace(options([prior(value)]));
    failureUnchanged(workspace, () => workspace.retireEntry(0, 'old', 4, '试图淘汰'));
    failureUnchanged(workspace, () => workspace.updateEntry(0, 'old', 4, { ...value, placement: 'detail' }, '试图归档'));
    failureUnchanged(workspace, () => workspace.updateEntry(0, 'old', 4, { ...value, lifecycle: 'historical' }, '试图结束'));
    failureUnchanged(workspace, () => workspace.updateEntry(0, 'old', 4, input(), '试图降级'));
    failureUnchanged(workspace, () => workspace.decideCoverage(0,
      { ref: ref(), decision: 'retained', entryIds: ['old'], rationale: '尝试忽略保护映射' },
      { ref: ref(), decision: 'no-protectable-state', entryIds: [], rationale: '不得覆盖真实保护评估' }));
  }
});

test('合法状态覆盖原子结束旧状态，保存非驻留记录及新证据', () => {
  const value = protectedInput(), config = options([prior(value)]), workspace = new MemoryWorkspace(config);
  const replacement = protectedInput('e2'); replacement.validFrom = later;
  failureUnchanged(workspace, () => workspace.replaceState(0, 'old', 4, replacement, [ref()], '不得重用旧证据'));
  const result = workspace.replaceState(0, 'old', 4, replacement, [ref('e2')], '同范围的新模式生效');
  const old = workspace.export().candidate.entries.find(row => row.id === 'old')!;
  assert.equal(old.placement, 'detail'); assert.equal(old.format === 'reviewed' && old.lifecycle, 'superseded');
  assert.equal(old.format === 'reviewed' && old.validTo, later);
  assert.equal(result.result.revision, 1);
  const before = workspace.export(); replacement.text = '外部改写';
  assert.deepEqual(workspace.export(), before);
});

test('pending 显式收敛仍不等于语义和覆盖已完成，重复编辑不破坏持久修订', () => {
  const value = protectedInput('e1', true), workspace = new MemoryWorkspace(options([prior(value)]));
  const resolved = { ...value, protectionAssessment: { decision: 'ineligible' as const, evidence: [ref()], rationale: '已确认仅为局部事项' }, protection: { mode: 'none' as const } };
  const result = workspace.resolveProtection(0, 'old', 4, resolved, '明确核对资格');
  assert.equal(result.result.revision, 5); assert.equal(workspace.check().coverageComplete, false);
  workspace.updateEntry(1, 'old', 5, { ...resolved, text: '合成事项仍保留当前表达' }, '简化正文');
  assert.equal(workspace.export().candidate.entries[0]!.revision, 5);
  workspace.decideCoverage(2,
    { ref: ref(), decision: 'retained', entryIds: ['old'], rationale: '本部分已覆盖' },
    { ref: ref(), decision: 'no-protectable-state', entryIds: [], rationale: '普通事项无保护资格' });
  assert.equal(workspace.check().valid, true);
});

test('普通合并与拆分保留替代边，漏来源或受保护条目失败不半改', () => {
  const workspace = new MemoryWorkspace(options([prior()]));
  const a = input(); a.text = '合成展台显示方式';
  const b = input(); b.text = '合成展台显示范围';
  const result = workspace.reorganizeEntries(0, [{ id: 'old', revision: 4 }], [a, b], '拆分两个具体命题');
  assert.equal(result.result.length, 2);
  const old = workspace.export().candidate.entries.find(row => row.id === 'old')!;
  assert.equal(old.format === 'reviewed' && old.replacedBy.length, 2);
  const merged = input(); merged.text = '合成展台采用范围明确的列表';
  workspace.reorganizeEntries(1, result.result.map(row => ({ id: row.id, revision: 1 })), [merged], '合并相关命题');
  const missing = input('e2'); missing.text = '缺少原来源的命题';
  const active = workspace.export().candidate.entries.at(-1)!;
  failureUnchanged(workspace, () => workspace.reorganizeEntries(2, [{ id: active.id, revision: active.revision }], [missing], '缺来源'));
});

test('组织环、实体身份和关系有效期/引用均受合同约束', () => {
  const workspace = new MemoryWorkspace(options());
  const child = workspace.createOrganization(0, { title: '分区', parentId: 'root' }, '组织少量信息');
  failureUnchanged(workspace, () => workspace.updateOrganization(1, 'root', { title: '展台', parentId: child.result.id }, '形成环'));
  failureUnchanged(workspace, () => workspace.removeOrganization(1, 'root', '父节点仍被使用'));
  const person = workspace.createEntity(1, { kind: 'person', name: '合成人物甲', aliases: [], identityEvidence: [ref('e2')] }, '人物身份');
  failureUnchanged(workspace, () => workspace.updateEntity(2, person.result.id, { kind: 'person', name: '合成人物乙', aliases: [], identityEvidence: [ref()] }, '不得换人'));
  const value = input(); value.entityIds.push(person.result.id); value.text = '合成人物甲负责展台';
  const entry = workspace.createEntry(2, value, '关系的主要事实');
  failureUnchanged(workspace, () => workspace.setRelation(3, null, { subjectId: 'subject', objectId: person.result.id, entryId: entry.result.id, kind: '负责', validFrom: later, validTo: null }, '时间不一致'));
  const relation = workspace.setRelation(3, null, { subjectId: 'subject', objectId: person.result.id, entryId: entry.result.id, kind: '负责', validFrom: at, validTo: null }, '一致的关系');
  assert.equal(relation.result.entryId, entry.result.id);
  workspace.updateEntry(4, entry.result.id, 1, { ...value, validTo: later, lifecycle: 'historical' }, '结束该人物的关系时段');
  assert.equal(workspace.export().candidate.relations[0]!.validTo, later);
  failureUnchanged(workspace, () => workspace.setRelation(5, relation.result.id, { subjectId: 'subject', objectId: person.result.id, entryId: entry.result.id, kind: '另一个身份关系', validFrom: at, validTo: later }, '旧关系身份不得复用'));
});

test('legacy 不可普通改写或评分，只能显式完整承接为常驻条目', () => {
  const legacy: MemoryEntry = { format: 'legacy-unreviewed', id: 'legacy', revision: 1, text: '合成旧文\n\n保留空白。', primaryNodeId: 'root', relatedNodeIds: [], entityIds: [], placement: 'resident', legacyRef: 'legacy-ref', contentHash: 'b'.repeat(64) };
  const workspace = new MemoryWorkspace(options([legacy]));
  failureUnchanged(workspace, () => workspace.retireEntry(0, 'legacy', 1, '未复核不能淘汰'));
  failureUnchanged(workspace, () => workspace.reviewLegacy(0, 'legacy', [], [ref()], '没有承接'));
  failureUnchanged(workspace, () => workspace.reviewLegacy(0, 'legacy', [{ ...input(), placement: 'detail' }], [ref()], '不能悄悄转档'));
  workspace.reviewLegacy(0, 'legacy', [input()], [ref()], '已逐项核对完整承接');
  assert.equal(workspace.export().candidate.legacyCoverage[0]!.legacyEntryId, 'legacy');
  assert.equal(workspace.export().candidate.previousEntries[0]!.text, legacy.text);
});

test('同批新建 pending 可显式收敛，但不能借收敛扩大范围', () => {
  const value = protectedInput('e1', true), workspace = new MemoryWorkspace(options());
  const created = workspace.createEntry(0, value, '待核对保护资格');
  const resolved = { ...value, protectionAssessment: { decision: 'ineligible' as const, evidence: [ref()], rationale: '已确认是普通局部事项' }, protection: { mode: 'none' as const } };
  failureUnchanged(workspace, () => workspace.resolveProtection(1, created.result.id, 1, { ...resolved, scope: { ...resolved.scope, qualifier: '扩大范围' } }, '不能扩大范围'));
  const result = workspace.resolveProtection(1, created.result.id, 1, resolved, '同批明确收敛');
  assert.equal(result.result.revision, 1); assert.equal(result.result.protection.mode, 'none');
  assert.equal(workspace.check().coverageComplete, false);
});

test('同来源多条普通记忆可逐项淘汰，覆盖不会遗漏此前淘汰身份', () => {
  const workspace = new MemoryWorkspace(options());
  const a = workspace.createEntry(0, input(), '合成事项甲');
  const b = workspace.createEntry(1, { ...input(), text: '合成展台局部使用浅色边框。' }, '合成事项乙');
  workspace.retireEntry(2, a.result.id, 1, '甲不再有后续用途');
  workspace.retireEntry(3, b.result.id, 1, '乙不再有后续用途');
  assert.deepEqual(workspace.export().candidate.coverage[0]!.entryIds, [a.result.id, b.result.id]);
  assert.equal(workspace.check().valid, true);
});

test('已完成 no-op 覆盖仍只是可计算检查，不能修改宿主来源', () => {
  const workspace = new MemoryWorkspace(options());
  for (const [index, id] of ['e1', 'e2'].entries()) workspace.decideCoverage(index,
    { ref: ref(id), decision: 'no-effective-new-information', entryIds: [], rationale: '合成输入没有有效新增信息' },
    { ref: ref(id), decision: 'no-protectable-state', entryIds: [], rationale: '已逐部分核对，无保护状态' });
  assert.deepEqual(workspace.check(), { valid: true, coverageComplete: true, issues: [] });
  assert.equal(workspace.export().candidate.entries.length, 0);
  assert.equal(workspace.export().candidate.evidence.length, 2);
});

test('ID 冲突、非法评分及空理由均失败且不污染候选', () => {
  const config = options(); config.createId = () => 'subject';
  const workspace = new MemoryWorkspace(config);
  failureUnchanged(workspace, () => workspace.createEntry(0, input(), '已占用的 ID'));
  const normal = new MemoryWorkspace(options());
  for (const score of [0, 11, 1.5]) failureUnchanged(normal, () => normal.createEntry(0, { ...input(), retention: { score, rationale: '非法评分' } }, '拒绝评分'));
  failureUnchanged(normal, () => normal.createEntry(0, input(), '   '));
  failureUnchanged(normal, () => normal.createEntry(0, { ...input(), protectionAssessment: { ...input().protectionAssessment, rationale: ' ' } }, '拒绝空评估'));
});

test('来源缺口不能被 no-op、未知引用或伪造分组吞掉', () => {
  const config = options(); config.evidence[1]!.coverage = { status: 'unavailable', parts: [{ key: 'text', status: 'unavailable', reason: '合成缺口' }] };
  const workspace = new MemoryWorkspace(config);
  failureUnchanged(workspace, () => workspace.decideCoverage(0,
    { ref: ref('e2'), decision: 'no-effective-new-information', entryIds: [], rationale: '试图忽略缺口' },
    { ref: ref('e2'), decision: 'no-protectable-state', entryIds: [], rationale: '试图忽略缺口' }));
  assert.equal(workspace.check().coverageComplete, false);
  assert.throws(() => new MemoryWorkspace({ ...options(), supportGroups: [] }), MemoryWorkspaceError);
});
