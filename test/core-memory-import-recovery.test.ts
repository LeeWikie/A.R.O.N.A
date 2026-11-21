import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { currentMemoryView, scopedReview, workingSetReader } from './memory-v1-synthetic-model.js';
import { removeTemp, until } from './helpers.js';
function zip(text: string) {
  const bytes = Buffer.from(text), name = Buffer.from('conversations-000.json'); let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}
function fixtureModel() {
  const readOld = workingSetReader(); let phase: 'A' | 'B' = 'A', serial = 0;
  const model = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
    if (!request.tools?.some(tool => tool.name === 'memory_ready')) return finish(JSON.stringify(scopedReview(request.prompt)));
    if (JSON.stringify(request.prompt.at(-1)).includes('"ready":true')) return finish('done');
    const view = currentMemoryView(request.prompt), candidate = view.candidate;
    let action = readOld(request.prompt);
    const change = (name: string, input: Record<string, unknown>) => ({ name, input: { expectedDraftRevision: view.draftRevision, rationale: 'Synthetic import state fixture', ...input } });
    if (!action) {
      const records = candidate.evidence.filter(record => record.actor === 'user'), record = phase === 'B' ? records.at(-1)! : records[0]!;
      const ref = { evidenceId: record.id, partKey: 'body' }, current = candidate.entries.find(entry => entry.format === 'reviewed' && entry.protection.mode === 'state' && entry.lifecycle === 'current');
      if (!candidate.organizations.length) action = change('memory_organization_create', { organization: { title: 'Synthetic device', parentId: null } });
      else if (!candidate.entities.length) action = change('memory_entity_create', { entity: { name: 'Synthetic user', kind: 'person', aliases: [], identityEvidence: [ref] } });
      else if (!current || current.format === 'reviewed' && current.protection.mode === 'state' && current.protection.value !== phase) {
        const entry = { text: `Synthetic device mode ${phase}.`, primaryNodeId: candidate.organizations[0]!.id, relatedNodeIds: [], entityIds: [candidate.entities[0]!.id], nature: 'fact', certainty: 'reported', lifecycle: 'current', scope: { subjectId: candidate.entities[0]!.id, dimension: 'device-mode', qualifier: 'Synthetic device' }, validFrom: phase === 'B' ? '2026-01-02T00:00:00.000Z' : null, validTo: null, retention: { score: 8, rationale: 'Current device state' }, protectionAssessment: { decision: 'eligible', rationale: 'Mutually exclusive device mode', evidence: [ref] }, protection: { mode: 'state', stateKey: 'device-mode', value: phase, establishedBy: [ref], overrideRule: 'Explicit later mode change' }, followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref, role: 'supports' }], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] };
        action = current ? change('memory_state_replace', { entryId: current.id, expectedEntryRevision: current.revision, evidence: [ref], entry }) : change('memory_entry_create', { entry });
      } else {
        const pending = candidate.evidence.flatMap(record => record.coverage.parts.map(part => ({ evidenceId: record.id, partKey: part.key }))).find(ref => !candidate.coverage.some(row => row.ref.evidenceId === ref.evidenceId && row.ref.partKey === ref.partKey && !row.decision.startsWith('pending-')));
        if (pending) {
          const entries = candidate.entries.filter(entry => entry.format === 'reviewed' && entry.evidence.some(item => item.ref.evidenceId === pending.evidenceId));
          action = { name: 'memory_coverage', input: { expectedDraftRevision: view.draftRevision, coverage: { ref: pending, decision: entries.length ? 'retained' : 'no-effective-new-information', entryIds: entries.map(entry => entry.id), rationale: 'Synthetic source coverage' }, protection: { ref: pending, decision: entries.length ? 'mapped' : 'no-protectable-state', entryIds: entries.map(entry => entry.id), rationale: 'Synthetic state coverage' } } };
        } else action = { name: 'memory_ready', input: { expectedDraftRevision: view.draftRevision } };
      }
    }
    return { content: [{ type: 'tool-call' as const, toolName: action.name, toolCallId: `import-state-${++serial}`, input: JSON.stringify(action.input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  return { model, phase: (value: 'A' | 'B') => { phase = value; } };
}
test('pure imported history can retry and recover across restart without the ZIP or native acceptance, preserving later protected state and watermarks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-import-recovery-')), engine = fixtureModel();
  let core = await Core.open({ dataDir: directory, model: engine.model, memoryContextMode: 'v1', memoryEnabled: true });
  t.after(async () => { await core.close(); await removeTemp(directory); });
  const archivePath = path.join(directory, 'synthetic.zip');
  const document = (second: boolean) => [{ id: 'synthetic-context', current_node: second ? 'b' : 'a', mapping: { r: { id: 'r', parent: null, message: null, children: ['a'] }, a: { id: 'a', parent: 'r', children: second ? ['b'] : [], message: { id: 'message-a', author: { role: 'user' }, create_time: '2026-01-01T00:00:00.000Z', content: { content_type: 'text', parts: ['Synthetic device mode A.'] } } }, ...(second ? { b: { id: 'b', parent: 'a', children: [], message: { id: 'message-b', author: { role: 'user' }, create_time: '2026-01-02T00:00:00.000Z', content: { content_type: 'text', parts: ['Synthetic device mode B.'] } } } } : {}) } }];
  const settled = async (id: string) => { const job = await until(() => core.projectMemory.jobs().find(job => job.id === id), job => !!job && ['succeeded', 'failed', 'interrupted'].includes(job.status)); assert.equal(job!.status, 'succeeded', JSON.stringify(job)); };
  async function importPhase(second: boolean) {
    fs.writeFileSync(archivePath, zip(JSON.stringify(document(second))));
    const result = await core.importMemory({ archivePath, namespace: 'synthetic', sourceRef: 'recovery', conversation: { index: 0 }, maxNodes: 8, organize: true, expectedHead: core.projectMemory.version().id });
    assert.ok('job' in result); await settled(result.job!.id); return { head: core.projectMemory.version(), runId: result.id! };
  }
  const a = await importPhase(false); engine.phase('B'); const b = await importPhase(true);
  assert.deepEqual([a.head.generation, b.head.generation], [1, 2]);
  const before = core.projectMemory.readV1Version(b.head.id).workspace.candidate.entries;
  const watermarks = core.runtime.setting('memory-watermarks', {});
  await core.close(); fs.unlinkSync(archivePath);
  core = await Core.open({ dataDir: directory, model: engine.model, memoryContextMode: 'v1', memoryEnabled: true });
  const retry = await core.queueMemory(b.runId, true); await settled(retry.id);
  const plan = core.planMemoryV1Recovery(a.head.id, core.projectMemory.version().id);
  const recovery = await core.executeMemoryV1Recovery(plan.id); await settled(recovery.id);
  const recovered = core.projectMemory.readV1Version(core.projectMemory.version().id).workspace.candidate.entries;
  assert.deepEqual(recovered, before); assert.deepEqual(core.runtime.setting('memory-watermarks', {}), watermarks);
  assert.ok(core.projectMemory.version().generation > b.head.generation);
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM signals').get()!.n, 0);
  assert.equal(core.store.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n, 0);
  assert.equal((await core.executeMemoryV1Recovery(plan.id)).id, recovery.id);
});
