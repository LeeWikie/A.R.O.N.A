import { currentMemoryView, scopedReview, workingSetReader, requestObjects } from './memory-v1-synthetic-model.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import type { MemoryContextPolicy } from '../src/memory/v1/policy.js';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { createProvider } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { measureMemoryText } from '../src/memory/v1/tokens.js';
import type { MemoryCandidate } from '../src/memory/v1/contracts.js';
import { finished, until, removeTemp } from './helpers.js';

type View = { draftRevision: number; candidate: MemoryCandidate };
const inspect = currentMemoryView;
function syntheticModel() {
  const readOld = workingSetReader();
  const prompts: unknown[] = [], generated: unknown[] = [], operations: string[] = [];
  let reviews = 0, rejectReview = false, calls = 0, failStream = false, compress = false, online = false;
  let effectiveAt = new Date(Date.now() - 1000).toISOString();
  let generationGate: Promise<void> | undefined, streamGate: Promise<void> | undefined, ignoreGenerationAbort = false;
  const pause = async (gate: Promise<void> | undefined, signal?: AbortSignal) => {
    signal?.throwIfAborted(); if (!gate) return;
    let abort!: () => void;
    try { await Promise.race([gate, new Promise<never>((_resolve, reject) => { abort = () => reject(signal?.reason); signal?.addEventListener('abort', abort, { once: true }); })]); }
    finally { signal?.removeEventListener('abort', abort); }
    signal?.throwIfAborted();
  };
  const model = new MastraLanguageModelV2Mock({
    doStream: async request => {
      prompts.push(request.prompt);
      await pause(streamGate, request.abortSignal);
      if (failStream) throw new Error('合成 provider 失败');
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 'answer' });
        c.enqueue({ type: 'text-delta', id: 'answer', delta: '合成确认' }); c.enqueue({ type: 'text-end', id: 'answer' });
        c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
      } }) };
    },
    doGenerate: async request => {
      generated.push(request.prompt);
      await pause(generationGate, ignoreGenerationAbort ? undefined : request.abortSignal);
      const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, warnings: [] });
      if (!request.tools?.some(tool => tool.name === 'memory_ready')) {
        reviews++;
        return finish(JSON.stringify(scopedReview(request.prompt, rejectReview ? 'reject' : 'pass', rejectReview ? [{ severity: 'high', category: 'scope', entryIds: [], evidenceIds: [], message: '合成复核拒绝' }] : [])));
      }
      const last = request.prompt.at(-1);
      const replies = last?.role === 'tool' ? requestObjects(last) : [];
      if (replies.some(row => row.toolName === 'memory_ready') && replies.some(row => row.ok === true && row.value?.ready === true)) return finish('合成维护结束');
      let name = 'memory_inspect', input: Record<string, unknown> = {};
      const reading = readOld(request.prompt);
      if (reading) { name = reading.name; input = reading.input; }
      else {
        const v = inspect(request.prompt), candidate = v.candidate;
        const record = (online ? candidate.evidence.filter(row => row.kind === 'user-statement').at(-1) : candidate.evidence.find(row => row.kind === 'user-statement'))!;
        if (!record) {
          const part = candidate.evidence.flatMap(row => row.coverage.parts.map(part => ({ row, part }))).find(({ row, part }) => !candidate.coverage.some(item => item.ref.evidenceId === row.id && item.ref.partKey === part.key && !['pending-review', 'pending-source'].includes(item.decision)));
          const ref = part && { evidenceId: part.row.id, partKey: part.part.key };
          const action = ref ? { name: 'memory_coverage', input: { expectedDraftRevision: v.draftRevision, coverage: { ref, decision: 'no-effective-new-information', entryIds: [], rationale: '合成非用户证据无新增' }, protection: { ref, decision: 'no-protectable-state', entryIds: [], rationale: '合成非用户证据无保护状态' } } } : { name: 'memory_ready', input: { expectedDraftRevision: v.draftRevision } };
          operations.push(action.name);
          return { content: [{ type: 'tool-call' as const, toolName: action.name, toolCallId: `synthetic-${++calls}`, input: JSON.stringify(action.input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, warnings: [] };
        }
        const ref = { evidenceId: record.id, partKey: 'body' };
        const change = (tool: string, fields: Record<string, unknown>) => { name = tool; input = { expectedDraftRevision: v.draftRevision, rationale: '合成资料维护', ...fields }; };
        if (!candidate.organizations.some(row => row.title === '合成主题')) change('memory_organization_create', { organization: { title: '合成主题', parentId: null } });
        else if (!candidate.entities.length) change('memory_entity_create', { entity: { name: '合成主体', kind: 'person', aliases: [], identityEvidence: [ref] } });
        else if (!candidate.entries.some(row => row.format === 'reviewed')) {
          const subjectId = candidate.entities[0]!.id;
          change('memory_entry_create', { entry: { text: '合成主体的工作环境当前采用离线方式，日常操作不依赖外部服务连接；此状态持续生效，在明确迁移之前应按离线条件安排操作。', primaryNodeId: candidate.organizations.find(row => row.title === '合成主题')!.id,
            relatedNodeIds: [], entityIds: [subjectId], nature: 'fact', certainty: 'reported', lifecycle: 'current', scope: { subjectId, dimension: 'environment', qualifier: '合成工作环境' }, validFrom: null, validTo: null,
            retention: { score: 8, rationale: '影响后续操作' }, protectionAssessment: { decision: 'eligible', rationale: '持续生效环境状态', evidence: [ref] }, protection: { mode: 'state', stateKey: 'environment', value: 'offline', establishedBy: [ref], overrideRule: '明确变更环境状态' },
            followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref, role: 'supports' }], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] } });
        } else {
          const entry = candidate.entries.find(row => row.format === 'reviewed' && row.lifecycle === 'current')!;
          if (entry.format !== 'reviewed') throw new Error('合成条目类型错误');
          if (online && entry.protection.mode === 'state' && entry.protection.value !== 'online') {
            const { id: _id, revision: _revision, format: _format, createdInBatch: _created, updatedInBatch: _updated, evidence: _evidence, ...fields } = entry;
            change('memory_state_replace', { entryId: entry.id, expectedEntryRevision: entry.revision, evidence: [ref], entry: { ...fields, text: '合成主体的工作环境已变更为在线方式。', validFrom: effectiveAt, detailRefs: [], evidence: [{ ref, role: 'supports' }], protectionAssessment: { decision: 'eligible', rationale: '新环境替换旧状态', evidence: [ref] }, protection: { ...entry.protection, value: 'online', establishedBy: [ref] } } });
          } else if (compress && entry.text.length > 12 && JSON.stringify(request.prompt).includes('excessTextTokens')) {
            const { id: _id, revision: _revision, format: _format, createdInBatch: _created, updatedInBatch: _updated, evidence, ...fields } = entry;
            change('memory_entry_update', { entryId: entry.id, expectedEntryRevision: entry.revision, entry: { ...fields, text: '工作环境离线。', evidence: evidence.map(({ ref, role }) => ({ ref, role })) } });
          } else if (!entry.detailRefs.length) change('memory_detail_put', { entryId: entry.id, expectedEntryRevision: entry.revision, detailId: null, content: '详细档案专属哨兵，不属于常驻正文。' });
          else if (!candidate.relations.length) change('memory_relation', { expectedEntryRevision: entry.revision, relationId: null, relation: { subjectId: candidate.entities[0]!.id, objectId: candidate.entities[0]!.id, kind: 'describes', entryId: entry.id, validFrom: null, validTo: null } });
          else {
            const pending = candidate.evidence.flatMap(row => row.coverage.parts.map(part => ({ row, part }))).find(({ row, part }) => !candidate.coverage.some(item => item.ref.evidenceId === row.id && item.ref.partKey === part.key && !['pending-review', 'pending-source'].includes(item.decision)));
            if (pending) {
              const partRef = { evidenceId: pending.row.id, partKey: pending.part.key };
              const coveredEntry = candidate.entries.find(row => row.format === 'reviewed' && row.evidence.some(item => item.ref.evidenceId === partRef.evidenceId && item.ref.partKey === partRef.partKey));
              const used = !!coveredEntry;
              name = 'memory_coverage'; input = { expectedDraftRevision: v.draftRevision,
                coverage: { ref: partRef, decision: used ? 'retained' : 'no-effective-new-information', entryIds: coveredEntry ? [coveredEntry.id] : [], rationale: '合成覆盖决定' },
                protection: { ref: partRef, decision: used ? 'mapped' : 'no-protectable-state', entryIds: coveredEntry ? [coveredEntry.id] : [], rationale: '合成保护复核' } };
            } else { name = 'memory_ready'; input = { expectedDraftRevision: v.draftRevision }; }
          }
        }
      }
      operations.push(name);
      return { content: [{ type: 'tool-call', toolName: name, toolCallId: `synthetic-${++calls}`, input: JSON.stringify(input) }], finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, warnings: [] };
    },
  });
  return { model, prompts, generated, operations, fail: (value: boolean) => { failStream = value; }, compress: () => { compress = true; }, online: (at: string) => { online = true; effectiveAt = at; },
    holdGeneration: (ignoreAbort = false) => { let release!: () => void; ignoreGenerationAbort = ignoreAbort; generationGate = new Promise<void>(done => { release = done; }); return () => { generationGate = undefined; ignoreGenerationAbort = false; release(); }; },
    holdStream: () => { let release!: () => void; streamGate = new Promise<void>(done => { release = done; }); return () => { streamGate = undefined; release(); }; },
    get reviews() { return reviews; }, reject: (value: boolean) => { rejectReview = value; } };
}
async function fixture(t: test.TestContext, options: { mode?: 'legacy' | 'shadow' | 'v1'; enabled?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-native-v1-')), engine = syntheticModel();
  let core = await Core.open({ dataDir: dir, model: engine.model, memoryContextMode: options.mode ?? 'v1', memoryEnabled: options.enabled ?? true });
  t.after(async () => { await core.close(); await removeTemp(dir); });
  return { get core() { return core; }, engine, dir,
    reopen: async () => { await core.close(); core = await Core.open({ dataDir: dir, model: engine.model, memoryEnabled: options.enabled ?? true }); },
    async send(content: string, contextId = 'main') { const row = await core.submitMessage({ content, contextId }); await finished(core, row.runId!); return row; },
    async settled(runId: string) { return until(() => core.projectMemory.jobs().find(job => job.runId === runId), job => !!job && ['succeeded', 'failed', 'interrupted'].includes(job.status)); },
    request(url: string, body?: unknown) { return createApp(core).request(url, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${core.controlToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); },
  };
}

test('真实 Core → 原生 manager → 条目/评分/保护/关联/详情 → 独立复核 → 版本与下一会话资料请求', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const first = await f.send('合成工作环境采用离线方式。');
  const job = await f.settled(first.runId!); assert.equal(job!.status, 'succeeded', JSON.stringify(job)); assert.ok(job!.nativeTaskId);
  const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!;
  const native = await manager.getTask(job!.nativeTaskId!); assert.equal(native!.toolName, 'organize-memory-v1'); assert.equal(native!.agentId, 'memory-organizer');
  assert.match(native!.toolCallId, /^memory-v1:/); assert.equal(native!.maxRetries, 0);
  assert.ok(f.engine.reviews > 0); for (const tool of ['memory_entry_create', 'memory_detail_put', 'memory_relation', 'memory_coverage', 'memory_ready']) assert.ok(f.engine.operations.includes(tool));
  const version = f.core.projectMemory.version(); assert.equal(version.format, 'shittimchest-memory-v1'); assert.ok(version.manifestHash);
  const published = f.core.projectMemory.readV1Version(version.id); const entry = published.workspace.candidate.entries.find(row => row.format === 'reviewed')!;
  assert.equal(entry.format === 'reviewed' && entry.retention.score, 8); assert.equal(entry.format === 'reviewed' && entry.protection.mode, 'state');
  assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  const other = f.core.createConversationContext({ id: 'chat.fresh', name: '新会话' });
  const second = await f.send('新会话当前输入', other.id); const view = f.core.memoryV1RunView(second.runId!)!;
  const prompt = f.engine.prompts.at(-1) as { role: string; content: unknown }[];
  assert.equal(view.mode, 'v1'); assert.equal(view.injected, true); assert.equal(view.resident.finalText, published.finalText);
  assert.deepEqual(view.measurement, measureMemoryText(view.observationText));
  assert.ok(prompt.some(message => message.role === 'user' && JSON.stringify(message.content).includes(JSON.stringify(view.observationText).slice(1, -1))));
  const system = JSON.stringify(prompt.filter(message => message.role === 'system'));
  assert.ok(!system.includes('合成工作环境采用离线方式。')); assert.ok(!system.includes(entry.text));
  const text = JSON.stringify(prompt); assert.ok(text.includes('合成工作环境采用离线方式。')); assert.ok(!text.includes('详细档案专属哨兵'));
  const snapshot = f.core.projectMemory.snapshot(second.runId!); assert.ok(!JSON.stringify(snapshot.nativeMessages).includes('历史资料：以下是过去'));
  assert.equal(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()!.n, 2);
  await f.settled(second.runId!);
  assert.equal(f.core.projectMemory.version().id, version.id, '第二轮无新增正文仍更新独立处理基线');
  const noOpHead = f.core.projectMemory.version().id; const processing = f.core.projectMemory.processingV1Head();
  await f.core.reconcileMemoryV1(); assert.equal(f.core.projectMemory.version().id, noOpHead); assert.equal(f.core.projectMemory.processingV1Head(), processing);
  const dto = await (await f.request(`/memory/runs/${second.runId}/view`)).json();
  assert.doesNotMatch(JSON.stringify(dto), /nativeTaskId|canonicalIdentity|scopeId|contentHash|evidenceId|sourceRef|partBindings/);
  assert.equal((await f.request(`/memory/versions/${version.id}/entries/${entry.id}`)).status, 200);
});

test('关闭整理保留同事务受理义务，重新开启核对并通过运行配置跨重启保持 V1', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { enabled: false });
  f.core.configure('runtime', { memoryContextMode: 'v1' });
  const first = await f.send('合成暂停期间输入'); await f.core.reconcileMemoryV1();
  assert.equal(f.engine.generated.length, 0); assert.ok(f.core.memoryV1Status().intake!.accepted > 0); assert.ok(f.core.memoryV1Status().pendingRecords > 0);
  f.core.configure('runtime', { memoryEnabled: true }); const job = await f.settled(first.runId!); assert.equal(job!.status, 'succeeded', JSON.stringify(job));
  await f.reopen(); assert.equal(f.core.memoryV1Status().mode, 'v1'); assert.equal(f.core.memoryV1Status().pendingRecords, 0);
});

