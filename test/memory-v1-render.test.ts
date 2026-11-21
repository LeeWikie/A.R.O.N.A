import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import test from 'node:test';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
import { resolveMemoryContextPolicy } from '../src/memory/v1/binding.js';
import { tokenMeasurementSchema, versionManifestSchema } from '../src/memory/v1/contracts.js';
import type { MemoryEntry, OrganizationNode } from '../src/memory/v1/contracts.js';
import { createDefaultMemoryContextPolicy } from '../src/memory/v1/policy.js';
import {
  assertMemoryResidentBudget,
  MemoryResidentBudgetExceededError,
  MemoryResidentStructureError,
  renderMemoryResidentDraft,
} from '../src/memory/v1/render.js';
import type { MemoryResidentRenderInput } from '../src/memory/v1/render.js';
import { measureMemoryText } from '../src/memory/v1/tokens.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const encoder = new Tiktoken(cl100kBase);
type Reviewed = Extract<MemoryEntry, { format: 'reviewed' }>;
type Legacy = Extract<MemoryEntry, { format: 'legacy-unreviewed' }>;
const ref = { evidenceId: 'source.synthetic', partKey: 'body' };

function reviewed(overrides: Partial<Reviewed> = {}): Reviewed {
  return {
    id: 'entry.a', revision: 1, text: '合成主体计划使用绿色标签。', primaryNodeId: 'node.a', relatedNodeIds: [], entityIds: ['subject.a'],
    format: 'reviewed', nature: 'intent', certainty: 'reported', lifecycle: 'current',
    scope: { subjectId: 'subject.a', dimension: 'label', qualifier: '仅限合成项目' }, validFrom: null, validTo: null,
    retention: { score: 3, rationale: 'metadata-retention-only' },
    protectionAssessment: { decision: 'ineligible', rationale: 'metadata-assessment-only', evidence: [ref] },
    protection: { mode: 'none' },
    followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] },
    evidence: [{ ref, role: 'supports', supportGroup: 'group.a' }], abstraction: 'episode', derivedFromEntryIds: [],
    placement: 'resident', detailRefs: ['detail.metadata-only'], replacedBy: [], createdInBatch: 'batch.a', updatedInBatch: 'batch.a',
    ...overrides,
  };
}

function legacy(text = '  合成旧文\r\n# 原始标题\n\t原文尾部  '): Legacy {
  return {
    id: 'entry.legacy', revision: 1, format: 'legacy-unreviewed', text, contentHash: sha256(text),
    primaryNodeId: 'node.a', relatedNodeIds: [], entityIds: [], placement: 'resident', legacyRef: 'legacy.synthetic',
  };
}

function protectedEntry(overrides: Partial<Reviewed> = {}): Reviewed {
  return reviewed({
    id: 'entry.protected',
    protectionAssessment: { decision: 'eligible', rationale: 'metadata-protection-only', evidence: [ref] },
    protection: { mode: 'state', stateKey: 'label-state', value: 'green', establishedBy: [ref], overrideRule: 'metadata-override-only' },
    ...overrides,
  });
}

function pending(overrides: Partial<Reviewed> = {}): Reviewed {
  return reviewed({
    id: 'entry.pending', text: '合成主体的标签约束尚未确定。', certainty: 'unknown', lifecycle: 'unresolved',
    protectionAssessment: { decision: 'pending-review', rationale: 'metadata-pending-assessment-only', evidence: [ref] },
    protection: { mode: 'pending-review', reason: 'metadata-pending-reason-only' },
    ...overrides,
  });
}

function input(entries: MemoryEntry[] = [reviewed()], organizations?: OrganizationNode[]): MemoryResidentRenderInput {
  return {
    version: { id: 'version.synthetic:1', parentVersionId: null, generation: 1 },
    entries,
    organizations: organizations ?? [{ id: 'node.a', title: '合成主题', parentId: null, entryIds: entries.map(entry => entry.id) }],
    policy: resolveMemoryContextPolicy(),
  };
}

function withBudget(value: MemoryResidentRenderInput, textTokens: number): MemoryResidentRenderInput {
  return { ...value, policy: { ...value.policy, resident: { ...value.policy.resident, textTokens } } };
}

