import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { ProjectMemory } from '../src/memory/index.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { createDefaultMemoryContextPolicy } from '../src/memory/v1/policy.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import type { MemoryCandidate, MemoryEntry } from '../src/memory/v1/contracts.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';
import { currentMemoryView, requestObjects, scopedReview } from './memory-v1-synthetic-model.js';

const at = '2026-01-01T00:00:00.000Z', cutoff = '2026-02-01T00:00:00.000Z';
const identityText = '合成用户计划学习合成主题，尚未完成。';
const newText = '合成用户已完成独立资料登记。';
const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
const tool = (name: string, input: Record<string, unknown>, serial: number) => ({
  ...finish(''), content: [{ type: 'tool-call' as const, toolName: name, toolCallId: `reference-${serial}`, input: JSON.stringify(input) }], finishReason: 'tool-calls' as const,
});
function entryInput(entry: MemoryEntry): MemoryEntryInput {
  assert.equal(entry.format, 'reviewed');
  if (entry.format !== 'reviewed') throw new Error('reviewed entry required');
  const { id: _id, revision: _revision, format: _format, createdInBatch: _created, updatedInBatch: _updated, evidence, ...rest } = entry;
  return { ...rest, evidence: evidence.map(({ ref, role }) => ({ ref, role })) };
}
function source(runId: string, sequence: number, text: string) {
  return prepareNativeMemorySource({ namespace: 'synthetic:reference-publication', source: { contextId: 'context', runId, sequence }, events: [], gaps: [], entries: [{
    business: { kind: 'user-statement', origin: 'signal', content: text, provenance: { contextId: 'context', runId, signalId: runId } },
    location: { contextId: 'context', runId, recordId: `record:${runId}`, receivedAt: at, visibleAfter: at }, original: { text, attachments: [] },
  }] });
}
function coverage(ref: { evidenceId: string; partKey: string }, entryId: string) {
  return { coverage: { ref, decision: 'retained', entryIds: [entryId], rationale: '保留合成认识' },
    protection: { ref, decision: 'no-protectable-state', entryIds: [], rationale: '普通合成资料' } };
}