test('legacy 默认与 shadow 均不走 V1 自动发布，shadow 明确拒绝手动发布', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { mode: 'legacy', enabled: false });
  assert.equal(f.core.memoryV1Status().mode, 'legacy'); await f.send('兼容模式原文'); assert.equal(f.engine.generated.length, 0);
  f.core.configure('runtime', { memoryContextMode: 'shadow', memoryEnabled: true });
  const next = await f.send('观察模式当前输入'); await f.core.reconcileMemoryV1();
  assert.equal(f.engine.generated.length, 0); assert.equal(f.core.projectMemory.version().id, 'initial');
  assert.equal(f.core.memoryV1RunView(next.runId!)!.injected, false);
  const response = await f.request('/memory/requests', { runId: next.runId }); assert.equal(response.status, 409); assert.equal((await response.json()).error, 'memory_shadow_no_publication');
});

test('复核失败不发布，显式重试走新的原生任务；无完整快照保持 pending-source', { timeout: 40_000 }, async t => {
  const f = await fixture(t); f.engine.reject(true);
  const first = await f.send('合成待复核来源'); const failed = await f.settled(first.runId!); assert.equal(failed!.status, 'failed'); assert.equal(f.core.projectMemory.version().id, 'initial');
  assert.ok(f.core.memoryV1Status().pendingRecords > 0); f.engine.reject(false);
  const retry = await f.request(`/memory/jobs/${failed!.id}/retry`, {}); assert.equal(retry.status, 202);
  const row = await retry.json(); await until(() => f.core.projectMemory.jobs().find(job => job.id === row.id), job => job?.status === 'succeeded');
  assert.notEqual(f.core.projectMemory.jobs().find(job => job.id === row.id)!.nativeTaskId, failed!.nativeTaskId);
  f.core.store.db.prepare('DELETE FROM model_snapshots WHERE run_id=?').run(first.runId!);
  await f.core.reconcileMemoryV1(); assert.ok(f.core.memoryV1Status().intake!.pendingSource > 0);
  const issue = await (await f.request('/memory/issues')).json(); assert.ok(issue.intake.pendingSource > 0);
});

