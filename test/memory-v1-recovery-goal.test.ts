import { currentMemoryView, scopedReview, workingSetReader } from './memory-v1-synthetic-model.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import type { EvidenceReference, MemoryCandidate, MemoryEntry } from '../src/memory/v1/contracts.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';
import { memoryV1ModelView } from '../src/memory/v1/organizer.js';
import { measureMemoryText } from '../src/memory/v1/tokens.js';
import { finished, until, removeTemp } from './helpers.js';

type Reviewed = Extract<MemoryEntry, { format: 'reviewed' }>;
type View = { draftRevision: number; candidate: MemoryCandidate };
type Visible = { evidence: MemoryCandidate['evidence'][number]; body: string };
type Envelope = { recoveryTarget?: MemoryCandidate; residentBudget?: number; businessEvidence?: Visible[]; trustedBaseline?: { recoveryTarget?: MemoryCandidate }; proposal?: { candidate: MemoryCandidate } };
type Action = { name: string; input: Record<string, unknown> };
const firstInput = '岑遥希望亲自参观一次旧水塔展览，目前尚未成行。；岑遥的记录仪当前采用 A 模式。';
const indexInput = '今天只核对资料索引，没有新增出行或设备状态。';
const effectiveAt = '2026-01-02T00:00:00.000Z';
const newStateInput = `岑遥的记录仪已于 ${effectiveAt} 切换为 B 模式。`;
const reviewed = (candidate: MemoryCandidate) => candidate.entries.filter((entry): entry is Reviewed => entry.format === 'reviewed');
const wish = (candidate: MemoryCandidate) => reviewed(candidate).find(entry => entry.scope.dimension === 'visit-wish' && entry.lifecycle === 'current')
  ?? reviewed(candidate).find(entry => entry.scope.dimension === 'visit-wish')!;
function editable(entry: Reviewed): MemoryEntryInput {
  const { id: _id, revision: _revision, format: _format, createdInBatch: _created, updatedInBatch: _updated, evidence, ...rest } = entry;
  return { ...rest, evidence: evidence.map(({ ref, role }) => ({ ref, role })) };
}
function objects(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') { try { return objects(JSON.parse(value)); } catch { return []; } }
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(objects)];
}
const viewFrom = currentMemoryView;

