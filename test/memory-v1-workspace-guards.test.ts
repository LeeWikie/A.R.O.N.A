import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';
import type { MemoryEntryInput, MemoryWorkspaceOptions } from '../src/memory/v1/workspace.js';
import type { MemoryCandidate, MemoryEntry } from '../src/memory/v1/contracts.js';
import { validateMemoryCandidate } from '../src/memory/v1/validate.js';
import { MemoryVersionFiles } from '../src/memory/v1/version-files.js';
import { createDefaultMemoryContextPolicy } from '../src/memory/v1/policy.js';

type Reviewed = Extract<MemoryEntry, { format: 'reviewed' }>;
const at = '2026-01-01T00:00:00.000Z', later = '2026-01-02T00:00:00.000Z';
const ref = (evidenceId = 'e1') => ({ evidenceId, partKey: 'text' });
function input(evidenceId = 'e1'): MemoryEntryInput {
  return {
    text: '合成展台采用紧凑列表。', nature: 'preference', certainty: 'reported', lifecycle: 'current',
    scope: { subjectId: 'subject', dimension: 'display', qualifier: '合成展台' }, validFrom: at, validTo: null,
    retention: { score: 2, rationale: '局部显示用途' },
    protectionAssessment: { decision: 'ineligible', evidence: [ref(evidenceId)], rationale: '普通呈现偏好' }, protection: { mode: 'none' },
    followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: ref(evidenceId), role: 'supports' }],
    primaryNodeId: 'root', relatedNodeIds: [], entityIds: ['subject'], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [],
  };
}
function state(evidenceId = 'e1', pending = false): MemoryEntryInput {
  return { ...input(evidenceId), text: `合成设备模式 ${evidenceId}`, nature: 'fact',
    protectionAssessment: { decision: pending ? 'pending-review' : 'eligible', evidence: [ref(evidenceId)], rationale: '持续设备模式' },
    protection: pending ? { mode: 'pending-review', reason: '资格待核对' } : { mode: 'state', stateKey: 'mode', value: evidenceId, establishedBy: [ref(evidenceId)], overrideRule: '同范围新模式' },
  };
}
function prior(value = input(), id = 'old'): Reviewed {
  return { ...value, format: 'reviewed', id, revision: 7, createdInBatch: 'previous', updatedInBatch: 'previous', evidence: value.evidence.map(row => ({ ...row, supportGroup: 'same-origin' })) };
}
function options(previousEntries: MemoryEntry[] = [prior()]): MemoryWorkspaceOptions {
  let next = 0;
  return {
    baseVersion: previousEntries.length ? 'v0' : null, batchId: 'batch', auditedAt: later, previousEntries,
    evidence: ['e1', 'e2'].map(id => ({
      schemaVersion: 1, id, kind: 'user-statement', actor: 'user',
      origin: { system: 'native', namespace: 'synthetic', sourceRef: 'source', contextRef: 'context', recordRef: id, lineageRoot: id, capture: 'native-snapshot' },
      occurredAt: at, receivedAt: at, visibleAfter: at, timeBasis: 'host-admission', contentRef: id, contentHash: 'a'.repeat(64), operationRef: null,
      derivedFrom: [], attachments: [], coverage: { status: 'complete', parts: [{ key: 'text', status: 'available', reason: null }] },
    })), observations: [],
    entities: [{ id: 'subject', kind: 'other', name: '合成展台', aliases: [], identityEvidence: [ref()] }],
    organizations: [{ id: 'root', title: '展台', parentId: null, entryIds: previousEntries.map(entry => entry.id) }],
    supportGroups: ['e1', 'e2'].map(id => ({ ref: ref(id), group: 'same-origin' })), clock: () => later, createId: kind => `${kind}-${++next}`,
  };
}
function unchanged(workspace: MemoryWorkspace, run: () => unknown) {
  const before = workspace.export(); assert.throws(run); assert.deepEqual(workspace.export(), before);
}
const invalidRevisions = [undefined, null, Number.NaN, 0, -1, 0.5, Infinity, '7', Number.MAX_SAFE_INTEGER + 1];
for (const operation of ['updateEntry', 'retireEntry', 'replaceState', 'resolveProtection'] as const) {
  test(`${operation} 运行时必须提供正整数条目修订，失败不安装候选或审计`, () => {
    for (const revision of invalidRevisions) {
      const initial = operation === 'replaceState' ? state() : operation === 'resolveProtection' ? state('e1', true) : input();
      const workspace = new MemoryWorkspace(options([prior(initial)]));
      const expectedRevision = revision as number;
      unchanged(workspace, () => {
        if (operation === 'updateEntry') return workspace.updateEntry(0, 'old', expectedRevision, { ...input(), text: '修改合成事项' }, '更新');
        if (operation === 'retireEntry') return workspace.retireEntry(0, 'old', expectedRevision, '淘汰');
        if (operation === 'replaceState') return workspace.replaceState(0, 'old', expectedRevision, { ...state('e2'), validFrom: later }, [ref('e2')], '覆盖');
        return workspace.resolveProtection(0, 'old', expectedRevision, input(), '收敛');
      });
    }
  });
}