function structureError(value: MemoryResidentRenderInput, code?: string) {
  assert.throws(() => renderMemoryResidentDraft(value), error => error instanceof MemoryResidentStructureError && (!code || error.code === code));
}

function occurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('章节和关联节点只有一个主要正文，空组织不制造独立章节', () => {
  const entries = [
    reviewed({ text: '唯一主要正文-A', relatedNodeIds: ['node.b'] }),
    reviewed({ id: 'entry.b', primaryNodeId: 'node.b', text: '唯一主要正文-B', relatedNodeIds: ['node.a'] }),
  ];
  const value = input(entries, [
    { id: 'node.root', title: '共同祖先', parentId: null, entryIds: [] },
    { id: 'node.a', title: '主题 A', parentId: 'node.root', entryIds: ['entry.a'] },
    { id: 'node.b', title: '主题 B', parentId: 'node.root', entryIds: ['entry.b'] },
    { id: 'node.empty', title: '不可见空主题', parentId: null, entryIds: [] },
  ]);
  const result = renderMemoryResidentDraft(value);
  assert.equal(occurrences(result.finalText, '唯一主要正文-A'), 1);
  assert.equal(occurrences(result.finalText, '唯一主要正文-B'), 1);
  assert.ok(result.finalText.includes('"共同祖先" / "主题 A"'));
  assert.ok(result.finalText.includes('"共同祖先" / "主题 B"'));
  assert.ok(!result.finalText.includes('不可见空主题'));
  assert.deepEqual(result.entryIds, ['entry.a', 'entry.b']);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0]?.entryIds, result.entryIds);
});

test('只按 placement 注入，不混入 detail、retired、来源定位和程序元数据', () => {
  const low = reviewed({ text: '低分常驻正文', retention: { score: 1, rationale: 'metadata-low-only' }, abstraction: 'episode' });
  const high = reviewed({ id: 'entry.high', text: '高分详细正文不可注入', placement: 'detail', retention: { score: 10, rationale: 'metadata-high-only' }, abstraction: 'profile' });
  const retired = reviewed({ id: 'entry.retired', text: '退役正文不可注入', placement: 'retired' });
  const result = renderMemoryResidentDraft(input([low, high, retired]));
  assert.ok(result.finalText.includes(low.text));
  for (const excluded of [high.text, retired.text, 'metadata-', ref.evidenceId, 'detail.metadata-only', 'batch.a', 'supportGroup', 'retention', 'protectionAssessment']) {
    assert.ok(!result.finalText.includes(excluded), excluded);
  }
  assert.deepEqual(result.entryIds, [low.id]);
  assert.deepEqual(result.metadata.entries.map(entry => entry.id), ['entry.a', 'entry.high', 'entry.retired']);
  assert.ok(result.metadata.entries.every(entry => !Object.hasOwn(entry, 'text')));
  const retained = result.metadata.entries.find(entry => entry.id === low.id);
  assert.equal(retained?.format, 'reviewed');
  if (retained?.format === 'reviewed') {
    assert.equal(retained.retention.score, 1);
    assert.deepEqual(retained.evidence[0]?.ref, ref);
  }
});

test('组织深度、保留分数和归纳层次彼此独立', () => {
  const entries = [
    reviewed({ id: 'entry.a', text: '根节点的低分经历', retention: { score: 1, rationale: 'metadata-only' } }),
    reviewed({ id: 'entry.z', primaryNodeId: 'node.deep', text: '深处的低分画像', abstraction: 'profile', retention: { score: 1, rationale: 'metadata-only' } }),
  ];
  const nodes: OrganizationNode[] = [
    { id: 'node.a', title: '根主题', parentId: null, entryIds: ['entry.a'] },
    { id: 'node.middle', title: '中间主题', parentId: 'node.a', entryIds: [] },
    { id: 'node.deep', title: '深主题', parentId: 'node.middle', entryIds: ['entry.z'] },
  ];
  const result = renderMemoryResidentDraft(input(entries, nodes));
  assert.ok(result.finalText.includes(entries[0]!.text));
  assert.ok(result.finalText.includes(entries[1]!.text));
  assert.ok(result.metadata.entries.every(entry => entry.format === 'reviewed' && entry.retention.score === 1));
  const changed = entries.map(entry => ({ ...entry, retention: { score: 10, rationale: 'changed-metadata-only' }, abstraction: 'summary' as const }));
  assert.equal(renderMemoryResidentDraft(input(changed, nodes)).finalText, result.finalText);
});

