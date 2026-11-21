import test from 'node:test';
import { currentMemoryView, scopedReview, workingSetReader } from './memory-v1-synthetic-model.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { ProjectMemory } from '../src/memory/index.js';
import type { ContextSnapshot, MemoryV1OrganizeOptions } from '../src/memory/index.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import type { NativeSourceEntry, PreparedMemorySource } from '../src/memory/v1/source.js';
import { createDefaultMemoryContextPolicy } from '../src/memory/v1/policy.js';
import { MemoryEvidenceLedger } from '../src/memory/v1/ledger.js';
import { memoryReviewCategories, parseMemorySemanticReview } from '../src/memory/v1/review.js';
import { measureMemoryText } from '../src/memory/v1/tokens.js';
import { removeTemp } from './helpers.js';
import type { MemoryCandidate, MemoryEntry } from '../src/memory/v1/contracts.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';

const at = '2026-01-01T00:00:00.000Z';
type View = { draftRevision: number; candidate: MemoryCandidate };
type Action = { name: string; input: Record<string, unknown> };
type Step = (view: View) => Action;
const viewFrom = currentMemoryView;
const legacyPass = () => ({ pass: true, checks: Object.fromEntries(memoryReviewCategories.map(category => [category, true])), issues: [] });
const pass = scopedReview;
function modelFor(steps: Step[] = [], review: (request: unknown, call: number) => unknown = prompt => pass(prompt)) {
  let index = 0, inspect = true, calls = 0, reviewCalls = 0, readyCalls = 0;
  const readOld = workingSetReader();
  const requests: unknown[] = [];
  return { requests, get reviewCalls() { return reviewCalls; }, get readyCalls() { return readyCalls; }, model: new MastraLanguageModelV2Mock({ doGenerate: async request => {
    calls++; requests.push(request);
    if (!request.tools?.some(tool => tool.name === 'memory_ready')) {
      const result = await review(request.prompt, ++reviewCalls);
      return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }], finishReason: 'stop' as const, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, warnings: [] };
    }
    let action: Action;
    const reading = readOld(request.prompt);
    if (reading) action = reading;
    else if (index < steps.length) {
      if (inspect) { action = { name: 'memory_inspect', input: {} }; inspect = false; }
      else { action = steps[index++]!(viewFrom(request.prompt)); inspect = false; }
    } else action = { name: 'memory_ready', input: { expectedDraftRevision: viewFrom(request.prompt).draftRevision } };
    // ready 后让这一轮正常终止，下一次独立修正调用可继续使用同一模型。
    const last = request.prompt.at(-1);
    if (last?.role === 'tool' && JSON.stringify(last).includes('"ready":true')) return { content: [{ type: 'text' as const, text: '本批维护结束。' }], finishReason: 'stop' as const, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, warnings: [] };
    if (action.name === 'memory_ready') readyCalls++;
    return { content: [{ type: 'tool-call' as const, toolName: action.name, toolCallId: `call-${calls}`, input: JSON.stringify(action.input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, warnings: [] };
  } }) };
}
function fixture(persistent = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-v1-organize-'));
  const db = new DatabaseSync(persistent ? path.join(directory, 'runtime.sqlite') : ':memory:'), store = new RuntimeStore(db), memory = new ProjectMemory(store, directory);
  const policy = createDefaultMemoryContextPolicy();
  function source(runId: string, sequence: number, text = '用户计划学习合成主题。', actor: 'user' | 'assistant' = 'user') {
    const snapshot: ContextSnapshot = { contextId: 'context', runId, sequence, modelProfile: 'default', createdAt: at, prompt: [{ role: 'user', content: [{ type: 'text', text }] }], nativeMessages: [], providerOptions: {} };
    memory.archive(snapshot); const job = memory.newJob(runId); memory.bind(job.id, `native:${job.id}`);
    const entry: NativeSourceEntry = {
      business: actor === 'user' ? { kind: 'user-statement', origin: 'signal', content: text, provenance: { contextId: 'context', runId, signalId: runId } } : { kind: 'assistant-statement', content: text, provenance: { contextId: 'context', runId } },
      location: { contextId: 'context', runId, recordId: `record:${runId}`, receivedAt: at, visibleAfter: at },
      ...(actor === 'user' ? { original: { text, attachments: [] } } : {}),
    };
    return { job, snapshot, prepared: prepareNativeMemorySource({ namespace: 'test', source: snapshot, entries: [entry], events: [], gaps: [] }) };
  }
  function options(input: ReturnType<typeof source>, model: ReturnType<typeof modelFor>['model'], extra: Partial<MemoryV1OrganizeOptions> = {}): MemoryV1OrganizeOptions {
    return { expectedHead: memory.version().id, preparedSource: input.prepared, policy, cutoff: '2026-02-01T00:00:00.000Z', scopeId: 'native:test', resolveModel: () => model, ...extra };
  }
  return { db, store, memory, directory, source, options, policy, async close() { db.close(); await removeTemp(directory); } };
}
const mutate = (name: string, input: (v: View) => Record<string, unknown>): Step => v => ({ name, input: { expectedDraftRevision: v.draftRevision, ...(name === 'memory_coverage' ? {} : { rationale: '合成资料维护' }), ...input(v) } });
const refs = (v: View) => ({ evidenceId: v.candidate.evidence.at(-1)!.id, partKey: 'body' });
const organization: Step = mutate('memory_organization_create', () => ({ organization: { title: '共同主题', parentId: null } }));
const entity: Step = mutate('memory_entity_create', v => ({ entity: { name: '合成用户', kind: 'person', aliases: [], identityEvidence: [refs(v)] } }));
function entry(v: View, overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  const subjectId = v.candidate.entities[0]!.id;
  return {
    text: '用户计划学习合成主题，尚未完成。', primaryNodeId: v.candidate.organizations.at(-1)!.id, relatedNodeIds: [], entityIds: [subjectId],
    nature: 'intent', certainty: 'reported', lifecycle: 'current', scope: { subjectId, dimension: 'learning', qualifier: '合成主题' }, validFrom: null, validTo: null,
    retention: { score: 7, rationale: '明确的学习意图' }, protectionAssessment: { decision: 'ineligible', rationale: '合成普通意图', evidence: [refs(v)] }, protection: { mode: 'none' },
    followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: refs(v), role: 'supports' }], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [], ...overrides,
  };
}
function inputEntry(old: MemoryEntry): MemoryEntryInput {
  assert.equal(old.format, 'reviewed'); if (old.format !== 'reviewed') throw new Error('not reviewed');
  const { id: _id, revision: _revision, format: _format, createdInBatch: _created, updatedInBatch: _updated, evidence, ...rest } = old;
  return { ...rest, evidence: evidence.map(({ ref, role }) => ({ ref, role })) };
}
const createEntry: Step = mutate('memory_entry_create', v => ({ entry: entry(v) }));
const coverage: Step = mutate('memory_coverage', v => ({ coverage: { ref: refs(v), decision: 'retained', entryIds: [v.candidate.entries.at(-1)!.id], rationale: '已归纳意图' }, protection: { ref: refs(v), decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' } }));
const noopCoverage: Step = mutate('memory_coverage', v => ({ coverage: { ref: refs(v), decision: 'no-effective-new-information', entryIds: [], rationale: '无有效新增' }, protection: { ref: refs(v), decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' } }));
const noopFor = (evidenceId: string): Step => mutate('memory_coverage', () => ({ coverage: { ref: { evidenceId, partKey: 'body' }, decision: 'no-effective-new-information', entryIds: [], rationale: '重整核对后无有效新增' }, protection: { ref: { evidenceId, partKey: 'body' }, decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' } }));
function includeSource(target: PreparedMemorySource, prior: PreparedMemorySource) {
  target.records.push(...prior.records.filter(row => !target.records.some(old => old.id === row.id)));
  for (const [key, value] of prior.contents) target.contents.set(key, value);
  for (const [key, value] of prior.canonicalRefs) target.canonicalRefs.set(key, value);
  for (const [key, value] of prior.attachmentRefs) target.attachmentRefs.set(key, value);
  target.observations.push(...prior.observations.filter(row => !target.observations.some(old => old.id === row.id)));
}

test('V1 真实 Agent 工具创建更新、关联和详情，按最终串计量并可信读回', async () => {
  const f = fixture();
  try {
    const s = f.source('first', 1);
    const model = modelFor([organization, entity,
      mutate('memory_entity_create', v => ({ entity: { name: '学习主题', kind: 'topic', aliases: [], identityEvidence: [refs(v)] } })),
      mutate('memory_entry_create', v => ({ entry: entry(v, { entityIds: v.candidate.entities.map(row => row.id) }) })),
      mutate('memory_entry_update', v => { const old = v.candidate.entries[0]!; return { entryId: old.id, expectedEntryRevision: old.revision, entry: { ...inputEntry(old), text: '用户计划学习合成主题，需保留练习步骤；尚未执行。', retention: { score: 8, rationale: '近期明确计划' } } }; }),
      mutate('memory_relation', v => ({ relationId: null, expectedEntryRevision: v.candidate.entries[0]!.revision, relation: { subjectId: v.candidate.entities[0]!.id, objectId: v.candidate.entities[1]!.id, kind: '学习', entryId: v.candidate.entries[0]!.id, validFrom: null, validTo: null } })),
      mutate('memory_detail_put', v => ({ entryId: v.candidate.entries[0]!.id, expectedEntryRevision: v.candidate.entries[0]!.revision, detailId: null, content: '合成详细练习档案，不应注入常驻。' })), coverage,
    ]);
    const result = await f.memory.organizeV1(s.job.id, f.options(s, model.model));
    assert.equal(result.complete, true); assert.equal(result.changed, true); assert.equal(model.reviewCalls, 1);
    const read = f.memory.readV1Version(result.version);
    assert.equal(read.workspace.candidate.entries[0]!.revision, 1, '同批多轮修改不增加持久修订');
    assert.equal(read.workspace.candidate.relations.length, 1);
    assert.equal(read.details[0]!.content, '合成详细练习档案，不应注入常驻。');
    assert.equal(f.memory.resident().text, read.finalText);
    assert.equal(read.manifest.measurement.textTokens, measureMemoryText(read.finalText).textTokens);
    assert.ok(!read.finalText.includes('合成详细练习档案'));
    const publicJob = f.memory.status().jobs[0]!;
    assert.deepEqual(Object.keys(publicJob).sort(), ['contextId', 'createdAt', 'error', 'id', 'runId', 'status']);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, 1);
    assert.equal(new MemoryEvidenceLedger(f.db).listPending('native:test', '2026-02-01T00:00:00Z').length, 0);
  } finally { await f.close(); }
});

test('V1 新批 no-op 仍独立复核并记录覆盖；评分改变必须发布新版本和差异', async () => {
  const f = fixture();
  try {
    const a = f.source('a', 1), first = modelFor([organization, entity, createEntry, coverage]);
    const old = await f.memory.organizeV1(a.job.id, f.options(a, first.model));
    const b = f.source('b', 2, '你好。'), second = modelFor([noopCoverage]);
    const noop = await f.memory.organizeV1(b.job.id, f.options(b, second.model));
    assert.equal(noop.version, old.version); assert.equal(noop.changed, false); assert.equal(second.reviewCalls, 1);
    assert.equal(f.memory.v1Versions().length, 1);
    const c = f.source('c', 3, '现在比较关注该主题。');
    const scoring = modelFor([
      mutate('memory_entry_update', v => { const old = v.candidate.entries[0]!; return { entryId: old.id, expectedEntryRevision: old.revision, entry: { ...inputEntry(old), retention: { score: 9, rationale: '关注提高' } } }; }), noopCoverage,
    ]);
    const changed = await f.memory.organizeV1(c.job.id, f.options(c, scoring.model));
    assert.equal(changed.changed, true);
    assert.equal(f.memory.readV1Version(changed.version).workspace.candidate.entries[0]!.revision, 2);
    assert.ok(f.memory.diffV1Versions(old.version, changed.version).changes.some(row => row.collection === 'entries'));
    const plan = f.memory.planV1Recovery(old.version, changed.version, '2026-02-01T00:00:00.000Z');
    assert.ok(plan.requiredEvidenceIds.length > 0);
    assert.ok(plan.requiredEvidenceIds.includes(b.prepared.records[0]!.id), '恢复计划包含没有写入当前版本的 no-op 来源');
    const d = f.source('d', 4, '重新核对资料。'); includeSource(d.prepared, b.prepared);
    const recover = modelFor([noopFor(d.prepared.records[0]!.id), noopFor(b.prepared.records[0]!.id)]);
    const recovered = await f.memory.organizeV1(d.job.id, f.options(d, recover.model), plan);
    assert.equal(recovered.generation, 3); assert.equal(recovered.changed, true);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, 4);
    assert.throws(() => f.memory.planV1Recovery(old.version, changed.version, plan.cutoff), /memory_version_conflict/);
  } finally { await f.close(); }
});

test('V1 复核拒绝把建议写成完成；无工具独立调用并保留旧 head', async () => {
  const f = fixture();
  try {
    f.policy.organization.maxCapacityCorrections = 1;
    const s = f.source('suggestion', 1, '建议尝试合成步骤。', 'assistant');
    const model = modelFor([organization, entity, mutate('memory_entry_create', v => ({ entry: entry(v, { text: '用户已经完成了合成步骤。', nature: 'action' }) })), coverage], (prompt) => ({ ...pass(prompt), verdict: 'reject', issues: [{ severity: 'high', category: 'subject-and-nature', entryIds: [], evidenceIds: [], message: '助手建议不能冒充用户完成。' }] }));
    await assert.rejects(f.memory.organizeV1(s.job.id, f.options(s, model.model)), /memory_semantic_review_rejected/);
    assert.equal(model.reviewCalls, 1); assert.equal(model.readyCalls, 2); assert.equal(f.memory.version().id, 'initial');
    assert.equal(f.memory.v1Versions().length, 0);
    assert.ok(new MemoryEvidenceLedger(f.db).listPending('native:test', '2026-02-01T00:00:00Z').length > 0);
    const reviews = model.requests.filter(request => !(request as { tools?: { name: string }[] }).tools?.some(tool => tool.name === 'memory_ready'));
    assert.ok(reviews.every(request => !(request as { tools?: unknown[] }).tools?.length));
  } finally { await f.close(); }
});

test('V1 复核失败允许有界修正，同条持久修订只增加一次', async () => {
  const f = fixture();
  try {
    const s = f.source('correct', 1);
    const actions = [organization, entity, createEntry, coverage];
    const model = modelFor(actions, (prompt, call) => {
      if (call !== 1) return pass(prompt);
      actions.push(mutate('memory_entry_update', v => { const old = v.candidate.entries[0]!; return { entryId: old.id, expectedEntryRevision: old.revision,
        entry: { ...inputEntry(old), text: '用户计划学习合成主题；仍是意图，尚未开始或完成。' } }; }));
      return { ...pass(prompt), verdict: 'reject', issues: [{ severity: 'high', category: 'intent-details', entryIds: [], evidenceIds: [], message: '重新核对意图细节。' }] };
    });
    const result = await f.memory.organizeV1(s.job.id, f.options(s, model.model));
    assert.equal(result.corrections, 1); assert.equal(model.reviewCalls, 2);
    assert.equal(f.memory.readV1Version(result.version).workspace.candidate.entries[0]!.revision, 1);
    assert.ok(f.memory.resident().text.includes('尚未开始或完成'));
  } finally { await f.close(); }
});

test('V1 相同失败提案只给一次 writer 修正机会，不能重复 ready 重抽复核', async () => {
  const f = fixture();
  try {
    const s = f.source('same-rejected-proposal', 1);
    const model = modelFor([organization, entity, createEntry, coverage], (prompt, call) => call === 1
      ? { ...pass(prompt), verdict: 'reject', issues: [{ severity: 'high', category: 'intent-details', entryIds: [], evidenceIds: [], message: '意图细节需要实际修正。' }] }
      : pass(prompt));
    await assert.rejects(f.memory.organizeV1(s.job.id, f.options(s, model.model)), /memory_semantic_review_rejected/);
    assert.equal(model.reviewCalls, 1, '未修改失败提案不能再次抽取独立 judge');
    assert.equal(model.readyCalls, 2, '先给 writer 一次实际修正机会，再拒绝其原样 ready');
    assert.equal(f.memory.version().id, 'initial'); assert.equal(f.memory.v1Versions().length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_processing').get()!.n, 0);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
    assert.equal(new MemoryEvidenceLedger(f.db).listPending('native:test', '2026-02-01T00:00:00Z').length, 1);
  } finally { await f.close(); }
});

test('V1 返回更早失败的 A 提案不能通过 A→B→A 重抽复核', async () => {
  const f = fixture();
  try {
    const s = f.source('rejected-proposal-aba', 1);
    const actions = [organization, entity, createEntry, coverage];
    const model = modelFor(actions, (prompt, call) => {
      if (call <= 2) actions.push(mutate('memory_entry_update', v => { const old = v.candidate.entries[0]!; return { entryId: old.id, expectedEntryRevision: old.revision,
        entry: { ...inputEntry(old), text: call === 1 ? '用户计划学习合成主题，尚未开始或完成。' : '用户计划学习合成主题，尚未完成。' } }; }));
      return call <= 2 ? { ...pass(prompt), verdict: 'reject', issues: [{ severity: 'high', category: 'intent-details', entryIds: [], evidenceIds: [], message: '合成意图仍需修正。' }] } : pass(prompt);
    });
    await assert.rejects(f.memory.organizeV1(s.job.id, f.options(s, model.model)), /memory_semantic_review_rejected/);
    assert.equal(model.reviewCalls, 2, 'A 和实际改变的 B 各复核一次，返回 A 不再抽取');
    assert.equal(model.readyCalls, 3);
    assert.equal(f.memory.version().id, 'initial'); assert.equal(f.memory.v1Versions().length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_processing').get()!.n, 0);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
  } finally { await f.close(); }
});

test('V1 重复未覆盖提案保留 coverage 错误且不重复独立复核', async () => {
  const f = fixture();
  try {
    const s = f.source('same-uncovered-proposal', 1), model = modelFor();
    await assert.rejects(f.memory.organizeV1(s.job.id, f.options(s, model.model)), /memory_coverage_incomplete/);
    assert.equal(model.reviewCalls, 1); assert.equal(model.readyCalls, 2);
    assert.equal(f.memory.version().id, 'initial'); assert.equal(f.memory.v1Versions().length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_processing').get()!.n, 0);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
  } finally { await f.close(); }
});

test('V1 未审旧 Markdown 原样承接，容量冲突不截断、不切 current', async () => {
  const f = fixture();
  try {
    const initial = f.memory.version(); fs.writeFileSync(path.join(initial.filesDirectory, 'old.md'), '# 旧资料\n\n未经核对的合成认识。\n');
    const before = f.memory.resident().text;
    const s = f.source('legacy', 1, '你好。'), model = modelFor([noopCoverage]);
    const result = await f.memory.organizeV1(s.job.id, f.options(s, model.model));
    const old = f.memory.readV1Version(result.version).workspace.candidate.entries[0]!;
    assert.equal(old.format, 'legacy-unreviewed'); assert.equal(old.text, before); assert.equal(old.placement, 'resident');
    const b = f.source('capacity', 2, '你好。'); f.policy.resident.textTokens = 1; f.policy.organization.maxCapacityCorrections = 1;
    const overflow = modelFor([noopCoverage]);
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, overflow.model)), /memory_capacity_conflict/);
    assert.equal(overflow.reviewCalls, 1); assert.equal(overflow.readyCalls, 2); assert.equal(f.memory.version().id, result.version);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, 1);
    assert.equal(f.memory.readV1Version(result.version).workspace.candidate.entries[0]!.text, before);
  } finally { await f.close(); }
});

test('V1 缺图和无绑定 record 独立 defer，不阻塞完整记录且不推进水位', async () => {
  const f = fixture();
  try {
    const s = f.source('partial', 1, '你好。');
    const missing = prepareNativeMemorySource({ namespace: 'test', source: s.snapshot, entries: [{
      business: { kind: 'user-statement', origin: 'signal', content: '见缺失图片。', provenance: { contextId: 'context', runId: 'partial' } },
      location: { contextId: 'context', runId: 'partial', recordId: 'missing', receivedAt: at, visibleAfter: at },
      original: { text: '见缺失图片。', attachments: [{ id: 'missing-image' }] },
    }], events: [], gaps: [{ contextId: 'context', runId: 'partial', reason: 'missing-source' }] });
    s.prepared.records.push(...missing.records);
    for (const [key, value] of missing.contents) s.prepared.contents.set(key, value);
    for (const [key, value] of missing.canonicalRefs) s.prepared.canonicalRefs.set(key, value);
    s.prepared.gaps.push(...missing.gaps);
    const model = modelFor([noopCoverage]);
    const result = await f.memory.organizeV1(s.job.id, f.options(s, model.model));
    assert.equal(result.complete, false); assert.equal(result.processedRecords, 1); assert.equal(result.deferredRecords, 1);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
    const deferred = JSON.parse(String(f.db.prepare('SELECT body FROM memory_v1_deferred').get()!.body));
    assert.equal(deferred.deferred.length, 1); assert.equal(deferred.gaps.length, 1);
    assert.ok(!f.memory.readV1Version(result.version).workspace.candidate.evidence.some(record => record.id === missing.records[0]!.id));
    const b = f.source('independent', 2, '你好。');
    await f.memory.organizeV1(b.job.id, f.options(b, modelFor([noopCoverage]).model));
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined, '旧 pending 义务不能被后续水位跳过');
  } finally { await f.close(); }
});

test('V1 取消、head 冲突、rename 和 SQL 失败均不发布半版', async t => {
  for (const kind of ['cancel', 'conflict', 'rename', 'sql'] as const) await t.test(kind, async () => {
    const f = fixture();
    try {
      const s = f.source(kind, 1), abort = new AbortController();
      const original = f.store.event.bind(f.store);
      f.store.event = input => { if (kind === 'sql' && input.kind === 'memory_updated') throw new Error('synthetic sql failure'); original(input); };
      const model = modelFor([noopCoverage], (prompt) => {
        if (kind === 'cancel') abort.abort();
        if (kind === 'conflict') f.store.setSetting('memory-version', { ...f.memory.version(), id: 'concurrent' });
        if (kind === 'rename') { fs.rmSync(path.join(f.memory.directory, 'versions'), { recursive: true }); fs.writeFileSync(path.join(f.memory.directory, 'versions'), 'not a directory'); }
        return pass(prompt);
      });
      await assert.rejects(f.memory.organizeV1(s.job.id, f.options(s, model.model, { signal: abort.signal })));
      assert.equal(f.memory.version().id, kind === 'conflict' ? 'concurrent' : 'initial');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_versions').get()!.n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_processing').get()!.n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_coverage').get()!.n, 0);
      assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
    } finally { await f.close(); }
  });
});

test('V1 复核 JSON 必须完整校验，不能以缺项、Markdown 或未知引用通过', () => {
  const candidate = { entries: [], previousEntries: [], evidence: [] } as unknown as MemoryCandidate;
  for (const input of ['```json\n{}\n```', '{"pass":true}', JSON.stringify({ ...legacyPass(), checks: {} }), JSON.stringify({ ...legacyPass(), issues: [{ severity: 'high', category: 'scope', entryIds: ['invented'], evidenceIds: [], message: '错误' }] })]) assert.throws(() => parseMemorySemanticReview(input, candidate), /memory_semantic_review_invalid/);
});

test('V2 独立复核真实 scope 拒绝旧全局 pass、未知 ID、错范围及证据不足', async t => {
  for (const failure of ['legacy', 'unknown-entry', 'unknown-evidence', 'wrong-scope', 'insufficient-evidence'] as const) await t.test(failure, async () => {
    const f = fixture();
    try {
      f.policy.organization.maxCapacityCorrections = 1;
      const source = f.source(`scope-${failure}`, 1);
      const model = modelFor([noopCoverage], prompt => {
        const valid = scopedReview(prompt);
        if (failure === 'legacy') return legacyPass();
        if (failure === 'wrong-scope') return { ...valid, scopeHash: `${valid.scopeHash[0] === '0' ? '1' : '0'}${valid.scopeHash.slice(1)}` };
        if (failure === 'insufficient-evidence') return scopedReview(prompt, 'insufficient-evidence');
        return scopedReview(prompt, 'reject', [{ severity: 'high', category: 'scope',
          entryIds: failure === 'unknown-entry' ? ['entry:invented'] : [],
          evidenceIds: failure === 'unknown-evidence' ? ['evidence:invented'] : [], message: '合成越界引用' }]);
      });
      await assert.rejects(f.memory.organizeV1(source.job.id, f.options(source, model.model)),
        failure === 'insufficient-evidence' ? /memory_semantic_review_rejected/ : /memory_semantic_review_invalid/);
      assert.ok(model.reviewCalls > 0);
      assert.equal(f.memory.version().id, 'initial');
      assert.equal(f.memory.v1Versions().length, 0);
      assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
    } finally { await f.close(); }
  });
});

test('V2 旧域真实 page/open 后才进入下一请求，完整宿主候选与详情仍可读回', async () => {
  const f = fixture();
  try {
    const a = f.source('visible-old', 1);
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor([organization, entity, createEntry,
      mutate('memory_detail_put', v => ({ entryId: v.candidate.entries[0]!.id, expectedEntryRevision: v.candidate.entries[0]!.revision,
        detailId: null, content: '仅由真实打开依赖提供的旧详情。' })), coverage]).model));
    const old = f.memory.readV1Version(first.version).workspace.candidate.entries[0]!;
    const b = f.source('visible-new', 2, '独立的新来源。');
    const model = modelFor([mutate('memory_entry_update', v => {
      const delivered = v.candidate.entries.find(row => row.id === old.id)!;
      assert.ok(delivered, '操作 ID 必须在真实当前投影内');
      return { entryId: delivered.id, expectedEntryRevision: delivered.revision,
        entry: { ...inputEntry(delivered), retention: { score: 9, rationale: '真实读取旧依赖后的调整' } } };
    }), noopCoverage]);
    const result = await f.memory.organizeV1(b.job.id, f.options(b, model.model));
    const writers = model.requests.filter(request => (request as { tools?: { name: string }[] }).tools?.some(tool => tool.name === 'memory_ready')) as { prompt: unknown }[];
    assert.equal(currentMemoryView(writers[0]!.prompt).candidate.entries.length, 0);
    assert.ok(!JSON.stringify(writers[0]).includes('仅由真实打开依赖提供的旧详情。'));
    const opened = writers.findIndex(request => JSON.stringify(request).includes('"status":"queued"'));
    assert.ok(opened > 0, '必须执行真实 open 并取得工具回执');
    assert.ok(writers.slice(opened).some(request => currentMemoryView(request.prompt).candidate.entries.some(row => row.id === old.id)));
    assert.ok(writers.slice(opened).some(request => JSON.stringify(request).includes('仅由真实打开依赖提供的旧详情。')));
    const read = f.memory.readV1Version(result.version);
    assert.equal(read.workspace.candidate.entries[0]!.revision, 2);
    assert.equal(read.workspace.candidate.evidence.length, 2);
    assert.equal(read.details[0]!.content, '仅由真实打开依赖提供的旧详情。');
  } finally { await f.close(); }
});

test('V1 保护状态替换保留结束链，跨版本和恢复参考不回拨现行状态', async () => {
  const f = fixture();
  const stateEntry = (v: View, value: string, validFrom: string) => entry(v, {
    text: `合成设备模式为 ${value}。`, nature: 'fact', validFrom,
    protectionAssessment: { decision: 'eligible', rationale: '持续设备状态', evidence: [refs(v)] },
    protection: { mode: 'state', stateKey: 'mode', value, establishedBy: [refs(v)], overrideRule: '后续明确模式更正' },
  });
  const stateCoverage = mutate('memory_coverage', v => ({
    coverage: { ref: refs(v), decision: 'retained', entryIds: [v.candidate.entries.at(-1)!.id], rationale: '已保留设备状态' },
    protection: { ref: refs(v), decision: 'mapped', entryIds: [v.candidate.entries.at(-1)!.id], rationale: '持续状态受保护' },
  }));
  try {
    const a = f.source('mode-a', 1, '合成设备模式为 A。');
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor([organization, entity, mutate('memory_entry_create', v => ({ entry: stateEntry(v, 'A', at) })), stateCoverage]).model));
    const b = f.source('mode-b', 2, '更正：合成设备模式从第二天起为 B。');
    const second = await f.memory.organizeV1(b.job.id, f.options(b, modelFor([
      mutate('memory_state_replace', v => ({ entryId: v.candidate.entries[0]!.id, expectedEntryRevision: v.candidate.entries[0]!.revision, entry: stateEntry(v, 'B', '2026-01-02T00:00:00.000Z'), evidence: [refs(v)] })), stateCoverage,
    ]).model));
    const read = f.memory.readV1Version(second.version);
    const ended = read.workspace.candidate.entries[0]!;
    assert.equal(ended.format, 'reviewed'); if (ended.format !== 'reviewed') throw new Error('reviewed');
    assert.equal(ended.lifecycle, 'superseded'); assert.equal(ended.placement, 'detail'); assert.equal(ended.revision, 2);
    assert.equal(read.workspace.candidate.overrides.length, 1);
    assert.ok(read.finalText.includes('模式为 B')); assert.ok(!read.finalText.includes('模式为 A'));
    const c = f.source('state-noop', 3, '你好。');
    await f.memory.organizeV1(c.job.id, f.options(c, modelFor([noopCoverage]).model));
    const plan = f.memory.planV1Recovery(first.version, second.version, '2026-02-01T00:00:00.000Z');
    const d = f.source('state-recover', 4, '重新复核设备资料。'); includeSource(d.prepared, c.prepared);
    const recovered = await f.memory.organizeV1(d.job.id, f.options(d, modelFor([noopFor(d.prepared.records[0]!.id), noopFor(c.prepared.records[0]!.id)]).model), plan);
    assert.equal(recovered.generation, 3); assert.ok(f.memory.resident().text.includes('模式为 B'));
    assert.equal(f.memory.readV1Version(recovered.version).workspace.candidate.overrides.length, 1);
  } finally { await f.close(); }
});

test('V1 模型合并、状态更新与容量修正实际经过工具，同批修订保持加一', async () => {
  const f = fixture();
  try {
    const a = f.source('two-intents', 1);
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor([organization, entity, createEntry,
      mutate('memory_entry_create', v => ({ entry: entry(v, { text: '用户还计划开展合成练习。' }) })), coverage,
    ]).model));
    const b = f.source('merge', 2, '将学习与练习安排一同考虑。');
    const actions: Step[] = [mutate('memory_entries_reorganize', v => ({
      oldEntries: v.candidate.entries.map(row => ({ id: row.id, revision: row.revision })),
      replacements: [entry(v, { text: '用户计划学习合成主题并练习，尚未执行。'.repeat(45), abstraction: 'summary', evidence: v.candidate.evidence.map(record => ({ ref: { evidenceId: record.id, partKey: 'body' }, role: 'supports' as const })) })],
    })), coverage];
    f.policy.resident.textTokens = 600;
    assert.ok(measureMemoryText('用户计划学习合成主题并练习，尚未执行。'.repeat(45)).textTokens > f.policy.resident.textTokens);
    const model = modelFor(actions, (prompt, call) => {
      if (call === 1) actions.push(mutate('memory_entry_update', v => { const old = v.candidate.entries.at(-1)!; return { entryId: old.id, expectedEntryRevision: old.revision, entry: { ...inputEntry(old), text: '用户计划学习合成主题并练习，尚未执行。', retention: { score: 6, rationale: '合并后的普通意图' } } }; }));
      return pass(prompt);
    });
    const result = await f.memory.organizeV1(b.job.id, f.options(b, model.model));
    assert.equal(result.corrections, 1); assert.equal(model.reviewCalls, 2);
    const read = f.memory.readV1Version(result.version);
    assert.equal(read.workspace.candidate.entries.length, 3);
    assert.equal(read.workspace.candidate.entries.filter(entry => entry.placement === 'resident').length, 1);
    assert.ok(read.workspace.candidate.entries.slice(0, 2).every(entry => entry.revision === 2));
    assert.equal(read.workspace.candidate.entries.at(-1)!.revision, 1);
    assert.equal(f.memory.readV1Version(first.version).workspace.candidate.entries.length, 2);
  } finally { await f.close(); }
});

test('V1 陈旧修订和注入宿主字段失败不半改，失败后的工具仍可继续', async () => {
  const f = fixture();
  try {
    const s = f.source('stale', 1);
    const model = modelFor([organization, entity, createEntry,
      mutate('memory_entry_update', v => ({ entryId: v.candidate.entries[0]!.id, expectedEntryRevision: 99, entry: { ...inputEntry(v.candidate.entries[0]!), text: '不应保存的陈旧正文。' } })),
      mutate('memory_entry_update', v => ({ entryId: v.candidate.entries[0]!.id, expectedEntryRevision: 1, entry: { ...inputEntry(v.candidate.entries[0]!), id: 'injected-id', text: '不应保存的注入正文。' } })), coverage,
    ]);
    const result = await f.memory.organizeV1(s.job.id, f.options(s, model.model));
    const read = f.memory.readV1Version(result.version);
    assert.equal(read.workspace.draftRevision, 4);
    assert.ok(!read.finalText.includes('不应保存'));
    assert.ok(JSON.stringify(model.requests).includes('memory_workspace_stale_entry'));
  } finally { await f.close(); }
});

test('V1 真正 Core 快照、来源准备及原生 manager 执行不建平行队列', { timeout: 40000 }, async () => {
  const { Core } = await import('../src/core.js');
  const { finished } = await import('./helpers.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-v1-core-organize-'));
  const main = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] });
    c.enqueue({ type: 'text-start', id: 'main' }); c.enqueue({ type: 'text-delta', id: 'main', delta: '收到合成意图，但尚未执行。' }); c.enqueue({ type: 'text-end', id: 'main' });
    c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }); c.close();
  } }) }) });
  const core = await Core.open({ dataDir: directory, model: main, memoryEnabled: false });
  try {
    const sent = await core.submitMessage({ contextId: 'main', content: '我计划学习合成主题并练习，尚未执行。' });
    await finished(core, sent.runId!);
    const snapshot = core.projectMemory.snapshot(sent.runId!);
    const source = await core.prepareMemorySource(sent.runId!);
    assert.ok(source.records.length > 0); assert.ok(snapshot.nativeMessages);
    const user = source.records.find(record => record.kind === 'user-statement')!;
    const userRef = { evidenceId: user.id, partKey: 'body' };
    const steps: Step[] = [organization, entity, mutate('memory_entry_create', v => ({ entry: entry(v, {
      evidence: [{ ref: userRef, role: 'supports' }], protectionAssessment: { decision: 'ineligible', rationale: '普通学习计划', evidence: [userRef] },
    }) }))];
    for (const record of source.records) for (const part of record.coverage.parts) steps.push(mutate('memory_coverage', v => ({
      coverage: { ref: { evidenceId: record.id, partKey: part.key }, decision: record.id === user.id ? 'retained' : 'no-effective-new-information', entryIds: record.id === user.id ? [v.candidate.entries[0]!.id] : [], rationale: '核对真实快照资料' },
      protection: { ref: { evidenceId: record.id, partKey: part.key }, decision: 'no-protectable-state', entryIds: [], rationale: '无持续保护状态' },
    })));
    const model = modelFor(steps), job = core.projectMemory.newJob(sent.runId!);
    const manager = core.sessions.controller.getMastra()?.backgroundTaskManager; assert.ok(manager);
    let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const task = await manager.enqueue({ runId: sent.runId!, toolName: 'organize-memory', toolCallId: `memory:${sent.runId}`, agentId: 'memory-organizer', args: { jobId: job.id }, maxRetries: 0 }, { executor: { execute: async (_args, execution) => {
      try {
        const result = await core.projectMemory.organizeV1(job.id, { expectedHead: 'initial', preparedSource: source, policy: createDefaultMemoryContextPolicy(), cutoff: new Date().toISOString(), scopeId: `native:${core.storageId}`, resolveModel: () => model.model, signal: execution?.abortSignal });
        resolve(result); return result;
      } catch (error) { reject(error); throw error; }
    } } });
    core.projectMemory.bind(job.id, task.task.id);
    await done;
    assert.equal(core.projectMemory.jobs().find(row => row.id === job.id)!.nativeTaskId, task.task.id);
    assert.equal(core.projectMemory.jobs().find(row => row.id === job.id)!.status, 'succeeded');
    assert.match(core.projectMemory.resident().text, /计划学习/);
    assert.deepEqual(core.projectMemory.snapshot(sent.runId!), snapshot);
    assert.equal((await manager.listTasks({ runId: sent.runId! })).tasks.length, 1);
    assert.ok(!JSON.stringify(core.projectMemory.status().jobs).includes(task.task.id));
  } finally { await core.close(); await removeTemp(directory); }
});

