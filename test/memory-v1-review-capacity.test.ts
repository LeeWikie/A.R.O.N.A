import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMemoryV1Review } from '../src/memory/v1/organizer.js';
import { assertMemoryModelObject } from '../src/memory/v1/request-budget.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import { createMemoryV1Tools } from '../src/memory/v1/tools.js';
import { MemoryWorkingSet } from '../src/memory/v1/working-set.js';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';

function objectTokens(value: unknown): number {
  try { assertMemoryModelObject(value, 1); }
  catch (error) {
    assert.equal((error as { code: string }).code, 'memory_model_object_capacity');
    return (error as { textTokens: number }).textTokens;
  }
  assert.fail('Expected a document larger than one token');
}

test('ready rejects the actual review proposal one token over its bound and accepts a shorter retry', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const source = prepareNativeMemorySource({ namespace: 'synthetic:review-capacity', source: { contextId: 'main', runId: 'run', sequence: 1 }, events: [], gaps: [],
    entries: [0, 1].map(index => ({ business: { kind: 'user-statement', origin: 'signal', content: `synthetic detail ${index}`, provenance: { contextId: 'main', runId: 'run', signalId: `signal:${index}` } },
      location: { contextId: 'main', runId: 'run', recordId: `record:${index}`, receivedAt: at, visibleAfter: at }, original: { text: `synthetic detail ${index}`, attachments: [] } })) });
  const groups = source.records.map(record => ({ ref: { evidenceId: record.id, partKey: 'body' }, group: `support:${record.id}` }));
  let identity = 0;
  const options = { baseVersion: null, batchId: 'batch', auditedAt: at, previousEntries: [], evidence: source.records, observations: [], entities: [], organizations: [],
    supportGroups: groups, clock: () => at, createId: (kind: string) => `${kind}:${++identity}` };
  const entry = (subjectId: string, primaryNodeId: string, index: number, words: number): MemoryEntryInput => ({ text: 'detail '.repeat(words), nature: 'preference', certainty: 'reported', lifecycle: 'current',
    scope: { subjectId, dimension: `temporary:${index}`, qualifier: 'synthetic' }, validFrom: at, validTo: null, retention: { score: 2, rationale: 'temporary synthetic detail' },
    protectionAssessment: { decision: 'ineligible', evidence: [groups[index]!.ref], rationale: 'ordinary temporary preference' }, protection: { mode: 'none' },
    followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: groups[index]!.ref, role: 'supports' }], primaryNodeId, relatedNodeIds: [], entityIds: [subjectId],
    abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] });
  const seed = new MemoryWorkspace(options);
  const subject = seed.createEntity(seed.draftRevision, { kind: 'other', name: 'synthetic subject', aliases: [], identityEvidence: [groups[0]!.ref] }, 'synthetic identity').result.id;
  const oldNode = seed.createOrganization(seed.draftRevision, { title: 'old synthetic topic', parentId: null }, 'synthetic topic').result.id;
  const old = seed.createEntry(seed.draftRevision, entry(subject, oldNode, 0, 2000), 'synthetic seed').result;
  seed.decideCoverage(seed.draftRevision, { ref: groups[0]!.ref, decision: 'retained', entryIds: [old.id], rationale: 'synthetic retained' }, { ref: groups[0]!.ref, decision: 'no-protectable-state', entryIds: [], rationale: 'ordinary temporary preference' });
  const inherited = seed.export().candidate;
  let set: MemoryWorkingSet;
  const workspace = new MemoryWorkspace({ ...options, baseVersion: 'prior', previousEntries: inherited.entries, entities: inherited.entities, organizations: inherited.organizations, inherited,
    assertMutation: (before, after) => set.assertMutation(before, after, workspace.draftRevision + 1) });
  const baseline = workspace.export().candidate;
  const makeSet = (metadataTokens: number) => {
    let next: MemoryWorkingSet | undefined;
    next = new MemoryWorkingSet({ anchor: { published: { id: 'prior', manifestHash: 'a'.repeat(64) }, processing: null, scopeId: 'scope', cutoff: at, policyDigest: 'b'.repeat(64) }, baseline, details: [],
      selectedEvidenceIds: [source.records[1]!.id], metadataTokens, preflight(packet) { const current = workspace.export(); next?.project(current.candidate, current.draftRevision, new Set(packet.objectHandles), new Set(packet.evidenceIds)); } });
    next.open(next.handles().find(row => row.collection === 'entries' && row.identity === old.id)!.handle); next.writerSent(next.packet().packetHash); return next;
  };
  set = makeSet(65536);
  const node = workspace.createOrganization(workspace.draftRevision, { title: 'new synthetic topic', parentId: null }, 'synthetic topic').result.id;
  const added = workspace.createEntry(workspace.draftRevision, entry(subject, node, 1, 50), 'synthetic create').result;
  workspace.decideCoverage(workspace.draftRevision, { ref: groups[1]!.ref, decision: 'retained', entryIds: [added.id], rationale: 'synthetic retained' }, { ref: groups[1]!.ref, decision: 'no-protectable-state', entryIds: [], rationale: 'ordinary temporary preference' });
  const current = workspace.export();
  const documents = prepareMemoryV1Review({ workingSet: set, candidate: current.candidate, draftRevision: current.draftRevision, details: [], metadataTextTokens: 65536 });
  const expectedTokens = objectTokens(documents.proposal), budget = expectedTokens - 1;
  assert.ok(objectTokens(documents.baseline) < budget);
  assert.ok(objectTokens(set.project(current.candidate, current.draftRevision)) < budget);
  assert.ok(objectTokens({ changes: documents.scope.changes, obligations: documents.scope.obligations, details: [] }) < budget);
  set = makeSet(budget);
  let readyDocuments: ReturnType<typeof prepareMemoryV1Review> | undefined;
  const controller = createMemoryV1Tools(workspace, [], { workingSet: set, assertReady(candidate, details) {
    readyDocuments = prepareMemoryV1Review({ workingSet: set, candidate, draftRevision: workspace.draftRevision, details, metadataTextTokens: budget });
  } });
  const packet = set.packet();
  const rejected = await controller.tools.memory_ready.execute!({ expectedDraftRevision: current.draftRevision }, {} as never);
  assert.deepEqual(rejected, { ok: false, error: 'memory_model_object_capacity', capacity: { textTokens: expectedTokens, budget } });
  assert.equal(controller.isReady(), false); assert.equal(readyDocuments, undefined); assert.deepEqual(workspace.export(), current); assert.deepEqual(set.packet(), packet);
  workspace.updateEntry(workspace.draftRevision, added.id, added.revision, entry(subject, node, 1, 1), 'shorter synthetic detail');
  const accepted = await controller.tools.memory_ready.execute!({ expectedDraftRevision: workspace.draftRevision }, {} as never) as { ok: boolean };
  assert.equal(accepted.ok, true); assert.equal(controller.isReady(), true);
  const acceptedDocuments = readyDocuments as ReturnType<typeof prepareMemoryV1Review> | undefined;
  assert.ok(acceptedDocuments);
  const formal = prepareMemoryV1Review({ workingSet: set, candidate: workspace.export().candidate, draftRevision: workspace.draftRevision, details: [], metadataTextTokens: budget });
  assert.deepEqual(formal.baseline, acceptedDocuments.baseline); assert.deepEqual(formal.proposal, acceptedDocuments.proposal);
});