// 受控历史坏输出用于复现损失；后续恢复只能读取实际请求中的旧版和证据。
function modelFixture(badMode: 'update' | 'reorganize' = 'update', recoveryMode: 'update' | 'reorganize' = 'update') {
  const readOld = workingSetReader();
  let phase: 'initial' | 'bad-summary' | 'state-b' = 'initial', serial = 0;
  let failure: 'none' | 'reject-review' | 'review-provider' | 'forged-source' | 'over-budget' = 'none';
  let forgedAttempted = false;
  const operations: Action[] = [], toolReplies: unknown[] = [];
  const recoveryWriters: { target: MemoryCandidate; evidence: Visible[] }[] = [];
  const recoveryReviews: { target: MemoryCandidate; evidence: Visible[]; candidate: MemoryCandidate }[] = [];
  const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, warnings: [] });
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => ({ stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'reply' });
      controller.enqueue({ type: 'text-delta', id: 'reply', delta: '资料已收到。' });
      controller.enqueue({ type: 'text-end', id: 'reply' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      controller.close();
    } }) }),
    doGenerate: async request => {
      const rows = objects(request.prompt) as Envelope[];
      const evidence = rows.find(row => row.businessEvidence)?.businessEvidence ?? [];
      const initial = rows.find(row => row.recoveryTarget), review = rows.find(row => row.trustedBaseline);
      const target = initial?.recoveryTarget ?? review?.trustedBaseline?.recoveryTarget;
      if (!request.tools?.some(tool => tool.name === 'memory_ready')) {
        const candidate = review?.proposal?.candidate;
        assert.ok(candidate, '独立复核收到实际 proposal');
        if (target) {
          recoveryReviews.push({ target: structuredClone(target), evidence: structuredClone(evidence), candidate: structuredClone(candidate) });
          if (failure === 'review-provider') throw new Error('合成复核 provider 失败');
          assert.ok(evidence.some(row => row.evidence.id === wish(target).evidence[0]!.ref.evidenceId && row.body.includes(wish(target).text)), '复核实际收到旧愿望原文，而非当前输入补写');
        }
        const restored = !target || (wish(candidate).text === wish(target).text && wish(candidate).nature === 'intent'
          && JSON.stringify(wish(candidate).scope) === JSON.stringify(wish(target).scope) && wish(candidate).lifecycle === 'current'
          && wish(candidate).certainty === wish(target).certainty && wish(candidate).placement === 'resident'
          && wish(candidate).followup.outcome === 'unknown' && wish(candidate).followup.outcomeEvidence.length === 0
          && JSON.stringify(wish(candidate).evidence) === JSON.stringify(wish(target).evidence));
        const pass = restored && failure !== 'reject-review';
        // bad-summary 阶段有意放过语义错误，不能作为该概括正确的证据。
        return finish(JSON.stringify(scopedReview(request.prompt, pass ? 'pass' : 'reject', pass ? [] : [{ severity: 'high', category: 'intent-details', entryIds: [wish(candidate).id], evidenceIds: [], message: '合成复核拒绝：具体愿望未被正确承接或本轮主动拒绝。' }])));
      }
      const last = request.prompt.at(-1);
      if (last?.role === 'tool') toolReplies.push(structuredClone(last));
      if (last?.role === 'tool' && JSON.stringify(last).includes('"ready":true')) return finish('整理结束。');
      const view = viewFrom(request.prompt), candidate = view.candidate;
      if (target) recoveryWriters.push({ target: structuredClone(target), evidence: structuredClone(evidence) });
      let action: Action = { name: 'memory_inspect', input: {} };
      const reading = readOld(request.prompt);
      if (reading) action = reading;
      else {
        const refFor = (record: Visible): EvidenceReference => ({ evidenceId: record.evidence.id, partKey: 'body' });
        const original = evidence.find(row => row.evidence.kind === 'user-statement' && row.body.includes('尚未成行'));
        assert.ok(original, '初始来源始终由系统交给写者');
        const originalRef = refFor(original), person = candidate.entities.find(entity => entity.name === '岑遥');
        const change = (name: string, input: Record<string, unknown>): Action => ({ name, input: { expectedDraftRevision: view.draftRevision, rationale: '合成资料维护', ...input } });
        const base = (text: string, dimension: string): MemoryEntryInput => ({
          text, primaryNodeId: candidate.organizations[0]!.id, relatedNodeIds: [], entityIds: [person!.id],
          nature: 'intent', certainty: 'reported', lifecycle: 'current', scope: { subjectId: person!.id, dimension, qualifier: '岑遥' }, validFrom: null, validTo: null,
          retention: { score: 8, rationale: '明确且尚未兑现的信息' }, protectionAssessment: { decision: 'ineligible', rationale: '普通愿望不自动成为互斥状态', evidence: [originalRef] }, protection: { mode: 'none' },
          followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: originalRef, role: 'supports' }], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [],
        });
        if (!candidate.organizations.length) action = change('memory_organization_create', { organization: { title: '人物与设备', parentId: null } });
        else if (!person) action = change('memory_entity_create', { entity: { name: '岑遥', kind: 'person', aliases: [], identityEvidence: [originalRef] } });
        else if (!wish(candidate)) action = change('memory_entry_create', { entry: base(original.body.split('；')[0]!, 'visit-wish') });
        else if (!reviewed(candidate).some(entry => entry.scope.dimension === 'recorder-mode')) {
          action = change('memory_entry_create', { entry: { ...base(original.body.split('；')[1]!, 'recorder-mode'), nature: 'fact', retention: { score: 8, rationale: '持续设备状态' },
            protectionAssessment: { decision: 'eligible', rationale: '互斥设备模式', evidence: [originalRef] }, protection: { mode: 'state', stateKey: 'mode', value: 'A', establishedBy: [originalRef], overrideRule: '明确设备模式变更' } } });
        } else if (target && (wish(candidate).text !== wish(target).text || wish(candidate).nature !== wish(target).nature
          || wish(candidate).lifecycle !== 'current' || wish(candidate).placement !== 'resident')) {
          const old = wish(target);
          assert.ok(evidence.some(row => row.evidence.id === old.evidence[0]!.ref.evidenceId && row.body.includes(old.text)), '恢复写者实际收到旧愿望来源');
          const entry = editable(old);
          if (failure === 'forged-source' && !forgedAttempted) {
            forgedAttempted = true;
            entry.evidence = [{ ref: { evidenceId: 'evidence:synthetic-forged', partKey: 'body' }, role: 'supports' }];
          } else if (failure === 'forged-source' || objects(request.prompt).some(row => row.error === 'memory_workspace_use_transition')) {
            // 工具明确拒绝后交独立复核，不私改草稿或注入新来源绕过身份转换。
            action = { name: 'memory_ready', input: { expectedDraftRevision: view.draftRevision } };
          }
          if (action.name !== 'memory_ready') {
            if (recoveryMode === 'reorganize') {
              const ended = reviewed(candidate).find(row => row.id === old.id)!;
              const descendants = new Set(ended.replacedBy);
              for (let n = 0; n < candidate.entries.length; n++) for (const row of reviewed(candidate))
                if (descendants.has(row.id)) for (const id of row.replacedBy) descendants.add(id);
              const current = reviewed(candidate).find(row => descendants.has(row.id) && row.lifecycle === 'current' && row.protection.mode === 'none');
              assert.ok(current, '重组以实际替代链上的当前条目为输入，不复活旧物理 ID');
              entry.derivedFromEntryIds = [...new Set([...old.derivedFromEntryIds, old.id])];
              action = change('memory_entries_reorganize', { oldEntries: [{ id: current.id, revision: current.revision }], replacements: [entry] });
            } else {
              const current = wish(candidate);
              action = change('memory_entry_update', { entryId: current.id, expectedEntryRevision: current.revision, entry });
            }
          }
        } else if (target && failure === 'over-budget' && candidate.organizations[0]!.title.length < rows.find(row => row.residentBudget)!.residentBudget!) {
          const budget = rows.find(row => row.residentBudget)!.residentBudget!;
          // 分词边界保持编码工作线性；长连续汉字串会把夹具变成编码器压力测试。
          action = change('memory_organization_update', { organizationId: candidate.organizations[0]!.id, organization: { title: `合成栏目${' x'.repeat(budget + 1)}`, parentId: null } });
        } else if (!target && phase === 'bad-summary' && wish(candidate).nature === 'intent' && wish(candidate).lifecycle === 'current') {
          const current = wish(candidate), generic: MemoryEntryInput = { ...editable(current), text: '岑遥对建筑展览感兴趣。', nature: 'preference' };
          action = badMode === 'update'
            ? change('memory_entry_update', { entryId: current.id, expectedEntryRevision: current.revision, entry: generic })
            : change('memory_entries_reorganize', { oldEntries: [{ id: current.id, revision: current.revision }], replacements: [{ ...generic, scope: { ...generic.scope, dimension: 'visit-interest' } }] });
        } else if (!target && phase === 'state-b' && reviewed(candidate).some(entry => entry.protection.mode === 'state' && entry.protection.value === 'A' && entry.lifecycle === 'current')) {
          const current = reviewed(candidate).find(entry => entry.protection.mode === 'state' && entry.lifecycle === 'current')!;
          const latest = evidence.find(row => row.evidence.kind === 'user-statement' && row.body.includes('切换为 B 模式'));
          assert.ok(latest); const ref = refFor(latest);
          action = change('memory_state_replace', { entryId: current.id, expectedEntryRevision: current.revision, evidence: [ref], entry: { ...editable(current), text: latest.body, validFrom: effectiveAt,
            protectionAssessment: { decision: 'eligible', rationale: '明确的新模式', evidence: [ref] }, protection: { ...current.protection, mode: 'state', stateKey: 'mode', value: 'B', establishedBy: [ref], overrideRule: '明确设备模式变更' }, evidence: [{ ref, role: 'supports' }] } });
        } else {
          const pending = candidate.evidence.flatMap(record => record.coverage.parts.map(part => ({ record, part }))).find(({ record, part }) => !candidate.coverage.some(row => row.ref.evidenceId === record.id && row.ref.partKey === part.key && !['pending-review', 'pending-source'].includes(row.decision)));
          if (pending) {
            const ref = { evidenceId: pending.record.id, partKey: pending.part.key };
            const entries = reviewed(candidate).filter(entry => entry.evidence.some(item => item.ref.evidenceId === ref.evidenceId && item.ref.partKey === ref.partKey));
            const protectedEntries = entries.filter(entry => entry.protection.mode === 'state');
            action = { name: 'memory_coverage', input: { expectedDraftRevision: view.draftRevision,
              coverage: { ref, decision: entries.length ? 'retained' : 'no-effective-new-information', entryIds: entries.map(entry => entry.id), rationale: '合成覆盖核对' },
              protection: { ref, decision: protectedEntries.length ? 'mapped' : 'no-protectable-state', entryIds: protectedEntries.map(entry => entry.id), rationale: '合成保护核对' } } };
          } else action = { name: 'memory_ready', input: { expectedDraftRevision: view.draftRevision } };
        }
      }
      assert.ok(request.tools?.some(tool => tool.name === action.name), `只能调用实际提供的工具：${action.name}`);
      operations.push(structuredClone(action));
      return { content: [{ type: 'tool-call' as const, toolName: action.name, toolCallId: `recovery-goal-${++serial}`, input: JSON.stringify(action.input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, warnings: [] };
    },
  });
  return { model, operations, toolReplies, recoveryWriters, recoveryReviews,
    phase: (value: typeof phase) => { phase = value; }, fail: (value: typeof failure) => { failure = value; } };
}