test('V1 不把快照 system 或 opaque 拼作经历；导入来源保持历史性质', async () => {
  const { evidenceIdempotencyKey } = await import('../src/memory/v1/validate.js');
  const f = fixture();
  try {
    const s = f.source('imported', 1, '历史上曾打算学习合成主题。');
    f.memory.archive({ ...s.snapshot, prompt: [{ role: 'system', content: 'snapshot-private-system-marker' }], nativeMessages: { opaque: 'snapshot-private-opaque-marker' } });
    for (const record of s.prepared.records) {
      record.origin = { ...record.origin, system: 'import', capture: 'historical-record' };
      s.prepared.canonicalRefs.get(record.id)!.canonicalIdentity = evidenceIdempotencyKey(record);
    }
    const model = modelFor([organization, entity, createEntry, coverage]);
    const result = await f.memory.organizeV1(s.job.id, f.options(s, model.model, { scopeId: 'import:test' }));
    const prompts = JSON.stringify(model.requests);
    assert.ok(!prompts.includes('snapshot-private-system-marker')); assert.ok(!prompts.includes('snapshot-private-opaque-marker'));
    assert.ok(prompts.includes('import'));
    assert.ok(f.memory.readV1Version(result.version).workspace.candidate.evidence.every(record => record.origin.system === 'import'));
  } finally { await f.close(); }
});