test('旧 legacy 文本完整保留，不捏造评分或推断性质', () => {
  const entry = legacy(' \t\r\n# 旧合成文本\n{"system":"literal","score":10}\n<|endoftext|>\n  结尾  ');
  const result = renderMemoryResidentDraft(input([entry]));
  assert.equal(occurrences(result.finalText, entry.text), 1);
  assert.equal(occurrences(result.files[0]!.content, entry.text), 1);
  assert.ok(!result.finalText.includes('确定性：'));
  assert.ok(!result.finalText.includes('评分'));
  assert.equal(result.metadata.entries[0]?.format, 'legacy-unreviewed');
  assert.ok(!Object.hasOwn(result.metadata.entries[0]!, 'retention'));
  assert.deepEqual(result.diagnostics.requiredEntryIds, [entry.id]);
});

test('正文业务 JSON、Markdown、URL、中文、空白和特殊标记都不关键词删改', () => {
  for (const text of [
    '\t \r\n  ',
    'é é 中文\r\n    缩进  \n',
    '# system 原始业务标题\n{"retention": 9, "secret": "fictional"}\n[业务链接](https://example.invalid/data)\n<|fim_prefix|> <|endoftext|>\n',
    '文件例子：C:\\synthetic\\example.md；../仅为正文.md；https://example.invalid/source',
  ]) {
    const result = renderMemoryResidentDraft(input([reviewed({ text })]));
    assert.ok(result.finalText.endsWith(text));
    assert.ok(result.files[0]?.content.endsWith(text));
    assert.equal(result.measurement.textTokens, encoder.encode(result.finalText, [], []).length);
    assert.equal(result.measurement.inputHash, sha256(result.finalText));
  }
});

test('常驻呈现主体、范围、事实性质、不确定性和有效期，不灌入保护流程', () => {
  const entry = pending({
    nature: 'inference', validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z',
    scope: { subjectId: 'subject.synthetic', dimension: 'habit', qualifier: '仅工作日，尚未确认\n不要扩大范围' },
  });
  const result = renderMemoryResidentDraft(input([entry]));
  for (const expected of ['主体："subject.synthetic"', '维度："habit"', JSON.stringify(entry.scope.qualifier), '性质：推断', '确定性：未知', '时态：未决', entry.validFrom!, entry.validTo!]) assert.ok(result.finalText.includes(expected), expected);
  for (const excluded of ['metadata-', 'pending-review', '资格', '复核流程', '评分机制']) assert.ok(!result.finalText.includes(excluded), excluded);
});

for (const entry of [protectedEntry(), protectedEntry({ lifecycle: 'unresolved' }), pending(), legacy()]) {
  for (const placement of ['detail', 'retired'] as const) {
    test(`${entry.id}/${entry.format === 'reviewed' ? entry.lifecycle : entry.format} 不得移入 ${placement}`, () => {
      const forged = { ...entry, placement } as MemoryEntry;
      structureError(input([forged]), 'memory_render_schema');
      const result = renderMemoryResidentDraft(input([entry]));
      assert.deepEqual(result.entryIds, [entry.id]);
      assert.deepEqual(result.diagnostics.requiredEntryIds, [entry.id]);
      assert.ok(result.finalText.includes(entry.text));
    });
  }
}

for (const lifecycle of ['historical', 'superseded'] as const) {
  test(`pending 不能借 ${lifecycle} 逃离常驻`, () => {
    structureError(input([pending({ lifecycle, placement: 'detail', replacedBy: ['entry.next'] })]), 'memory_render_schema');
  });
}