async function fixture(t: test.TestContext, badMode: 'update' | 'reorganize' = 'update', recoveryMode: 'update' | 'reorganize' = 'update') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovery-goal-')), engine = modelFixture(badMode, recoveryMode);
  const core = await Core.open({ dataDir: directory, model: engine.model, memoryContextMode: 'v1', memoryEnabled: true });
  t.after(async () => { await core.close(); await removeTemp(directory); });
  const request = (url: string, body: unknown) => createApp(core).request(url, { method: 'POST', headers: { Authorization: `Bearer ${core.controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settled = (id: string) => until(() => core.projectMemory.jobs().find(job => job.id === id), job => !!job && ['succeeded', 'failed', 'interrupted'].includes(job.status));
  async function send(content: string) {
    const row = await core.submitMessage({ contextId: 'main', content }); await finished(core, row.runId!);
    const job = await until(() => core.projectMemory.jobs().find(job => job.runId === row.runId), job => !!job && ['succeeded', 'failed'].includes(job.status));
    assert.equal(job!.status, 'succeeded', JSON.stringify(job));
    return core.projectMemory.version();
  }
  async function plan(targetVersionId: string, expectedHead = core.projectMemory.version().id) {
    const response = await request('/memory/recovery/plans', { targetVersionId, expectedHead });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as { id: string; targetVersionId: string; expectedHead: string; cutoff: string };
  }
  async function execute(id: string) {
    const response = await request(`/memory/recovery/plans/${id}/execute`, {});
    assert.equal(response.status, 202, await response.clone().text());
    const job = await response.json(); return (await settled(job.id))!;
  }
  const v1 = await send(firstInput);
  engine.phase('bad-summary'); const v2 = await send(indexInput);
  engine.phase('state-b'); const v3 = await send(newStateInput);
  assert.deepEqual([v1.generation, v2.generation, v3.generation], [1, 2, 3]);
  return { core, engine, request, plan, execute, v1, v2, v3 };
}
function snapshot(core: Core) {
  return {
    head: core.projectMemory.version(), processing: core.projectMemory.processingV1Head(),
    versions: core.projectMemory.v1Versions(), watermarks: core.runtime.setting<Record<string, number>>('memory-watermarks', {}),
    signals: core.store.db.prepare('SELECT * FROM signals ORDER BY rowid').all(),
    evidence: core.store.db.prepare('SELECT * FROM memory_v1_evidence ORDER BY id').all(),
    receipts: core.store.db.prepare('SELECT * FROM memory_v1_receipts ORDER BY id').all(),
    processed: core.store.db.prepare('SELECT * FROM memory_v1_processing ORDER BY rowid').all(),
    publicationTables: Object.fromEntries(['memory_v1_versions', 'memory_v1_processing_head', 'memory_v1_coverage', 'memory_v1_coverage_batches', 'memory_v1_deferred'].map(table => [table, core.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    sourceTables: Object.fromEntries(['memory_v1_contents', 'memory_v1_evidence_ids', 'memory_v1_evidence_revisions'].map(table => [table, core.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    resident: core.projectMemory.resident().text,
  };
}

test('恢复具体未兑现愿望，同时保留新设备状态、稳定身份、来源和单调水位', { timeout: 40_000 }, async t => {
  const f = await fixture(t), memory = f.core.projectMemory;
  const original = memory.readV1Version(f.v1.id).workspace.candidate;
  const bad = memory.readV1Version(f.v2.id).workspace.candidate;
  const head = memory.readV1Version(f.v3.id).workspace.candidate;
  assert.equal(wish(original).nature, 'intent'); assert.match(wish(original).text, /亲自参观一次旧水塔展览.*尚未成行/);
  assert.equal(wish(bad).nature, 'preference'); assert.doesNotMatch(wish(bad).text, /亲自参观一次旧水塔展览|尚未成行/);
  const loss = memory.diffV1Versions(f.v1.id, f.v2.id);
  assert.equal(loss.changes.filter(change => change.collection === 'entries' && change.id === wish(original).id).length, 1);
  const lost = loss.changes.find(change => change.id === wish(original).id)!;
  assert.equal((lost.before as Reviewed).text, wish(original).text); assert.equal((lost.after as Reviewed).text, wish(bad).text);
  assert.ok(!memory.diffV1Versions(f.v2.id, f.v3.id).changes.some(change => change.id === wish(original).id), '损失定位在 V2 而非后续设备更新轮');
  const before = snapshot(f.core), plan = await f.plan(f.v1.id), job = await f.execute(plan.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job)); assert.ok(job.nativeTaskId);
  const native = await f.core.sessions.controller.getMastra()!.backgroundTaskManager!.getTask(job.nativeTaskId!);
  assert.equal(native!.toolName, 'organize-memory-v1'); assert.equal(native!.agentId, 'memory-organizer');
  const published = memory.readV1Version(memory.version().id), candidate = published.workspace.candidate, restored = wish(candidate);
  assert.equal(published.manifest.parentVersionId, f.v3.id); assert.equal(published.manifest.generation, 4);
  assert.equal(restored.id, wish(original).id); assert.equal(restored.revision, wish(head).revision + 1);
  assert.equal(restored.text, wish(original).text); assert.equal(restored.nature, 'intent');
  assert.equal(restored.scope.subjectId, wish(original).scope.subjectId); assert.equal(candidate.entities.find(entity => entity.id === restored.scope.subjectId)!.name, '岑遥');
  assert.equal(restored.lifecycle, 'current'); assert.equal(restored.followup.outcome, 'unknown'); assert.deepEqual(restored.followup.outcomeEvidence, []);
  assert.deepEqual(restored.evidence, wish(original).evidence); assert.deepEqual(candidate.evidence, head.evidence);
  assert.deepEqual(candidate.overrides, head.overrides); assert.equal(candidate.overrides.length, 1);
  const states = reviewed(candidate).filter(entry => entry.scope.dimension === 'recorder-mode');
  assert.deepEqual(states, reviewed(head).filter(entry => entry.scope.dimension === 'recorder-mode'));
  assert.ok(states.some(entry => entry.lifecycle === 'current' && entry.protection.mode === 'state' && entry.protection.value === 'B'));
  assert.ok(states.some(entry => entry.lifecycle === 'superseded' && entry.protection.mode === 'state' && entry.protection.value === 'A'));
  assert.match(published.finalText, /亲自参观一次旧水塔展览.*尚未成行/); assert.match(published.finalText, /切换为 B 模式/);
  assert.ok(measureMemoryText(published.finalText).textTokens <= f.core.memoryV1Status().policy!.resident.textTokens);
  const after = snapshot(f.core);
  assert.deepEqual(after.signals, before.signals); assert.deepEqual(after.evidence, before.evidence); assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(after.sourceTables, before.sourceTables, '恢复不登记新来源、别名或伪造原文');
  assert.equal(restored.createdInBatch, wish(original).createdInBatch);
  assert.ok(published.workspace.audit.some(row => row.operation === 'update-entry' && row.changes.some(change => change.identity === restored.id)));
  assert.deepEqual(after.watermarks, before.watermarks, '重整旧来源不能回拨水位');
  assert.notEqual(after.processing, before.processing);
  assert.ok(f.engine.recoveryWriters.length); assert.ok(f.engine.recoveryReviews.length);
  for (const observed of [...f.engine.recoveryWriters, ...f.engine.recoveryReviews]) {
    assert.equal(wish(observed.target).id, restored.id); assert.equal(wish(observed.target).text, restored.text);
    const source = observed.evidence.find(row => row.evidence.id === restored.evidence[0]!.ref.evidenceId)!;
    assert.ok(source); assert.equal(source.body, firstInput); assert.equal(source.evidence.actor, 'user');
  }
  assert.ok(f.engine.recoveryReviews.some(row => wish(row.candidate).text === restored.text));
  assert.ok(f.engine.operations.some(action => action.name === 'memory_entry_update' && (action.input.entry as MemoryEntryInput).text === restored.text));
  const repeated = await f.execute(plan.id); assert.equal(repeated.id, job.id); assert.equal(memory.version().generation, 4);
});

for (const mode of ['update', 'reorganize'] as const) for (const failure of ['reject-review', 'review-provider', 'forged-source', 'over-budget'] as const) {
  test(`${mode === 'update' ? '普通修订' : '合法重组'}恢复失败不发布候选或推进处理基线：${failure}`, { timeout: 40_000 }, async t => {
    const f = await fixture(t, mode, mode);
    if (failure === 'over-budget') {
      // 用小常驻额度隔离容量门禁，避免巨大单对象同时触发模型输入/输出上限。
      const current = f.core.memoryV1Status().policy!;
      const policy = { ...current, revision: current.revision + 1, resident: { ...current.resident, textTokens: 64 },
        organization: { ...current.organization, maxCapacityCorrections: 1 } };
      f.core.configure('runtime', { memoryContextPolicy: policy });
      await f.core.reconcileMemoryV1();
      await until(() => f.core.projectMemory.jobs(), jobs => jobs.every(job => !['pending', 'running'].includes(job.status)));
    }
    const before = snapshot(f.core), plan = await f.plan(f.v1.id);
    f.engine.fail(failure); const job = await f.execute(plan.id);
    assert.equal(job.status, 'failed', JSON.stringify(job));
    assert.equal(job.error, failure === 'review-provider' ? 'memory_organization_failed' : failure === 'over-budget' ? 'memory_capacity_conflict' : 'memory_semantic_review_rejected');
    assert.deepEqual(snapshot(f.core), before, '失败候选不改 head、历史、来源、水位或成功处理记录');
    assert.ok(f.engine.recoveryWriters.length); assert.ok(f.engine.recoveryReviews.length);
    if (failure === 'forged-source') assert.match(JSON.stringify(f.engine.toolReplies), /memory_workspace_unknown_evidence/);
    else assert.ok(f.engine.recoveryReviews.some(row => wish(row.candidate).text === wish(row.target).text
      && wish(row.candidate).lifecycle === 'current'
      && (mode === 'update' || (wish(row.candidate).id !== wish(row.target).id && wish(row.candidate).derivedFromEntryIds.includes(wish(row.target).id)))), '已承接具体愿望的草稿仍须通过独立复核和容量门禁才能发布');
  });
}

for (const mode of ['update', 'reorganize'] as const) test(`${mode === 'update' ? '普通修订' : '合法重组'}恢复计划绑定可信 head，较早计划不能覆盖更新后的版本`, { timeout: 40_000 }, async t => {
  const f = await fixture(t, mode, mode), stale = await f.plan(f.v1.id), fresh = await f.plan(f.v1.id);
  assert.equal((await f.execute(fresh.id)).status, 'succeeded');
  const before = snapshot(f.core), calls = f.engine.operations.length;
  const response = await f.request(`/memory/recovery/plans/${stale.id}/execute`, {});
  assert.equal(response.status, 409); assert.match((await response.json()).error, /memory_(?:version|recovery_.*)_conflict/);
  assert.deepEqual(snapshot(f.core), before); assert.equal(f.engine.operations.length, calls);
});

for (const mode of ['update', 'reorganize'] as const) test(`${mode === 'update' ? '普通修订' : '合法重组'}恢复候选通过复核后发布事务中止，可信正文与账本完整回滚且新计划可重试`, { timeout: 40_000 }, async t => {
  const f = await fixture(t, mode, mode), before = snapshot(f.core), plan = await f.plan(f.v1.id);
  f.core.store.db.exec(`CREATE TEMP TRIGGER goal_recovery_rollback BEFORE INSERT ON memory_v1_processing
    BEGIN SELECT RAISE(ABORT, 'synthetic recovery publication rollback'); END`);
  const job = await f.execute(plan.id);
  assert.equal(job.status, 'failed'); assert.equal(job.error, 'memory_organization_failed');
  assert.ok(f.engine.recoveryReviews.some(row => wish(row.candidate).text === wish(row.target).text && wish(row.candidate).lifecycle === 'current'), '事务故障发生前候选已抵达复核');
  assert.deepEqual(snapshot(f.core), before, '回滚版本指针、可信索引、覆盖、处理 head 与水位，不只检查任务状态');
  f.core.store.db.exec('DROP TRIGGER goal_recovery_rollback');
  const retry = await f.plan(f.v1.id); assert.notEqual(retry.id, plan.id);
  assert.equal((await f.execute(retry.id)).status, 'succeeded');
  assert.equal(f.core.projectMemory.version().generation, 4);
  assert.match(f.core.projectMemory.resident().text, /亲自参观一次旧水塔展览.*尚未成行/);
});

test('安全负向：普通 update 不可抹去结束边或伪逆转旧物理 ID，失败不改可信基线', { timeout: 40_000 }, async t => {
  const f = await fixture(t, 'reorganize'), memory = f.core.projectMemory;
  const original = memory.readV1Version(f.v1.id).workspace.candidate;
  const bad = memory.readV1Version(f.v2.id).workspace.candidate;
  const head = memory.readV1Version(f.v3.id).workspace.candidate;
  const old = wish(original), ended = wish(head);
  assert.equal(ended.id, old.id); assert.equal(ended.lifecycle, 'superseded'); assert.equal(ended.placement, 'detail');
  assert.ok(ended.replacedBy.length); assert.doesNotMatch(memory.resident().text, /亲自参观一次旧水塔展览/);
  const generic = reviewed(bad).find(entry => ended.replacedBy.includes(entry.id))!;
  assert.equal(generic.text, '岑遥对建筑展览感兴趣。'); assert.equal(generic.nature, 'preference');
  const loss = memory.diffV1Versions(f.v1.id, f.v2.id).changes.find(change => change.collection === 'entries' && change.id === old.id)!;
  assert.equal((loss.before as Reviewed).placement, 'resident'); assert.equal((loss.after as Reviewed).placement, 'detail');
  assert.ok(!memory.diffV1Versions(f.v2.id, f.v3.id).changes.some(change => change.id === old.id));
  const before = snapshot(f.core), plan = await f.plan(f.v1.id), job = await f.execute(plan.id);
  assert.ok(job.nativeTaskId); assert.ok(f.engine.recoveryWriters.length); assert.ok(f.engine.recoveryReviews.length);
  for (const observed of [...f.engine.recoveryWriters, ...f.engine.recoveryReviews]) {
    assert.equal(wish(observed.target).id, old.id);
    assert.equal(observed.evidence.find(row => row.evidence.id === old.evidence[0]!.ref.evidenceId)!.body, firstInput);
  }
  const attempts = f.engine.operations.filter(action => action.name === 'memory_entry_update' && action.input.entryId === old.id);
  assert.ok(attempts.some(action => (action.input.entry as MemoryEntryInput).text === old.text && (action.input.entry as MemoryEntryInput).lifecycle === 'current'));
  assert.ok(attempts.some(action => (action.input.entry as MemoryEntryInput).replacedBy.length === 0), '保留真实非法操作：普通更新试图清空 A→B');
  assert.equal(job.status, 'failed'); assert.equal(job.error, 'memory_semantic_review_rejected');
  assert.ok(objects(f.engine.toolReplies).some(row => row.error === 'memory_workspace_use_transition'), '真实工具拒绝伪逆转，而非 mock 直接返回失败');
  assert.ok(f.engine.recoveryReviews.every(row => wish(row.candidate).lifecycle === 'superseded'), '未修改草稿仍进入独立复核，不被误认为恢复成功');
  assert.deepEqual(snapshot(f.core), before, 'head、来源、覆盖、processing、历史正文及水位逐字段不变');
  const unchanged = memory.readV1Version(memory.version().id).workspace.candidate;
  assert.deepEqual(unchanged, head, '旧身份、替代边、未兑现性质、范围和新设备保护链均不被失败尝试改写');
  assert.equal(memory.version().generation, 3);
  assert.doesNotMatch(memory.resident().text, /亲自参观一次旧水塔展览/);
  // 具体愿望的逻辑来源承接由合法重组正例验证，不把旧物理 ID 复活作为恢复条件。
});

test('合法重组恢复具体未兑现愿望：逻辑来源承接 A→B→C，不复活旧物理 ID', { timeout: 40_000 }, async t => {
  const f = await fixture(t, 'reorganize', 'reorganize'), memory = f.core.projectMemory;
  const original = memory.readV1Version(f.v1.id).workspace.candidate;
  const bad = memory.readV1Version(f.v2.id).workspace.candidate;
  const head = memory.readV1Version(f.v3.id).workspace.candidate;
  const a = wish(original), ended = reviewed(head).find(row => row.id === a.id)!;
  const b = reviewed(head).find(row => ended.replacedBy.includes(row.id))!;
  assert.equal(a.nature, 'intent'); assert.equal(a.lifecycle, 'current'); assert.equal(a.followup.outcome, 'unknown');
  assert.match(a.text, /亲自参观一次旧水塔展览.*尚未成行/);
  assert.equal(ended.lifecycle, 'superseded'); assert.equal(ended.placement, 'detail'); assert.deepEqual(ended.replacedBy, [b.id]);
  assert.equal(b.lifecycle, 'current'); assert.equal(b.nature, 'preference'); assert.equal(b.text, '岑遥对建筑展览感兴趣。');
  assert.notEqual(b.scope.dimension, a.scope.dimension);
  assert.doesNotMatch(memory.resident().text, /亲自参观一次旧水塔展览|尚未成行/);
  const loss = memory.diffV1Versions(f.v1.id, f.v2.id).changes.find(row => row.collection === 'entries' && row.id === a.id)!;
  assert.equal((loss.before as Reviewed).text, a.text); assert.equal((loss.before as Reviewed).placement, 'resident');
  assert.equal((loss.after as Reviewed).placement, 'detail');
  assert.deepEqual(reviewed(bad).find(row => row.id === b.id), b);
  assert.ok(!memory.diffV1Versions(f.v2.id, f.v3.id).changes.some(row => row.id === a.id || row.id === b.id), '损失在 V2，新设备状态在 V3');
  const before = snapshot(f.core), plan = await f.plan(f.v1.id), callsBefore = f.engine.operations.length;
  assert.equal(plan.targetVersionId, f.v1.id); assert.equal(plan.expectedHead, f.v3.id);
  const job = await f.execute(plan.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job)); assert.ok(job.nativeTaskId);
  const native = await f.core.sessions.controller.getMastra()!.backgroundTaskManager!.getTask(job.nativeTaskId!);
  assert.equal(native!.agentId, 'memory-organizer'); assert.equal(native!.toolName, 'organize-memory-v1');
  const published = memory.readV1Version(memory.version().id), candidate = published.workspace.candidate;
  const c = wish(candidate), aFinal = reviewed(candidate).find(row => row.id === a.id)!, bFinal = reviewed(candidate).find(row => row.id === b.id)!;
  assert.equal(published.manifest.generation, 4); assert.equal(published.manifest.parentVersionId, f.v3.id);
  assert.notEqual(c.id, a.id); assert.notEqual(c.id, b.id); assert.equal(c.revision, 1);
  assert.notEqual(c.createdInBatch, a.createdInBatch);
  assert.deepEqual(aFinal, ended, 'A 的旧物理身份及结束边完整保留');
  assert.equal(bFinal.revision, b.revision + 1); assert.equal(bFinal.lifecycle, 'superseded'); assert.equal(bFinal.placement, 'detail');
  assert.deepEqual(bFinal.replacedBy, [c.id]); assert.ok(bFinal.derivedFromEntryIds.includes(a.id));
  assert.deepEqual(new Set(c.derivedFromEntryIds), new Set([a.id, b.id]), '恢复条目保留旧愿望和中间概括的贡献链');
  assert.equal(c.text, a.text); assert.equal(c.nature, 'intent'); assert.equal(c.certainty, a.certainty);
  assert.deepEqual(c.scope, a.scope); assert.equal(c.scope.subjectId, b.scope.subjectId);
  assert.equal(candidate.entities.find(row => row.id === c.scope.subjectId)!.name, '岑遥'); assert.deepEqual(c.entityIds, a.entityIds);
  assert.equal(c.lifecycle, 'current'); assert.equal(c.placement, 'resident'); assert.deepEqual(c.replacedBy, []);
  assert.deepEqual(c.followup, a.followup); assert.equal(c.followup.outcome, 'unknown'); assert.deepEqual(c.followup.outcomeEvidence, []);
  assert.equal(c.validFrom, a.validFrom); assert.equal(c.validTo, a.validTo);
  assert.deepEqual(c.evidence, a.evidence, '引用、角色及 supportGroup 原样承接，不把旧来源重复计为新支持');
  assert.ok(c.evidence.every(row => row.supportGroup)); assert.deepEqual(c.protectionAssessment, a.protectionAssessment);
  assert.deepEqual(c.protection, a.protection); assert.deepEqual(c.retention, a.retention);
  assert.deepEqual(bFinal.evidence, b.evidence); assert.deepEqual(candidate.evidence, head.evidence);
  assert.deepEqual(candidate.overrides, head.overrides); assert.equal(candidate.overrides.length, 1);
  const states = (value: MemoryCandidate) => reviewed(value).filter(row => row.scope.dimension === 'recorder-mode');
  assert.deepEqual(states(candidate), states(head), '新设备 B 及旧设备 A 的保护链、范围、证据和有效时间逐字段不变');
  assert.ok(states(candidate).some(row => row.lifecycle === 'current' && row.protection.mode === 'state' && row.protection.value === 'B'));
  assert.ok(states(candidate).some(row => row.lifecycle === 'superseded' && row.protection.mode === 'state' && row.protection.value === 'A'));
  assert.match(published.finalText, /亲自参观一次旧水塔展览.*尚未成行/); assert.match(published.finalText, /切换为 B 模式/);
  assert.doesNotMatch(published.finalText, /对建筑展览感兴趣/);
  assert.ok(measureMemoryText(published.finalText).textTokens <= f.core.memoryV1Status().policy!.resident.textTokens);
  const after = snapshot(f.core);
  for (const key of ['signals', 'evidence', 'receipts', 'sourceTables', 'watermarks'] as const) assert.deepEqual(after[key], before[key], key);
  assert.notEqual(after.processing, before.processing);
  assert.deepEqual(after.processed.slice(0, before.processed.length), before.processed); assert.ok(after.processed.length > before.processed.length);
  assert.ok(f.engine.recoveryWriters.length); assert.ok(f.engine.recoveryReviews.length);
  for (const observed of [...f.engine.recoveryWriters, ...f.engine.recoveryReviews]) {
    assert.deepEqual(observed.target, memoryV1ModelView(original), '写者与独立复核收到实际旧版本的模型可见投影，未以新用户输入补写答案');
    const source = observed.evidence.find(row => row.evidence.id === a.evidence[0]!.ref.evidenceId)!;
    assert.ok(source); assert.equal(source.body, firstInput); assert.equal(source.evidence.actor, 'user');
    const latestState = states(head).find(row => row.lifecycle === 'current')!;
    const laterSource = observed.evidence.find(row => row.evidence.id === latestState.evidence[0]!.ref.evidenceId)!;
    assert.ok(laterSource); assert.equal(laterSource.body, newStateInput); assert.equal(laterSource.evidence.actor, 'user');
  }
  assert.ok(f.engine.recoveryReviews.some(row => wish(row.candidate).id === c.id && wish(row.candidate).text === a.text));
  const operations = f.engine.operations.slice(callsBefore), reorganization = operations.find(row => row.name === 'memory_entries_reorganize')!;
  assert.ok(reorganization);
  assert.deepEqual(reorganization.input.oldEntries, [{ id: b.id, revision: b.revision }], '实际重组当前泛兴趣 B，而不是更新 A 或创建旁路条目');
  assert.ok(!operations.some(row => row.name === 'memory_entry_update' || row.name === 'memory_entry_create'));
  assert.ok(published.workspace.audit.some(row => row.operation === 'reorganize-entries'));
  const repeated = await f.execute(plan.id); assert.equal(repeated.id, job.id);
  assert.deepEqual(snapshot(f.core), after, '同一恢复计划幂等，不重复发布、处理或登记来源');
});