test('V1 图片真正传给整理与无工具复核；相同附件 Hash 不虚增独立来源组', async () => {
  const { prepareMemoryV1Batch } = await import('../src/memory/v1/organizer.js');
  const { createHash } = await import('node:crypto');
  const f = fixture();
  try {
    const s = f.source('images', 1, '你好。');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
    const imageHash = createHash('sha256').update(bytes).digest('hex');
    const images = prepareNativeMemorySource({ namespace: 'test', source: s.snapshot, entries: ['one', 'two'].map(id => ({
      business: { kind: 'user-statement', origin: 'signal', content: '合成图片', provenance: { contextId: 'context', runId: 'images' } },
      location: { contextId: 'context', runId: 'images', recordId: id, receivedAt: at, visibleAfter: at },
      original: { text: '合成图片', attachments: [{ id, bytes, metadata: { sha256: imageHash, mediaType: 'image/png', bytes: bytes.length } }] },
    })), events: [], gaps: [] });
    includeSource(s.prepared, images);
    const batch = prepareMemoryV1Batch(s.prepared, new MemoryEvidenceLedger(f.db), 'native:test', '2026-02-01T00:00:00.000Z', ['image/png']);
    const imageGroups = batch.groups.filter(group => group.ref.partKey !== 'body');
    assert.equal(imageGroups.length, 2); assert.equal(imageGroups[0]!.group, imageGroups[1]!.group);
    const steps: Step[] = [];
    for (const record of s.prepared.records) for (const part of record.coverage.parts) steps.push(mutate('memory_coverage', () => ({
      coverage: { ref: { evidenceId: record.id, partKey: part.key }, decision: 'no-effective-new-information', entryIds: [], rationale: '合成图片无新增认识' },
      protection: { ref: { evidenceId: record.id, partKey: part.key }, decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' },
    })));
    const model = modelFor(steps);
    const result = await f.memory.organizeV1(s.job.id, f.options(s, model.model, { supportedImageMediaTypes: ['image/png'] }));
    assert.equal(result.processedRecords, 3); assert.equal(result.complete, true);
    const inspect = (request: unknown): number => {
      let count = 0;
      const visit = (value: unknown) => { if (!value || typeof value !== 'object') return; const row = value as Record<string, unknown>; if (row.type === 'file' && row.mediaType === 'image/png') count++; for (const child of Object.values(row)) visit(child); };
      visit((request as { prompt: unknown }).prompt); return count;
    };
    const reviewRequest = model.requests.find(request => !(request as { tools?: { name: string }[] }).tools?.some(tool => tool.name === 'memory_ready'));
    assert.ok(model.requests.some(request => inspect(request) >= 2)); assert.ok(reviewRequest && inspect(reviewRequest) >= 2);
  } finally { await f.close(); }
});

test('V1 资料可见时间使用完整小数秒，不向模型提前泄漏未来证据', async () => {
  const f = fixture();
  try {
    const s = f.source('future', 1, '尚不可见的合成消息。');
    s.prepared.records[0]!.visibleAfter = '2026-01-01T00:00:00.0009Z';
    const model = modelFor();
    await assert.rejects(f.memory.organizeV1(s.job.id, f.options(s, model.model, { cutoff: '2026-01-01T00:00:00.0001Z' })), /memory_source_deferred/);
    assert.equal(model.requests.length, 0); assert.equal(f.memory.version().id, 'initial');
  } finally { await f.close(); }
});

test('V1 部分成功之后可以显式创建同源原生 job 补源重试，不被旧水位跳过', async () => {
  const f = fixture();
  try {
    const s = f.source('retry-source', 1, '你好。');
    s.prepared.gaps.push({ contextId: 'context', runId: s.snapshot.runId, messageId: `record:${s.snapshot.runId}`, reason: 'missing-source' });
    const first = await f.memory.organizeV1(s.job.id, f.options(s, modelFor([noopCoverage]).model));
    assert.equal(first.complete, false);
    const job = f.memory.newV1Job(s.snapshot.runId, first.version);
    assert.notEqual(job.id, s.job.id); assert.equal(job.nativeTaskId, null);
    assert.equal(f.memory.newV1Job(s.snapshot.runId, first.version).id, job.id, '未终结的同源 job 不重复受理');
    f.memory.bind(job.id, 'native:source-retry');
    const options = f.options(s, modelFor([noopCoverage]).model); options.preparedSource.gaps = [];
    const second = await f.memory.organizeV1(job.id, options);
    assert.equal(second.complete, true); assert.equal(second.changed, false);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, 1);
    assert.equal(f.memory.jobs().find(row => row.id === job.id)!.nativeTaskId, 'native:source-retry');
    assert.throws(() => f.memory.newV1Job(s.snapshot.runId, 'initial'), /memory_version_conflict/);
    const another = f.source('legacy-rejected', 2);
    await assert.rejects(f.memory.organize(another.job.id, () => modelFor().model), /memory_format_requires_v1/);
  } finally { await f.close(); }
});

