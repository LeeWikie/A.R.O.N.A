import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';
import { assertMemoryModelObject } from '../src/memory/v1/request-budget.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import { createMemoryV1Tools } from '../src/memory/v1/tools.js';
import { MemoryWorkingSet } from '../src/memory/v1/working-set.js';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';

function objectTokens(value: unknown): number {
  try { assertMemoryModelObject(value, 1); }
  catch (error) {
    assert.equal((error as { code: string }).code, 'memory_model_object_capacity');
    const measured = (error as { textTokens: number }).textTokens;
    assert.ok(Number.isSafeInteger(measured));
    return measured;
  }
  assert.fail('Expected a projection larger than one token');
}

test('opening a packet counts newly visible evidence before installing it', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const source = prepareNativeMemorySource({ namespace: 'synthetic:packet-capacity', source: { contextId: 'main', runId: 'run', sequence: 1 }, events: [], gaps: [],
    entries: [0, 1].map(index => ({
      business: { kind: 'user-statement', origin: 'signal', content: `synthetic detail ${index}`, provenance: { contextId: 'main', runId: 'run', signalId: `signal:${index}` } },
      location: { contextId: 'main', runId: 'run', recordId: `record:${index}`, receivedAt: at, visibleAfter: at }, original: { text: `synthetic detail ${index}`, attachments: [] },
    })) });
  const supportGroups = source.records.map(record => ({ ref: { evidenceId: record.id, partKey: 'body' }, group: `support:${record.id}` }));
  let identity = 0;
  const options = { baseVersion: null, batchId: 'batch', auditedAt: at, previousEntries: [], evidence: source.records, observations: [], entities: [], organizations: [],
    supportGroups, clock: () => at, createId: (kind: string) => `${kind}:${++identity}` };
  const input = (subjectId: string, nodeId: string, index: number, words: number): MemoryEntryInput => {
    const ref = supportGroups[index]!.ref;
    return { text: 'detail '.repeat(words), nature: 'preference', certainty: 'reported', lifecycle: 'current', scope: { subjectId, dimension: `temporary:${index}`, qualifier: 'synthetic' },
      validFrom: at, validTo: null, retention: { score: 2, rationale: 'temporary synthetic detail' },
      protectionAssessment: { decision: 'ineligible', evidence: [ref], rationale: 'ordinary temporary preference' }, protection: { mode: 'none' },
      followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref, role: 'supports' }], primaryNodeId: nodeId,
      relatedNodeIds: [], entityIds: [subjectId], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] };
  };
  const seed = new MemoryWorkspace(options);
  const oldSubject = seed.createEntity(seed.draftRevision, { kind: 'other', name: 'old synthetic subject', aliases: [], identityEvidence: [supportGroups[0]!.ref] }, 'synthetic seed').result.id;
  const oldNode = seed.createOrganization(seed.draftRevision, { title: 'old synthetic topic', parentId: null }, 'synthetic seed').result.id;
  const oldEntry = seed.createEntry(seed.draftRevision, input(oldSubject, oldNode, 0, 600), 'synthetic seed').result;
  const inherited = seed.export().candidate;
  const workspace = new MemoryWorkspace({ ...options, baseVersion: 'prior', previousEntries: inherited.entries, entities: inherited.entities, organizations: inherited.organizations, inherited });
  const baseline = workspace.export().candidate;
  const subject = workspace.createEntity(workspace.draftRevision, { kind: 'other', name: 'new synthetic subject', aliases: [], identityEvidence: [supportGroups[1]!.ref] }, 'synthetic create').result.id;
  const node = workspace.createOrganization(workspace.draftRevision, { title: 'new synthetic topic', parentId: null }, 'synthetic create').result.id;
  workspace.createEntry(workspace.draftRevision, input(subject, node, 1, 5000), 'synthetic create');
  const current = workspace.export();
  const setOptions = { anchor: { published: { id: 'prior', manifestHash: 'a'.repeat(64) }, processing: null, scopeId: 'scope', cutoff: at, policyDigest: 'b'.repeat(64) },
    baseline, details: [], selectedEvidenceIds: [source.records[1]!.id] };
  const measure = new MemoryWorkingSet({ ...setOptions, metadataTokens: 65536, preflight() {} });
  const initialPacket = measure.packet();
  const oldHandle = measure.handles().find(row => row.collection === 'entries' && row.identity === oldEntry.id)!.handle;
  measure.open(oldHandle);
  const proposed = measure.packet(), visible = new Set(proposed.objectHandles);
  const previousProjection = measure.project(current.candidate, current.draftRevision, visible, new Set(initialPacket.evidenceIds));
  const nextProjection = measure.project(current.candidate, current.draftRevision, visible, new Set(proposed.evidenceIds));
  const budget = objectTokens(previousProjection), expectedTokens = objectTokens(nextProjection);
  assert.ok(expectedTokens > budget);
  let bounded: MemoryWorkingSet | undefined;
  bounded = new MemoryWorkingSet({ ...setOptions, metadataTokens: budget, preflight(packet) {
    bounded?.project(current.candidate, current.draftRevision, new Set(packet.objectHandles), new Set(packet.evidenceIds));
  } });
  bounded.writerSent(bounded.packet().packetHash);
  const before = bounded.packet();
  const handle = bounded.handles().find(row => row.collection === 'entries' && row.identity === oldEntry.id)!.handle;
  const controller = createMemoryV1Tools(workspace, [], { workingSet: bounded });
  const feedback = await controller.tools.memory_working_set_open!.execute!({ expectedDraftRevision: workspace.draftRevision, handle, mode: 'edit' }, {} as never);
  assert.deepEqual(feedback, { ok: false, error: 'memory_model_object_capacity', capacity: { textTokens: expectedTokens, budget } });
  assert.deepEqual(bounded.packet(), before);
  assert.deepEqual(workspace.export(), current);
  assert.doesNotThrow(() => bounded!.project(current.candidate, current.draftRevision));
  assert.equal(bounded.pageHandles({ revision: current.draftRevision, collection: 'entries' }).items.find(row => row.handle === handle)!.received, false);
});