test('普通 queue 可重试原生复核失败，完整回执随后稳定去重', { timeout: 40_000 }, async t => {
  const f = await fixture(t); f.engine.reject(true);
  const first = await f.send('合成普通重试的原生来源');
  const failed = await f.settled(first.runId!); assert.equal(failed!.status, 'failed');
  f.engine.reject(false);
  const retry = await f.core.queueMemory(first.runId!);
  assert.notEqual(retry.id, failed!.id); assert.notEqual(retry.nativeTaskId, failed!.nativeTaskId);
  const completed = await until(() => f.core.projectMemory.jobs().find(row => row.id === retry.id), row => !!row && ['succeeded', 'failed', 'interrupted'].includes(row.status));
  assert.equal(completed!.status, 'succeeded', JSON.stringify(completed));
  await f.core.reconcileMemoryV1();
  assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  const head = f.core.projectMemory.version(), processing = f.core.projectMemory.processingV1Head();
  const calls = f.engine.generated.length, jobs = f.core.projectMemory.jobs().length;
  assert.equal((await f.core.queueMemory(first.runId!)).id, retry.id);
  await f.core.reconcileMemoryV1();
  assert.equal(f.engine.generated.length, calls); assert.equal(f.core.projectMemory.jobs().length, jobs);
  assert.deepEqual(f.core.projectMemory.version(), head); assert.equal(f.core.projectMemory.processingV1Head(), processing);
});

test('受控恢复计划显式执行并发布新 generation，重复 execute 返回同一 job', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const first = await f.send('合成恢复来源'); assert.equal((await f.settled(first.runId!))!.status, 'succeeded');
  const version = f.core.projectMemory.version();
  const response = await f.request('/memory/recovery/plans', { targetVersionId: version.id, expectedHead: version.id }); assert.equal(response.status, 201);
  const plan = await response.json(); assert.doesNotMatch(JSON.stringify(plan), /ManifestHash|ProcessingHead|requiredEvidenceIds/);
  const submitted = await f.request(`/memory/recovery/plans/${plan.id}/execute`, {}); assert.equal(submitted.status, 202); const job = await submitted.json();
  await until(() => f.core.projectMemory.jobs().find(row => row.id === job.id), row => row?.status === 'succeeded');
  assert.ok(f.core.projectMemory.version().generation > version.generation);
  const repeated = await (await f.request(`/memory/recovery/plans/${plan.id}/execute`, {})).json(); assert.equal(repeated.id, job.id);
  const unauthorized = await createApp(f.core).request('/memory/recovery/plans', { method: 'POST', body: '{}' }); assert.equal(unauthorized.status, 401);
});

test('失败与中断的已受理输入都进入原生整理，未受理取消不产生义务', { timeout: 40_000 }, async t => {
  const f = await fixture(t); f.engine.fail(true);
  const first = await f.send('合成失败运行的有效输入'); assert.equal(f.core.store.getRun(first.runId!)!.status, 'failed');
  assert.equal((await f.settled(first.runId!))!.status, 'succeeded');
  f.engine.fail(false); const release = f.engine.holdStream();
  try {
    const admitted = await f.core.submitMessage({ content: '合成中断运行的有效输入' });
    await until(() => f.core.memoryV1RunView(admitted.runId!), Boolean);
    const queued = await f.core.submitMessage({ content: '合成未受理取消', mode: 'queue' });
    f.core.cancelQueuedMessage(queued.id, f.core.queuedMessages('main').find(row => row.id === queued.id)!.revision);
    f.core.sessions.peek('main')!.abort(); release(); await finished(f.core, admitted.runId!);
    assert.equal(f.core.store.getRun(admitted.runId!)!.status, 'interrupted'); assert.equal((await f.settled(admitted.runId!))!.status, 'succeeded');
    assert.equal(f.core.memoryV1Status().intake!.accepted, 2);
  } finally { release(); }
});