test('已被覆盖的保护状态可以留在 detail 或 retired，不强迫永久常驻', () => {
  for (const placement of ['detail', 'retired'] as const) {
    const old = protectedEntry({ lifecycle: 'superseded', placement, text: '旧状态仅供归档', replacedBy: ['entry.next'] });
    const next = protectedEntry({ id: 'entry.next', text: '当前合成标签为蓝色。' });
    const result = renderMemoryResidentDraft(input([old, next]));
    assert.deepEqual(result.entryIds, [next.id]);
    assert.deepEqual(result.diagnostics.requiredEntryIds, [next.id]);
    assert.ok(!result.finalText.includes(old.text));
    assert.ok(result.finalText.includes(next.text));
    assert.equal(result.metadata.entries.length, 2);
  }
});

test('危险标题不会成为文件路径；host ID 中的 Windows 保留名称和冒号也安全散列', () => {
  const title = '../CON:<bad>|?*\\目录\n## 假章节\r\u0000';
  const entry = reviewed({ id: 'CON', primaryNodeId: 'NUL:node' });
  const value = input([entry], [{ id: 'NUL:node', title, parentId: null, entryIds: [entry.id] }]);
  for (const id of ['CON', 'NUL:version', 'LPT1', 'version:with:colon']) {
    const result = renderMemoryResidentDraft({ ...value, version: { ...value.version, id } });
    const path = result.files[0]!.path;
    assert.match(path, /^resident\/[a-f0-9]{64}\.md$/);
    assert.equal(path, `resident/${sha256(id)}.md`);
    assert.equal(posix.isAbsolute(path), false);
    assert.equal(win32.isAbsolute(path), false);
    assert.ok(!path.includes('\\') && !path.includes(':') && !path.includes('..'));
    assert.ok(result.finalText.includes(JSON.stringify(title)));
    assert.equal(result.finalText.includes('\u0000'), false);
  }
});

for (const id of ['../escape', '/absolute', 'C:\\escape', 'bad/id', 'bad\\id', 'x\nheader', 'x\u0000', '', 'x'.repeat(161)]) {
  test(`未校验的危险身份直接拒绝 ${JSON.stringify(id)}`, () => {
    structureError(input([reviewed({ id })]), 'memory_render_schema');
    const base = input();
    structureError({ ...base, version: { ...base.version, id } }, 'memory_render_schema');
    structureError(input([reviewed({ primaryNodeId: id })], [{ id, parentId: null, title: '合成', entryIds: ['entry.a'] }]), 'memory_render_schema');
  });
}

test('空树和只有空组织的树得到空正文、零 token 和零 resident 文件', () => {
  for (const organizations of [[], [{ id: 'empty', title: '无用空结构', parentId: null, entryIds: [] }]]) {
    const result = assertMemoryResidentBudget(input([], organizations));
    assert.equal(result.finalText, '');
    assert.equal(result.sha256, sha256(''));
    assert.equal(result.measurement.textTokens, 0);
    assert.equal(result.diagnostics.requiredSubsetMeasurement.textTokens, 0);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.entryIds, []);
  }
});

test('重复 entry ID 或 node ID 拒绝，不会 Map 覆盖丢失正文', () => {
  structureError(input([reviewed(), reviewed({ text: '第二份不可覆盖' })], [{ id: 'node.a', title: '合成主题', parentId: null, entryIds: ['entry.a'] }]), 'memory_render_duplicate_entry');
  const base = input();
  structureError({ ...base, organizations: [...base.organizations, { ...base.organizations[0]!, entryIds: [] }] }, 'memory_render_duplicate_node');
});

test('主正文重复、缺失、错挂和悬空全部拒绝', () => {
  const base = input();
  structureError({ ...base, organizations: [{ ...base.organizations[0]!, entryIds: ['entry.a', 'entry.a'] }] }, 'memory_render_schema');
  structureError({ ...base, organizations: [{ ...base.organizations[0]!, entryIds: [] }] }, 'memory_render_missing_body');
  structureError({ ...base, organizations: [...base.organizations, { id: 'node.other', title: '其他', parentId: null, entryIds: ['entry.a'] }] }, 'memory_render_duplicate_body');
  structureError(input([reviewed()], [{ id: 'node.other', title: '错挂', parentId: null, entryIds: ['entry.a'] }]), 'memory_render_wrong_primary_node');
  structureError({ ...base, organizations: [{ ...base.organizations[0]!, entryIds: ['missing'] }] }, 'memory_render_dangling_entry');
  structureError({ ...base, entries: [reviewed({ primaryNodeId: 'missing' })], organizations: [] }, 'memory_render_dangling_node');
  structureError({ ...base, entries: [reviewed({ relatedNodeIds: ['missing'] })] }, 'memory_render_dangling_node');
  structureError({ ...base, entries: [reviewed({ relatedNodeIds: ['node.a'] })] }, 'memory_render_schema');
});

