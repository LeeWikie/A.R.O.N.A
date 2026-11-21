import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { ProjectMemory } from '../src/memory/index.js';
import type { MemoryV1OrganizeOptions } from '../src/memory/index.js';
import { createHash } from 'node:crypto';
import { RuntimeStore } from '../src/runtime-store.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import type { PreparedMemorySource } from '../src/memory/v1/source.js';
import type { MemoryCandidate } from '../src/memory/v1/contracts.js';
import { createDefaultMemoryContextPolicy } from '../src/memory/v1/policy.js';
import { DEFAULT_MEMORY_V1_SOURCE_TEXT_TOKENS } from '../src/memory/v1/organizer.js';
import { memoryReviewCategories } from '../src/memory/v1/review.js';
import { measureMemoryText } from '../src/memory/v1/tokens.js';
import { MemoryEvidenceLedger } from '../src/memory/v1/ledger.js';

const at = '2026-01-01T00:00:00.000Z', cutoff = '2026-02-01T00:00:00.000Z', scopeId = 'synthetic:working-set';
const tokens = (value: unknown) => measureMemoryText(JSON.stringify(value)).textTokens;
function objects(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') { try { return objects(JSON.parse(value)); } catch { return []; } }
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(objects)];
}
function prepared(runId: string, sequence: number, texts: string[]): PreparedMemorySource {
  return prepareNativeMemorySource({ namespace: 'synthetic:working-set', source: { contextId: 'context', runId, sequence }, events: [], gaps: [],
    entries: texts.map((text, index) => ({
      business: { kind: 'user-statement', origin: 'signal', content: text, provenance: { contextId: 'context', runId, signalId: `${runId}:${index}` } },
      location: { contextId: 'context', runId, recordId: `record:${runId}:${index}`, receivedAt: at, visibleAfter: at }, original: { text, attachments: [] },
    })) });
}
function envelope(sources: PreparedMemorySource[]) {
  return { businessEvidence: sources.flatMap(source => source.records.map(record => ({
    evidence: { id: record.id, kind: record.kind, actor: record.actor, origin: record.origin.system, occurredAt: record.occurredAt, timeBasis: record.timeBasis, coverage: record.coverage },
    body: Buffer.from(source.contents.get(record.contentRef)!.body).toString('utf8'), attachments: [],
  }))) };
}
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-working-set-'));
  let db = new DatabaseSync(path.join(directory, 'runtime.sqlite')), store = new RuntimeStore(db), memory = new ProjectMemory(store, directory);
  const policy = createDefaultMemoryContextPolicy();
  const requests: { writer: boolean; packet: unknown; tokens: number }[] = [];
  let serial = 0, latestWriter: unknown, inspectNext = true;
  const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
  const model = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    const rows = objects(request.prompt), packets = rows.filter(row => Array.isArray(row.businessEvidence));
    assert.equal(packets.length, 1, '真实 SDK 请求必须只含一份完整来源包');
    const packet = packets[0]!, writer = !!request.tools?.some(tool => tool.name === 'memory_ready');
    requests.push({ writer, packet: structuredClone(packet), tokens: tokens(packet) });
    if (!writer) {
      assert.equal(request.tools?.length ?? 0, 0); assert.deepEqual(packet, latestWriter, '独立 review 与 writer 真实收到同一来源包');
      const proposal = rows.find(row => row.proposal)?.proposal as { candidate: MemoryCandidate };
      assert.ok(proposal?.candidate);
      for (const record of proposal.candidate.evidence) for (const part of record.coverage.parts) {
        assert.ok(proposal.candidate.coverage.some(row => row.ref.evidenceId === record.id && row.ref.partKey === part.key && !row.decision.startsWith('pending-')));
        assert.ok(proposal.candidate.protectionChecks.some(row => row.ref.evidenceId === record.id && row.ref.partKey === part.key && row.decision !== 'pending-review'));
      }
      const scope = rows.find(row => row.scope)?.scope as { scopeHash: string };
      assert.ok(scope?.scopeHash, '独立复核必须绑定宿主范围，不接受旧全局 pass');
      return finish(JSON.stringify({ schemaVersion: 2, scopeHash: scope.scopeHash, verdict: 'pass', checks: Object.fromEntries(memoryReviewCategories.map(key => [key, true])), issues: [] }));
    }
    latestWriter = structuredClone(packet);
    for (const row of rows.filter(row => typeof row.ok === 'boolean')) assert.notEqual(row.ok, false, '工具操作必须实际成功');
    const views = rows.filter(row => typeof row.draftRevision === 'number' && row.candidate);
    const view = views.at(-1) as { draftRevision: number; candidate: MemoryCandidate } | undefined;
    assert.ok(view, '读取真实 Agent 输入而非复制整理实现');
    const revision = Math.max(...rows.flatMap(row => typeof row.draftRevision === 'number' ? [row.draftRevision] : []));
    const last = request.prompt.at(-1);
    if (last?.role === 'tool' && JSON.stringify(last).includes('"ready":true')) return finish('已核对本批合成资料。');
    const pending = view.candidate.coverage.find(row => row.decision.startsWith('pending-'));
    const name = inspectNext ? 'memory_inspect' : pending ? 'memory_coverage' : 'memory_ready';
    const input = inspectNext ? {} : pending ? { expectedDraftRevision: revision,
      coverage: { ref: pending.ref, decision: 'no-effective-new-information', entryIds: [], rationale: '合成资料没有新增常驻认识' },
      protection: { ref: pending.ref, decision: 'no-protectable-state', entryIds: [], rationale: '合成资料无保护状态' },
    } : { expectedDraftRevision: revision };
    inspectNext = !inspectNext;
    return { content: [{ type: 'tool-call' as const, toolName: name, toolCallId: `work-${++serial}`, input: JSON.stringify(input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    requests, get db() { return db; }, get memory() { return memory; }, get store() { return store; },
    reopen() { db.close(); db = new DatabaseSync(path.join(directory, 'runtime.sqlite')); store = new RuntimeStore(db); memory = new ProjectMemory(store, directory); },
    async organize(source: PreparedMemorySource, sourceTextTokens?: number, extra: Partial<MemoryV1OrganizeOptions> = {}) {
      memory.archive({ ...source.source, modelProfile: 'synthetic', createdAt: at, prompt: [], nativeMessages: [], providerOptions: {} });
      const job = memory.newV1Job(source.source.runId, memory.version().id); memory.bind(job.id, `synthetic:${job.id}`);
      return memory.organizeV1(job.id, { expectedHead: memory.version().id, preparedSource: source, scopeId, cutoff, policy, sourceTextTokens, resolveModel: () => model, ...extra });
    },
  };
}
async function saturate(f: ReturnType<typeof fixture>) {
  const sources: PreparedMemorySource[] = [], limit = DEFAULT_MEMORY_V1_SOURCE_TEXT_TOKENS;
  for (let round = 1; round <= 4; round++) {
    let lo = 1, hi = round === 4 ? limit / 2 : Math.floor(limit / 4) - 200;
    if (round === 4) while (lo < hi) {
      const n = Math.ceil((lo + hi) / 2), source = prepared(`round-${round}`, round, ['word '.repeat(n)]);
      if (tokens(envelope([...sources, source])) <= limit - 8) lo = n; else hi = n - 1;
    }
    else lo = hi;
    const source = prepared(`round-${round}`, round, ['word '.repeat(lo)]);
    assert.ok(tokens(envelope([source])) < limit / 2);
    const result = await f.organize(source); assert.equal(result.complete, true); assert.equal(result.processedRecords, 1);
    if (round > 1) assert.equal(result.changed, false);
    sources.push(source);
  }
  assert.ok(limit - tokens(envelope(sources)) <= 12, '保持实际默认额度下的累计饱和反例');
  return sources;
}

test('默认来源额度饱和后，独立 tiny 来源继续经真实工具与 review 完成', async t => {
  const f = fixture(t), sources = await saturate(f), oldHead = f.memory.version().id;
  const evidenceBefore = f.db.prepare('SELECT * FROM memory_v1_evidence ORDER BY id').all();
  const coverageBefore = f.db.prepare('SELECT * FROM memory_v1_coverage ORDER BY sequence').all();
  const tiny = prepared('tiny', 5, ['合成小记录。']); assert.ok(tokens(envelope([tiny])) < 256);
  const result = await f.organize(tiny);
  assert.equal(result.complete, true); assert.equal(result.processedRecords, 1); assert.equal(result.changed, false); assert.equal(result.version, oldHead);
  const ledger = new MemoryEvidenceLedger(f.db);
  for (const source of sources) for (const record of source.records) assert.equal(ledger.readContent(record.id), Buffer.from(source.contents.get(record.contentRef)!.body).toString('utf8'));
  for (const old of evidenceBefore) assert.deepEqual(f.db.prepare('SELECT * FROM memory_v1_evidence WHERE id=?').get(String(old.id)), old);
  for (const old of coverageBefore) assert.deepEqual(f.db.prepare('SELECT * FROM memory_v1_coverage WHERE sequence=?').get(Number(old.sequence)), old);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_coverage').get()!.n, coverageBefore.length + 1, '继承旧覆盖不能生成伪重审记录');
  assert.ok(f.requests.every(row => row.tokens <= DEFAULT_MEMORY_V1_SOURCE_TEXT_TOKENS));
});

test('同预算第二轮跳过已完成重放，实际推进同批余项', async t => {
  const f = fixture(t), source = prepared('two', 1, ['word '.repeat(350), 'word '.repeat(350)]);
  const budget = tokens(envelope([source])) - 1;
  for (const record of source.records) assert.ok(tokens(envelope([{ ...source, records: [record] }])) < budget);
  const first = await f.organize(source, budget); assert.equal(first.processedRecords, 1); assert.equal(first.complete, false);
  const second = await f.organize(source, budget);
  assert.equal(second.complete, true); assert.equal(second.processedRecords, 1); assert.equal(second.deferredRecords, 0);
  assert.equal(new MemoryEvidenceLedger(f.db).listPending(scopeId, cutoff).length, 0);
  const third = await f.organize(source, budget); assert.equal(third.processedRecords, 0, '完成重放不是新进度');
});

test('新资料连续 no-op 不因历史正文与元数据增长耗尽本轮额度', async t => {
  const f = fixture(t);
  let head: string | undefined;
  for (let i = 0; i < 24; i++) {
    const source = prepared(`noop-${i}`, i + 1, [`合成资料 ${i}。${'word '.repeat(100)}`]);
    const result = await f.organize(source, 600);
    assert.equal(result.complete, true); assert.equal(result.processedRecords, 1);
    if (head) { assert.equal(result.version, head); assert.equal(result.changed, false); }
    head = result.version;
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_evidence').get()!.n, 24);
  assert.equal(f.requests.filter(row => !row.writer).length, 24, '每条新 no-op 必须有独立复核');
  assert.ok(f.requests.every(row => row.tokens <= 600));
});

test('重启后从可信 processing 续进，不重新累计旧正文预算', async t => {
  const f = fixture(t); await saturate(f); const published = f.memory.version();
  f.reopen(); assert.deepEqual(f.memory.version(), published);
  const result = await f.organize(prepared('after-restart', 5, ['重启后的独立合成小记录。']));
  assert.equal(result.complete, true); assert.equal(result.processedRecords, 1); assert.equal(result.version, published.id);
});

test('空批不结清巨项待办，也不虚增完成记录', async t => {
  const f = fixture(t), large = prepared('large-and-small', 1, ['word '.repeat(1000), '小记录']);
  const partial = await f.organize(large, 600); assert.equal(partial.complete, false); assert.equal(partial.processedRecords, 1);
  const empty = await f.organize(prepared('empty', 2, []), 600);
  assert.equal(empty.complete, false); assert.equal(empty.processedRecords, 0); assert.equal(empty.deferredRecords, 1);
  assert.equal(f.store.setting<Record<string, number>>('memory-watermarks', {}).context, undefined);
});

// 工作集门禁直接接生产 workspace；来源仍通过 SQLite 账本的规范接收入口。
async function guardedFixture(t: test.TestContext, preflight?: (ids: readonly string[]) => void, selected = [2]) {
  const { MemoryWorkspace } = await import('../src/memory/v1/workspace.js');
  const { MemoryWorkingSet } = await import('../src/memory/v1/working-set.js');
  const { prepareMemoryV1Batch } = await import('../src/memory/v1/organizer.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-workspace-set-'));
  const db = new DatabaseSync(path.join(directory, 'runtime.sqlite')); new RuntimeStore(db);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ledger = new MemoryEvidenceLedger(db), source = prepared('guarded', 1, ['旧呈现偏好', '旧关系依据', '新的独立资料']);
  const batch = prepareMemoryV1Batch(source, ledger, scopeId, cutoff);
  const ref = (n: number) => ({ evidenceId: batch.records[n]!.id, partKey: batch.records[n]!.coverage.parts[0]!.key });
  let serial = 0;
  const base = { baseVersion: null, batchId: 'initial', auditedAt: cutoff, previousEntries: [], evidence: batch.records, observations: [],
    organizations: [{ id: 'root', title: '合成事项', parentId: null, entryIds: [] }], entities: [], supportGroups: batch.groups,
    clock: () => cutoff, createId: (kind: string) => `${kind}:${++serial}` };
  const initial = new MemoryWorkspace(base);
  const subject = initial.createEntity(initial.draftRevision, { kind: 'other', name: '合成展台', aliases: [], identityEvidence: [ref(0)] }, '资料身份').result.id;
  const entry = (n: number) => ({ text: `合成呈现偏好${n}`, nature: 'preference' as const, certainty: 'reported' as const, lifecycle: 'current' as const,
    scope: { subjectId: subject, dimension: `display${n}`, qualifier: '合成展台' }, validFrom: at, validTo: null,
    retention: { score: 2 as const, rationale: '呈现用途' }, protectionAssessment: { decision: 'ineligible' as const, evidence: [ref(n)], rationale: '普通偏好' }, protection: { mode: 'none' as const },
    followup: { attention: 'none' as const, outcome: 'unknown' as const, outcomeEvidence: [] }, evidence: [{ ref: ref(n), role: 'supports' as const }],
    primaryNodeId: 'root', relatedNodeIds: [], entityIds: [subject], abstraction: 'episode' as const, derivedFromEntryIds: [], placement: 'resident' as const, detailRefs: [] as string[], replacedBy: [],
  });
  const first = initial.createEntry(initial.draftRevision, { ...entry(0), detailRefs: ['detail:old'] }, '保留旧认识').result;
  const second = initial.createEntry(initial.draftRevision, entry(1), '关联旧认识').result;
  for (let n = 0; n < 2; n++) initial.decideCoverage(initial.draftRevision,
    { ref: ref(n), decision: 'retained', entryIds: [n ? second.id : first.id], rationale: '旧版已核对' },
    { ref: ref(n), decision: 'no-protectable-state', entryIds: [], rationale: '旧版无保护状态' });
  const inherited = initial.export().candidate;
  let set: InstanceType<typeof MemoryWorkingSet>;
  const workspace = new MemoryWorkspace({ ...base, baseVersion: 'published', batchId: 'next', previousEntries: inherited.entries,
    entities: inherited.entities, organizations: inherited.organizations, relations: inherited.relations, overrides: inherited.overrides,
    inherited: { coverage: inherited.coverage.filter(row => row.ref.evidenceId !== ref(2).evidenceId), protectionChecks: inherited.protectionChecks.filter(row => row.ref.evidenceId !== ref(2).evidenceId) },
    assertMutation: (before, after) => set.assertMutation(before, after),
  });
  const details = [{ id: 'detail:old', content: '完整合成细节，保留 CRLF\r\n与空白  。' }];
  set = new MemoryWorkingSet({ anchor: { published: { id: 'published', manifestHash: 'a'.repeat(64) }, processing: null, scopeId, cutoff, policyDigest: 'b'.repeat(64) },
    baseline: workspace.export().candidate, details, selectedEvidenceIds: selected.map(n => ref(n).evidenceId),
    preflight: packet => { for (const id of packet.evidenceIds) assert.ok(ledger.readContent(id)); preflight?.(packet.evidenceIds); },
  });
  return { workspace, set, ledger, ref, first, second, entry, details, subject };
}

test('工作集 seed 保留旧覆盖原句，不增修订或伪审计；投影明确不是完整候选', async t => {
  const f = await guardedFixture(t), state = f.workspace.export();
  assert.equal(state.draftRevision, 0); assert.deepEqual(state.audit, []);
  assert.equal(state.candidate.coverage[0]!.rationale, '旧版已核对');
  const view = f.set.project(state.candidate, state.draftRevision) as { projectionVersion: number; completeCandidate: boolean; candidate: MemoryCandidate };
  assert.equal(view.projectionVersion, 2); assert.equal(view.completeCandidate, false);
  assert.deepEqual(view.candidate.entries, []); assert.equal(view.candidate.evidence.length, 1);
  assert.equal(view.candidate.coverage.length, 1);
});

test('未送达原件时不能编辑旧认识；open 同一步不授权，下一实际曝光后才成功', async t => {
  const f = await guardedFixture(t), before = f.workspace.export();
  const update = () => f.workspace.updateEntry(0, f.first.id, f.first.revision, { ...f.entry(0), text: '修改合成偏好', detailRefs: ['detail:old'] }, '调整');
  assert.throws(update, /memory_working_set_needs_evidence/); assert.deepEqual(f.workspace.export(), before);
  const handle = f.set.handles().find(row => row.collection === 'entries' && row.identity === f.first.id)!.handle;
  const opened = f.set.open(handle);
  assert.equal(opened.status, 'queued'); assert.throws(update, /memory_working_set_needs_evidence/); assert.deepEqual(f.workspace.export(), before);
  const packet = f.set.packet(); assert.equal(packet.details[0]!.content, f.details[0]!.content);
  assert.ok(packet.evidenceIds.includes(f.ref(0).evidenceId)); assert.ok(!packet.evidenceIds.includes(f.ref(1).evidenceId), '仅引用共享主体身份不强制读取无关事实');
  f.set.writerSent(packet.packetHash); update(); assert.equal(f.workspace.draftRevision, 1);
});

test('依赖容量拒绝不改变包、候选、修订、审计或旧详情', async t => {
  const f = await guardedFixture(t, ids => { if (ids.length > 1) throw new Error('synthetic-capacity'); });
  const packet = f.set.packet(), state = f.workspace.export(), details = structuredClone(f.details);
  const handle = f.set.handles().find(row => row.collection === 'entries' && row.identity === f.first.id)!.handle;
  assert.throws(() => f.set.open(handle), /synthetic-capacity/);
  assert.deepEqual(f.set.packet(), packet); assert.deepEqual(f.workspace.export(), state); assert.deepEqual(f.details, details);
  for (const forged of ['/tmp/anything', 'https://example.invalid', 'SELECT * FROM memory_v1_evidence', `object:${'0'.repeat(64)}`]) assert.throws(() => f.set.open(forged), /memory_working_set_unknown_handle/);
});

test('反向 coverage、保护、实体、组织语义、关系和详情后门在安装前拒绝', async t => {
  const f = await guardedFixture(t), before = f.workspace.export();
  f.set.writerSent(f.set.packet().packetHash);
  const changes: ((candidate: MemoryCandidate) => void)[] = [
    candidate => { candidate.coverage.find(row => row.ref.evidenceId === f.ref(2).evidenceId)!.entryIds = [f.first.id]; },
    candidate => { candidate.protectionChecks.find(row => row.ref.evidenceId === f.ref(0).evidenceId)!.rationale = '改变旧保护'; },
    candidate => { candidate.entities[0]!.name = '改变身份'; },
    candidate => { candidate.organizations[0]!.title = '改变主题语义'; },
    candidate => { candidate.entries[0]!.text = '改变旧正文'; },
    candidate => { candidate.relations.push({ id: 'relation:forged', subjectId: f.subject, objectId: f.subject, kind: '关联', entryId: f.first.id, validFrom: at, validTo: null }); },
  ];
  for (const change of changes) { const after = structuredClone(before.candidate); change(after); assert.throws(() => f.set.assertMutation(before.candidate, after), /memory_working_set_needs_evidence/); assert.deepEqual(f.workspace.export(), before); }
  assert.throws(() => f.set.assertDetails(f.details, [{ ...f.details[0]!, content: '改写未见详情' }], before.candidate), /memory_working_set_needs_detail/);
  assert.throws(() => f.workspace.updateEntity(0, f.subject, { kind: 'other', name: '改名', aliases: [], identityEvidence: [f.ref(0)] }, '更新'), /memory_working_set_needs_evidence/);
  assert.deepEqual(f.workspace.export(), before, '实际逻辑工具走安装前守卫，不只测独立比对函数');
});

test('只有本轮实核 refs 可生成覆盖记账，旧域继承不变且伪 pass 不越权', async t => {
  const f = await guardedFixture(t); f.set.writerSent(f.set.packet().packetHash);
  f.workspace.decideCoverage(0, { ref: f.ref(2), decision: 'no-effective-new-information', entryIds: [], rationale: '独立新资料无新增认识' },
    { ref: f.ref(2), decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' });
  const candidate = f.workspace.export().candidate, scope = f.set.freeze(candidate, f.details);
  const response = (scopeHash = scope.scopeHash, verdict = 'pass') => JSON.stringify({ schemaVersion: 2, scopeHash, verdict, checks: Object.fromEntries(memoryReviewCategories.map(key => [key, true])), issues: [] });
  assert.equal(scope.changes.length, 2); assert.deepEqual(scope.obligations, [f.ref(2)]);
  assert.throws(() => f.set.acceptReview(response(), candidate, f.details), /memory_working_set_review_conflict/);
  f.set.reviewerSent(scope.scopeHash, scope.packetHash);
  assert.throws(() => f.set.auditedDecisions(candidate, f.details, scope.scopeHash), /memory_working_set_review_conflict/);
  assert.throws(() => f.set.acceptReview(JSON.stringify({ pass: true, checks: Object.fromEntries(memoryReviewCategories.map(key => [key, true])), issues: [] }), candidate, f.details), /memory_semantic_review_invalid/);
  assert.throws(() => f.set.acceptReview(response('0'.repeat(64)), candidate, f.details), /memory_semantic_review_invalid/);
  f.set.acceptReview(response(scope.scopeHash, 'insufficient-evidence'), candidate, f.details);
  assert.throws(() => f.set.auditedDecisions(candidate, f.details, scope.scopeHash), /memory_working_set_review_conflict/);
  f.set.acceptReview(response(), candidate, f.details);
  assert.deepEqual(f.set.auditedDecisions(candidate, f.details, scope.scopeHash).map(row => row.ref), [f.ref(2)]);
  const changed = structuredClone(candidate); changed.coverage[0]!.rationale = '复核后篡改';
  assert.throws(() => f.set.auditedDecisions(changed, f.details, scope.scopeHash), /memory_working_set_review_conflict/);
  const oldHandle = f.set.handles().find(row => row.collection === 'entries' && row.identity === f.first.id)!.handle;
  f.set.open(oldHandle); assert.throws(() => f.set.auditedDecisions(candidate, f.details, scope.scopeHash), /memory_working_set_review_conflict/);
});

test('真实 Agent 工具与无工具 scoped review 在最后 SDK 边界登记同一实际包', async t => {
  const { Agent } = await import('@mastra/core/agent');
  const { createMemoryV1Tools } = await import('../src/memory/v1/tools.js');
  const { MemoryRequestBudget } = await import('../src/memory/v1/request-budget.js');
  const { reviewScopedMemoryCandidate } = await import('../src/memory/v1/review.js');
  const f = await guardedFixture(t), packet = f.set.packet(), budget = new MemoryRequestBudget();
  const evidence = { businessEvidence: packet.evidenceIds.map(id => ({ id, body: f.ledger.readContent(id) })) };
  const evidencePrompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: JSON.stringify(evidence) }] }];
  let writerCalls = 0, reviewCalls = 0;
  let scope: ReturnType<typeof f.set.freeze> | undefined;
  const raw = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    const packets = objects(request.prompt).filter(row => Array.isArray(row.businessEvidence));
    assert.deepEqual(packets, [evidence]);
    const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
    if (!(request.tools?.length)) {
      reviewCalls++; assert.ok(scope); assert.equal(request.tools?.length ?? 0, 0);
      return finish(JSON.stringify({ schemaVersion: 2, scopeHash: scope.scopeHash, verdict: 'pass', checks: Object.fromEntries(memoryReviewCategories.map(key => [key, true])), issues: [] }));
    }
    writerCalls++;
    for (const row of objects(request.prompt).filter(row => typeof row.ok === 'boolean')) assert.equal(row.ok, true);
    if (writerCalls > 2) return finish('合成资料已核对。');
    const toolName = writerCalls === 1 ? 'memory_coverage' : 'memory_ready';
    const input = writerCalls === 1 ? { expectedDraftRevision: 0,
      coverage: { ref: f.ref(2), decision: 'no-effective-new-information', entryIds: [], rationale: '无新增' },
      protection: { ref: f.ref(2), decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' },
    } : { expectedDraftRevision: 1 };
    return { content: [{ type: 'tool-call' as const, toolName, toolCallId: `scoped-${writerCalls}`, input: JSON.stringify(input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  const controller = createMemoryV1Tools(f.workspace, f.details);
  const writer = new Agent({ id: 'guarded-writer', name: '合成写者', instructions: '仅核对合成证据。',
    model: budget.wrap(raw, { onRequest: () => f.set.writerSent(packet.packetHash) }), tools: controller.tools,
    inputProcessors: [{ id: 'synthetic-packet', processLLMRequest: args => ({ prompt: [...evidencePrompt, ...args.prompt] }) }],
  });
  await writer.generate(JSON.stringify(f.set.project(f.workspace.export().candidate, 0)), { maxSteps: 4 });
  assert.equal(controller.isReady(), true); assert.equal(writerCalls, 3);
  const candidate = f.workspace.export().candidate; scope = f.set.freeze(candidate, f.details);
  const reviewed = await reviewScopedMemoryCandidate({
    model: raw, budget, onRequest: () => f.set.reviewerSent(scope!.scopeHash, packet.packetHash), providerOptions: {}, candidate,
    scope: { scopeHash: scope.scopeHash, evidenceIds: packet.evidenceIds, entryIds: [] },
    baseline: { inheritedHash: scope.inheritedHash }, proposal: { changes: scope.changes, obligations: scope.obligations }, evidencePrompt,
  });
  f.set.acceptReview(reviewed.text, candidate, f.details);
  assert.equal(reviewCalls, 1); assert.equal(budget.receipts().length, 4);
  assert.deepEqual(f.set.auditedDecisions(candidate, f.details, scope.scopeHash).map(row => row.ref), [f.ref(2)]);
});

test('宿主页游标绑定工作集、资料包、节与修订；不能重放旧页扩大可见域', async t => {
  const f = await guardedFixture(t), other = await guardedFixture(t);
  const page = f.set.pageHandles({ revision: 0 });
  assert.equal(page.complete, false); assert.equal(page.items.length, 8); assert.ok(page.nextCursor);
  assert.ok(tokens(page) <= 2048);
  const next = f.set.pageHandles({ revision: 0, cursor: page.nextCursor! }); assert.ok(next.items.length > 0);
  assert.throws(() => f.set.pageHandles({ revision: 1, cursor: page.nextCursor! }), /memory_working_set_cursor_invalid/);
  assert.throws(() => f.set.pageHandles({ revision: 0, collection: 'entries', cursor: page.nextCursor! }), /memory_working_set_cursor_invalid/);
  assert.throws(() => other.set.pageHandles({ revision: 0, cursor: page.nextCursor! }), /memory_working_set_cursor_invalid/);
  assert.throws(() => other.set.open(page.items[0]!.handle), /memory_working_set_unknown_handle/);
  f.set.writerSent(f.set.packet().packetHash);
  f.workspace.decideCoverage(0, { ref: f.ref(2), decision: 'no-effective-new-information', entryIds: [], rationale: '无新增' },
    { ref: f.ref(2), decision: 'no-protectable-state', entryIds: [], rationale: '无保护' });
  assert.throws(() => f.set.pageHandles({ revision: 0, cursor: page.nextCursor! }), /memory_working_set_cursor_invalid/);
});

test('模型不能借修改宿主前提或来源框架洗掉不可见旧域', async t => {
  const f = await guardedFixture(t), candidate = f.workspace.export().candidate;
  for (const edit of [
    (copy: MemoryCandidate) => { copy.previousEntries = []; },
    (copy: MemoryCandidate) => { copy.batchId = 'forged'; },
    (copy: MemoryCandidate) => { copy.auditedAt = at; },
    (copy: MemoryCandidate) => { copy.evidence = copy.evidence.slice(1); },
    (copy: MemoryCandidate) => { copy.observations = [{ id: 'forged' }] as MemoryCandidate['observations']; },
  ]) {
    const copy = structuredClone(candidate); edit(copy);
    assert.throws(() => f.set.assertMutation(candidate, copy), /memory_working_set_frozen_source/);
  }
  assert.deepEqual(f.workspace.export().candidate, candidate);
});


test('旧 coverage 删除原映射前必须打开并送达旧条目及详情', async t => {
  const { createMemoryV1Tools } = await import('../src/memory/v1/tools.js');
  const f = await guardedFixture(t, undefined, [0, 2]);
  const controller = createMemoryV1Tools(f.workspace, f.details);
  f.set.writerSent(f.set.packet().packetHash);
  const before = f.workspace.export(), details = controller.details();
  const input = { expectedDraftRevision: 0,
    coverage: { ref: f.ref(0), decision: 'no-effective-new-information' as const, entryIds: [], rationale: '重新核对无新增' },
    protection: { ref: f.ref(0), decision: 'no-protectable-state' as const, entryIds: [], rationale: '旧版无保护状态' },
  };
  const result = await controller.tools.memory_coverage.execute!(input, {} as never) as { ok: boolean; error?: string };
  assert.deepEqual(result, { ok: false, error: 'memory_working_set_needs_evidence', validation: undefined });
  assert.deepEqual(f.workspace.export(), before); assert.deepEqual(controller.details(), details);
  const handle = f.set.handles().find(row => row.collection === 'coverage' && row.identity === JSON.stringify(f.ref(0)))!.handle;
  f.set.open(handle);
  assert.deepEqual(await controller.tools.memory_coverage.execute!(input, {} as never), result, '仅 open 仍不能删除旧映射');
  f.set.writerSent(f.set.packet().packetHash);
  assert.ok(f.set.packet().details.some(row => row.id === 'detail:old' && row.content === f.details[0]!.content));
  const success = await controller.tools.memory_coverage.execute!(input, {} as never) as { ok: boolean };
  assert.equal(success.ok, true); assert.equal(f.workspace.draftRevision, 1);
});

test('详情工具在安装前核对容量和旧域，拒绝时保留候选审计与详情', async t => {
  const { createMemoryV1Tools } = await import('../src/memory/v1/tools.js');
  const f = await guardedFixture(t);
  const controller = createMemoryV1Tools(f.workspace, f.details, { assertDetails: (before, after, candidate) => f.set.assertDetails(before, after, candidate) });
  const input = { expectedDraftRevision: 0, entryId: f.first.id, expectedEntryRevision: f.first.revision,
    rationale: '更新合成细节', detailId: 'detail:old', content: '短小合成更新' };
  const before = f.workspace.export(), details = controller.details();
  const denied = await controller.tools.memory_detail_put.execute!(input, {} as never) as { ok: boolean; error?: string };
  assert.equal(denied.ok, false); assert.equal(denied.error, 'memory_working_set_needs_evidence');
  assert.deepEqual(f.workspace.export(), before); assert.deepEqual(controller.details(), details);
  f.set.open(f.set.handles().find(row => row.collection === 'entries' && row.identity === f.first.id)!.handle);
  f.set.writerSent(f.set.packet().packetHash);
  for (const detailId of ['detail:old', null]) {
    const denied = await controller.tools.memory_detail_put.execute!({ ...input, detailId, content: 'longword '.repeat(12000) }, {} as never) as { ok: boolean; error?: string };
    assert.equal(denied.ok, false); assert.equal(denied.error, 'memory_model_object_capacity');
    assert.deepEqual(f.workspace.export(), before); assert.deepEqual(controller.details(), details);
  }
  const success = await controller.tools.memory_detail_put.execute!(input, {} as never) as { ok: boolean };
  assert.equal(success.ok, true); assert.equal(f.workspace.draftRevision, 1);
  assert.equal(f.workspace.export().audit.length, before.audit.length + 1);
  assert.equal(controller.details().find(row => row.id === 'detail:old')!.content, input.content);
});

test('未接工作集的详情工具也原子拒绝单对象超额', async t => {
  const { createMemoryV1Tools } = await import('../src/memory/v1/tools.js');
  const f = await guardedFixture(t);
  f.set.open(f.set.handles().find(row => row.collection === 'entries' && row.identity === f.first.id)!.handle); f.set.writerSent(f.set.packet().packetHash);
  const controller = createMemoryV1Tools(f.workspace, f.details), before = f.workspace.export(), details = controller.details();
  const result = await controller.tools.memory_detail_put.execute!({ expectedDraftRevision: 0, entryId: f.first.id, expectedEntryRevision: f.first.revision,
    rationale: '更新合成细节', detailId: 'detail:old', content: 'longword '.repeat(12000) }, {} as never) as { ok: boolean; error?: string };
  assert.equal(result.ok, false); assert.equal(result.error, 'memory_model_object_capacity');
  assert.deepEqual(f.workspace.export(), before); assert.deepEqual(controller.details(), details);
});


test('选中旧来源但未改变映射时，同样不能把未打开的依赖记为实核', async t => {
  const f = await guardedFixture(t, undefined, [0, 2]);
  f.set.writerSent(f.set.packet().packetHash);
  f.workspace.decideCoverage(0, { ref: f.ref(2), decision: 'no-effective-new-information', entryIds: [], rationale: '无新增' },
    { ref: f.ref(2), decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' });
  const candidate = f.workspace.export().candidate;
  assert.throws(() => f.set.freeze(candidate, f.details), /memory_working_set_needs_evidence/);
  f.set.open(f.set.handles().find(row => row.collection === 'coverage' && row.identity === JSON.stringify(f.ref(0)))!.handle);
  f.set.writerSent(f.set.packet().packetHash);
  const scope = f.set.freeze(candidate, f.details);
  assert.deepEqual(scope.obligations, [f.ref(0), f.ref(2)]);
});

test('详情安装回调拒绝时不产生修订审计，允许随后合法重试', async t => {
  const { createMemoryV1Tools } = await import('../src/memory/v1/tools.js');
  const { MemoryWorkspaceError } = await import('../src/memory/v1/workspace.js');
  const f = await guardedFixture(t);
  f.set.open(f.set.handles().find(row => row.collection === 'entries' && row.identity === f.first.id)!.handle); f.set.writerSent(f.set.packet().packetHash);
  let reject = true, observed = false;
  const controller = createMemoryV1Tools(f.workspace, f.details, { assertDetails: (_before, after, candidate) => {
    observed = true;
    assert.ok(after.some(row => row.content === '合成短详情'));
    const next = candidate.entries.find(row => row.id === f.first.id)!;
    assert.equal(next.revision, f.first.revision + 1);
    assert.equal(f.workspace.draftRevision, 0, '回调检查真实新候选时，原候选尚未安装');
    if (reject) throw new MemoryWorkspaceError('synthetic_detail_rejected');
  } });
  const before = f.workspace.export(), details = controller.details();
  const input = { expectedDraftRevision: 0, entryId: f.first.id, expectedEntryRevision: f.first.revision,
    rationale: '更新合成细节', detailId: 'detail:old', content: '合成短详情' };
  const result = await controller.tools.memory_detail_put.execute!(input, {} as never) as { ok: boolean; error?: string };
  assert.equal(observed, true); assert.equal(result.ok, false); assert.equal(result.error, 'synthetic_detail_rejected');
  assert.deepEqual(f.workspace.export(), before); assert.deepEqual(controller.details(), details);
  reject = false;
  assert.equal((await controller.tools.memory_detail_put.execute!(input, {} as never) as { ok: boolean }).ok, true);
  assert.equal(f.workspace.draftRevision, 1);
});

test('真实 Agent 删除旧 coverage 映射被原子拒绝，完整曝光后仍能通过独立复核', async t => {
  const { Agent } = await import('@mastra/core/agent');
  const { createMemoryV1Tools } = await import('../src/memory/v1/tools.js');
  const { MemoryRequestBudget } = await import('../src/memory/v1/request-budget.js');
  const { reviewScopedMemoryCandidate } = await import('../src/memory/v1/review.js');
  const f = await guardedFixture(t, undefined, [0, 2]);
  const controller = createMemoryV1Tools(f.workspace, f.details), budget = new MemoryRequestBudget();
  const before = f.workspace.export();
  let allowed = false, serial = 0, reviewed = false;
  let scope: ReturnType<typeof f.set.freeze>;
  const packetPrompt = () => [{ role: 'user' as const, content: [{ type: 'text' as const, text: JSON.stringify({
    businessEvidence: f.set.packet().evidenceIds.map(id => ({ id, body: f.ledger.readContent(id) })), details: f.set.packet().details,
  }) }] }];
  const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
  const raw = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    if (!request.tools?.length) {
      reviewed = true;
      assert.ok(JSON.stringify(request.prompt).includes(f.first.text));
      assert.ok(objects(request.prompt).some(row => row.content === f.details[0]!.content), '独立复核确实收到完整旧详情');
      return finish(JSON.stringify({ schemaVersion: 2, scopeHash: scope.scopeHash, verdict: 'pass', checks: Object.fromEntries(memoryReviewCategories.map(key => [key, true])), issues: [] }));
    }
    const result = objects(request.prompt).find(row => typeof row.ok === 'boolean');
    if (result) {
      assert.equal(result.ok, allowed);
      if (!allowed) assert.equal(result.error, 'memory_working_set_needs_evidence');
      return finish('本次工具调用结束。');
    }
    return { content: [{ type: 'tool-call' as const, toolName: 'memory_coverage', toolCallId: `dependency-${++serial}`, input: JSON.stringify({ expectedDraftRevision: 0,
      coverage: { ref: f.ref(0), decision: 'no-effective-new-information', entryIds: [], rationale: '完整核对后无新增' },
      protection: { ref: f.ref(0), decision: 'no-protectable-state', entryIds: [], rationale: '旧版无保护状态' },
    }) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  const writer = new Agent({ id: 'reverse-dependency-regression', name: '合成写者', instructions: '核对合成资料。', tools: controller.tools,
    model: budget.wrap(raw, { onRequest: () => f.set.writerSent(f.set.packet().packetHash) }),
    inputProcessors: [{ id: 'actual-dependencies', processLLMRequest: args => ({ prompt: [...packetPrompt(), ...args.prompt] }) }],
  });
  await writer.generate(JSON.stringify(f.set.project(before.candidate, 0)), { maxSteps: 3 });
  assert.deepEqual(f.workspace.export(), before); assert.deepEqual(controller.details(), f.details);
  f.set.open(f.set.handles().find(row => row.collection === 'coverage' && row.identity === JSON.stringify(f.ref(0)))!.handle);
  allowed = true;
  await writer.generate(JSON.stringify(f.set.project(f.workspace.export().candidate, 0)), { maxSteps: 3 });
  assert.equal(f.workspace.draftRevision, 1);
  f.workspace.decideCoverage(1, { ref: f.ref(2), decision: 'no-effective-new-information', entryIds: [], rationale: '新资料无新增' },
    { ref: f.ref(2), decision: 'no-protectable-state', entryIds: [], rationale: '无保护状态' });
  const candidate = f.workspace.export().candidate; scope = f.set.freeze(candidate, controller.details());
  const packet = f.set.packet();
  const review = await reviewScopedMemoryCandidate({ model: raw, budget, providerOptions: {}, candidate,
    onRequest: () => f.set.reviewerSent(scope.scopeHash, packet.packetHash), evidencePrompt: packetPrompt(),
    scope: { scopeHash: scope.scopeHash, entryIds: candidate.entries.map(row => row.id), evidenceIds: packet.evidenceIds },
    baseline: { projection: f.set.project(before.candidate, 0), inheritedHash: scope.inheritedHash }, proposal: { changes: scope.changes, obligations: scope.obligations },
  });
  assert.equal(reviewed, true); f.set.acceptReview(review.text, candidate, controller.details());
  assert.ok(f.set.auditedDecisions(candidate, controller.details(), scope.scopeHash).some(row => row.ref.evidenceId === f.ref(0).evidenceId));
  assert.equal(budget.receipts().length, 5, '两个真实 writer 尝试及一次独立无工具复核共用调用预算');
});

test('引用已有实体只读取身份依据，不把其全部旧认识变成新增的前置来源', async t => {
  const f = await guardedFixture(t);
  const handle = f.set.handles().find(row => row.collection === 'entities' && row.identity === f.subject)!.handle;
  f.set.open(handle, true);
  const packet = f.set.packet();
  assert.deepEqual(new Set(packet.evidenceIds), new Set([f.ref(0).evidenceId, f.ref(2).evidenceId]));
  assert.deepEqual(packet.details, []);
  f.set.writerSent(packet.packetHash);
  const before = f.workspace.export();
  assert.throws(() => f.workspace.updateEntity(0, f.subject, {
    kind: 'other', name: '不能凭引用改身份', aliases: [], identityEvidence: [f.ref(0)],
  }, '身份修改需要反向依赖'), /memory_working_set_needs_evidence/);
  assert.deepEqual(f.workspace.export(), before);
  const created = f.workspace.createEntry(0, f.entry(2), '同一主体的新独立认识');
  assert.ok(created.result.id);
  assert.deepEqual(f.workspace.export().candidate.entries.filter(row => row.id !== created.result.id), before.candidate.entries);
  f.workspace.decideCoverage(1, { ref: f.ref(2), decision: 'retained', entryIds: [created.result.id], rationale: '保留新认识' },
    { ref: f.ref(2), decision: 'no-protectable-state', entryIds: [], rationale: '普通独立认识' });
  const candidate = f.workspace.export().candidate, scope = f.set.freeze(candidate, f.details);
  assert.deepEqual(scope.obligations, [f.ref(2)], '身份原件已读不等于旧覆盖发生重分类');
  assert.deepEqual(candidate.coverage.filter(row => row.ref.evidenceId !== f.ref(2).evidenceId),
    before.candidate.coverage.filter(row => row.ref.evidenceId !== f.ref(2).evidenceId));
  f.set.reviewerSent(scope.scopeHash, scope.packetHash);
  f.set.acceptReview(JSON.stringify({ schemaVersion: 2, scopeHash: scope.scopeHash, verdict: 'pass',
    checks: Object.fromEntries(memoryReviewCategories.map(key => [key, true])), issues: [] }), candidate, f.details);
  assert.deepEqual(f.set.auditedDecisions(candidate, f.details, scope.scopeHash).map(row => row.ref), [f.ref(2)]);
});

function imageSource(runId: string, sequence: number, count = 1): PreparedMemorySource {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
  return prepareNativeMemorySource({ namespace: 'synthetic:working-set', source: { contextId: 'context', runId, sequence }, events: [], gaps: [],
    entries: Array.from({ length: count }, (_, index) => ({
      business: { kind: 'user-statement', origin: 'signal', content: '合成图片资料', provenance: { contextId: 'context', runId, signalId: `${runId}:${index}` } },
      location: { contextId: 'context', runId, recordId: `record:${runId}:${index}`, receivedAt: at, visibleAfter: at },
      original: { text: '合成图片资料', attachments: [{ id: `image:${runId}:${index}`, bytes,
        metadata: { name: 'synthetic.png', mediaType: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }] },
    })) });
}

test('完整操作来源合计超限时整组延期，但独立小记录继续且所有原件留账本', async t => {
  const { prepareMemoryV1Batch } = await import('../src/memory/v1/organizer.js');
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); new RuntimeStore(db);
  const ledger = new MemoryEvidenceLedger(db), source = prepared('operation-unit', 1, ['word '.repeat(300), 'word '.repeat(300), '独立小记录']);
  source.records = source.records.map((record, index) => index < 2 ? { ...record, operationRef: 'operation:synthetic' } : record);
  const batch = prepareMemoryV1Batch(source, ledger, scopeId, cutoff, [], { sourceTextTokens: 600 });
  assert.deepEqual(batch.records.map(row => row.id), [source.records[2]!.id]);
  assert.equal(batch.deferred.length, 2); assert.ok(batch.deferred.every(row => row.reason === 'source-text-capacity'));
  for (const record of source.records) assert.equal(ledger.readContent(record.id), Buffer.from(source.contents.get(record.contentRef)!.body).toString('utf8'));
});

test('媒体数量按实际选批独立约束，超额图片延期且原 bytes 与定位仍保存', async t => {
  const { prepareMemoryV1Batch } = await import('../src/memory/v1/organizer.js');
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); new RuntimeStore(db);
  const ledger = new MemoryEvidenceLedger(db), source = imageSource('image-capacity', 1, 5);
  const batch = prepareMemoryV1Batch(source, ledger, scopeId, cutoff, ['image/png']);
  assert.equal(batch.records.length, 4); assert.equal(batch.deferred.length, 1); assert.equal(batch.deferred[0]!.reason, 'source-media-capacity');
  for (const record of source.records) assert.ok(ledger.readContent(record.id, record.attachments[0]!.sourceId));
});

test('旧图片已完成后，独立纯文本使用无图片能力模型也能继续', async t => {
  const f = fixture(t);
  assert.equal((await f.organize(imageSource('old-image', 1), undefined, { supportedImageMediaTypes: ['image/png'] })).complete, true);
  const start = f.requests.length;
  const result = await f.organize(prepared('text-after-image', 2, ['完全独立的合成文本资料。']));
  assert.equal(result.complete, true); assert.equal(result.processedRecords, 1);
  assert.ok(f.requests.slice(start).every(row => JSON.stringify(row.packet).includes('text/plain') === false &&
    !JSON.stringify(row.packet).includes('image/png')), '没有把无关旧媒体混回新包');
});

test('可信较小模型窗口约束实际生产请求，过大说明和工具 schema 不会发给模型', async t => {
  const f = fixture(t), source = prepared('small-model-window', 1, ['合成小资料']);
  await assert.rejects(f.organize(source, undefined, { modelContextWindow: 4096, modelMaxOutputTokens: 512 }), /memory_request_text_capacity/);
  assert.equal(f.requests.length, 0); assert.equal(f.memory.version().id, 'initial');
  assert.ok(new MemoryEvidenceLedger(f.db).listPending(scopeId, cutoff).length > 0);
});