test('V1 首请求资料冻结覆盖 steer、排队与后台更新，资料投影不进入受理权限', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const first = await f.send('首份跨会话合成原文'); await f.settled(first.runId!);
  const other = f.core.createConversationContext({ id: 'chat.freeze', name: '冻结对话' });
  const release = f.engine.holdStream();
  try {
    const current = await f.core.submitMessage({ contextId: other.id, content: '冻结当前输入' });
    await until(() => f.core.memoryV1RunView(current.runId!), Boolean); const frozen = f.core.memoryV1RunView(current.runId!)!;
    const steer = await f.core.submitMessage({ contextId: other.id, content: '当前补充', mode: 'steer', expectedRunId: current.runId });
    const queued = await f.core.submitMessage({ contextId: other.id, content: '下一排队输入', mode: 'queue' });
    assert.equal(steer.runId, current.runId); assert.deepEqual(f.core.memoryV1RunView(current.runId!), frozen);
    release(); await finished(f.core, current.runId!); await f.settled(current.runId!);
    const next = await until(() => f.core.store.getSignal(queued.id), row => row?.status === 'accepted'); await finished(f.core, next!.runId!); await f.settled(next!.runId!);
    assert.notEqual(next!.runId, current.runId); assert.deepEqual(f.core.memoryV1RunView(current.runId!), frozen);
    const prompt = f.engine.prompts.find(row => JSON.stringify(row).includes('冻结当前输入')) as { role: string; content: unknown }[];
    const projection = prompt.find(row => row.role === 'user' && JSON.stringify(row.content).includes('历史资料：以下是过去'))!;
    assert.deepEqual(Object.keys(projection).sort(), ['content', 'role']);
    assert.equal(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()!.n, 4);
  } finally { release(); }
});

test('现行保护状态由新证据显式替换，恢复参考旧版不倒拨现行基线', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const first = await f.send('合成离线环境状态'); await f.settled(first.runId!); const old = f.core.projectMemory.version();
  const effectiveAt = new Date(Date.now() - 100).toISOString(); f.engine.online(effectiveAt); const second = await f.send(`合成环境已在 ${effectiveAt} 改在线`); const secondJob = await f.settled(second.runId!); assert.equal(secondJob!.status, 'succeeded', JSON.stringify({ secondJob, operations: f.engine.operations }));
  const current = f.core.projectMemory.version(); const data = f.core.projectMemory.readV1Version(current.id);
  assert.ok(f.engine.operations.includes('memory_state_replace')); assert.ok(data.workspace.candidate.overrides.length);
  assert.ok(data.workspace.candidate.entries.some(row => row.format === 'reviewed' && row.lifecycle === 'superseded'));
  const response = await f.request('/memory/recovery/plans', { targetVersionId: old.id, expectedHead: current.id }); const plan = await response.json();
  assert.equal(response.status, 201); const execution = await f.request(`/memory/recovery/plans/${plan.id}/execute`, {}); const submitted = await execution.json(); assert.equal(execution.status, 202, JSON.stringify(submitted));
  await until(() => f.core.projectMemory.jobs().find(row => row.id === submitted.id), row => !!row && ['succeeded', 'failed'].includes(row.status));
  assert.equal(f.core.projectMemory.jobs().find(row => row.id === submitted.id)!.status, 'succeeded');
  const restored = f.core.projectMemory.readV1Version(f.core.projectMemory.version().id);
  assert.ok(restored.workspace.candidate.entries.some(row => row.format === 'reviewed' && row.lifecycle === 'current' && row.protection.mode === 'state' && row.protection.value === 'online'));
  assert.ok(f.core.projectMemory.version().generation > current.generation);
});

test('真实原生整理容量反馈触发修正，保护本身超限保留旧版与待处理义务', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const first = await f.send('合成容量来源'); await f.settled(first.runId!);
  const prior = f.core.projectMemory.version(), draft = f.core.projectMemory.readV1Version(prior.id).draft;
  const policy: MemoryContextPolicy = structuredClone(f.core.memoryV1Status().policy!); policy.revision++; policy.resident.textTokens = draft.measurement.textTokens! - 2;
  f.engine.compress(); f.core.configure('runtime', { memoryContextPolicy: policy });
  const corrected = await until(() => f.core.projectMemory.jobs().filter(row => row.runId === first.runId!), rows => rows.length > 1 && ['succeeded', 'failed'].includes(rows.at(-1)!.status));
  assert.equal(corrected.at(-1)!.status, 'succeeded', JSON.stringify({ job: corrected.at(-1), operations: f.engine.operations }));
  assert.ok(f.engine.operations.includes('memory_entry_update')); assert.ok(corrected.length > 1);
  const head = f.core.projectMemory.version(); assert.ok(f.core.projectMemory.readV1Version(head.id).draft.measurement.textTokens! <= policy.resident.textTokens);
  const nextPolicy = structuredClone(policy); nextPolicy.revision++; nextPolicy.resident.textTokens = 1;
  f.core.configure('runtime', { memoryContextPolicy: nextPolicy });
  const blocked = await until(() => f.core.projectMemory.jobs(), rows => rows.length > corrected.length && rows.at(-1)!.status === 'failed');
  assert.equal(blocked.at(-1)!.error, 'memory_capacity_conflict'); assert.equal(f.core.projectMemory.version().id, head.id);
  assert.ok(f.core.projectMemory.readV1Version(head.id).workspace.candidate.entries.some(row => row.format === 'reviewed' && row.protection.mode === 'state'));
});

test('原生取消与重启对账保留资料，新尝试不能被旧 job 成功阻塞', { timeout: 40_000 }, async t => {
  const f = await fixture(t); f.core.configure('runtime', { memoryContextMode: 'v1' });
  const release = f.engine.holdGeneration();
  try {
    const row = await f.send('合成取消整理来源'); const running = await until(() => f.core.projectMemory.jobs().find(job => job.runId === row.runId), job => job?.status === 'running');
    const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!; await manager.cancel(running!.nativeTaskId!);
    release(); await until(() => f.core.projectMemory.jobs().find(job => job.id === running!.id), job => job?.status === 'interrupted');
    assert.ok(f.core.memoryV1Status().pendingRecords > 0); await f.reopen();
    const retried = await until(() => f.core.projectMemory.jobs().filter(job => job.runId === row.runId), jobs => jobs.length > 1 && jobs.at(-1)!.status === 'succeeded');
    assert.notEqual(retried.at(-1)!.nativeTaskId, running!.nativeTaskId); assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  } finally { release(); }
});

class SyntheticTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('loopback HTTP、独立 CLI 进程与现有 TUI 记忆入口使用相同受控合同', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const first = await f.send('合成管理入口来源'); await f.settled(first.runId!);
  const server = serve({ fetch: createApp(f.core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  const cli = async (...args: string[]) => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { PATH: process.env.PATH, HOME: f.dir, NO_COLOR: '1', SHITTIMCHEST_CORE_URL: url, SHITTIMCHEST_CONTROL_TOKEN: f.core.controlToken, SHITTIMCHEST_DATA_DIR: f.dir }, timeout: 15_000 });
    return JSON.parse(result.stdout);
  };
  const app = new TerminalApp(new Client(url, f.core.controlToken), 'main', new SyntheticTerminal());
  const state = app as unknown as { capabilities: Set<string>; choose: () => Promise<string | undefined>; memory: () => Promise<void>; note: (value: string) => void };
  const notes: string[] = []; state.note = value => { notes.push(value); }; let choices: (string | undefined)[] = []; state.choose = async () => choices.shift();
  try {
    const versions = await cli('memory', 'versions'); assert.ok(versions.versions.length); const id = versions.versions.at(-1).id;
    const version = await cli('memory', 'version', id); const entry = version.entries.find((row: { format: string }) => row.format === 'reviewed');
    assert.equal((await cli('memory', 'entry', id, entry.id)).entry.id, entry.id); assert.ok((await cli('memory', 'view', first.runId!)).view.injected);
    assert.doesNotMatch(JSON.stringify(await cli('memory', 'issues')), /nativeTaskId|canonicalIdentity|partBindings/);
    const config = await cli('configuration', 'runtime', '{"memoryContextMode":"shadow"}'); assert.equal(config.memoryContextMode, 'shadow');
    state.capabilities.add('memory-v1'); choices = ['context', 'mode', 'v1']; await state.memory(); assert.equal(f.core.memoryV1Status().mode, 'v1');
    choices = ['issues']; await state.memory(); assert.ok(notes.some(note => note.includes('pendingRecords')));
    choices = ['versions', id, 'show']; await state.memory(); assert.ok(notes.some(note => note.includes(entry.text)));
    choices = ['versions', id, 'recover', 'yes']; await state.memory();
    await until(() => f.core.projectMemory.jobs(), jobs => jobs.length > 1 && jobs.at(-1)!.status === 'succeeded');
    assert.ok(notes.some(note => note.includes('恢复重整任务已提交')));
  } finally { await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('恢复计划绑定 processingHead 与 cutoff，旧计划不能跨正文 no-op 继续执行', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const first = await f.send('合成恢复基线'); await f.settled(first.runId!);
  const head = f.core.projectMemory.version().id; const body = { targetVersionId: head, expectedHead: head };
  const app = createApp(f.core), headers = { Authorization: `Bearer ${f.core.controlToken}`, 'content-type': 'application/json', 'Idempotency-Key': 'synthetic-plan-operation' };
  const create = () => app.request('/memory/recovery/plans', { method: 'POST', headers, body: JSON.stringify(body) });
  const plan = await (await create()).json(); assert.equal((await (await create()).json()).id, plan.id);
  const second = await f.send('合成无新增正文'); await f.settled(second.runId!); assert.equal(f.core.projectMemory.version().id, head);
  const result = await f.request(`/memory/recovery/plans/${plan.id}/execute`, {}); assert.equal(result.status, 409); assert.match((await result.json()).error, /^memory_recovery_(?:plan|cutoff)_conflict$/);
  const forged = await f.request(`/memory/recovery/plans/${plan.id}/execute`, { expectedProcessingHead: 'synthetic' }); assert.equal(forged.status, 400);
});

test('legacy 旧正文完整承接，shadow 切换后不借 system 通道注入 V1 正文', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const legacy = f.core.projectMemory.version();
  fs.writeFileSync(path.join(legacy.filesDirectory, 'synthetic.md'), '合成旧版完整正文，尚未逐项核对。');
  const first = await f.send('合成新输入'); const job = await f.settled(first.runId!); assert.equal(job!.status, 'succeeded', JSON.stringify(job));
  const head = f.core.projectMemory.version(); const data = f.core.projectMemory.readV1Version(head.id);
  assert.throws(() => f.core.configure('runtime', { memoryContextMode: 'legacy' }), /memory_legacy_format_incompatible/);
  assert.ok(data.workspace.candidate.entries.some(row => row.format === 'legacy-unreviewed' && row.text.includes('合成旧版完整正文')));
  f.core.configure('runtime', { memoryContextMode: 'shadow' });
  const other = f.core.createConversationContext({ id: 'chat.shadow-after', name: '观察会话' });
  await f.send('观察模式当前输入', other.id); assert.ok(!JSON.stringify(f.engine.prompts.at(-1)).includes('合成旧版完整正文')); assert.equal(f.core.projectMemory.version().id, head.id);
});

test('停用正在整理的 V1 任务会撤销原生执行，重新启用对账后可处理', { timeout: 40_000 }, async t => {
  const f = await fixture(t); const release = f.engine.holdGeneration();
  try {
    const first = await f.send('合成停用中的来源'); const job = await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => row?.status === 'running');
    assert.throws(() => f.core.configure('runtime', { memoryContextMode: 'shadow' }), /memory_configuration_busy/);
    f.core.configure('runtime', { memoryEnabled: false }); release();
    await until(() => f.core.projectMemory.jobs().find(row => row.id === job!.id), row => row?.status === 'interrupted');
    assert.equal(f.core.projectMemory.version().id, 'initial'); assert.ok(f.core.memoryV1Status().pendingRecords > 0);
    f.core.configure('runtime', { memoryEnabled: true });
    await until(() => f.core.projectMemory.jobs().filter(row => row.runId === first.runId), rows => rows.length > 1 && rows.at(-1)!.status === 'succeeded');
    assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  } finally { release(); }
});