test('组织环与悬空父引用在空树、非空树上都拒绝', () => {
  for (const entries of [[], [reviewed()]]) {
    const ids = entries.map(entry => entry.id);
    structureError(input(entries, [{ id: 'node.a', title: '自环', parentId: 'node.a', entryIds: ids }]), 'memory_render_organization_cycle');
    structureError(input(entries, [
      { id: 'node.a', title: '环 A', parentId: 'node.b', entryIds: ids },
      { id: 'node.b', title: '环 B', parentId: 'node.a', entryIds: [] },
    ]), 'memory_render_organization_cycle');
    structureError(input(entries, [{ id: 'node.a', title: '悬空', parentId: 'missing', entryIds: ids }]), 'memory_render_dangling_parent');
  }
});

test('detail 或 retired 也必须具有合法组织与唯一主位置', () => {
  for (const placement of ['detail', 'retired'] as const) {
    structureError(input([reviewed({ placement, relatedNodeIds: ['missing'] })]), 'memory_render_dangling_node');
    structureError(input([reviewed({ placement })], [{ id: 'node.a', title: '空', parentId: null, entryIds: [] }]), 'memory_render_missing_body');
  }
});

test('排序及哈希稳定，不因数组顺序或标题改名产生新信息身份', () => {
  const entries = [reviewed({ id: 'entry.z' }), reviewed({ id: 'entry.a', primaryNodeId: 'node.b', relatedNodeIds: ['node.a', 'node.c'] })];
  const nodes: OrganizationNode[] = [
    { id: 'node.a', title: '主题 Z', parentId: null, entryIds: ['entry.z'] },
    { id: 'node.b', title: '主题 A', parentId: 'node.a', entryIds: ['entry.a'] },
    { id: 'node.c', title: '空主题', parentId: null, entryIds: [] },
  ];
  const first = renderMemoryResidentDraft(input(entries, nodes));
  const reordered = renderMemoryResidentDraft(input([...entries].reverse().map(entry => ({ ...entry, relatedNodeIds: [...entry.relatedNodeIds].reverse() })), [...nodes].reverse()));
  assert.deepEqual(first, reordered);
  const renamed = renderMemoryResidentDraft(input(entries, nodes.map(node => ({ ...node, title: `改名 ${node.title}`, parentId: null }))));
  assert.deepEqual(renamed.entryIds, first.entryIds);
  assert.equal(renamed.files[0]?.path, first.files[0]?.path);
  assert.notEqual(renamed.sha256, first.sha256);
  assert.deepEqual(renamed.metadata.entries.map(entry => entry.id), first.metadata.entries.map(entry => entry.id));
});

test('render 与预算检查均不突变输入，返回独立深冻结快照', () => {
  const value = input([reviewed(), protectedEntry(), pending(), legacy()]);
  const before = structuredClone(value);
  deepFreeze(value);
  const result = assertMemoryResidentBudget(value);
  assert.deepEqual(value, before);
  assert.deepEqual(renderMemoryResidentDraft(value), result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.files), true);
  assert.equal(Object.isFrozen(result.metadata.entries[0]), true);
  assert.equal(Object.isFrozen(result.metadata.organizations[0]?.entryIds), true);
  assert.throws(() => (result.files as unknown as unknown[]).push({}), TypeError);
  assert.throws(() => Object.assign(result.measurement, { textTokens: 0 }), TypeError);
  const mutable = input();
  const snapshot = renderMemoryResidentDraft(mutable);
  mutable.entries[0]!.text = '后来变化';
  mutable.organizations[0]!.title = '后来改名';
  assert.ok(!snapshot.finalText.includes('后来'));
});