test('V1 no-op 的复核解析失败保留证据和旧版，失败调用仍计入真实供应商用量', async () => {
  const f = fixture();
  try {
    const a = f.source('base-invalid', 1), base = await f.memory.organizeV1(a.job.id, f.options(a, modelFor([noopCoverage]).model));
    const b = f.source('invalid-json', 2), model = modelFor([noopCoverage], (prompt) => '{"pass":true}');
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, model.model)), /memory_semantic_review_invalid/);
    assert.equal(f.memory.version().id, base.version); assert.equal(f.memory.jobs().find(row => row.id === b.job.id)!.error, 'memory_semantic_review_invalid');
    const usages = f.db.prepare("SELECT data FROM runtime_events WHERE kind='memory_usage' AND run_id=?").all(b.snapshot.runId).map(row => JSON.parse(String(row.data)));
    assert.ok(usages.some(usage => usage.role === 'memory-review' && usage.usage.totalTokens > 0));
    assert.ok(new MemoryEvidenceLedger(f.db).listPending('native:test', '2026-02-01T00:00:00.000Z').length > 0);
    const c = f.source('later-complete', 3);
    await f.memory.organizeV1(c.job.id, f.options(c, modelFor([noopCoverage]).model));
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, 1, '较新成功不能掩盖未复核来源');
  } finally { await f.close(); }
});

test('V1 busy 和中途绑定不破坏原生 job，只有现有 operation 发布', async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  try {
    const a = f.source('busy-a', 1), b = f.source('busy-b', 2);
    const model = modelFor([noopCoverage], async (prompt) => { started(); await gate; return pass(prompt); });
    const operation = f.memory.organizeV1(a.job.id, f.options(a, model.model));
    await running;
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, modelFor().model)), /memory_writer_busy/);
    assert.equal(f.memory.version().id, 'initial');
    f.memory.bind(a.job.id, 'native:late-binding'); release();
    await operation;
    assert.equal(f.memory.jobs().find(job => job.id === a.job.id)!.nativeTaskId, 'native:late-binding');
    assert.equal(f.memory.jobs().find(job => job.id === b.job.id)!.status, 'pending');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM runtime_operations WHERE id LIKE ?').get('memory-publication:%')!.n, 1);
  } finally { release(); await f.close(); }
});

test('V1 恢复计划列出 no-op、失败和缺源义务，未补放材料不发布恢复版本', async () => {
  const f = fixture();
  try {
    const a = f.source('recover-base', 1), initial = await f.memory.organizeV1(a.job.id, f.options(a, modelFor([noopCoverage]).model));
    const b = f.source('recover-noop', 2); await f.memory.organizeV1(b.job.id, f.options(b, modelFor([noopCoverage]).model));
    const plan = f.memory.planV1Recovery(initial.version, initial.version, '2026-02-01T00:00:00.000Z');
    assert.ok(plan.requiredEvidenceIds.includes(b.prepared.records[0]!.id));
    const job = f.memory.newV1Job(a.snapshot.runId, initial.version), unused = modelFor();
    await assert.rejects(f.memory.organizeV1(job.id, f.options(a, unused.model), plan), /memory_recovery_evidence_incomplete/);
    assert.equal(unused.requests.length, 0); assert.equal(f.memory.version().id, initial.version); assert.equal(f.memory.v1Versions().length, 1);
    const c = f.source('recover-gap', 3); c.prepared.gaps.push({ contextId: 'context', reason: 'missing-source' });
    await f.memory.organizeV1(c.job.id, f.options(c, modelFor([noopCoverage]).model));
    const blockedPlan = f.memory.planV1Recovery(initial.version, initial.version, plan.cutoff);
    assert.ok(blockedPlan.pendingSourceRuns.includes(c.snapshot.runId));
    const retry = f.memory.newV1Job(a.snapshot.runId, initial.version);
    await assert.rejects(f.memory.organizeV1(retry.id, f.options(a, unused.model), blockedPlan), /memory_recovery_source_deferred/);
    assert.equal(f.memory.version().generation, 1);
  } finally { await f.close(); }
});

test('V1 读回使用 SQLite 可信父基线与 manifest 锚，不相信文件自报或递归注入详情', async () => {
  const f = fixture();
  try {
    const a = f.source('anchor-base', 1), first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor([organization, entity, createEntry, coverage]).model));
    const row = f.db.prepare('SELECT baseline_json FROM memory_v1_versions WHERE id=?').get(first.version)!;
    f.db.prepare('UPDATE memory_v1_versions SET baseline_json=? WHERE id=?').run('[{}]', first.version);
    assert.throws(() => f.memory.readV1Version(first.version), /memory_version_baseline_mismatch/);
    f.db.prepare('UPDATE memory_v1_versions SET baseline_json=? WHERE id=?').run(String(row.baseline_json), first.version);
    const head = f.memory.version(), read = f.memory.readV1Version(head.id);
    const file = read.manifest.files.find(file => file.layer === 'resident')!;
    fs.appendFileSync(path.join(head.filesDirectory, file.path), '\n文件自报的未授权正文。');
    assert.throws(() => f.memory.resident(), /memory_version_hash_mismatch/);
    f.store.setSetting('memory-version', { ...head, format: 'unrecognized-format' });
    assert.throws(() => f.memory.resident(), /memory_version_pointer_invalid/);
    assert.equal(f.memory.version().id, first.version);
  } finally { await f.close(); }
});

