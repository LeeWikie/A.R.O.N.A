import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';
import { MemoryWorkingSet } from '../src/memory/v1/working-set.js';
import { prepareMemoryV1Review } from '../src/memory/v1/organizer.js';
import { assertMemoryModelObject } from '../src/memory/v1/request-budget.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('完整前后差异可以超过单侧额度，两份实际送审资料分别受限且保持完整哈希绑定', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const source = prepareNativeMemorySource({ namespace: 'synthetic-freeze', source: { contextId: 'context', runId: 'run', sequence: 1 }, events: [], gaps: [],
    entries: ['Synthetic identity', 'Synthetic source'].map((text, index) => ({
      business: { kind: 'user-statement' as const, origin: 'signal' as const, content: text, provenance: { contextId: 'context', runId: 'run', signalId: `signal-${index}` } },
      location: { contextId: 'context', runId: 'run', recordId: `record-${index}`, receivedAt: at, visibleAfter: at }, original: { text, attachments: [] },
    })) });
  const ref = (index: number) => ({ evidenceId: source.records[index]!.id, partKey: 'body' });
  let serial = 0;
  const base = { baseVersion: null, batchId: 'before', auditedAt: at, previousEntries: [], evidence: source.records, observations: [], entities: [],
    organizations: [{ id: 'root', title: 'Synthetic', parentId: null, entryIds: [] }], supportGroups: source.records.map(record => ({ ref: { evidenceId: record.id, partKey: 'body' }, group: record.id })),
    clock: () => at, createId: (kind: string) => `${kind}:${++serial}` };
  const initial = new MemoryWorkspace(base);
  const subject = initial.createEntity(initial.draftRevision, { name: 'Subject', kind: 'person', aliases: [], identityEvidence: [ref(0)] }, 'identity').result;
  const fields: MemoryEntryInput = { text: 'previous '.repeat(4200), nature: 'fact', certainty: 'reported', lifecycle: 'current', scope: { subjectId: subject.id, dimension: 'topic', qualifier: 'synthetic' }, validFrom: at, validTo: null,
    retention: { score: 4, rationale: 'useful' }, protectionAssessment: { decision: 'ineligible', rationale: 'ordinary fact', evidence: [ref(1)] }, protection: { mode: 'none' }, followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] },
    evidence: [{ ref: ref(1), role: 'supports' }], primaryNodeId: 'root', relatedNodeIds: [], entityIds: [subject.id], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] };
  const oldEntry = initial.createEntry(initial.draftRevision, fields, 'fact').result;
  for (const index of [0, 1]) initial.decideCoverage(initial.draftRevision,
    { ref: ref(index), decision: index ? 'retained' : 'no-effective-new-information', entryIds: index ? [oldEntry.id] : [], rationale: 'checked' },
    { ref: ref(index), decision: 'no-protectable-state', entryIds: [], rationale: 'ordinary fact' });
  const prior = initial.export().candidate;
  let set: MemoryWorkingSet;
  const workspace = new MemoryWorkspace({ ...base, baseVersion: 'published', batchId: 'after', previousEntries: prior.entries, entities: prior.entities, organizations: prior.organizations, inherited: prior,
    assertMutation: (before, after) => set.assertMutation(before, after, workspace.draftRevision + 1) });
  set = new MemoryWorkingSet({ anchor: { published: { id: 'published', manifestHash: 'a'.repeat(64) }, processing: null, scopeId: 'scope', cutoff: at, policyDigest: 'b'.repeat(64) },
    baseline: workspace.export().candidate, details: [], selectedEvidenceIds: [], preflight: () => {}, metadataTokens: 8192 });
  set.open(set.handles().find(row => row.collection === 'entries' && row.identity === oldEntry.id)!.handle);
  set.writerSent(set.packet().packetHash);
  workspace.updateEntry(0, oldEntry.id, oldEntry.revision, { ...fields, text: 'updated '.repeat(4200) }, 'update fact');
  assert.equal(workspace.check().valid, true);
  const state = workspace.export();
  const review = prepareMemoryV1Review({ workingSet: set, candidate: state.candidate, draftRevision: state.draftRevision, details: [], previousDetails: [], metadataTextTokens: 8192 });
  assert.doesNotThrow(() => assertMemoryModelObject(review.baseline, 8192));
  assert.doesNotThrow(() => assertMemoryModelObject(review.proposal, 8192));
  assert.throws(() => assertMemoryModelObject({ changes: review.scope.changes, obligations: review.scope.obligations, details: [] }, 8192), /memory_model_object_capacity/);
  const changed = review.scope.changes.find(row => row.collection === 'entries')!;
  assert.equal((changed.before as { text: string }).text, fields.text);
  assert.equal((changed.after as { text: string }).text, 'updated '.repeat(4200));
  assert.equal(review.scope.diffHash, digest(review.scope.changes));
  assert.equal(review.scope.candidateHash, digest([state.candidate, []]));
  const modified = structuredClone(state.candidate); modified.entries[0]!.text += 'new ending';
  const other = set.freeze(modified, []);
  assert.notEqual(other.candidateHash, review.scope.candidateHash);
  assert.notEqual(other.diffHash, review.scope.diffHash);
  assert.notEqual(other.scopeHash, review.scope.scopeHash);
});
