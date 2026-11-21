import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';
import { MemoryWorkingSet } from '../src/memory/v1/working-set.js';

test('打开既有条目只引用主体身份，修改主体本身仍须完整关联闭包', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const source = prepareNativeMemorySource({ namespace: 'synthetic', source: { contextId: 'context', runId: 'run', sequence: 1 }, events: [], gaps: [], entries: Array.from({ length: 13 }, (_, i) => ({
    business: { kind: 'user-statement' as const, origin: 'signal' as const, content: `Independent fact ${i}`, provenance: { contextId: 'context', runId: 'run', signalId: `signal-${i}` } },
    location: { contextId: 'context', runId: 'run', recordId: `record-${i}`, receivedAt: at, visibleAfter: at }, original: { text: `Independent fact ${i}`, attachments: [] },
  })) });
  let serial = 0;
  const workspace = new MemoryWorkspace({ baseVersion: null, batchId: 'batch', auditedAt: at, previousEntries: [], evidence: source.records, observations: [], entities: [], organizations: [{ id: 'root', title: 'Topics', parentId: null, entryIds: [] }], relations: [], overrides: [], supportGroups: source.records.map(record => ({ ref: { evidenceId: record.id, partKey: 'body' }, group: 'source' })), clock: () => at, createId: kind => `${kind}:${++serial}` });
  const ref = (i: number) => ({ evidenceId: source.records[i]!.id, partKey: 'body' });
  const subject = workspace.createEntity(workspace.draftRevision, { name: 'Subject', kind: 'person', aliases: [], identityEvidence: [ref(0)] }, 'identity').result;
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const row = workspace.createEntry(workspace.draftRevision, { text: `Independent fact ${i}`, nature: 'fact', certainty: 'reported', lifecycle: 'current', scope: { subjectId: subject.id, dimension: `topic-${i}`, qualifier: 'subject' }, validFrom: at, validTo: null,
      retention: { score: 4, rationale: 'useful' }, protectionAssessment: { decision: 'ineligible', rationale: 'ordinary fact', evidence: [ref(i)] }, protection: { mode: 'none' }, followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] },
      evidence: [{ ref: ref(i), role: 'supports' }], primaryNodeId: 'root', relatedNodeIds: [], entityIds: [subject.id], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [],
    }, 'record fact').result;
    ids.push(row.id);
    workspace.decideCoverage(workspace.draftRevision, { ref: ref(i), decision: 'retained', entryIds: [row.id], rationale: 'retained' }, { ref: ref(i), decision: 'no-protectable-state', entryIds: [], rationale: 'ordinary fact' });
  }
  const set = () => new MemoryWorkingSet({ anchor: { published: { id: 'base', manifestHash: 'a'.repeat(64) }, processing: null, scopeId: 'scope', cutoff: at, policyDigest: 'b'.repeat(64) }, baseline: workspace.export().candidate, details: [], selectedEvidenceIds: [source.records[12]!.id], preflight: () => {}, metadataTokens: 65536 });
  const entrySet = set(); entrySet.open(entrySet.handles().find(row => row.collection === 'entries' && row.identity === ids[11])!.handle);
  entrySet.writerSent(entrySet.packet().packetHash);
  const visible = entrySet.project(workspace.export().candidate, workspace.draftRevision) as { candidate: { entries: { id: string }[] } };
  assert.ok(visible.candidate.entries.some(row => row.id === ids[11]));
  assert.ok(visible.candidate.entries.length < 12, '共享主体身份不能强制打开全部不相关事实');
  const entitySet = set(); entitySet.open(entitySet.handles().find(row => row.collection === 'entities' && row.identity === subject.id)!.handle);
  entitySet.writerSent(entitySet.packet().packetHash);
  const entityView = entitySet.project(workspace.export().candidate, workspace.draftRevision) as typeof visible;
  assert.equal(entityView.candidate.entries.length, 12, '编辑主体身份仍须完整关联闭包');
});