const noops = (source: PreparedMemorySource) => source.records.flatMap(record => record.coverage.parts.map(part => mutate('memory_coverage', () => ({ coverage: { ref: { evidenceId: record.id, partKey: part.key }, decision: 'no-effective-new-information', entryIds: [], rationale: '合成资料逐项核对' }, protection: { ref: { evidenceId: record.id, partKey: part.key }, decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' } }))));

test('V1 no-op 晚到失败跨重启进入后续独立来源的处理基线', async () => {
  const f = fixture(true);
  let reopened: DatabaseSync | undefined;
  try {
    const a = f.source('operation-a', 1);
    const base = { contextId: 'context', runId: 'operation-a', toolCallId: 'call-one', receivedAt: at };
    const events = [
      { ...base, seq: 1, kind: 'tool_start' as const, data: { toolName: 'synthetic', args: {} } },
      { ...base, seq: 2, kind: 'tool_end' as const, data: { denied: false, isError: false, resultError: false } },
    ];
    a.prepared = prepareNativeMemorySource({ namespace: 'test', source: a.snapshot, entries: [], events, gaps: [] });
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(a.prepared)).model));
    assert.equal(f.memory.readV1Version(first.version).workspace.candidate.observations[0]!.toolTerminal, 'finished');
    const b = f.source('operation-b', 2);
    const late = prepareNativeMemorySource({ namespace: 'test', source: b.snapshot, entries: [], events: [...events, { ...base, seq: 3, kind: 'tool_end', data: { denied: false, isError: true, resultError: true } }], gaps: [] });
    includeSource(b.prepared, late);
    let secondTerminal = '';
    const inspectB: Step = v => { secondTerminal = v.candidate.observations[0]!.toolTerminal; return noopCoverage(v); };
    const second = await f.memory.organizeV1(b.job.id, f.options(b, modelFor([...noops(b.prepared), inspectB]).model));
    assert.equal(secondTerminal, 'failed'); assert.equal(second.changed, false);
    const processedB = JSON.parse(String(f.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(b.job.id)!.result_json));
    assert.equal(processedB.workspace.candidate.observations[0].toolTerminal, 'failed');
    reopened = new DatabaseSync(path.join(f.directory, 'runtime.sqlite'));
    const restarted = new ProjectMemory(new RuntimeStore(reopened), f.directory);
    const c = f.source('operation-c', 3);
    let thirdTerminal = '';
    const inspectC: Step = v => { thirdTerminal = v.candidate.observations[0]!.toolTerminal; return noopCoverage(v); };
    await restarted.organizeV1(c.job.id, f.options(c, modelFor([inspectC]).model));
    assert.equal(thirdTerminal, 'failed');
  } finally { reopened?.close(); await f.close(); }
});

test('V1 同源子集重试不能解除缺绑定来源义务', async () => {
  const f = fixture();
  try {
    const s = f.source('pending-omission', 1, '完整合成文字。');
    const fullOriginal = structuredClone(s.prepared);
    const missing = prepareNativeMemorySource({ namespace: 'test', source: s.snapshot, entries: [{
      business: { kind: 'user-statement', origin: 'signal', content: '见未到图片。', provenance: { contextId: 'context', runId: s.snapshot.runId } },
      location: { contextId: 'context', runId: s.snapshot.runId, recordId: 'missing-binding', receivedAt: at, visibleAfter: at },
      original: { text: '见未到图片。', attachments: [{ id: 'not-loaded' }] },
    }], events: [], gaps: [] });
    includeSource(s.prepared, missing);
    const first = await f.memory.organizeV1(s.job.id, f.options(s, modelFor(noops(fullOriginal)).model));
    assert.equal(first.complete, false); assert.equal(first.deferredRecords, 1);
    const oldDeferred = JSON.parse(String(f.db.prepare('SELECT body FROM memory_v1_deferred').get()!.body));
    assert.equal(oldDeferred.deferred[0].evidenceId, missing.records[0]!.id);
    assert.equal(new MemoryEvidenceLedger(f.db).readEvidence(missing.records[0]!.id), undefined);
    const retry = f.memory.newV1Job(s.snapshot.runId, first.version);
    const second = await f.memory.organizeV1(retry.id, f.options({ ...s, prepared: fullOriginal }, modelFor(noops(fullOriginal)).model));
    assert.equal(second.complete, false);
    assert.equal(JSON.parse(String(f.db.prepare('SELECT body FROM memory_v1_deferred').get()!.body)).deferred.length, 1);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
  } finally { await f.close(); }
});

test('V1 语义失败子集保留旧义务，后续独立来源不越过水位', async () => {
  const f = fixture();
  try {
    const s = f.source('pending-failed-retry', 1);
    const original = structuredClone(s.prepared);
    const missing = prepareNativeMemorySource({ namespace: 'test', source: s.snapshot, entries: [{
      business: { kind: 'user-statement', origin: 'signal', content: '图片尚未可读。', provenance: { contextId: 'context', runId: s.snapshot.runId } },
      location: { contextId: 'context', runId: s.snapshot.runId, recordId: 'failed-retry-missing', receivedAt: at, visibleAfter: at },
      original: { text: '图片尚未可读。', attachments: [{ id: 'missing-failed-retry-asset' }] },
    }], events: [], gaps: [] });
    includeSource(s.prepared, missing);
    const first = await f.memory.organizeV1(s.job.id, f.options(s, modelFor(noops(original)).model));
    assert.equal(first.complete, false);
    const retry = f.memory.newV1Job(s.snapshot.runId, first.version);
    await assert.rejects(f.memory.organizeV1(retry.id, f.options({ ...s, prepared: original }, modelFor(noops(original), (prompt) => '{"pass":true}').model)), /memory_semantic_review_invalid/);
    assert.equal(JSON.parse(String(f.db.prepare('SELECT body FROM memory_v1_deferred').get()!.body)).deferred.length, 1);
    const next = f.source('independent-after-failed-retry', 2);
    await f.memory.organizeV1(next.job.id, f.options(next, modelFor([noopCoverage]).model));
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
    assert.equal(f.memory.jobs().find(job => job.id === retry.id)!.status, 'failed');
  } finally { await f.close(); }
});

function operationSource(f: ReturnType<typeof fixture>, run: string, sequence: number, failed: boolean, onlyLate = false, toolCallId = 'one') {
  const source = f.source(run, sequence);
  const base = { contextId: 'context', runId: 'operation-origin', toolCallId, receivedAt: at };
  source.prepared = prepareNativeMemorySource({ namespace: 'test', source: source.snapshot, entries: [], gaps: [], events: [
    { ...base, seq: toolCallId === 'one' ? 1 : 4, kind: 'tool_start' as const, data: { toolName: 'synthetic', args: {} } },
    ...(!onlyLate && failed ? [{ ...base, seq: 2, kind: 'tool_end' as const, data: { denied: false, isError: false, resultError: false } }] : []),
    { ...base, seq: failed ? 3 : toolCallId === 'one' ? 2 : 5, kind: 'tool_end', data: { denied: false, isError: failed, resultError: failed } },
  ] });
  return source;
}
const processingRow = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT * FROM memory_v1_processing_head').get();
const pendingRows = (f: ReturnType<typeof fixture>, run: string) => JSON.parse(String(f.db.prepare('SELECT body FROM memory_v1_deferred WHERE run_id=?').get(run)!.body)) as { deferred: { evidenceId: string }[]; gaps: unknown[] };

function attachmentSource(f: ReturnType<typeof fixture>, run: string, recordId: string, filled: boolean) {
  const bytes = Buffer.from('合成图片字节');
  return prepareNativeMemorySource({ namespace: 'test', source: { contextId: 'context', runId: run, sequence: 1 }, entries: [{
    business: { kind: 'user-statement', origin: 'signal', content: '合成图文。', provenance: { contextId: 'context', runId: run } },
    location: { contextId: 'context', runId: run, recordId, receivedAt: at, visibleAfter: at },
    original: { text: '合成图文。', attachments: [{ id: `asset:${recordId}`, ...(filled ? { bytes, metadata: { sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', bytes: bytes.length } } : {}) }] },
  }], events: [], gaps: [] });
}

test('V1 未发布的失败观察不污染处理 head；部分重放单调归并且新 attempt 可成功', async () => {
  const f = fixture();
  try {
    const a = operationSource(f, 'head-first', 1, false);
    const initial = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(a.prepared)).model));
    const original = processingRow(f);
    const b = operationSource(f, 'head-failed', 2, true, true);
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, modelFor(noops(b.prepared), () => '{"pass":true}').model)), /memory_semantic_review_invalid/);
    assert.deepEqual(processingRow(f), original);
    const restarted = new ProjectMemory(f.store, f.directory), c = f.source('head-independent', 3);
    const inspect: Step = v => { assert.equal(v.candidate.observations[0]!.toolTerminal, 'finished'); assert.ok(!v.candidate.evidence.some(record => record.id === b.prepared.records.at(-1)!.id)); return noopCoverage(v); };
    await restarted.organizeV1(c.job.id, f.options(c, modelFor([inspect]).model));
    const retry = f.memory.newV1Job(b.snapshot.runId, initial.version);
    const accepted = await f.memory.organizeV1(retry.id, f.options(b, modelFor(noops(b.prepared)).model));
    assert.equal(accepted.changed, false);
    const replay = operationSource(f, 'head-stale-finished', 4, false);
    const inspectReplay: Step = v => { assert.equal(v.candidate.observations[0]!.toolTerminal, 'failed'); return noopCoverage(v); };
    await f.memory.organizeV1(replay.job.id, f.options(replay, modelFor([...noops(replay.prepared), inspectReplay]).model));
    const next = operationSource(f, 'head-new-attempt', 5, false, false, 'two');
    const inspectNext: Step = v => { assert.deepEqual(v.candidate.observations.map(row => row.toolTerminal), ['failed', 'finished']); return noopCoverage(v); };
    await f.memory.organizeV1(next.job.id, f.options(next, modelFor([...noops(next.prepared), inspectNext]).model));
    assert.equal(f.memory.v1Versions().length, 1);
  } finally { await f.close(); }
});

test('V1 子集取消、SQL rollback 与 head 冲突保留旧义务和处理基线', async t => {
  for (const kind of ['cancel', 'sql', 'conflict'] as const) await t.test(kind, async () => {
    const f = fixture();
    try {
      const a = f.source(`deferred-${kind}`, 1), original = structuredClone(a.prepared);
      includeSource(a.prepared, attachmentSource(f, a.snapshot.runId, 'pending', false));
      await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
      const prior = processingRow(f), head = f.memory.version(), pending = pendingRows(f, a.snapshot.runId);
      const job = f.memory.newV1Job(a.snapshot.runId, head.id), abort = new AbortController();
      const event = f.store.event.bind(f.store);
      f.store.event = input => { if (kind === 'sql' && input.kind === 'memory_processed') throw new Error('synthetic rollback'); event(input); };
      const model = modelFor(noops(original), (prompt) => {
        if (kind === 'cancel') abort.abort();
        if (kind === 'conflict') f.store.setSetting('memory-version', { ...head, id: 'concurrent' });
        return pass(prompt);
      });
      await assert.rejects(f.memory.organizeV1(job.id, f.options({ ...a, prepared: original }, model.model, { signal: abort.signal })));
      assert.deepEqual(pendingRows(f, a.snapshot.runId), pending); assert.deepEqual(processingRow(f), prior);
      if (kind === 'conflict') f.store.setSetting('memory-version', head);
      f.store.event = event;
      const c = f.source(`after-${kind}`, 2);
      const result = await f.memory.organizeV1(c.job.id, f.options(c, modelFor([organization, entity, createEntry, coverage]).model, { scopeId: 'another:scope' }));
      assert.equal(result.changed, true); assert.equal(result.complete, false);
      assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
    } finally { await f.close(); }
  });
});

test('V1 真正补齐按 canonical 来源和部分逐项解除；异源同文不能解除', async () => {
  const f = fixture();
  try {
    const a = f.source('exact-source', 1), original = structuredClone(a.prepared);
    const missingA = attachmentSource(f, a.snapshot.runId, 'pending-a', false), missingB = attachmentSource(f, a.snapshot.runId, 'pending-b', false);
    includeSource(a.prepared, missingA); includeSource(a.prepared, missingB);
    a.prepared.gaps.push({ contextId: 'context', runId: a.snapshot.runId, messageId: 'pending-a', reason: 'missing-source' });
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
    assert.equal(first.deferredRecords, 2);
    // 不同 run 的相同文字、附件和 record 名不能履行原 run 的义务。
    const other = f.source('other-source', 2); other.prepared = attachmentSource(f, other.snapshot.runId, 'other-record', true); other.prepared.source = { ...other.prepared.source, sequence: other.snapshot.sequence };
    await f.memory.organizeV1(other.job.id, f.options(other, modelFor(noops(other.prepared)).model, { supportedImageMediaTypes: ['image/png'] }));
    assert.equal(pendingRows(f, a.snapshot.runId).deferred.length, 2);
    const filledA = attachmentSource(f, a.snapshot.runId, 'pending-a', true), retryA = f.memory.newV1Job(a.snapshot.runId, first.version);
    const second = await f.memory.organizeV1(retryA.id, f.options({ ...a, prepared: filledA }, modelFor(noops(filledA)).model, { supportedImageMediaTypes: ['image/png'] }));
    assert.equal(second.complete, false); assert.equal(second.deferredRecords, 1);
    assert.deepEqual(pendingRows(f, a.snapshot.runId).deferred.map(row => row.evidenceId), [missingB.records[0]!.id]);
    assert.equal(pendingRows(f, a.snapshot.runId).gaps.length, 0);
    const filledB = attachmentSource(f, a.snapshot.runId, 'pending-b', true), retryB = f.memory.newV1Job(a.snapshot.runId, first.version);
    const third = await f.memory.organizeV1(retryB.id, f.options({ ...a, prepared: filledB }, modelFor(noops(filledB)).model, { supportedImageMediaTypes: ['image/png'] }));
    assert.equal(third.complete, true); assert.equal(third.deferredRecords, 0); assert.equal(third.changed, false);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, 1);
    const repeated = f.memory.newV1Job(a.snapshot.runId, first.version);
    assert.equal((await f.memory.organizeV1(repeated.id, f.options({ ...a, prepared: filledB }, modelFor(noops(filledB)).model, { supportedImageMediaTypes: ['image/png'] }))).complete, true);
  } finally { await f.close(); }
});

test('V1 补齐资料复核失败或事务回滚不能提前解除真实缺口', async t => {
  for (const kind of ['semantic', 'cancel', 'sql'] as const) await t.test(kind, async () => {
    const f = fixture();
    try {
      const a = f.source(`fill-${kind}`, 1), original = structuredClone(a.prepared);
      includeSource(a.prepared, attachmentSource(f, a.snapshot.runId, 'real-gap', false));
      await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
      const before = pendingRows(f, a.snapshot.runId), prior = processingRow(f), abort = new AbortController();
      const filled = attachmentSource(f, a.snapshot.runId, 'real-gap', true), job = f.memory.newV1Job(a.snapshot.runId, f.memory.version().id);
      const event = f.store.event.bind(f.store);
      f.store.event = input => { if (kind === 'sql' && input.kind === 'memory_processed') throw new Error('synthetic rollback'); event(input); };
      const model = modelFor(noops(filled), (prompt) => { if (kind === 'cancel') abort.abort(); return kind === 'semantic' ? '{"pass":true}' : pass(prompt); });
      await assert.rejects(f.memory.organizeV1(job.id, f.options({ ...a, prepared: filled }, model.model, { supportedImageMediaTypes: ['image/png'], signal: abort.signal })));
      assert.deepEqual(pendingRows(f, a.snapshot.runId), before); assert.deepEqual(processingRow(f), prior);
      f.store.event = event;
      const retry = f.memory.newV1Job(a.snapshot.runId, f.memory.version().id);
      assert.equal((await f.memory.organizeV1(retry.id, f.options({ ...a, prepared: filled }, modelFor(noops(filled)).model, { supportedImageMediaTypes: ['image/png'] }))).complete, true);
    } finally { await f.close(); }
  });
});

test('V1 恢复计划锚定 no-op 处理 head，保留晚到执行事实与未映射缺口', async () => {
  const f = fixture();
  try {
    const a = operationSource(f, 'recovery-op-a', 1, false), initial = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(a.prepared)).model));
    const plan = f.memory.planV1Recovery(initial.version, initial.version, '2026-02-01T00:00:00.000Z');
    const b = operationSource(f, 'recovery-op-b', 2, true, true);
    await f.memory.organizeV1(b.job.id, f.options(b, modelFor(noops(b.prepared)).model));
    const next = f.memory.planV1Recovery(initial.version, initial.version, plan.cutoff);
    assert.notEqual(next.expectedProcessingHead, plan.expectedProcessingHead);
    assert.ok(next.requiredEvidenceIds.includes(b.prepared.records.at(-1)!.id));
    const c = f.source('recovery-op-c', 3), unused = modelFor();
    await assert.rejects(f.memory.organizeV1(c.job.id, f.options(c, unused.model), plan), /memory_recovery_plan_conflict/);
    assert.equal(unused.requests.length, 0);
    includeSource(c.prepared, b.prepared);
    const restoredJob = f.memory.newV1Job(c.snapshot.runId, initial.version);
    const inspect: Step = v => { assert.equal(v.candidate.observations[0]!.toolTerminal, 'failed'); return noopCoverage(v); };
    const recovered = await f.memory.organizeV1(restoredJob.id, f.options(c, modelFor([...noops(c.prepared), inspect]).model), next);
    assert.equal(recovered.changed, true);
    assert.equal(f.memory.readV1Version(recovered.version).workspace.candidate.observations[0]!.toolTerminal, 'failed');
    const d = f.source('recovery-with-gap', 4), original = structuredClone(d.prepared), missing = attachmentSource(f, d.snapshot.runId, 'recovery-missing', false);
    includeSource(d.prepared, missing);
    await f.memory.organizeV1(d.job.id, f.options(d, modelFor(noops(original)).model));
    assert.ok(f.memory.planV1Recovery(initial.version, recovered.version, plan.cutoff).pendingSourceEvidenceIds.includes(missing.records[0]!.id));
  } finally { await f.close(); }
});

