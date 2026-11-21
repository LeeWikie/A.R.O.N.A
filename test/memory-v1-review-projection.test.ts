import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareMemoryV1Review } from '../src/memory/v1/organizer.js';
import { assertMemoryModelObject } from '../src/memory/v1/request-budget.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import { createMemoryV1Tools } from '../src/memory/v1/tools.js';
import { MemoryWorkingSet } from '../src/memory/v1/working-set.js';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function objectTokens(value: unknown): number {
  try { assertMemoryModelObject(value, 1); }
  catch (error) {
    assert.equal((error as { code: string }).code, 'memory_model_object_capacity');
    return (error as { textTokens: number }).textTokens;
  }
  assert.fail('expected a document larger than one token');
}
function fixture() {
  const at = '2026-01-01T00:00:00.000Z';
  const source = prepareNativeMemorySource({ namespace: 'synthetic-review-projection', source: { contextId: 'context', runId: 'run', sequence: 1 }, events: [], gaps: [],
    entries: [0, 1].map(index => ({ business: { kind: 'user-statement', origin: 'signal', content: `Synthetic fact ${index}`, provenance: { contextId: 'context', runId: 'run', signalId: `signal:${index}` } },
      location: { contextId: 'context', runId: 'run', recordId: `record:${index}`, receivedAt: at, visibleAfter: at }, original: { text: `Synthetic fact ${index}`, attachments: [] } })) });
  const ref = (index: number) => ({ evidenceId: source.records[index]!.id, partKey: 'body' });
  let serial = 0;
  const options = { baseVersion: null, batchId: 'seed', auditedAt: at, previousEntries: [], evidence: source.records, observations: [], entities: [],
    organizations: [
      { id: 'parent', title: 'UNCHANGED_PARENT_TITLE', parentId: null, entryIds: [] },
      { id: 'topic', title: 'Synthetic shared topic', parentId: 'parent', entryIds: [] },
      { id: 'unrelated', title: 'UNRELATED_HIDDEN_ORGANIZATION_TITLE', parentId: null, entryIds: [] },
    ], supportGroups: source.records.map(record => ({ ref: { evidenceId: record.id, partKey: 'body' }, group: record.id })), clock: () => at, createId: (kind: string) => `${kind}:${++serial}` };
  const seed = new MemoryWorkspace(options);
  const subject = seed.createEntity(seed.draftRevision, { kind: 'person', name: 'Synthetic subject', aliases: [], identityEvidence: [ref(0)] }, 'synthetic identity').result.id;
  const input = (index: number): MemoryEntryInput => ({ text: `Synthetic fact ${index}`, nature: 'fact', certainty: 'reported', lifecycle: 'current', scope: { subjectId: subject, dimension: `fact:${index}`, qualifier: 'synthetic subject' },
    validFrom: at, validTo: null, retention: { score: 4, rationale: 'synthetic information' }, protectionAssessment: { decision: 'ineligible', rationale: 'ordinary fact', evidence: [ref(index)] }, protection: { mode: 'none' },
    followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: ref(index), role: 'supports' }], primaryNodeId: 'topic', relatedNodeIds: [], entityIds: [subject],
    abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] });
  const old = seed.createEntry(seed.draftRevision, input(0), 'synthetic old fact').result;
  seed.decideCoverage(seed.draftRevision, { ref: ref(0), decision: 'retained', entryIds: [old.id], rationale: 'retained' }, { ref: ref(0), decision: 'no-protectable-state', entryIds: [], rationale: 'ordinary fact' });
  const inherited = seed.export().candidate;
  let set: MemoryWorkingSet;
  const workspace = new MemoryWorkspace({ ...options, baseVersion: 'published', batchId: 'new', previousEntries: inherited.entries, entities: inherited.entities, organizations: inherited.organizations, inherited,
    assertMutation: (before, after) => set.assertMutation(before, after, workspace.draftRevision + 1) });
  set = new MemoryWorkingSet({ anchor: { published: { id: 'published', manifestHash: 'a'.repeat(64) }, processing: null, scopeId: 'scope', cutoff: at, policyDigest: 'b'.repeat(64) },
    baseline: workspace.export().candidate, details: [], selectedEvidenceIds: [source.records[1]!.id], preflight: () => {}, metadataTokens: 65536 });
  set.open(set.handles().find(row => row.collection === 'entries' && row.identity === old.id)!.handle);
  set.writerSent(set.packet().packetHash);
  const added = workspace.createEntry(workspace.draftRevision, input(1), 'synthetic new fact').result;
  workspace.decideCoverage(workspace.draftRevision, { ref: ref(1), decision: 'retained', entryIds: [added.id], rationale: 'retained' }, { ref: ref(1), decision: 'no-protectable-state', entryIds: [], rationale: 'ordinary fact' });
  return { workspace, set, old, added };
}