test('草稿修订严格解析；拆并列表的条目修订不可省略或伪造', () => {
  const workspace = new MemoryWorkspace(options());
  for (const revision of [...invalidRevisions, 1]) if (revision !== 0) unchanged(workspace, () => workspace.createEntry(revision as number, { ...input(), text: '另一个合成事项' }, '新增'));
  for (const revision of invalidRevisions) unchanged(workspace, () => workspace.reorganizeEntries(0, [{ id: 'old', revision: revision as number }], [input()], '拆并'));
  workspace.updateEntry(0, 'old', 7, { ...input(), text: '第一次修改' }, '更新');
  workspace.updateEntry(1, 'old', 8, { ...input(), text: '第二次修改' }, '更新');
  assert.equal(workspace.export().candidate.entries[0]!.revision, 8);
  assert.equal(workspace.draftRevision, 2);
  unchanged(workspace, () => workspace.retireEntry(2, 'old', 7, '旧修订不能淘汰'));
  workspace.retireEntry(2, 'old', 8, '修改后淘汰仍只增加一个持久修订');
  assert.equal(workspace.export().candidate.entries[0]!.revision, 8);
});

for (const kind of ['back-reference', 'ended', 'retired', 'live-edge'] as const) test(`拆并拒绝无有效承接的替代输入 ${kind}`, () => {
  const workspace = new MemoryWorkspace(options());
  const replacement = { ...input(), text: '替代合成事项' };
  if (kind === 'back-reference') { replacement.lifecycle = 'superseded'; replacement.replacedBy = ['old']; }
  if (kind === 'ended') { replacement.lifecycle = 'superseded'; replacement.replacedBy = ['missing']; }
  if (kind === 'retired') replacement.placement = 'retired';
  if (kind === 'live-edge') replacement.replacedBy = ['old'];
  unchanged(workspace, () => workspace.reorganizeEntries(0, [{ id: 'old', revision: 7 }], [replacement], '拆并'));
});