for (const attackFirst of [false, true]) test(`reference 身份的新事实经真实 Agent/review/SQLite 发布${attackFirst ? '，先拒绝旧域与身份修改' : '，纯正向'}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reference-publication-'));
  const databasePath = path.join(directory, 'runtime.sqlite'), db = new DatabaseSync(databasePath);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = new RuntimeStore(db), memory = new ProjectMemory(store, directory), policy = createDefaultMemoryContextPolicy();
  async function organize(prepared: ReturnType<typeof source>, model: MastraLanguageModelV2Mock) {
    memory.archive({ ...prepared.source, modelProfile: 'synthetic', createdAt: at, prompt: [], nativeMessages: [], providerOptions: {} });
    const job = memory.newV1Job(prepared.source.runId, memory.version().id); memory.bind(job.id, `synthetic:${job.id}`);
    return memory.organizeV1(job.id, { expectedHead: memory.version().id, preparedSource: prepared, policy, cutoff,
      scopeId: 'synthetic:reference-publication', resolveModel: () => model });
  }
  const first = source('old-identity', 1, identityText), oldRef = { evidenceId: first.records[0]!.id, partKey: 'body' };
  let seedStep = 0;
  const seedModel = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    if (!request.tools?.some(row => row.name === 'memory_ready')) return finish(JSON.stringify(scopedReview(request.prompt)));
    const v = currentMemoryView(request.prompt), revision = { expectedDraftRevision: v.draftRevision };
    switch (seedStep++) {
      case 0: return tool('memory_organization_create', { ...revision, rationale: '合成主题', organization: { title: '共同主题', parentId: null } }, seedStep);
      case 1: return tool('memory_entity_create', { ...revision, rationale: '合成身份', entity: { kind: 'person', name: '合成用户', aliases: [], identityEvidence: [oldRef] } }, seedStep);
      case 2: {
        const subjectId = v.candidate.entities[0]!.id;
        const entry: MemoryEntryInput = { text: identityText, primaryNodeId: v.candidate.organizations.at(-1)!.id, relatedNodeIds: [], entityIds: [subjectId],
          nature: 'intent', certainty: 'reported', lifecycle: 'current', scope: { subjectId, dimension: 'learning', qualifier: '合成主题' }, validFrom: null, validTo: null,
          retention: { score: 7, rationale: '明确学习意图' }, protectionAssessment: { decision: 'ineligible', rationale: '普通意图', evidence: [oldRef] }, protection: { mode: 'none' },
          followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: oldRef, role: 'supports' }], abstraction: 'episode',
          derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] };
        return tool('memory_entry_create', { ...revision, rationale: '合成愿望', entry }, seedStep);
      }
      case 3: return tool('memory_coverage', { ...revision, ...coverage(oldRef, v.candidate.entries[0]!.id) }, seedStep);
      case 4: return tool('memory_ready', revision, seedStep);
      default: return finish('合成资料已核对。');
    }
  } });
  const seeded = await organize(first, seedModel);
  assert.equal(seeded.complete, true);
  const prior = memory.readV1Version(seeded.version).workspace.candidate;
  const oldEntity = prior.entities[0]!, oldEntry = prior.entries[0]!;
  const oldCoverage = db.prepare('SELECT * FROM memory_v1_coverage ORDER BY sequence').all();
  assert.equal(oldCoverage.length, 1);
  const nextSource = source('independent-fact', 2, newText), newRef = { evidenceId: nextSource.records[0]!.id, partKey: 'body' };
  let stage = 0, reviewCalls = 0, serial = 0, writerSawIdentity = false;
  let lastPacket: unknown;
  const denied: string[] = [];
  const actions = ['page-entries', ...(attackFirst ? ['attack-entry', 'check-entry'] : []), 'page-entities', 'open-reference',
    ...(attackFirst ? ['attack-identity', 'check-identity'] : []), 'create', 'coverage', 'ready'];
  const model = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    const rows = requestObjects(request.prompt), packet = rows.find(row => Array.isArray(row.businessEvidence));
    assert.ok(packet);
    if (!request.tools?.some(row => row.name === 'memory_ready')) {
      reviewCalls++; assert.equal(request.tools?.length ?? 0, 0); assert.deepEqual(packet, lastPacket);
      assert.ok(writerSawIdentity);
      const proposal = rows.find(row => row.proposal)!.proposal as { candidate: MemoryCandidate; obligations: unknown[] };
      assert.deepEqual(proposal.candidate.entities, [oldEntity]);
      assert.deepEqual(proposal.obligations, [newRef], '身份原件只是参考，不应伪造旧 coverage 重审义务');
      assert.ok(proposal.candidate.entries.some(row => row.text === newText));
      assert.ok(!proposal.candidate.entries.some(row => row.id === oldEntry.id), '未打开的旧愿望不应进入工作集');
      assert.deepEqual(packet.businessEvidence.map((row: { evidence: { id: string }; body: string }) => [row.evidence.id, row.body]).sort(),
        [[oldRef.evidenceId, identityText], [newRef.evidenceId, newText]].sort(), 'review 实收完整身份原件及新资料');
      return finish(JSON.stringify(scopedReview(request.prompt)));
    }
    const v = currentMemoryView(request.prompt), revision = { expectedDraftRevision: v.draftRevision };
    assert.equal(v.candidate.entries.some(row => row.id === oldEntry.id), false);
    if (v.candidate.entities.length) {
      assert.deepEqual(v.candidate.entities, [oldEntity]);
      assert.deepEqual(packet.businessEvidence.map((row: { evidence: { id: string }; body: string }) => [row.evidence.id, row.body]).sort(),
        [[oldRef.evidenceId, identityText], [newRef.evidenceId, newText]].sort(), 'writer 实收原件，非只读摘要或 id');
      writerSawIdentity = true;
    }
    lastPacket = structuredClone(packet);
    const last = request.prompt.at(-1), results = last?.role === 'tool' ? requestObjects(last) : [];
    const action = actions[stage++];
    const emit = (name: string, input: Record<string, unknown>) => tool(name, input, ++serial);
    if (action !== 'check-entry' && action !== 'check-identity') for (const row of results.filter(row => typeof row.ok === 'boolean')) assert.equal(row.ok, true);
    switch (action) {
      case 'page-entries': assert.equal(v.draftRevision, 0); return emit('memory_working_set_page', { ...revision, collection: 'entries' });
      case 'attack-entry': return emit('memory_entry_update', { ...revision, entryId: oldEntry.id, expectedEntryRevision: oldEntry.revision,
        rationale: '合成旧域攻击', entry: { ...entryInput(oldEntry), text: '不得覆盖旧愿望' } });
      case 'check-entry': case 'check-identity': {
        const error = results.find(row => row.ok === false)?.error;
        assert.equal(error, 'memory_working_set_needs_evidence'); denied.push(error); assert.equal(v.draftRevision, 0);
        return emit('memory_inspect', {});
      }
      case 'page-entities': return emit('memory_working_set_page', { ...revision, collection: 'entities' });
      case 'open-reference': {
        const handle = results.flatMap(row => row.items ?? []).find(row => row.identity === oldEntity.id)?.handle;
        assert.ok(handle); return emit('memory_working_set_open', { ...revision, handle, mode: 'reference' });
      }
      case 'attack-identity': return emit('memory_entity_update', { ...revision, entityId: oldEntity.id, rationale: '合成身份攻击',
        entity: { kind: oldEntity.kind, name: '不得凭引用修改身份', aliases: oldEntity.aliases, identityEvidence: oldEntity.identityEvidence } });
      case 'create': return emit('memory_entry_create', { ...revision, rationale: '新的独立事实', entry: { ...entryInput(oldEntry), text: newText, nature: 'fact',
        scope: { subjectId: oldEntity.id, dimension: 'independent-registration', qualifier: '合成用户' }, evidence: [{ ref: newRef, role: 'supports' }],
        protectionAssessment: { decision: 'ineligible', rationale: '独立事实', evidence: [newRef] }, derivedFromEntryIds: [], detailRefs: [] } });
      case 'coverage': assert.equal(v.draftRevision, 1); return emit('memory_coverage', { ...revision, ...coverage(newRef, v.candidate.entries[0]!.id) });
      case 'ready': assert.equal(v.draftRevision, 2); return emit('memory_ready', revision);
      default: return finish('合成新事实已核对。');
    }
  } });
  const published = await organize(nextSource, model);
  assert.equal(published.complete, true); assert.equal(published.changed, true); assert.notEqual(published.version, seeded.version);
  assert.equal(memory.version().id, published.version); assert.equal(reviewCalls, 1); assert.ok(writerSawIdentity);
  assert.deepEqual(denied, attackFirst ? ['memory_working_set_needs_evidence', 'memory_working_set_needs_evidence'] : []);
  const verify = (candidate: MemoryCandidate) => {
    assert.deepEqual(candidate.entities, prior.entities);
    assert.deepEqual(candidate.entries.find(row => row.id === oldEntry.id), oldEntry);
    assert.deepEqual(candidate.coverage.find(row => row.ref.evidenceId === oldRef.evidenceId), prior.coverage[0]);
    assert.deepEqual(candidate.protectionChecks.find(row => row.ref.evidenceId === oldRef.evidenceId), prior.protectionChecks[0]);
    const added = candidate.entries.find(row => row.text === newText); assert.ok(added); assert.notEqual(added.id, oldEntry.id);
    assert.deepEqual(entryInput(added).evidence.map(row => row.ref), [newRef]);
    const addedCoverage = candidate.coverage.find(row => row.ref.evidenceId === newRef.evidenceId);
    assert.ok(addedCoverage); assert.equal(addedCoverage.decision, 'retained'); assert.deepEqual(addedCoverage.entryIds, [added.id]);
  };
  verify(memory.readV1Version(published.version).workspace.candidate);
  for (const row of oldCoverage) assert.deepEqual(db.prepare('SELECT * FROM memory_v1_coverage WHERE sequence=?').get(Number(row.sequence)), row);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_v1_coverage').get()!.n, oldCoverage.length + 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_v1_coverage WHERE evidence_id=?').get(oldRef.evidenceId)!.n, 1, '不添伪重审');
  const reopened = new DatabaseSync(databasePath);
  try {
    const restored = new ProjectMemory(new RuntimeStore(reopened), directory);
    assert.equal(restored.version().id, published.version); verify(restored.readV1Version(published.version).workspace.candidate);
  } finally { reopened.close(); }
});