test('真实目录图片能力与 SDK 传输：丢失附件持续 pending，重启补回原 bytes 后重新送审并解除', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { enabled: false }); const originalFetch = globalThis.fetch; const transport: Record<string, unknown>[] = [];
  const model: Model<'anthropic-messages'> = { id: 'synthetic-vision', name: 'Synthetic vision', api: 'anthropic-messages', provider: 'synthetic-vision', baseUrl: 'https://synthetic-vision.invalid', input: ['text', 'image'], reasoning: false, contextWindow: 64000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const install = () => {
    f.core.providerRegistry.setProvider(createProvider({ id: model.provider, name: model.name, baseUrl: model.baseUrl, models: [model], api: anthropicMessagesApi(), auth: { apiKey: { name: 'Synthetic', resolve: async () => ({ auth: { apiKey: 'synthetic-not-a-real-key' }, source: 'synthetic' }) } } }));
    f.core.models.save({ id: 'memory.synthetic', name: 'Synthetic memory', providerId: model.provider, modelId: model.id });
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); assert.ok(request.url.startsWith(model.baseUrl));
    const body = await request.json() as { system?: unknown; messages: { role: string; content: unknown }[]; tools?: { name: string }[] }; transport.push(body as unknown as Record<string, unknown>);
    const names = new Map<string, string>();
    for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'tool_use') names.set(block.id, block.name);
    const prompt: unknown[] = [{ role: 'system', content: body.system }];
    for (const message of body.messages) {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
      const results = blocks.filter(block => block.type === 'tool_result');
      if (results.length) for (const block of results) prompt.push({ role: 'tool', content: [{ toolName: names.get(block.tool_use_id), content: block.content }] });
      else prompt.push(message);
    }
    const generated = await f.engine.model.doGenerate({ prompt, tools: body.tools, abortSignal: request.signal } as never);
    const frames: Record<string, unknown>[] = [{ type: 'message_start', message: { id: `synthetic-${transport.length}`, type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }];
    let index = 0;
    for (const part of generated.content) {
      if (part.type === 'text') {
        frames.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part.text } }, { type: 'content_block_stop', index });
      } else if (part.type === 'tool-call') {
        frames.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: part.toolCallId, name: part.toolName, input: {} } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part.input } }, { type: 'content_block_stop', index });
      }
      index++;
    }
    frames.push({ type: 'message_delta', delta: { stop_reason: generated.finishReason === 'tool-calls' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=', 'base64');
  let release = () => {};
  try {
    install(); f.core.configure('runtime', { memoryModel: 'memory.synthetic', memoryEnabled: true });
    const asset = await f.core.assets.put(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), 'synthetic-image.png');
    release = f.engine.holdStream();
    const first = await f.core.submitMessage({ content: '合成图片来源的环境状态', attachments: [asset.id] });
    await until(() => f.core.memoryV1RunView(first.runId!), Boolean); fs.unlinkSync(path.join(f.dir, 'assets', asset.id)); release();
    await finished(f.core, first.runId!); const partial = await f.settled(first.runId!); assert.equal(partial!.status, 'succeeded', JSON.stringify(partial));
    assert.ok(f.core.memoryV1Status().intake!.pendingSource > 0); assert.ok(f.core.memoryV1Status().pendingRecords > 0);
    const blockedHead = f.core.projectMemory.version().id;
    const plan = f.core.planMemoryV1Recovery(blockedHead, blockedHead); assert.ok(plan.pendingRuns > 0);
    await assert.rejects(f.core.executeMemoryV1Recovery(plan.id), /memory_recovery_source_deferred/);
    // 部分发布后仍会异步复查资料；等待既有配置门禁空闲，不绕过 admission。
    await until(async () => {
      const response = await f.request('/configuration/runtime', { memoryContextMode: 'shadow', memoryModel: 'same' });
      if (response.status === 409 && (await response.clone().json()).error === 'memory_configuration_busy') return false;
      assert.equal(response.status, 200, JSON.stringify(await response.json())); return true;
    }, Boolean);
    await f.reopen(); fs.writeFileSync(path.join(f.dir, 'assets', asset.id), bytes); install();
    f.core.configure('runtime', { memoryContextMode: 'v1', memoryModel: 'memory.synthetic' });
    const complete = await until(() => f.core.projectMemory.jobs().filter(row => row.runId === first.runId), rows => rows.length > 1 && ['succeeded', 'failed'].includes(rows.at(-1)!.status));
    assert.equal(complete.at(-1)!.status, 'succeeded', JSON.stringify(complete.at(-1))); assert.notEqual(complete.at(-1)!.nativeTaskId, partial!.nativeTaskId);
    assert.equal(f.core.memoryV1Status().intake!.pendingSource, 0); assert.equal(f.core.memoryV1Status().pendingRecords, 0);
    const requestsWithBytes = transport.filter(request => JSON.stringify(request).includes(bytes.toString('base64'))); assert.ok(requestsWithBytes.length >= 2);
    assert.ok(requestsWithBytes.some(request => JSON.stringify(request.system).includes('独立复核本次实际变更和覆盖义务')));
    assert.ok(f.core.projectMemory.readV1Version(f.core.projectMemory.version().id).workspace.candidate.evidence.some(record => record.attachments.length && record.coverage.status === 'complete'));
  } finally { release(); globalThis.fetch = originalFetch; }
});

test('active 必须有实际模型资源，伪造策略和无效联合配置不能部分开启', { timeout: 20_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-v1-unready-'));
  try {
    await assert.rejects(Core.open({ dataDir: directory, memoryContextMode: 'v1' }), /model_profile_not_found/);
    const legacy = await Core.open({ dataDir: directory, memoryEnabled: false });
    try { assert.equal(legacy.memoryV1Status().mode, 'legacy'); assert.equal(legacy.memoryV1Status().intake, null); }
    finally { await legacy.close(); }
  } finally { await removeTemp(directory); }
  const f = await fixture(t, { mode: 'legacy', enabled: false });
  const { createDefaultMemoryContextPolicy } = await import('../src/memory/v1/policy.js'); const policy = createDefaultMemoryContextPolicy();
  policy.tokenizer = { ...policy.tokenizer, readiness: 'ready', version: 'synthetic-wrong-version', vocabularyHash: '0'.repeat(64) };
  assert.throws(() => f.core.configure('runtime', { memoryContextMode: 'v1', memoryEnabled: true, memoryContextPolicy: policy }), /memory_tokenizer_identity_mismatch/);
  assert.equal(f.core.memoryV1Status().mode, 'legacy'); assert.equal(f.core.memoryEnabled(), false);
  assert.throws(() => f.core.configure('runtime', { memoryContextMode: 'v1', memoryEnabled: true, memoryModel: 'synthetic-missing-model' }), /model_profile_not_found/);
  assert.equal(f.core.memoryV1Status().mode, 'legacy'); assert.equal(f.core.memoryEnabled(), false); assert.equal(f.engine.generated.length, 0);
});