test('最终封装现场计量且符合严格 TokenMeasurement 与 manifest 文件合同', () => {
  const value = { ...input([reviewed({ text: '合成正文' }), legacy('旧条目原文')]), modelId: 'synthetic-provider' };
  const result = assertMemoryResidentBudget(value);
  assert.deepEqual(result.measurement, measureMemoryText(result.finalText, { modelId: value.modelId }));
  assert.deepEqual(tokenMeasurementSchema.parse(result.measurement), result.measurement);
  assert.equal(result.measurement.textTokens, encoder.encode(result.finalText, [], []).length);
  assert.equal(result.measurement.inputHash, result.sha256);
  assert.equal(result.sha256, sha256(result.finalText));
  assert.equal(result.measurement.basis, 'encoding');
  assert.equal(result.measurement.scope, 'final-injection');
  assert.equal(result.measurement.exactForEncoding, true);
  assert.equal(result.measurement.exactForProvider, false);
  assert.equal(result.measurement.mediaCostKnown, false);
  assert.equal(result.measurement.mediaTokens, null);
  assert.equal(result.measurement.modelId, value.modelId);
  assert.ok(result.finalText.includes(value.version.id));
  assert.ok(result.finalText.includes(`代次：${value.version.generation}`));
  for (const file of result.files) {
    assert.equal(file.sha256, sha256(file.content));
    assert.equal(occurrences(result.finalText, file.content), 1);
    assert.ok(result.finalText.includes(file.path));
  }
  const manifest = versionManifestSchema.parse({
    schemaVersion: 1, ...value.version, auditedAt: '2026-11-01T00:00:00Z', policyRevision: result.metadata.policy.revision,
    residentInjection: 'all', files: result.files.map(({ content: _content, ...file }) => file), measurement: result.measurement,
  });
  assert.equal(manifest.measurement.inputHash, result.sha256);
  const fileSum = result.files.reduce((sum, file) => sum + measureMemoryText(file.content).textTokens, 0);
  const entrySum = value.entries.reduce((sum, entry) => sum + measureMemoryText(entry.text).textTokens, 0);
  assert.ok(result.measurement.textTokens! > fileSum);
  assert.ok(result.measurement.textTokens! > entrySum);
  const changedVersion = assertMemoryResidentBudget({ ...value, version: { id: 'version.synthetic:2', parentVersionId: value.version.id, generation: 2 } });
  assert.notEqual(changedVersion.sha256, result.sha256);
  assert.ok(changedVersion.finalText.includes(`父版本：${JSON.stringify(value.version.id)}`));
  assert.deepEqual(changedVersion.measurement, measureMemoryText(changedVersion.finalText, { modelId: value.modelId }));
});

test('实际绑定 pending 策略并拒绝伪造 ready 精度或词表身份', () => {
  const base = input();
  const pendingPolicy = createDefaultMemoryContextPolicy();
  const result = renderMemoryResidentDraft({ ...base, policy: pendingPolicy });
  assert.equal(pendingPolicy.tokenizer.readiness, 'pending-dependency');
  assert.equal(result.metadata.policy.tokenizer.readiness, 'ready');
  assert.equal(result.metadata.policy.tokenizer.vocabularyHash, result.measurement.vocabularyHash);
  assert.equal(result.metadata.policy.tokenizer.version, result.measurement.tokenizerVersion);
  const prepared = resolveMemoryContextPolicy();
  assert.throws(() => renderMemoryResidentDraft({ ...base, policy: { ...prepared, tokenizer: { ...prepared.tokenizer, vocabularyHash: 'f'.repeat(64) } } }), /memory_tokenizer_identity_mismatch/);
  assert.throws(() => renderMemoryResidentDraft({ ...base, policy: { ...prepared, tokenizer: { ...prepared.tokenizer, version: 'wrong-version' } } }), /memory_tokenizer_identity_mismatch/);
  structureError({ ...base, policy: { ...prepared, tokenizer: { ...prepared.tokenizer, exactForProvider: true } } } as unknown as MemoryResidentRenderInput, 'memory_render_schema');
});

