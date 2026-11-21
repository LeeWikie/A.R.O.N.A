import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MemoryWorkspace } from '../src/memory/v1/workspace.js';
import type { MemoryEntryInput } from '../src/memory/v1/workspace.js';
import type { EvidenceRecord, MemoryEntry } from '../src/memory/v1/contracts.js';
import { MemoryVersionFiles } from '../src/memory/v1/version-files.js';
import type { MemoryVersionWriteInput } from '../src/memory/v1/version-files.js';
import { MemoryResidentBudgetExceededError } from '../src/memory/v1/render.js';
import { createDefaultMemoryContextPolicy } from '../src/memory/v1/policy.js';
import { measureMemoryText } from '../src/memory/v1/tokens.js';

const at = '2026-02-01T00:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ref = { evidenceId: 'e1', partKey: 'text' };
function fixture(): MemoryVersionWriteInput {
  let next = 0;
  const record: EvidenceRecord = {
    schemaVersion: 1, id: 'e1', kind: 'user-statement', actor: 'user',
    origin: { system: 'native', namespace: 'synthetic', sourceRef: 'source', contextRef: 'context', recordRef: 'record', lineageRoot: 'record', capture: 'native-snapshot' },
    occurredAt: at, receivedAt: at, visibleAfter: at, timeBasis: 'host-admission', contentRef: 'external-content', contentHash: hash('外部原始材料'), operationRef: null, derivedFrom: [], attachments: [],
    coverage: { status: 'complete', parts: [{ key: 'text', status: 'available', reason: null }] },
  };
  const legacy: MemoryEntry = {
    id: 'legacy', revision: 1, format: 'legacy-unreviewed', text: '合成旧文\n  保留缩进与尾行。\n',
    primaryNodeId: 'root', relatedNodeIds: [], entityIds: [], placement: 'resident', legacyRef: 'legacy-content', contentHash: hash('合成旧文\n  保留缩进与尾行。\n'),
  };
  const workspace = new MemoryWorkspace({
    baseVersion: 'v0', batchId: 'batch', auditedAt: at, previousEntries: [legacy], evidence: [record], observations: [],
    entities: [{ id: 'subject', kind: 'other', name: '合成展台', aliases: [], identityEvidence: [ref] }],
    organizations: [{ id: 'root', title: '展台', parentId: null, entryIds: ['legacy'] }],
    supportGroups: [{ ref, group: 'source-group' }], clock: () => at, createId: kind => `${kind}-${++next}`,
  });
  const value: MemoryEntryInput = {
    text: '合成展台采用单列布局。', nature: 'preference', certainty: 'reported', lifecycle: 'current', scope: { subjectId: 'subject', dimension: 'display', qualifier: '展台' }, validFrom: at, validTo: null,
    retention: { score: 2, rationale: '局部展示用途' }, protectionAssessment: { decision: 'ineligible', rationale: '普通展示事项', evidence: [ref] }, protection: { mode: 'none' },
    followup: { attention: 'none', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref, role: 'supports' }], entityIds: ['subject'], primaryNodeId: 'root', relatedNodeIds: [], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: ['document'], replacedBy: [],
  };
  workspace.createEntry(0, value, '记录展示事项');
  workspace.createEntry(1, { ...value, text: '只供归档的合成说明。', placement: 'detail', detailRefs: [] }, '详细材料另存');
  return { workspace: workspace.export(), version: { id: 'v1', parentVersionId: 'v0', generation: 2 }, policy: createDefaultMemoryContextPolicy(), details: [{ id: 'document', content: '只供查阅的详细合成档案。' }] };
}
function temporary(t: test.TestContext) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v1-files-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root: path.join(parent, 'version') };
}
function modifyManifest(root: string, edit: (value: any) => void): string {
  const file = path.join(root, 'manifest.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(value); const text = `${JSON.stringify(value)}\n`; fs.writeFileSync(file, text); return hash(text);
}

test('合法分层读回使用现成 renderer 的完整注入串和实际计量，detail/raw 不混入', t => {
  const { root } = temporary(t), files = new MemoryVersionFiles(root), input = fixture();
  const original = structuredClone(input), written = files.write(input);
  assert.deepEqual(input, original);
  assert.ok(written.finalText.includes(input.workspace.candidate.previousEntries[0]!.text));
  assert.ok(!written.finalText.includes('只供归档')); assert.ok(!written.finalText.includes('只供查阅'));
  assert.ok(!written.finalText.includes('外部原始材料'));
  assert.deepEqual(written.draft.measurement, measureMemoryText(written.finalText, { modelId: null }));
  const read = files.read({ manifestHash: written.manifestHash, version: input.version }, input.workspace.candidate.previousEntries);
  assert.equal(read.finalText, written.finalText); assert.deepEqual(read.workspace, input.workspace);
  assert.ok(Object.isFrozen(read.workspace.candidate.entries));
  assert.equal(read.manifest.files.filter(file => file.layer === 'resident').length, 1);
  assert.equal(read.manifest.files.filter(file => file.layer === 'detail').length, 2);
  assert.equal(read.manifest.files.filter(file => file.layer === 'raw').length, 1);
  assert.ok(!read.manifest.files.some(file => file.path === 'manifest.json'));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata/state.json'), 'utf8'));
  assert.equal(Object.hasOwn(metadata.candidate, 'previousEntries'), false);
  assert.deepEqual(read.details, input.details);
  assert.throws(() => files.write(input), /memory_version_not_empty/);
});

test('缺少文件、额外 Markdown、同目录旧 .md 均拒绝，不递归注入', async t => {
  for (const action of ['missing', 'extra', 'nested'] as const) await t.test(action, sub => {
    const { root } = temporary(sub), files = new MemoryVersionFiles(root), input = fixture(), written = files.write(input);
    const detail = written.manifest.files.find(file => file.layer === 'detail')!;
    if (action === 'missing') fs.unlinkSync(path.join(root, detail.path));
    else if (action === 'extra') fs.writeFileSync(path.join(root, 'extra.md'), '不能混入');
    else { fs.mkdirSync(path.join(root, 'old')); fs.writeFileSync(path.join(root, 'old/legacy.md'), '不能混入'); }
    assert.throws(() => files.read({ manifestHash: written.manifestHash, version: input.version }, input.workspace.candidate.previousEntries), /memory_version_file_set_mismatch/);
  });
});

test('正文篡改、manifest 锚点和宿主版本身份不匹配均拒绝', t => {
  const { root } = temporary(t), files = new MemoryVersionFiles(root), input = fixture(), written = files.write(input);
  const baseline = input.workspace.candidate.previousEntries, anchor = { manifestHash: written.manifestHash, version: input.version };
  assert.throws(() => files.read({ ...anchor, manifestHash: '0'.repeat(64) }, baseline), /memory_version_anchor_mismatch/);
  assert.throws(() => files.read({ ...anchor, version: { ...input.version, generation: 3 } }, baseline), /memory_version_identity_mismatch/);
  assert.throws(() => files.read(anchor, []), /memory_version_baseline_mismatch/);
  const resident = written.manifest.files.find(file => file.layer === 'resident')!;
  fs.appendFileSync(path.join(root, resident.path), '篡改');
  assert.throws(() => files.read(anchor, baseline), /memory_version_hash_mismatch/);
});

test('重签磁盘自报哈希也不能伪造 renderer 正文、分层或计数', async t => {
  for (const kind of ['resident', 'measurement', 'layer', 'raw', 'duplicate'] as const) await t.test(kind, sub => {
    const { root } = temporary(sub), files = new MemoryVersionFiles(root), input = fixture(), written = files.write(input);
    const manifestHash = modifyManifest(root, value => {
      const manifest = value.manifest;
      if (kind === 'measurement') manifest.measurement.textTokens++;
      else if (kind === 'layer') manifest.files.find((file: any) => file.layer === 'detail').layer = 'resident';
      else if (kind === 'duplicate') manifest.files.push(manifest.files[0]);
      else {
        const file = manifest.files.find((file: any) => file.layer === kind), content = kind === 'raw' ? '[]\n' : '伪造常驻正文';
        fs.writeFileSync(path.join(root, file.path), content); file.sha256 = hash(content);
      }
    });
    assert.notEqual(manifestHash, written.manifestHash);
    assert.throws(() => files.read({ manifestHash, version: input.version }, input.workspace.candidate.previousEntries));
  });
});

test('根替换、符号链接、硬链接和指向目录外的链接均拒绝', async t => {
  for (const kind of ['root', 'symlink', 'hardlink', 'directory-link'] as const) await t.test(kind, sub => {
    const { root, parent } = temporary(sub), files = new MemoryVersionFiles(root), input = fixture(), written = files.write(input);
    const anchor = { manifestHash: written.manifestHash, version: input.version };
    if (kind === 'root') { fs.renameSync(root, `${root}-old`); fs.mkdirSync(root); }
    else if (kind === 'directory-link') { fs.renameSync(path.join(root, 'detail'), path.join(parent, 'outside-detail')); fs.symlinkSync(path.join(parent, 'outside-detail'), path.join(root, 'detail')); }
    else {
      const resident = written.manifest.files.find(file => file.layer === 'resident')!;
      const target = path.join(root, resident.path), outside = path.join(parent, 'outside.md');
      fs.copyFileSync(target, outside); fs.unlinkSync(target);
      if (kind === 'symlink') fs.symlinkSync(outside, target); else fs.linkSync(outside, target);
    }
    assert.throws(() => files.read(anchor, input.workspace.candidate.previousEntries), /memory_(?:root_changed|link_refused)/);
  });
});

test('manifest 路径逃逸、跨平台保留文件名和未经引用的 detail 不能读写', async t => {
  for (const attack of ['../outside.md', 'detail/../../outside.md', 'C:\\outside.md', 'detail/CON.md', 'detail/file. ']) await t.test(attack, sub => {
    const { root } = temporary(sub), files = new MemoryVersionFiles(root), input = fixture(), written = files.write(input);
    const manifestHash = modifyManifest(root, value => { value.manifest.files[0].path = attack; });
    assert.throws(() => files.read({ manifestHash, version: input.version }, input.workspace.candidate.previousEntries));
  });
  const { root } = temporary(t), files = new MemoryVersionFiles(root), input = fixture();
  input.details!.push({ id: 'unreferenced', content: '不能任意写文件' });
  assert.throws(() => files.write(input), /memory_version_detail_reference/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('旧目录碰巧有 manifest.json 不会被当作 V1；根链接无法绑定', t => {
  const { root, parent } = temporary(t), files = new MemoryVersionFiles(root), input = fixture();
  const content = JSON.stringify({ schemaVersion: 1, id: 'v1', files: [] });
  fs.writeFileSync(path.join(root, 'manifest.json'), content);
  fs.writeFileSync(path.join(root, 'legacy.md'), '合成旧版本');
  assert.throws(() => files.read({ manifestHash: hash(content), version: input.version }, []));
  fs.symlinkSync(root, path.join(parent, 'alias'));
  assert.throws(() => new MemoryVersionFiles(path.join(parent, 'alias')), /memory_root_redirected/);
});

test('超限完整保留来源与候选，预算含 renderer 全封装且不写半版', t => {
  const { root } = temporary(t), files = new MemoryVersionFiles(root), input = fixture();
  input.policy.resident.textTokens = 1;
  const before = structuredClone(input);
  assert.throws(() => files.write(input), error => {
    assert.ok(error instanceof MemoryResidentBudgetExceededError);
    assert.ok(error.draft.finalText.includes('合成旧文'));
    assert.equal(error.draft.measurement.inputHash, hash(error.draft.finalText));
    assert.ok(error.draft.diagnostics.requiredEntryIds.includes('legacy'));
    return true;
  });
  assert.deepEqual(input, before); assert.deepEqual(fs.readdirSync(root), []);
});

test('实际 tokenizer 身份重算，伪造 ready 配置不因 schema 合法而被接受', t => {
  const { root } = temporary(t), files = new MemoryVersionFiles(root), input = fixture();
  input.policy.tokenizer = { implementation: 'js-tiktoken', encoding: 'cl100k_base', exactForProvider: false, readiness: 'ready', version: 'forged', vocabularyHash: '0'.repeat(64) };
  assert.throws(() => files.write(input), /memory_tokenizer_identity_mismatch/);
  assert.deepEqual(fs.readdirSync(root), []);
});