test('V1 其它 scope 的成功不能吞掉此前失败受理记录的覆盖义务', async () => {
  const f = fixture();
  try {
    const a = f.source('failed-scope', 1);
    await assert.rejects(f.memory.organizeV1(a.job.id, f.options(a, modelFor([noopCoverage], (prompt) => '{"pass":true}').model)));
    const b = f.source('new-scope', 2);
    const result = await f.memory.organizeV1(b.job.id, f.options(b, modelFor([organization, entity, createEntry, coverage]).model, { scopeId: 'scope:new' }));
    assert.equal(result.changed, true); assert.equal(result.complete, false);
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
    const retry = f.memory.newV1Job(a.snapshot.runId, result.version);
    const repaired = await f.memory.organizeV1(retry.id, f.options(a, modelFor(noops(a.prepared)).model, { scopeId: 'scope:new' }));
    assert.equal(repaired.complete, true);
    assert.equal(new MemoryEvidenceLedger(f.db).listPending('native:test', '2026-02-01T00:00:00.000Z').length, 0);
  } finally { await f.close(); }
});

test('V1 正文相同的并发 no-op 仍按处理 head 检测冲突', async () => {
  const f = fixture();
  try {
    const a = f.source('processing-concurrent-base', 1);
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor([noopCoverage]).model));
    const peer = new ProjectMemory(f.store, f.directory);
    const b = f.source('processing-concurrent-b', 2), c = f.source('processing-concurrent-c', 3);
    const model = modelFor([noopCoverage], async (prompt) => {
      const result = await peer.organizeV1(c.job.id, f.options(c, modelFor([noopCoverage]).model));
      assert.equal(result.changed, false);
      return pass(prompt);
    });
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, model.model)), /memory_processing_head_conflict/);
    assert.equal(processingRow(f)!.job_id, c.job.id); assert.equal(f.memory.version().id, first.version);
    assert.equal(f.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(b.job.id), undefined);
  } finally { await f.close(); }
});

test('V1 处理基线摘要不匹配时拒绝读取，不降级回正文中的旧执行状态', async () => {
  const f = fixture();
  try {
    const a = operationSource(f, 'processing-integrity', 1, false);
    await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(a.prepared)).model));
    f.db.prepare("UPDATE memory_v1_processing SET result_json='{}' WHERE job_id=?").run(a.job.id);
    const b = f.source('processing-integrity-next', 2), unused = modelFor();
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, unused.model)), /memory_processing_head_invalid/);
    assert.equal(unused.requests.length, 0);
  } finally { await f.close(); }
});

test('V1 补源正文 Hash 改变时先拒绝，不污染尚未登记的规范内容槽', async () => {
  const f = fixture();
  try {
    const a = f.source('hash-bound-gap', 1), original = structuredClone(a.prepared), missing = attachmentSource(f, a.snapshot.runId, 'hash-gap', false);
    includeSource(a.prepared, missing);
    await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
    const wrong = attachmentSource(f, a.snapshot.runId, 'hash-gap', true), body = Buffer.from('不同正文。');
    wrong.records[0]!.contentHash = createHash('sha256').update(body).digest('hex'); wrong.contents.get(wrong.records[0]!.contentRef)!.body = body;
    const job = f.memory.newV1Job(a.snapshot.runId, f.memory.version().id), unused = modelFor();
    await assert.rejects(f.memory.organizeV1(job.id, f.options({ ...a, prepared: wrong }, unused.model, { supportedImageMediaTypes: ['image/png'] })), /memory_source_identity_conflict/);
    assert.equal(unused.requests.length, 0); assert.equal(new MemoryEvidenceLedger(f.db).readEvidence(missing.records[0]!.id), undefined);
    assert.equal(pendingRows(f, a.snapshot.runId).deferred.length, 1);
    const repaired = attachmentSource(f, a.snapshot.runId, 'hash-gap', true), retry = f.memory.newV1Job(a.snapshot.runId, f.memory.version().id);
    assert.equal((await f.memory.organizeV1(retry.id, f.options({ ...a, prepared: repaired }, modelFor(noops(repaired)).model, { supportedImageMediaTypes: ['image/png'] }))).complete, true);
  } finally { await f.close(); }
});

test('V1 原先缺 canonical 定位的记录可凭同一规范身份与内容真实补齐', async () => {
  const f = fixture();
  try {
    const a = f.source('canonical-gap', 1), original = structuredClone(a.prepared), missing = attachmentSource(f, a.snapshot.runId, 'canonical-record', true);
    missing.canonicalRefs.clear(); includeSource(a.prepared, missing);
    await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model, { supportedImageMediaTypes: ['image/png'] }));
    assert.equal(pendingRows(f, a.snapshot.runId).deferred.length, 1);
    const filled = attachmentSource(f, a.snapshot.runId, 'canonical-record', true), retry = f.memory.newV1Job(a.snapshot.runId, f.memory.version().id);
    assert.equal((await f.memory.organizeV1(retry.id, f.options({ ...a, prepared: filled }, modelFor(noops(filled)).model, { supportedImageMediaTypes: ['image/png'] }))).complete, true);
  } finally { await f.close(); }
});

test('V1 no-op 拒绝观察优先于同 operation 后续重放的 granted 和 finished', async () => {
  const f = fixture();
  try {
    const a = operationSource(f, 'denial-base', 1, false);
    await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(a.prepared)).model));
    const base = { contextId: 'context', runId: 'operation-origin', toolCallId: 'one', receivedAt: at };
    const start = { ...base, seq: 1, kind: 'tool_start' as const, data: { toolName: 'synthetic', args: {} } };
    const b = f.source('denial-late', 2);
    b.prepared = prepareNativeMemorySource({ namespace: 'test', source: b.snapshot, entries: [], gaps: [], events: [start,
      { ...base, seq: 6, kind: 'tool_end', data: { denied: true, isError: false, resultError: false } },
      { ...base, seq: 7, kind: 'approval_state', data: { status: 'declined' } },
    ] });
    assert.equal((await f.memory.organizeV1(b.job.id, f.options(b, modelFor(noops(b.prepared)).model))).changed, false);
    const c = f.source('denial-replay', 3);
    c.prepared = prepareNativeMemorySource({ namespace: 'test', source: c.snapshot, entries: [], gaps: [], events: [start,
      { ...base, seq: 2, kind: 'tool_end', data: { denied: false, isError: false, resultError: false } },
      { ...base, seq: 8, kind: 'approval_state', data: { status: 'approved' } },
    ] });
    const inspect: Step = v => { assert.equal(v.candidate.observations[0]!.toolTerminal, 'denied'); assert.equal(v.candidate.observations[0]!.authorization.state, 'denied'); return noopCoverage(v); };
    await f.memory.organizeV1(c.job.id, f.options(c, modelFor([...noops(c.prepared), inspect]).model));
  } finally { await f.close(); }
});