test('最终串精确边界通过，低一 token 失败，不使用正文 token 求和', () => {
  const value = input([reviewed({ text: '短正文' })]);
  const result = renderMemoryResidentDraft(value);
  const tokens = result.measurement.textTokens;
  assert.equal(assertMemoryResidentBudget(withBudget(value, tokens)).measurement.textTokens, tokens);
  assert.throws(() => assertMemoryResidentBudget(withBudget(value, tokens - 1)), error => {
    assert.ok(error instanceof MemoryResidentBudgetExceededError);
    assert.equal(error.code, 'memory_resident_budget_exceeded');
    assert.equal(error.draft.diagnostics.excessTextTokens, 1);
    assert.equal(error.draft.finalText, result.finalText);
    return true;
  });
  const bodyTokens = measureMemoryText(value.entries[0]!.text).textTokens;
  assert.throws(() => assertMemoryResidentBudget(withBudget(value, bodyTokens)), MemoryResidentBudgetExceededError);
});

test('超预算保留全部正文和保护，草稿只诊断，不截断、改写或自动淘汰低分条目', () => {
  const entries = [
    reviewed({ text: '低分合成正文-'.repeat(70), retention: { score: 1, rationale: 'metadata-only' } }),
    protectedEntry({ text: '当前保护原表达-'.repeat(30) }),
    pending(),
    legacy('未审旧原文\n'.repeat(25)),
  ];
  const value = withBudget(input(entries), 1);
  const before = structuredClone(value);
  const draft = renderMemoryResidentDraft(value);
  assert.ok(draft.diagnostics.excessTextTokens > 0);
  assert.ok(draft.diagnostics.requiredSubsetMeasurement.textTokens > draft.diagnostics.budget);
  assert.deepEqual(draft.entryIds, entries.map(entry => entry.id).sort());
  assert.deepEqual(draft.diagnostics.requiredEntryIds, ['entry.legacy', 'entry.pending', 'entry.protected']);
  for (const entry of entries) assert.equal(occurrences(draft.finalText, entry.text), 1);
  const requiredOnly = renderMemoryResidentDraft(input(entries.filter(entry => entry.id !== 'entry.a')));
  assert.deepEqual(draft.diagnostics.requiredSubsetMeasurement, requiredOnly.measurement);
  assert.equal(draft.diagnostics.requiredSubsetMeasurement.inputHash, sha256(requiredOnly.finalText));
  assert.throws(() => assertMemoryResidentBudget(value), error => {
    assert.ok(error instanceof MemoryResidentBudgetExceededError);
    assert.deepEqual(error.draft, draft);
    return true;
  });
  assert.deepEqual(value, before);
});

test('只有普通条目超限时不把空保护子集诊断宣称为可发布', () => {
  const value = withBudget(input([reviewed({ text: '普通正文'.repeat(200) })]), 1);
  const result = renderMemoryResidentDraft(value);
  assert.deepEqual(result.diagnostics.requiredEntryIds, []);
  assert.equal(result.diagnostics.requiredSubsetMeasurement.textTokens, 0);
  assert.throws(() => assertMemoryResidentBudget(value), MemoryResidentBudgetExceededError);
});

test('渲染器只做局部结构检查，不把缺失原始证据的合成资料冒充完整候选验证', () => {
  const value = input([reviewed({ evidence: [{ ref: { evidenceId: 'not-loaded-by-renderer', partKey: 'body' }, role: 'supports', supportGroup: 'group.synthetic' }] })]);
  const result = assertMemoryResidentBudget(value);
  assert.ok(result.finalText.includes(value.entries[0]!.text));
  assert.equal(Object.hasOwn(result, 'validated'), false);
  assert.equal(Object.hasOwn(result, 'published'), false);
  assert.equal(Object.hasOwn(result, 'coverageComplete'), false);
});


test('非法预算、版本和未知正文输入字段不能绕过严格合同', () => {
  const base = input();
  for (const budget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    structureError(withBudget(base, budget), 'memory_render_schema');
  }
  for (const generation of [0, -1, 1.5]) {
    structureError({ ...base, version: { ...base.version, generation } }, 'memory_render_schema');
  }
  structureError({ ...base, rawText: '未获准的额外原文' } as unknown as MemoryResidentRenderInput, 'memory_render_schema');
  structureError({ ...base, modelId: '' }, 'memory_render_schema');
});