test('review includes the full after-row of a hidden derived organization without granting writer access', () => {
  const { workspace, set, old, added } = fixture(), current = workspace.export(), packet = set.packet();
  const pageBefore = set.pageHandles({ revision: workspace.draftRevision, collection: 'organizations' });
  assert.ok(pageBefore.items.every(row => !row.included && !row.received));
  const documents = prepareMemoryV1Review({ workingSet: set, candidate: current.candidate, draftRevision: current.draftRevision, details: [], metadataTextTokens: 65536 });
  const expectedBefore = { id: 'topic', title: 'Synthetic shared topic', parentId: 'parent', entryIds: [old.id] };
  const expectedAfter = { ...expectedBefore, entryIds: [old.id, added.id] };
  assert.deepEqual(documents.baseline.before.find(row => row.collection === 'organizations'), { collection: 'organizations', identity: 'topic', value: expectedBefore });
  assert.deepEqual(documents.projection.candidate.organizations, []);
  assert.deepEqual(documents.proposal.candidate.organizations, []);
  assert.deepEqual(documents.proposal.afterObjects, [{ collection: 'organizations', identity: 'topic', value: expectedAfter }]);
  assert.equal(documents.proposal.completeCandidate, false);
  assert.deepEqual(documents.proposal.inheritedCounts, documents.projection.inheritedCounts);
  assert.equal(documents.proposal.inheritedCounts.organizations, 3);
  assert.ok(!JSON.stringify(documents.proposal).includes('UNRELATED_HIDDEN_ORGANIZATION_TITLE'));
  assert.ok(!JSON.stringify(documents.proposal).includes('UNCHANGED_PARENT_TITLE'));
  assert.equal(documents.scope.diffHash, digest(documents.scope.changes));
  assert.equal(documents.scope.candidateHash, digest([current.candidate, []]));
  assert.deepEqual(set.packet(), packet);
  assert.deepEqual(set.pageHandles({ revision: workspace.draftRevision, collection: 'organizations' }), pageBefore);
  assert.throws(() => workspace.updateOrganization(workspace.draftRevision, 'topic', { title: 'Unauthorized changed title', parentId: 'parent' }, 'must open first'), /memory_working_set_needs_evidence/);
  assert.deepEqual(workspace.export(), current); assert.deepEqual(set.packet(), packet);
});

test('hidden organization after-rows count in the identical ready and formal review metadata bounds', async () => {
  const { workspace, set } = fixture(), current = workspace.export();
  const documents = prepareMemoryV1Review({ workingSet: set, candidate: current.candidate, draftRevision: current.draftRevision, details: [], metadataTextTokens: 65536 });
  const expectedTokens = objectTokens(documents.proposal), budget = expectedTokens - 1;
  assert.ok(documents.proposal.afterObjects.length > 0);
  assert.ok(objectTokens({ ...documents.proposal, afterObjects: [] }) <= budget);
  assert.ok(objectTokens(documents.baseline) <= budget);
  let readyDocuments: ReturnType<typeof prepareMemoryV1Review> | undefined, actualBudget = budget;
  const controller = createMemoryV1Tools(workspace, [], { workingSet: set, assertReady(candidate, details) {
    readyDocuments = prepareMemoryV1Review({ workingSet: set, candidate, draftRevision: workspace.draftRevision, details, metadataTextTokens: actualBudget });
  } });
  const packet = set.packet(), page = set.pageHandles({ revision: workspace.draftRevision, collection: 'organizations' });
  assert.deepEqual(await controller.tools.memory_ready.execute!({ expectedDraftRevision: current.draftRevision }, {} as never),
    { ok: false, error: 'memory_model_object_capacity', capacity: { textTokens: expectedTokens, budget } });
  assert.equal(controller.isReady(), false); assert.equal(readyDocuments, undefined);
  assert.deepEqual(workspace.export(), current); assert.deepEqual(set.packet(), packet);
  actualBudget = expectedTokens;
  const accepted = await controller.tools.memory_ready.execute!({ expectedDraftRevision: current.draftRevision }, {} as never) as { ok: boolean };
  assert.equal(accepted.ok, true); assert.equal(controller.isReady(), true);
  const acceptedDocuments = readyDocuments as ReturnType<typeof prepareMemoryV1Review> | undefined;
  assert.ok(acceptedDocuments);
  const formal = prepareMemoryV1Review({ workingSet: set, candidate: current.candidate, draftRevision: current.draftRevision, details: [], metadataTextTokens: actualBudget });
  assert.deepEqual(formal.baseline, acceptedDocuments.baseline); assert.deepEqual(formal.proposal, acceptedDocuments.proposal);
  assert.deepEqual(set.packet(), packet); assert.deepEqual(set.pageHandles({ revision: workspace.draftRevision, collection: 'organizations' }), page);
});