test('停用同时收尾运行中及从未启动的原生记忆任务，重新启用恢复两份资料', { timeout: 40_000 }, async t => {
  const f = await fixture(t), release = f.engine.holdGeneration();
  try {
    const first = await f.send('合成运行中整理资料');
    const running = await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => row?.status === 'running');
    const second = await f.send('合成排队整理资料');
    const queued = await until(() => f.core.projectMemory.jobs().find(row => row.runId === second.runId), row => !!row?.nativeTaskId && row.status === 'pending');
    const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!;
    assert.equal((await manager.getTask(queued!.nativeTaskId!))!.status, 'pending');
    const head = f.core.projectMemory.version(), processing = f.core.projectMemory.processingV1Head();
    const snapshots = [first, second].map(row => f.core.projectMemory.snapshot(row.runId!));
    const signals = f.core.store.db.prepare('SELECT count(*) AS count FROM signals').get();
    const calls = f.engine.generated.length;
    f.core.configure('runtime', { memoryEnabled: false });
    await until(() => manager.getTask(queued!.nativeTaskId!), row => row?.status === 'cancelled');
    await until(() => manager.getTask(running!.nativeTaskId!), row => row?.status === 'cancelled');
    release();
    await until(() => f.core.projectMemory.jobs().find(row => row.id === running!.id), row => row?.status === 'interrupted');
    await f.core.reconcileMemoryV1();
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'interrupted', '从未进入 executor 的取消任务也必须可重试');
    assert.equal(f.engine.generated.length, calls);
    assert.deepEqual(f.core.projectMemory.version(), head); assert.equal(f.core.projectMemory.processingV1Head(), processing);
    assert.ok(f.core.memoryV1Status().pendingRecords > 0);
    f.core.configure('runtime', { memoryEnabled: false }); await f.core.reconcileMemoryV1();
    assert.equal((await f.request('/configuration/runtime', { memoryContextMode: 'shadow' })).status, 200);
    const currentPolicy = f.core.memoryV1Status().policy!;
    const policy = { ...structuredClone(currentPolicy), revision: currentPolicy.revision + 1 };
    assert.equal((await f.request('/configuration/runtime', { memoryContextPolicy: policy })).status, 200);
    assert.equal(f.engine.generated.length, calls);
    assert.equal((await f.request('/configuration/runtime', { memoryContextMode: 'v1', memoryEnabled: true })).status, 200);
    await f.core.reconcileMemoryV1();
    for (const row of [first, second]) {
      const jobs = await until(() => f.core.projectMemory.jobs().filter(job => job.runId === row.runId), jobs => jobs.length > 1 && jobs.at(-1)!.status === 'succeeded');
      assert.notEqual(jobs.at(-1)!.nativeTaskId, jobs[0]!.nativeTaskId);
    }
    assert.equal(f.core.memoryV1Status().pendingRecords, 0);
    assert.deepEqual([first, second].map(row => f.core.projectMemory.snapshot(row.runId!)), snapshots);
    assert.deepEqual(f.core.store.db.prepare('SELECT count(*) AS count FROM signals').get(), signals);
    const finalHead = f.core.projectMemory.version(), finalProcessing = f.core.projectMemory.processingV1Head();
    await manager.cancel(queued!.nativeTaskId!); await f.core.reconcileMemoryV1();
    assert.deepEqual(f.core.projectMemory.version(), finalHead); assert.equal(f.core.projectMemory.processingV1Head(), finalProcessing);
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'interrupted');
  } finally { release(); }
});

test('queued 原生取消回执立即允许 retry，旧终态不覆盖新尝试或正常运行任务', { timeout: 40_000 }, async t => {
  const f = await fixture(t), release = f.engine.holdGeneration();
  try {
    const first = await f.send('合成占用原生 owner');
    const running = await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => row?.status === 'running');
    const second = await f.send('合成原生队列重试');
    const queued = await until(() => f.core.projectMemory.jobs().find(row => row.runId === second.runId), row => !!row?.nativeTaskId && row.status === 'pending');
    const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!;
    await manager.cancel(queued!.nativeTaskId!);
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'interrupted');
    const response = await f.request(`/memory/jobs/${queued!.id}/retry`, {}); assert.equal(response.status, 202);
    const dto = await response.json(); assert.deepEqual(Object.keys(dto).sort(), ['contextId', 'createdAt', 'error', 'id', 'runId', 'status']);
    const replacement = f.core.projectMemory.jobs().find(row => row.id === dto.id)!;
    assert.notEqual(replacement.nativeTaskId, queued!.nativeTaskId);
    assert.equal((await manager.getTask(replacement.nativeTaskId!))!.status, 'pending');
    const old = (await manager.getTask(queued!.nativeTaskId!))!;
    for (const status of ['cancelled', 'failed', 'timed_out', 'completed'] as const) {
      await manager.config.onTaskCancelled?.({ ...old, status });
      await manager.config.onTaskComplete?.({ ...old, status });
      await manager.config.onTaskFailed?.({ ...old, status });
    }
    // 任意一个身份维度不符，都不能把其它仍存活的 job 当成旧取消任务。
    for (const wrong of [{ ...old, args: { jobId: replacement.id } }, { ...old, id: replacement.nativeTaskId! }, { ...old, args: { jobId: replacement.id }, id: replacement.nativeTaskId!, runId: first.runId! }]) await manager.config.onTaskCancelled?.(wrong);
    await f.core.reconcileMemoryV1(); await f.core.reconcileMemoryV1();
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === running!.id)!.status, 'running');
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === replacement.id)!.status, 'pending');
    assert.equal((await manager.getTask(running!.nativeTaskId!))!.status, 'running');
    assert.equal(f.core.projectMemory.jobs().filter(row => row.runId === second.runId).length, 2);
    release(); await f.settled(first.runId!);
    await until(() => f.core.projectMemory.jobs().find(row => row.id === replacement.id), row => row?.status === 'succeeded');
    const head = f.core.projectMemory.version(), processing = f.core.projectMemory.processingV1Head();
    await manager.config.onTaskCancelled?.(old); await manager.config.onTaskComplete?.({ ...old, status: 'completed' });
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === replacement.id)!.status, 'succeeded');
    assert.deepEqual(f.core.projectMemory.version(), head); assert.equal(f.core.projectMemory.processingV1Head(), processing);
    assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  } finally { release(); }
});

test('原生回执漏失由去重前对账恢复，未知或不匹配的 native 状态不伪终结', { timeout: 40_000 }, async t => {
  const f = await fixture(t), release = f.engine.holdGeneration();
  const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!, getTask = manager.getTask.bind(manager), onCancelled = manager.config.onTaskCancelled;
  try {
    const first = await f.send('合成保持运行的整理');
    const running = await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => row?.status === 'running');
    const second = await f.send('合成需要原生对账的整理');
    const queued = await until(() => f.core.projectMemory.jobs().find(row => row.runId === second.runId), row => !!row?.nativeTaskId && row.status === 'pending');
    manager.config.onTaskCancelled = () => {};
    await manager.cancel(queued!.nativeTaskId!);
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'pending');
    manager.getTask = async id => { if (id === queued!.nativeTaskId) throw new Error('合成暂时读取失败'); return getTask(id); };
    await assert.rejects(f.core.reconcileMemoryV1(), /合成暂时读取失败/);
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'pending');
    manager.getTask = async id => id === queued!.nativeTaskId ? null : getTask(id);
    await f.core.reconcileMemoryV1(); assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'pending');
    const terminal = (await getTask(queued!.nativeTaskId!))!;
    manager.getTask = async id => id === queued!.nativeTaskId ? { ...terminal, runId: first.runId! } : getTask(id);
    await f.core.reconcileMemoryV1(); assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'pending');
    manager.getTask = getTask;
    // 不先显式 reconcile：queue 自身必须在 fingerprint 去重前修复旧 pending。
    const replacement = await f.core.queueMemory(second.runId!);
    assert.notEqual(replacement.id, queued!.id); assert.notEqual(replacement.nativeTaskId, queued!.nativeTaskId);
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'interrupted');
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === running!.id)!.status, 'running');
    release(); await f.settled(first.runId!);
    await until(() => f.core.projectMemory.jobs().find(row => row.id === replacement.id), row => row?.status === 'succeeded');
    assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  } finally { manager.getTask = getTask; manager.config.onTaskCancelled = onCancelled; release(); }
});