const memoryRows = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_v1_%' ORDER BY name").all()
  .map(row => [row.name, db.prepare(`SELECT * FROM ${String(row.name)} ORDER BY rowid`).all()]);

test('V1 接收准备的有效前缀与收集义务原子提交，冲突和 SQL trigger 失败不残留', async t => {
  for (const failure of ['body-conflict', 'receipt-trigger', 'collection-trigger', 'deferred-trigger'] as const) await t.test(failure, async () => {
    const f = fixture(true);
    let reopened: DatabaseSync | undefined;
    try {
      const a = f.source(`accepted-${failure}`, 1);
      const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(a.prepared)).model));
      const b = f.source(`prefix-${failure}`, 2), prefixId = b.prepared.records[0]!.id;
      const valid = structuredClone(b.prepared);
      const next = failure === 'body-conflict' ? structuredClone(a.prepared) : f.source(`suffix-${failure}`, 4).prepared;
      if (failure === 'body-conflict') {
        const body = Buffer.from('另一份合成正文。');
        next.records[0]!.contentHash = createHash('sha256').update(body).digest('hex');
        next.contents.get(next.records[0]!.contentRef)!.body = body;
      } else {
        const table = failure === 'receipt-trigger' ? 'memory_v1_receipts' : failure === 'collection-trigger' ? 'memory_v1_collection_refs' : 'memory_v1_deferred';
        const condition = failure === 'deferred-trigger' ? '' : ` WHEN NEW.evidence_id='${next.records[0]!.id}'`;
        f.db.exec(`CREATE TRIGGER reject_collection BEFORE INSERT ON ${table}${condition} BEGIN SELECT RAISE(ABORT, 'synthetic admission failure'); END`);
      }
      includeSource(b.prepared, next);
      const before = memoryRows(f.db), unused = modelFor();
      await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, unused.model)));
      assert.equal(unused.requests.length, 0);
      assert.deepEqual(memoryRows(f.db), before, '失败接收必须同时回滚正文、附件、修订、receipt 和收集义务');
      assert.equal(new MemoryEvidenceLedger(f.db).readEvidence(prefixId), undefined);
      assert.equal(f.memory.version().id, first.version);
      if (failure !== 'body-conflict') f.db.exec('DROP TRIGGER reject_collection');
      reopened = new DatabaseSync(path.join(f.directory, 'runtime.sqlite'));
      const store = new RuntimeStore(reopened), memory = new ProjectMemory(store, f.directory);
      assert.deepEqual(memoryRows(reopened), before);
      const c = f.source(`later-${failure}`, 3);
      const later = await memory.organizeV1(c.job.id, f.options(c, modelFor(noops(c.prepared)).model));
      assert.equal(later.complete, true, '整笔回滚后不能留下孤立 receipt');
      assert.equal(store.setting<Record<string, number>>('memory-watermarks', {}).context, 3);
      const retry = memory.newV1Job(b.snapshot.runId, later.version);
      assert.equal((await memory.organizeV1(retry.id, f.options({ ...b, prepared: valid }, modelFor(noops(valid)).model))).complete, true);
      assert.equal(store.setting<Record<string, number>>('memory-watermarks', {}).context, 3);
    } finally { reopened?.close(); await f.close(); }
  });
});

/** 使用宿主原始 signal 定位及原 assetId，不以文件名作来源身份。 */
function assetGapSource(snapshot: ContextSnapshot, assets: { id: string; filled: boolean }[], contextId = snapshot.contextId, runId = snapshot.runId, recordId = 'signal:synthetic:user-statement') {
  return prepareNativeMemorySource({ namespace: 'test', source: snapshot, entries: [{
    business: { kind: 'user-statement', origin: 'signal', content: '合成附件资料。', provenance: { contextId, runId } },
    location: { contextId, runId, recordId, receivedAt: at, visibleAfter: at },
    original: { text: '合成附件资料。', attachments: assets.map(asset => {
      const bytes = Buffer.from(`合成图片 ${asset.id}`);
      return { id: asset.id, metadata: { name: 'same.png', sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', bytes: bytes.length }, ...(asset.filled ? { bytes } : {}) };
    }) },
  }], events: [], gaps: assets.filter(asset => !asset.filled).map(asset => ({ contextId, runId, messageId: asset.id, reason: 'missing-source' })) });
}

test('V1 Core 同形 assetId 缺口跨重开精确补齐，多附件部分不能提前解除', async () => {
  const f = fixture(true);
  let reopened: DatabaseSync | undefined;
  try {
    const a = f.source('asset-gap', 1), original = structuredClone(a.prepared);
    const missing = assetGapSource(a.snapshot, [{ id: 'asset:one', filled: false }, { id: 'asset:two', filled: false }]);
    includeSource(a.prepared, missing); a.prepared.gaps.push(...missing.gaps);
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model, { supportedImageMediaTypes: ['image/png'] }));
    assert.equal(first.complete, false);
    const plan = f.memory.planV1Recovery(first.version, first.version, '2026-02-01T00:00:00.000Z');
    assert.deepEqual(plan.pendingSourceRuns, [a.snapshot.runId]);
    const partial = assetGapSource(a.snapshot, [{ id: 'asset:one', filled: true }, { id: 'asset:two', filled: false }]);
    const retry = f.memory.newV1Job(a.snapshot.runId, first.version);
    await assert.rejects(f.memory.organizeV1(retry.id, f.options({ ...a, prepared: partial }, modelFor().model, { supportedImageMediaTypes: ['image/png'] })), /memory_source_deferred/);
    assert.equal(pendingRows(f, a.snapshot.runId).gaps.length, 2);
    reopened = new DatabaseSync(path.join(f.directory, 'runtime.sqlite'));
    const store = new RuntimeStore(reopened), memory = new ProjectMemory(store, f.directory);
    const full = assetGapSource(a.snapshot, [{ id: 'asset:one', filled: true }, { id: 'asset:two', filled: true }]);
    const job = memory.newV1Job(a.snapshot.runId, first.version);
    const result = await memory.organizeV1(job.id, f.options({ ...a, prepared: full }, modelFor(noops(full)).model, { supportedImageMediaTypes: ['image/png'] }));
    assert.equal(result.complete, true); assert.equal(result.deferredRecords, 0);
    assert.equal(pendingRows(f, a.snapshot.runId).gaps.length, 0);
    assert.equal(store.setting<Record<string, number>>('memory-watermarks', {}).context, 1);
    const recovered = memory.planV1Recovery(first.version, first.version, '2026-02-01T00:00:00.000Z');
    assert.deepEqual(recovered.pendingSourceRuns, []); assert.deepEqual(recovered.pendingSourceEvidenceIds, []);
    const recoveryJob = memory.newV1Job(a.snapshot.runId, first.version);
    await assert.rejects(memory.organizeV1(recoveryJob.id, f.options({ ...a, prepared: full }, modelFor().model, { supportedImageMediaTypes: ['image/png'] }), plan), /memory_recovery_plan_conflict/);
    const next = memory.newV1Job(a.snapshot.runId, first.version);
    const resultRecovery = await memory.organizeV1(next.id, f.options({ ...a, prepared: full }, modelFor().model, { supportedImageMediaTypes: ['image/png'] }), recovered);
    assert.equal(resultRecovery.complete, true); assert.equal(resultRecovery.generation, first.generation + 1);
  } finally { reopened?.close(); await f.close(); }
});

test('V1 assetId 缺口不被异 context、run、规范来源或同名新文件解除', async t => {
  for (const different of ['context', 'run', 'record', 'asset'] as const) await t.test(different, async () => {
    const f = fixture();
    try {
      const a = f.source(`asset-identity-${different}`, 1), original = structuredClone(a.prepared);
      const missing = assetGapSource(a.snapshot, [{ id: 'asset:original', filled: false }]);
      includeSource(a.prepared, missing); a.prepared.gaps.push(...missing.gaps);
      const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
      const b = f.source(`asset-impostor-${different}`, 2);
      b.prepared = assetGapSource(b.snapshot, [{ id: different === 'asset' ? 'asset:replacement' : 'asset:original', filled: true }], different === 'context' ? 'another-context' : 'context', different === 'run' ? b.snapshot.runId : a.snapshot.runId, different === 'context' ? 'signal:other-context:user-statement' : different === 'run' ? 'signal:other-run:user-statement' : different === 'record' || different === 'asset' ? 'signal:other:user-statement' : undefined);
      const result = await f.memory.organizeV1(b.job.id, f.options(b, modelFor(noops(b.prepared)).model, { supportedImageMediaTypes: ['image/png'] }));
      assert.equal(result.complete, false); assert.equal(pendingRows(f, a.snapshot.runId).gaps.length, 1);
      assert.equal(pendingRows(f, a.snapshot.runId).deferred.length, 1);
      assert.deepEqual(f.memory.planV1Recovery(first.version, first.version, '2026-02-01T00:00:00.000Z').pendingSourceRuns, [a.snapshot.runId]);
    } finally { await f.close(); }
  });
});

test('V1 assetId 补齐的复核失败、错误 bytes 和发布 trigger 回滚不清义务', async t => {
  for (const failure of ['review', 'bytes', 'publish-trigger'] as const) await t.test(failure, async () => {
    const f = fixture(true);
    let reopened: DatabaseSync | undefined;
    try {
      const a = f.source(`asset-failure-${failure}`, 1), original = structuredClone(a.prepared);
      const missing = assetGapSource(a.snapshot, [{ id: 'asset:retry', filled: false }]);
      includeSource(a.prepared, missing); a.prepared.gaps.push(...missing.gaps);
      const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
      const full = assetGapSource(a.snapshot, [{ id: 'asset:retry', filled: true }]);
      const attempted = structuredClone(full), before = pendingRows(f, a.snapshot.runId), processing = processingRow(f);
      if (failure === 'bytes') attempted.contents.get(attempted.records[0]!.contentRef)!.attachments[0]!.bytes = Buffer.from('错误图片');
      if (failure === 'publish-trigger') f.db.exec("CREATE TRIGGER reject_asset_publish BEFORE INSERT ON memory_v1_processing BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END");
      const job = f.memory.newV1Job(a.snapshot.runId, first.version);
      await assert.rejects(f.memory.organizeV1(job.id, f.options({ ...a, prepared: attempted }, modelFor(noops(full), (prompt) => failure === 'review' ? '{"pass":true}' : pass(prompt)).model, { supportedImageMediaTypes: ['image/png'] })));
      assert.deepEqual(pendingRows(f, a.snapshot.runId), before); assert.deepEqual(processingRow(f), processing);
      assert.deepEqual(f.memory.planV1Recovery(first.version, first.version, '2026-02-01T00:00:00.000Z').pendingSourceRuns, [a.snapshot.runId]);
      if (failure === 'publish-trigger') f.db.exec('DROP TRIGGER reject_asset_publish');
      reopened = new DatabaseSync(path.join(f.directory, 'runtime.sqlite'));
      const memory = new ProjectMemory(new RuntimeStore(reopened), f.directory), retry = memory.newV1Job(a.snapshot.runId, first.version);
      assert.equal((await memory.organizeV1(retry.id, f.options({ ...a, prepared: full }, modelFor(noops(full)).model, { supportedImageMediaTypes: ['image/png'] }))).complete, true);
      assert.equal(pendingRows(f, a.snapshot.runId).gaps.length, 0);
    } finally { reopened?.close(); await f.close(); }
  });
});

