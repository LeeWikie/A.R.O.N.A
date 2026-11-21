import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { assertBenchmarkUpdatedState, benchmarkNetworkState, copySyntheticBenchmarkSeed } from '../scripts/memory-benchmark.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';
import { Core } from '../src/core.js';
import { removeTemp } from './helpers.js';
import type { MemoryV1Head } from '../src/memory/v1/version-index.js';

function stateFixture(value: string, text = value) {
  const before = '2026-01-01T00:00:00.000Z', after = '2026-01-02T00:00:00.000Z';
  const source = prepareNativeMemorySource({ namespace: 'synthetic:benchmark-oracle', source: { contextId: 'main', runId: 'run', sequence: 1 }, events: [], gaps: [],
    entries: [0, 1].map(index => ({ business: { kind: 'user-statement', origin: 'signal', content: index ? '工作电脑已经恢复联网。' : '工作电脑完全离线。', provenance: { contextId: 'main', runId: 'run', signalId: `signal:${index}` } },
      location: { contextId: 'main', runId: 'run', recordId: `record:${index}`, receivedAt: index ? after : before, visibleAfter: index ? after : before }, original: { text: index ? '工作电脑已经恢复联网。' : '工作电脑完全离线。', attachments: [] } })) });
  const groups = source.records.map(record => ({ ref: { evidenceId: record.id, partKey: 'body' }, group: `support:${record.id}` })); let serial = 0;
  const workspace = new MemoryWorkspace({ baseVersion: null, batchId: 'batch', auditedAt: after, previousEntries: [], evidence: source.records, observations: [], entities: [], organizations: [], supportGroups: groups, clock: () => after, createId: kind => `${kind}:${++serial}` });
  const subject = workspace.createEntity(workspace.draftRevision, { kind: 'other', name: '工作电脑', aliases: [], identityEvidence: [groups[0]!.ref] }, 'synthetic identity').result.id;
  const node = workspace.createOrganization(workspace.draftRevision, { title: '工作环境', parentId: null }, 'synthetic topic').result.id;
  const entry = (index: number, state: string, body: string): MemoryEntryInput => ({ text: body, nature: 'fact', certainty: 'reported', lifecycle: 'current', scope: { subjectId: subject, dimension: 'connectivity', qualifier: '工作电脑' }, validFrom: index ? after : before, validTo: null,
    retention: { score: 9, rationale: '当前工作环境' }, protectionAssessment: { decision: 'eligible', evidence: [groups[index]!.ref], rationale: '用户明确报告当前工作环境' },
    protection: { mode: 'state', stateKey: 'workstation.connectivity', value: state, establishedBy: [groups[index]!.ref], overrideRule: '仅由用户明确状态更新覆盖' },
    followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref: groups[index]!.ref, role: 'supports' }], primaryNodeId: node, relatedNodeIds: [], entityIds: [subject], abstraction: 'profile', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] });
  const old = workspace.createEntry(workspace.draftRevision, entry(0, '完全离线', '工作电脑完全离线。'), 'synthetic initial state').result;
  workspace.replaceState(workspace.draftRevision, old.id, old.revision, entry(1, value, text), [groups[1]!.ref], 'synthetic state update');
  return { candidate: structuredClone(workspace.export().candidate), oldId: old.id };
}

for (const [name, value] of [
  ['past offline state has ended', '电脑已经恢复联网；先前完全离线状态已结束。'],
  ['offline is explicitly negated', '电脑现在已联网，并非处于离线状态。'],
] as const) test(`state oracle accepts ${name} with the same ended identity chain`, () => {
  const fixture = stateFixture(value); assert.equal(benchmarkNetworkState(value), 'online');
  assert.doesNotThrow(() => assertBenchmarkUpdatedState(fixture.candidate, fixture.oldId));
  assert.doesNotThrow(() => assertBenchmarkUpdatedState(fixture.candidate));
});

test('state oracle rejects the old physical state remaining current despite a separate online entry', () => {
  assert.equal(benchmarkNetworkState('电脑完全离线；曾计划联网但尚未恢复。'), 'offline');
  const fixture = stateFixture('已恢复联网'); const old = fixture.candidate.entries.find(row => row.id === fixture.oldId)!;
  if (old.format !== 'reviewed') assert.fail(); old.lifecycle = 'current'; old.validTo = null; old.replacedBy = [];
  assert.throws(() => assertBenchmarkUpdatedState(fixture.candidate, fixture.oldId), /offline_ended_identity_lost/);
  assert.throws(() => assertBenchmarkUpdatedState(fixture.candidate), /offline_ended_identity_lost/);
});

for (const value of ['电脑尚未恢复联网，现在仍完全离线。', '电脑仍完全离线，未能恢复联网。', '电脑不能联网。', '电脑目前不联网。']) test(`state and recall oracle reject ${value}`, () => {
  const fixture = stateFixture(value); assert.equal(benchmarkNetworkState(value), 'offline');
  assert.throws(() => assertBenchmarkUpdatedState(fixture.candidate, fixture.oldId), /online_state_not_protected/);
  assert.throws(() => assertBenchmarkUpdatedState(fixture.candidate), /online_state_not_protected/);
  assert.equal(benchmarkNetworkState(`${value}望远镜拍月球的愿望尚未实现。`), 'offline');
});

test('network ambiguity is classified for manual review and cannot pass state or recall automatically', () => {
  for (const value of ['电脑可能已联网。', '若恢复联网就能下载。', '电脑是否联网尚不明确。']) {
    const fixture = stateFixture(value); assert.equal(benchmarkNetworkState(value), 'uncertain');
    assert.throws(() => assertBenchmarkUpdatedState(fixture.candidate, fixture.oldId), /network_state_requires_manual_review/);
  }
});