test('原生排队任务在绑定前取消，绑定后补读终态且保留来源义务', { timeout: 40_000 }, async t => {
  const f = await fixture(t), release = f.engine.holdGeneration();
  const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!, enqueue = manager.enqueue.bind(manager);
  try {
    const first = await f.send('合成绑定竞争占用者');
    await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => row?.status === 'running');
    manager.enqueue = async (...args) => {
      const result = await enqueue(...args);
      if (args[0].toolName === 'organize-memory-v1') await manager.cancel(result.task.id);
      return result;
    };
    const second = await f.send('合成绑定前取消的来源');
    const job = await until(() => f.core.projectMemory.jobs().find(row => row.runId === second.runId), row => !!row?.nativeTaskId && row.status === 'interrupted');
    assert.equal((await manager.getTask(job!.nativeTaskId!))!.status, 'cancelled');
    assert.equal(f.core.projectMemory.version().id, 'initial'); assert.ok(f.core.memoryV1Status().pendingRecords > 0);
    manager.enqueue = enqueue;
    const retry = await f.request(`/memory/jobs/${job!.id}/retry`, {}); assert.equal(retry.status, 202);
    const next = await retry.json(); release(); await f.settled(first.runId!);
    await until(() => f.core.projectMemory.jobs().find(row => row.id === next.id), row => row?.status === 'succeeded');
    assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  } finally { manager.enqueue = enqueue; release(); }
});

test('取消结果不确定时保留 native 存活状态，明确终态到达后才解除管理 busy', { timeout: 40_000 }, async t => {
  const f = await fixture(t), release = f.engine.holdGeneration();
  const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!, cancel = manager.cancel.bind(manager);
  try {
    const first = await f.send('合成取消不确定占用者');
    await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => row?.status === 'running');
    const second = await f.send('合成取消未确认来源');
    const queued = await until(() => f.core.projectMemory.jobs().find(row => row.runId === second.runId), row => !!row?.nativeTaskId && row.status === 'pending');
    const calls = f.engine.generated.length;
    manager.cancel = async () => { throw new Error('合成取消未送达'); };
    f.core.configure('runtime', { memoryEnabled: false });
    await f.core.reconcileMemoryV1();
    assert.equal((await manager.getTask(queued!.nativeTaskId!))!.status, 'pending');
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'pending');
    const blocked = await f.request('/configuration/runtime', { memoryContextMode: 'shadow' });
    assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, 'memory_configuration_busy');
    assert.equal(f.engine.generated.length, calls); assert.ok(f.core.memoryV1Status().pendingRecords > 0);
    manager.cancel = cancel; await manager.cancel(queued!.nativeTaskId!);
    const running = f.core.projectMemory.jobs().find(row => row.runId === first.runId)!;
    await manager.cancel(running.nativeTaskId!);
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === queued!.id)!.status, 'interrupted');
    assert.equal((await f.request('/configuration/runtime', { memoryContextMode: 'shadow' })).status, 200);
    release(); f.core.configure('runtime', { memoryContextMode: 'v1', memoryEnabled: true });
    for (const row of [first, second]) await until(() => f.core.projectMemory.jobs().filter(job => job.runId === row.runId).at(-1), job => job?.status === 'succeeded');
    assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  } finally { manager.cancel = cancel; release(); }
});

test('取消后旧模型迟到不能改写 interrupted 或发布，新尝试保持独立绑定', { timeout: 40_000 }, async t => {
  const f = await fixture(t), release = f.engine.holdGeneration(true);
  try {
    const first = await f.send('合成迟到模型资料');
    const old = await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => row?.status === 'running');
    const manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!;
    const head = f.core.projectMemory.version(), processing = f.core.projectMemory.processingV1Head();
    f.core.configure('runtime', { memoryEnabled: false });
    await until(() => manager.getTask(old!.nativeTaskId!), row => row?.status === 'cancelled');
    await f.core.reconcileMemoryV1();
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === old!.id)!.status, 'interrupted');
    f.core.configure('runtime', { memoryEnabled: true });
    const replacement = await f.core.queueMemory(first.runId!);
    assert.notEqual(replacement.id, old!.id); assert.notEqual(replacement.nativeTaskId, old!.nativeTaskId);
    assert.deepEqual(f.core.projectMemory.version(), head); assert.equal(f.core.projectMemory.processingV1Head(), processing);
    release();
    await until(() => f.core.projectMemory.jobs().find(row => row.id === replacement.id), row => row?.status === 'succeeded');
    assert.equal(f.core.projectMemory.jobs().find(row => row.id === old!.id)!.status, 'interrupted');
    assert.equal(f.core.projectMemory.jobs().filter(row => row.runId === first.runId).length, 2);
    const finalHead = f.core.projectMemory.version(), finalProcessing = f.core.projectMemory.processingV1Head();
    await f.core.reconcileMemoryV1(); await manager.cancel(old!.nativeTaskId!);
    assert.deepEqual(f.core.projectMemory.version(), finalHead); assert.equal(f.core.projectMemory.processingV1Head(), finalProcessing);
    assert.equal(f.core.memoryV1Status().pendingRecords, 0);
  } finally { release(); }
});

test('绑定后终态补读迟到不延长已发布任务的 admission 或阻塞配置', { timeout: 40_000 }, async t => {
  const f = await fixture(t), manager = f.core.sessions.controller.getMastra()!.backgroundTaskManager!, getTask = manager.getTask.bind(manager);
  let release!: () => void, readStarted = false;
  const gate = new Promise<void>(done => { release = done; });
  manager.getTask = async id => {
    const task = await getTask(id);
    if (task?.toolName === 'organize-memory-v1') { readStarted = true; await gate; }
    return getTask(id);
  };
  try {
    const first = await f.send('合成终态查询迟到资料');
    await until(() => f.core.projectMemory.jobs().find(row => row.runId === first.runId), row => readStarted && row?.status === 'succeeded');
    const head = f.core.projectMemory.version(), processing = f.core.projectMemory.processingV1Head();
    assert.equal((await f.request('/configuration/runtime', { memoryContextMode: 'shadow' })).status, 200);
    release(); manager.getTask = getTask;
    await f.core.reconcileMemoryV1();
    assert.deepEqual(f.core.projectMemory.version(), head); assert.equal(f.core.projectMemory.processingV1Head(), processing);
  } finally { release(); manager.getTask = getTask; }
});