test('V1 真实 Core 生成原 assetId 缺口，原文件恢复并经 Agent 覆盖后解除', { timeout: 40000 }, async () => {
  const { Core } = await import('../src/core.js');
  const { finished } = await import('./helpers.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-asset-repair-'));
  const main = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] });
    c.enqueue({ type: 'text-start', id: 'main' }); c.enqueue({ type: 'text-delta', id: 'main', delta: '收到合成图片。' }); c.enqueue({ type: 'text-end', id: 'main' });
    c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
  } }) }) });
  const core = await Core.open({ dataDir: directory, model: main, memoryEnabled: false });
  try {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
    const assets: { id: string }[] = [];
    for (let i = 0; i < 2; i++) assets.push(await core.assets.put(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), 'same.png'));
    const sent = await core.submitMessage({ contextId: 'main', content: '请核对合成图片。', attachments: assets.map(asset => asset.id) });
    await finished(core, sent.runId!);
    for (const asset of assets) fs.unlinkSync(path.join(directory, 'assets', asset.id));
    const missing = await core.prepareMemorySource(sent.runId!), memory = core.projectMemory;
    assert.deepEqual([...new Set(missing.gaps.filter(gap => assets.some(asset => asset.id === gap.messageId)).map(gap => gap.messageId))].sort(), assets.map(asset => asset.id).sort());
    const options = (source: PreparedMemorySource, model = modelFor(noops({ ...source, records: source.records.filter(record => record.coverage.status === 'complete') })).model): MemoryV1OrganizeOptions => ({
      expectedHead: memory.version().id, preparedSource: source, cutoff: new Date().toISOString(), policy: createDefaultMemoryContextPolicy(), scopeId: `native:${core.storageId}`, resolveModel: () => model, supportedImageMediaTypes: ['image/png'],
    });
    const first = await memory.organizeV1(memory.newJob(sent.runId!).id, options(missing));
    assert.equal(first.complete, false); assert.equal(first.deferredRecords, 1);
    fs.writeFileSync(path.join(directory, 'assets', assets[0]!.id), bytes, { mode: 0o600 });
    const partial = await core.prepareMemorySource(sent.runId!);
    const second = await memory.organizeV1(memory.newV1Job(sent.runId!, first.version).id, options(partial));
    assert.equal(second.complete, false); assert.equal(second.deferredRecords, 1);
    const row = () => JSON.parse(String(core.store.db.prepare('SELECT body FROM memory_v1_deferred WHERE run_id=?').get(sent.runId!)!.body));
    assert.equal(row().gaps.length, missing.gaps.length, '单条多附件记录未完整送审时不清任一原义务');
    fs.writeFileSync(path.join(directory, 'assets', assets[1]!.id), bytes, { mode: 0o600 });
    const full = await core.prepareMemorySource(sent.runId!);
    const result = await memory.organizeV1(memory.newV1Job(sent.runId!, first.version).id, options(full));
    assert.equal(result.complete, true); assert.equal(result.changed, false); assert.equal(result.deferredRecords, 0);
    assert.equal(row().gaps.length, 0);
    assert.equal(core.runtime.setting<Record<string, number>>('memory-watermarks', {}).main, memory.snapshot(sent.runId!).sequence);
    assert.deepEqual(memory.planV1Recovery(first.version, first.version, new Date().toISOString()).pendingSourceRuns, []);
  } finally { await core.close(); await removeTemp(directory); }
});

test('V1 assetId 补源必须保留原 canonical 与附件引用绑定，空 gaps 不是证明', async t => {
  for (const mismatch of ['context', 'run', 'part-bindings', 'asset-reference'] as const) await t.test(mismatch, async () => {
    const f = fixture();
    try {
      const a = f.source(`asset-proof-${mismatch}`, 1), original = structuredClone(a.prepared);
      const missing = assetGapSource(a.snapshot, [{ id: 'asset:proof', filled: false }]);
      includeSource(a.prepared, missing); a.prepared.gaps.push(...missing.gaps);
      const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
      const full = assetGapSource(a.snapshot, [{ id: 'asset:proof', filled: true }]), attempted = structuredClone(full);
      const record = attempted.records[0]!, canonical = attempted.canonicalRefs.get(record.id)!;
      if (mismatch === 'context') canonical.contextId = 'another-context';
      if (mismatch === 'run') canonical.runId = 'another-run';
      if (mismatch === 'part-bindings') attempted.contents.get(record.contentRef)!.partBindings = null;
      if (mismatch === 'asset-reference') attempted.attachmentRefs.clear();
      const job = f.memory.newV1Job(a.snapshot.runId, first.version), model = modelFor(noops(attempted));
      const result = f.memory.organizeV1(job.id, f.options({ ...a, prepared: attempted }, model.model, { supportedImageMediaTypes: ['image/png'] }));
      if (mismatch === 'asset-reference') assert.equal((await result).complete, false);
      else await assert.rejects(result, mismatch === 'part-bindings' ? /memory_source_deferred/ : /memory_source_identity_conflict/);
      assert.deepEqual([...new Set(pendingRows(f, a.snapshot.runId).deferred.map(row => row.evidenceId))], [full.records[0]!.id]); assert.equal(pendingRows(f, a.snapshot.runId).gaps.length, 1);
      assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
      const retry = f.memory.newV1Job(a.snapshot.runId, first.version);
      assert.equal((await f.memory.organizeV1(retry.id, f.options({ ...a, prepared: full }, modelFor(noops(full)).model, { supportedImageMediaTypes: ['image/png'] }))).complete, true);
    } finally { await f.close(); }
  });
});

test('V1 后缀冲突同时回滚前缀对既有缺附件证据的修订，不丢旧义务', async () => {
  const f = fixture(true);
  let reopened: DatabaseSync | undefined;
  try {
    const a = f.source('atomic-existing', 1), original = structuredClone(a.prepared);
    const missing = assetGapSource(a.snapshot, [{ id: 'asset:existing', filled: false }]);
    includeSource(a.prepared, missing); a.prepared.gaps.push(...missing.gaps);
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
    const b = f.source('atomic-existing-prefix', 2), full = assetGapSource(a.snapshot, [{ id: 'asset:existing', filled: true }]);
    includeSource(b.prepared, full);
    const conflict = structuredClone(original), body = Buffer.from('冲突的合成正文');
    conflict.records[0]!.contentHash = createHash('sha256').update(body).digest('hex');
    conflict.contents.get(conflict.records[0]!.contentRef)!.body = body; includeSource(b.prepared, conflict);
    const before = memoryRows(f.db), unused = modelFor();
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, unused.model, { supportedImageMediaTypes: ['image/png'] })));
    assert.equal(unused.requests.length, 0); assert.deepEqual(memoryRows(f.db), before);
    assert.equal(new MemoryEvidenceLedger(f.db).readEvidence(missing.records[0]!.id)!.coverage.status, 'partial');
    reopened = new DatabaseSync(path.join(f.directory, 'runtime.sqlite'));
    const memory = new ProjectMemory(new RuntimeStore(reopened), f.directory);
    assert.deepEqual(memoryRows(reopened), before);
    const c = f.source('atomic-existing-later', 3);
    assert.equal((await memory.organizeV1(c.job.id, f.options(c, modelFor(noops(c.prepared)).model))).complete, false);
    const job = memory.newV1Job(a.snapshot.runId, first.version);
    assert.equal((await memory.organizeV1(job.id, f.options({ ...a, prepared: full }, modelFor(noops(full)).model, { supportedImageMediaTypes: ['image/png'] }))).complete, true);
  } finally { reopened?.close(); await f.close(); }
});

test('V1 不同原记录的 assetId 缺口逐项结清，完整子集不代替其余附件', async () => {
  const f = fixture();
  try {
    const a = f.source('asset-separate', 1), original = structuredClone(a.prepared);
    const parts = ['one', 'two'].map(id => assetGapSource(a.snapshot, [{ id: `asset:${id}`, filled: false }], 'context', a.snapshot.runId, `signal:${id}:user-statement`));
    for (const part of parts) { includeSource(a.prepared, part); a.prepared.gaps.push(...part.gaps); }
    const first = await f.memory.organizeV1(a.job.id, f.options(a, modelFor(noops(original)).model));
    for (const [index, id] of ['one', 'two'].entries()) {
      const full = assetGapSource(a.snapshot, [{ id: `asset:${id}`, filled: true }], 'context', a.snapshot.runId, `signal:${id}:user-statement`);
      const job = f.memory.newV1Job(a.snapshot.runId, first.version);
      const result = await f.memory.organizeV1(job.id, f.options({ ...a, prepared: full }, modelFor(noops(full)).model, { supportedImageMediaTypes: ['image/png'] }));
      assert.equal(result.complete, index === 1); assert.equal(result.deferredRecords, 1 - index);
      assert.deepEqual(pendingRows(f, a.snapshot.runId).gaps, index === 0 ? [parts[1]!.gaps[0]!] : []);
    }
    assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, 1);
  } finally { await f.close(); }
});


test('V1 发布事务复验同 job 的处理内容与全部锚字段', async t => {
  for (const fault of ['result', 'result-and-head', 'scope_id', 'version_id', 'manifest_hash', 'missing-result'] as const) await t.test(fault, async () => {
    const f = fixture(true);
    try {
      const a = f.source(`commit-anchor-${fault}`, 1);
      await f.memory.organizeV1(a.job.id, f.options(a, modelFor([noopCoverage]).model));
      const previous = f.memory.version(), oldHead = processingRow(f)!;
      const oldResult = String(f.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(a.job.id)!.result_json);
      const coverageBefore = f.db.prepare('SELECT * FROM memory_v1_coverage ORDER BY sequence').all();
      const b = f.source(`commit-next-${fault}`, 2);
      const model = modelFor([noopCoverage], (prompt) => {
        if (fault === 'result' || fault === 'result-and-head') {
          const parsed = JSON.parse(oldResult); parsed.workspace.candidate.coverage[0].rationale = '合成存储故障';
          const changed = JSON.stringify(parsed);
          f.db.prepare('UPDATE memory_v1_processing SET result_json=? WHERE job_id=?').run(changed, a.job.id);
          if (fault === 'result-and-head') f.db.prepare('UPDATE memory_v1_processing_head SET result_hash=? WHERE slot=1').run(createHash('sha256').update(changed).digest('hex'));
        } else if (fault === 'missing-result') f.db.prepare('DELETE FROM memory_v1_processing WHERE job_id=?').run(a.job.id);
        else f.db.prepare(`UPDATE memory_v1_processing_head SET ${fault}=? WHERE slot=1`).run('synthetic:changed-anchor');
        return pass(prompt);
      });
      await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, model.model)), fault === 'result' || fault === 'missing-result' ? /memory_processing_head_invalid/ : /memory_processing_head_conflict/);
      assert.ok(model.reviewCalls > 0, '故障注入在读取基线后的独立复核期间发生');
      assert.deepEqual(f.memory.version(), previous);
      assert.equal(processingRow(f)!.job_id, oldHead.job_id);
      assert.equal(f.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(b.job.id), undefined);
      assert.deepEqual(f.db.prepare('SELECT * FROM memory_v1_coverage ORDER BY sequence').all(), coverageBefore);
      assert.equal(f.memory.jobs().find(row => row.id === b.job.id)!.status, 'failed');
    } finally { await f.close(); }
  });
});

test('V1 发布事务复验正文锚，事务前最后窗口的磁盘故障不发布', async () => {
  const f = fixture(true);
  try {
    const a = f.source('commit-published-anchor', 1);
    await f.memory.organizeV1(a.job.id, f.options(a, modelFor([noopCoverage]).model));
    const previous = f.memory.version(), before = processingRow(f)!;
    const file = path.join(previous.filesDirectory, 'metadata/state.json');
    const operation = f.store.operation.bind(f.store);
    let injected = false;
    f.store.operation = <T>(key: string, request: unknown, action: () => T): T => {
      if (key.startsWith('memory-publication:')) { fs.appendFileSync(file, ' '); injected = true; }
      return operation(key, request, action);
    };
    const b = f.source('commit-published-next', 2), model = modelFor([noopCoverage]);
    await assert.rejects(f.memory.organizeV1(b.job.id, f.options(b, model.model)), /memory_version_hash_mismatch/);
    assert.equal(injected, true); assert.ok(model.reviewCalls > 0);
    assert.deepEqual(f.memory.version(), previous); assert.deepEqual(processingRow(f), before);
    assert.equal(f.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(b.job.id), undefined);
  } finally { await f.close(); }
});