test('a V1 seed relocates only its copied host pointer and opens through the strict Core path without a network request', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arona-benchmark-seed-'));
  const nativeFetch = globalThis.fetch; let fetches = 0, core: Core | undefined;
  globalThis.fetch = async () => { fetches++; throw new Error('unexpected synthetic test network'); };
  t.after(async () => { await core?.close(); globalThis.fetch = nativeFetch; await removeTemp(directory); });
  const seed = path.join(directory, 'seed'), target = path.join(directory, 'target');
  const modelConfig = { protocol: 'responses' as const, baseURL: 'http://127.0.0.1:1/v1', modelId: 'synthetic-model', apiKey: 'synthetic-key', authHeader: 'bearer' as const };
  const repository = path.resolve(import.meta.dirname, '..'), moduleURL = (relative: string) => JSON.stringify(pathToFileURL(path.join(repository, relative)).href);
  const writer = path.join(directory, 'seed-writer.mjs'), marker = JSON.stringify({ schemaVersion: 1, syntheticOnly: true });
  await fs.writeFile(writer, `import fs from 'node:fs/promises';import path from 'node:path';
    import{Core}from${moduleURL('src/core.ts')};import{MemoryWorkspace}from${moduleURL('src/memory/v1/workspace.ts')};
    import{MemoryVersionFiles}from${moduleURL('src/memory/v1/version-files.ts')};import{MemoryV1VersionIndex}from${moduleURL('src/memory/v1/version-index.ts')};import{createDefaultMemoryContextPolicy}from${moduleURL('src/memory/v1/policy.ts')};
    let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('unexpected synthetic writer network')};
    const seed=${JSON.stringify(seed)},core=await Core.open({dataDir:seed,modelConfig:${JSON.stringify(modelConfig)},memoryContextMode:'v1',memoryEnabled:false});
    let result;try{const at='2026-01-01T00:00:00.000Z',workspace=new MemoryWorkspace({baseVersion:'initial',batchId:'synthetic-seed',auditedAt:at,previousEntries:[],evidence:[],observations:[],entities:[],organizations:[],supportGroups:[],clock:()=>at,createId:kind=>kind+':unused'});
      const version={id:'synthetic-v1',parentVersionId:'initial',generation:1},written=new MemoryVersionFiles(path.join(seed,'memory','versions',version.id)).write({workspace:workspace.export(),version,policy:createDefaultMemoryContextPolicy()});
      new MemoryV1VersionIndex(core.store.db,path.join(seed,'memory')).record(written);
      const head={...version,filesDirectory:path.join(seed,'memory','versions',version.id),format:'shittimchest-memory-v1',versionIndex:version.id,manifestHash:written.manifestHash,source:null};
      core.runtime.setSetting('memory-version',head);core.runtime.setSetting('memory-enabled',false);result={head,finalText:written.finalText,fetches};
    }finally{await core.close()}
    await fs.writeFile(path.join(seed,'.memory-benchmark-synthetic.json'),${JSON.stringify(marker)});await fs.writeFile(path.join(seed,'synthetic.txt'),'synthetic seed bytes');console.log(JSON.stringify(result));`, { mode: 0o600 });
  const generated = await promisify(execFile)(process.execPath, ['--import', 'tsx', writer], { cwd: repository, timeout: 30000,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHITTIMCHEST_'))) });
  const receipt = JSON.parse(generated.stdout.trim()) as { head: MemoryV1Head; finalText: string; fetches: number }, originalHead = receipt.head;
  assert.equal(receipt.fetches, 0);
  const sourceDatabase = await fs.readFile(path.join(seed, 'records.sqlite'));
  const copied = await copySyntheticBenchmarkSeed(seed, target); assert.equal(copied.originalUnchanged, true);
  assert.deepEqual(copied.relocation.changedTables, ['runtime_settings']); assert.equal(copied.relocation.otherRowsUnchanged, true);
  assert.equal(copied.relocation.from, originalHead.filesDirectory); assert.equal(copied.relocation.to, path.join(target, 'memory', 'versions', originalHead.id));
  assert.equal(await fs.readFile(path.join(seed, 'synthetic.txt'), 'utf8'), 'synthetic seed bytes'); assert.equal(await fs.readFile(path.join(target, 'synthetic.txt'), 'utf8'), 'synthetic seed bytes');
  assert.equal(await fs.readFile(path.join(seed, '.memory-benchmark-synthetic.json'), 'utf8'), marker);
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
  core = await Core.open({ dataDir: target, modelConfig, memoryContextMode: 'v1', memoryEnabled: false });
  assert.deepEqual(core.projectMemory.version(), { ...originalHead, filesDirectory: path.join(target, 'memory', 'versions', originalHead.id) });
  assert.equal(core.projectMemory.resident().text, receipt.finalText); await core.close(); core = undefined;
  assert.deepEqual(await fs.readFile(path.join(seed, 'records.sqlite')), sourceDatabase); assert.equal(fetches, 0);
  await assert.rejects(copySyntheticBenchmarkSeed(seed, target), (error: NodeJS.ErrnoException) => error.code === 'ERR_FS_CP_EEXIST');
  await fs.writeFile(path.join(seed, 'core.lock'), 'synthetic lock'); await assert.rejects(copySyntheticBenchmarkSeed(seed, path.join(directory, 'locked-copy')), /seed_not_closed_directory/);
});