function graph(): MemoryCandidate {
  const workspace = new MemoryWorkspace(options());
  workspace.reorganizeEntries(0, [{ id: 'old', revision: 7 }], [{ ...input(), text: '有效承接项' }], '归纳');
  workspace.decideCoverage(1, { ref: ref('e2'), decision: 'no-effective-new-information', entryIds: [], rationale: '无新增' }, { ref: ref('e2'), decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' });
  return structuredClone(workspace.export().candidate);
}
function reviewed(candidate: MemoryCandidate, index: number): Reviewed {
  const entry = candidate.entries[index]!; assert.equal(entry.format, 'reviewed'); return entry as Reviewed;
}
const graphMutations = ['self', 'cycle', 'long-cycle', 'cycle-with-terminal', 'missing', 'legacy', 'live-edge', 'previous-only', 'missing-branch', 'unjustified-retirement'] as const;
function invalidGraph(kind: typeof graphMutations[number]): MemoryCandidate {
  const value = graph(), first = reviewed(value, 0), next = reviewed(value, 1);
  if (kind === 'self') first.replacedBy = [first.id];
  if (kind === 'cycle' || kind === 'cycle-with-terminal') { next.lifecycle = 'superseded'; next.replacedBy = [first.id]; }
  if (kind === 'cycle-with-terminal') {
    const third = { ...structuredClone(next), id: 'third', lifecycle: 'current' as const, replacedBy: [] };
    first.replacedBy.push(third.id); value.entries.push(third); value.organizations[0]!.entryIds.push(third.id);
  }
  if (kind === 'unjustified-retirement') next.placement = 'retired';
  if (kind === 'long-cycle') {
    const third = { ...structuredClone(next), id: 'third', lifecycle: 'superseded' as const, replacedBy: [first.id] };
    next.lifecycle = 'superseded'; next.replacedBy = [third.id]; value.entries.push(third); value.organizations[0]!.entryIds.push(third.id);
  }
  if (kind === 'missing') first.replacedBy = ['missing'];
  if (kind === 'legacy') value.entries[1] = { id: next.id, revision: 1, text: '合成未审正文', format: 'legacy-unreviewed', placement: 'resident', legacyRef: 'old-block', contentHash: 'b'.repeat(64), primaryNodeId: 'root', relatedNodeIds: [], entityIds: [] };
  if (kind === 'live-edge') next.replacedBy = [first.id];
  if (kind === 'previous-only') { value.previousEntries.push({ ...structuredClone(next), id: 'archived-only' }); first.replacedBy = ['archived-only']; }
  if (kind === 'missing-branch') first.replacedBy.push('missing');
  return value;
}
for (const kind of graphMutations) test(`完整候选合同拒绝非法替代图 ${kind}`, () => {
  const candidate = invalidGraph(kind), before = structuredClone(candidate), result = validateMemoryCandidate(candidate);
  assert.equal(result.valid, false); assert.equal(result.coverageComplete, false); assert.deepEqual(candidate, before);
});

test('绕过 workspace 的完整循环 DTO 不能落盘，重签后的循环文件也不能读回', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-graph-contract-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const version = { id: 'v1', parentVersionId: 'v0', generation: 2 }, policy = createDefaultMemoryContextPolicy();
  const workspace = { baseVersion: 'v0', draftRevision: 0, audit: [], supportGroups: options().supportGroups, candidate: invalidGraph('cycle') };
  for (const kind of graphMutations) {
    const root = path.join(parent, kind), files = new MemoryVersionFiles(root);
    assert.throws(() => files.write({ workspace: { ...workspace, candidate: invalidGraph(kind) }, version, policy }), /memory_version_candidate_invalid/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
  const validRoot = path.join(parent, 'valid'), validFiles = new MemoryVersionFiles(validRoot);
  const baseline = graph(); validFiles.write({ workspace: { ...workspace, candidate: baseline }, version, policy });
  const manifestPath = path.join(validRoot, 'manifest.json'), envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const file = envelope.manifest.files.find((row: { path: string }) => row.path === 'metadata/state.json');
  const metadataPath = path.join(validRoot, file.path), metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.candidate.entries[1].lifecycle = 'superseded'; metadata.candidate.entries[1].replacedBy = ['old'];
  const text = JSON.stringify(metadata) + '\n'; fs.writeFileSync(metadataPath, text);
  file.sha256 = createHash('sha256').update(text).digest('hex');
  const manifest = JSON.stringify(envelope) + '\n'; fs.writeFileSync(manifestPath, manifest);
  assert.throws(() => validFiles.read({ manifestHash: createHash('sha256').update(manifest).digest('hex'), version }, baseline.previousEntries), /memory_version_candidate_invalid/);
});

test('拆分、合并、多代及跨组织替代保留真实终端，派生边不构成替代环且允许后续淘汰', () => {
  const workspace = new MemoryWorkspace(options());
  const node = workspace.createOrganization(0, { title: '另一个视角', parentId: null }, '新增组织');
  const split = workspace.reorganizeEntries(1, [{ id: 'old', revision: 7 }], [{ ...input(), text: '拆分甲', primaryNodeId: node.result.id }, { ...input(), text: '拆分乙', placement: 'detail' }], '拆分');
  const merged = workspace.reorganizeEntries(2, split.result.map(row => ({ id: row.id, revision: row.revision })), [{ ...input(), text: '合并后的承接', primaryNodeId: node.result.id }], '合并');
  assert.ok(merged.result[0]!.derivedFromEntryIds.includes(split.result[0]!.id));
  assert.equal(workspace.check().valid, true);
  workspace.retireEntry(3, merged.result[0]!.id, 1, '后续保留价值不足');
  assert.equal(workspace.check().valid, true);
  const candidate = structuredClone(workspace.export().candidate);
  candidate.previousEntries = structuredClone(candidate.entries);
  assert.equal(validateMemoryCandidate(candidate).valid, true);
});

test('同精确 scope 和 stateKey 的不同 current 保护值不能通过新增绕过覆盖', () => {
  const workspace = new MemoryWorkspace(options([prior(state())]));
  unchanged(workspace, () => workspace.createEntry(0, { ...state('e2'), validFrom: later }, '重叠当前值'));
});

test('精确状态维度门禁同样作用于直接构造的候选 DTO，不解析自然语言偏好', () => {
  const workspace = new MemoryWorkspace(options([prior(state())])), candidate = structuredClone(workspace.export().candidate);
  const next = prior({ ...state('e2'), validFrom: later }, 'next');
  candidate.entries.push(next); candidate.organizations[0]!.entryIds.push(next.id);
  candidate.protectionChecks[1] = { ref: ref('e2'), decision: 'mapped', entryIds: [next.id], rationale: '持续状态' };
  const result = validateMemoryCandidate(candidate); assert.equal(result.valid, false);
  assert.ok(result.issues.some(row => row.code === 'state-conflict'));
});

for (const kind of ['qualifier', 'dimension', 'subject', 'stateKey', 'non-overlap', 'same-value', 'preference'] as const) test(`精确门禁不把不同范围、分时值和普通多值偏好当作冲突 ${kind}`, () => {
  const first = state(), second = { ...state('e2'), validFrom: later };
  if (kind === 'qualifier') second.scope.qualifier = '另一设备';
  if (kind === 'dimension') second.scope.dimension = 'other';
  if (kind === 'subject') { second.scope.subjectId = 'another'; second.entityIds = ['another']; }
  if (kind === 'stateKey' && second.protection.mode === 'state') second.protection.stateKey = 'other';
  if (kind === 'non-overlap') first.validTo = later;
  if (kind === 'same-value' && second.protection.mode === 'state') second.protection.value = 'e1';
  if (kind === 'preference') { first.protection = { mode: 'none' }; first.protectionAssessment.decision = 'ineligible'; second.protection = { mode: 'none' }; second.protectionAssessment.decision = 'ineligible'; }
  const config = options([prior(first)]);
  if (kind === 'subject') config.entities.push({ ...config.entities[0]!, id: 'another' });
  const workspace = new MemoryWorkspace(config); workspace.createEntry(0, second, '不同维度或不重叠时段');
  assert.equal(workspace.check().valid, true);
});
