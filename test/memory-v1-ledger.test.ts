import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { EvidenceRecord, CoverageDecision } from '../src/memory/v1/contracts.js';
import { MemoryEvidenceLedger, MemoryLedgerError } from '../src/memory/v1/ledger.js';
import type { LedgerCoverageBatch, LedgerPartBinding } from '../src/memory/v1/ledger.js';

const at = '2025-02-01T00:00:00.000Z';
const later = '2025-02-02T00:00:00.000Z';
const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
function evidence(id = 'e1', body: string | Uint8Array = '合成记录'): EvidenceRecord {
  return {
    schemaVersion: 1, id, actor: 'user', kind: 'user-statement',
    origin: { system: 'native', namespace: 'synthetic', sourceRef: 'source-1', contextRef: 'context-1', recordRef: `record-${id}`, lineageRoot: 'root-1', capture: 'admitted-records' },
    occurredAt: null, receivedAt: at, visibleAfter: at, timeBasis: 'unknown',
    contentRef: `content-${id}`, contentHash: hash(body), operationRef: null, derivedFrom: [], attachments: [],
    coverage: { status: 'complete', parts: [{ key: 'text', status: 'available', reason: null }] },
  };
}
function decision(evidenceId = 'e1', partKey = 'text', kind: CoverageDecision['decision'] = 'no-effective-new-information'): CoverageDecision {
  return { ref: { evidenceId, partKey }, decision: kind, entryIds: [], rationale: '合成结构检查' };
}
function batch(batchId = 'batch-1', decisions = [decision()], scopeId = 'scope-1'): LedgerCoverageBatch {
  return { scopeId, batchId, versionId: null, auditedAt: later, decisions };
}
// 本组合成资料明确把首部分设为正文、次部分设为附件；单部分同时承载全部槽。
function fixtureBindings(record: EvidenceRecord): LedgerPartBinding[] {
  const body = { kind: 'body' as const, ref: record.contentRef };
  const attachments = record.attachments.map(item => ({ kind: 'attachment' as const, ref: item.sourceId }));
  return record.coverage.parts.map((part, index) => ({ partKey: part.key,
    slots: record.coverage.parts.length === 1 ? [body, ...attachments] : index === 1 && attachments.length ? attachments : [body],
  }));
}
function receipt(ledger: MemoryEvidenceLedger, record = evidence(), scopeId = 'scope-1', id = `receipt-${record.id}`) {
  return ledger.registerReceipt({ id, scopeId, evidence: record, partBindings: fixtureBindings(record) });
}
function expectError(code: MemoryLedgerError['code'], fn: () => unknown) {
  assert.throws(fn, error => error instanceof MemoryLedgerError && error.code === code);
}
function memory(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, ledger: new MemoryEvidenceLedger(db) };
}
function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
}

test('登记只保留待处理资料，缺来源不冒充已覆盖', t => {
  const { ledger } = memory(t);
  receipt(ledger);
  assert.deepEqual(ledger.readEvidence('e1'), evidence());
  expectError('missing-content', () => ledger.readContent('e1'));
  assert.deepEqual(ledger.listPending('scope-1', later)[0]!.gaps, [{ ref: { evidenceId: 'e1', partKey: 'text' }, reason: 'missing-content' }]);
  expectError('unavailable-part', () => ledger.recordCoverage(batch()));
  ledger.recordCoverage(batch('pending', [decision('e1', 'text', 'pending-source')]));
  ledger.putEvidence(evidence(), { body: '合成记录' });
  assert.equal(ledger.listPending('scope-1', later)[0]!.gaps[0]!.reason, 'pending-source');
  ledger.recordCoverage(batch());
  assert.deepEqual(ledger.listPending('scope-1', later), []);
});

test('实际 SQLite 外层 rollback 同时回滚业务记录、登记、内容和覆盖', t => {
  const { db, ledger } = memory(t);
  db.exec('CREATE TABLE synthetic_accept(id TEXT); BEGIN IMMEDIATE; INSERT INTO synthetic_accept VALUES (\'input-1\')');
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  ledger.recordCoverage(batch());
  assert.equal(db.isTransaction, true);
  assert.equal(ledger.coverageFor('scope-1', decision().ref).length, 1);
  db.exec('ROLLBACK');
  assert.equal(count(db, 'synthetic_accept'), 0);
  for (const table of ['memory_v1_evidence', 'memory_v1_contents', 'memory_v1_receipts', 'memory_v1_receipt_ids', 'memory_v1_evidence_ids', 'memory_v1_evidence_revisions', 'memory_v1_coverage', 'memory_v1_coverage_batches', 'memory_v1_coverage_scopes']) assert.equal(count(db, table), 0);
  assert.equal(ledger.readEvidence('e1'), undefined);
});

test('内部内容失败回滚本次全部写入且不终止外层事务', t => {
  const { db, ledger } = memory(t);
  db.exec('CREATE TABLE synthetic_accept(id TEXT); BEGIN; INSERT INTO synthetic_accept VALUES (\'input-1\')');
  const record = evidence();
  record.attachments = [{ sourceId: 'attachment-1', sha256: hash(new Uint8Array([1, 2])), bytes: 2, mediaType: 'application/octet-stream', derivedEvidenceIds: [] }];
  expectError('conflict', () => ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录', attachments: [{ sourceId: 'attachment-1', bytes: new Uint8Array([1, 9]) }] }));
  assert.equal(db.isTransaction, true);
  assert.equal(ledger.readEvidence('e1'), undefined);
  assert.equal(count(db, 'memory_v1_contents'), 0);
  db.exec('COMMIT');
  assert.equal(count(db, 'synthetic_accept'), 1);
});

test('独立操作原子提交，内容不足不会留下半份证据', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  record.attachments = [{ sourceId: 'attachment-1', sha256: hash('x'), bytes: 1, mediaType: 'application/octet-stream', derivedEvidenceIds: [] }];
  expectError('missing-content', () => ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' }));
  assert.equal(db.isTransaction, false);
  assert.equal(count(db, 'memory_v1_evidence'), 0);
  assert.equal(count(db, 'memory_v1_evidence_revisions'), 0);
});

test('规范来源幂等、别名复用且批次重放不增加覆盖行', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  receipt(ledger, record);
  assert.deepEqual(receipt(ledger, record), receipt(ledger, record));
  ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' });
  const alias = { ...record, id: 'copy-1' };
  assert.equal(ledger.putEvidence(alias, { body: '合成记录' }).id, record.id);
  assert.deepEqual(ledger.readEvidence('copy-1'), record);
  assert.equal(receipt(ledger, alias, 'scope-1', 'receipt-copy').id, 'receipt-e1');
  ledger.recordCoverage(batch('batch-1', [decision('copy-1')]));
  ledger.recordCoverage(batch());
  assert.equal(count(db, 'memory_v1_evidence'), 1);
  assert.equal(count(db, 'memory_v1_receipts'), 1);
  assert.equal(count(db, 'memory_v1_coverage'), 1);
  assert.equal(ledger.coverageFor('scope-1', decision('copy-1').ref).length, 1);
});

test('同正文不同真实来源保留各自身份，不按哈希合并', t => {
  const { db, ledger } = memory(t);
  ledger.putEvidence(evidence('e1'), { body: '合成记录' });
  ledger.putEvidence(evidence('e2'), { body: '合成记录' });
  assert.equal(count(db, 'memory_v1_evidence'), 2);
  assert.equal(ledger.readEvidence('e2')!.id, 'e2');
});

test('ID、来源、body、hash、contentRef 与 codec 冲突均拒绝且不覆盖', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' });
  expectError('conflict', () => ledger.putEvidence({ ...evidence('e2'), id: record.id }, { body: '合成记录' }));
  expectError('conflict', () => ledger.putEvidence({ ...record, contentHash: hash('别的正文') }, { body: '别的正文' }));
  expectError('conflict', () => ledger.putEvidence(record, { body: '别的正文' }));
  expectError('conflict', () => ledger.putEvidence({ ...record, origin: { ...record.origin, contextRef: 'context-2' } }, { body: '合成记录' }));
  expectError('conflict', () => ledger.putEvidence({ ...evidence('e2'), contentRef: record.contentRef }, { body: '合成记录' }));
  expectError('conflict', () => ledger.putEvidence(record, { body: Buffer.from('合成记录') }));
  assert.equal(ledger.readContent('e1'), '合成记录');
  assert.equal(count(db, 'memory_v1_evidence'), 1);
});

test('Unicode、空白、CRLF、NUL 与附件二进制精确读回且返回独立副本', t => {
  const { ledger } = memory(t);
  const text = ' \t合成 é é 𠀀\r\n下一行\n\u0000  ';
  const attachment = new Uint8Array([0, 255, 128, 13, 10, 0]);
  const record = evidence('e1', text);
  record.attachments = [{ sourceId: 'attachment-1', sha256: hash(attachment), bytes: attachment.length, mediaType: 'application/octet-stream', derivedEvidenceIds: [] }];
  ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: text, attachments: [{ sourceId: 'attachment-1', bytes: attachment }] });
  attachment.fill(3);
  assert.equal(ledger.readContent('e1'), text);
  const output = ledger.readContent('e1', 'attachment-1') as Uint8Array;
  assert.deepEqual(output, new Uint8Array([0, 255, 128, 13, 10, 0]));
  output.fill(9);
  assert.deepEqual(ledger.readContent('e1', 'attachment-1'), new Uint8Array([0, 255, 128, 13, 10, 0]));
  const binary = new Uint8Array([255, 0, 128]);
  ledger.putEvidence(evidence('binary', binary), { body: binary });
  assert.deepEqual(ledger.readContent('binary'), binary);
  assert.throws(() => ledger.putEvidence(evidence('bad', '\ud800'), { body: '\ud800' }), TypeError);
  assert.equal(ledger.readEvidence('bad'), undefined);
});

test('unknown 时间不补造，visibleAfter 与时区偏移按真实时间判断', t => {
  const { ledger } = memory(t);
  const record = evidence();
  record.visibleAfter = later;
  receipt(ledger, record);
  ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' });
  assert.equal(ledger.readEvidence('e1')!.occurredAt, null);
  assert.equal(ledger.readEvidence('e1')!.timeBasis, 'unknown');
  assert.deepEqual(ledger.listPending('scope-1', '2025-02-02T00:30:00+01:00'), []);
  expectError('not-visible', () => ledger.recordCoverage({ ...batch(), auditedAt: at }));
  assert.equal(ledger.listPending('scope-1', later).length, 1);
  ledger.recordCoverage(batch());
  assert.equal(ledger.readEvidence('e1')!.visibleAfter, later);
});

test('部分覆盖、pending-review 与旧缺口不受新来源或其他 scope 吞并', t => {
  const { ledger } = memory(t);
  const record = evidence();
  record.coverage = { status: 'partial', parts: [{ key: 'text', status: 'available', reason: null }, { key: 'image', status: 'unavailable', reason: '合成附件暂缺' }] };
  receipt(ledger, record);
  ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' });
  ledger.recordCoverage(batch('first', [decision(), decision('e1', 'image', 'pending-source')]));
  ledger.recordCoverage(batch('other-scope', [decision()], 'scope-2'));
  receipt(ledger, evidence('e2'));
  ledger.putEvidence(evidence('e2'), { body: '合成记录' });
  ledger.recordCoverage(batch('newer', [decision('e2')]));
  const gaps = ledger.listPending('scope-1', later);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0]!.gaps, [{ ref: { evidenceId: 'e1', partKey: 'image' }, reason: 'unavailable-part' }]);
  expectError('unavailable-part', () => ledger.recordCoverage(batch('bad-noop', [decision('e1', 'image')])));
  const complete = structuredClone(record);
  complete.coverage = { status: 'complete', parts: complete.coverage.parts.map(part => ({ ...part, status: 'available', reason: null })) };
  ledger.putEvidence(complete, { body: '合成记录' });
  assert.equal(ledger.evidenceHistory('e1').length, 2);
  assert.equal(ledger.evidenceHistory('e1')[0]!.coverage.status, 'partial');
  assert.equal(ledger.listPending('scope-1', later)[0]!.gaps[0]!.reason, 'pending-source');
  ledger.recordCoverage(batch('review', [decision('e1', 'image', 'pending-review')]));
  assert.equal(ledger.listPending('scope-1', later)[0]!.gaps[0]!.reason, 'pending-review');
  ledger.recordCoverage({ ...batch('done', [decision('e1', 'image')]), versionId: 'version-2' });
  assert.deepEqual(ledger.listPending('scope-1', later), []);
  assert.deepEqual(ledger.coverageFor('scope-1', decision('e1', 'image').ref).map(item => [item.batchId, item.versionId]), [['first', null], ['review', null], ['done', 'version-2']]);
  assert.equal(ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' }).coverage.status, 'complete');
  assert.equal(receipt(ledger, record).evidence.coverage.status, 'partial');
  assert.equal(ledger.evidenceHistory('e1').length, 2);
  const downgrade = structuredClone(record);
  downgrade.coverage.parts[1]!.reason = '不同的缺口';
  expectError('conflict', () => ledger.putEvidence(downgrade, { body: '合成记录' }));
});

test('未知证据、未知部分、重复部分与批次改写拒绝且整批原子', t => {
  const { db, ledger } = memory(t);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  expectError('unknown-evidence', () => ledger.recordCoverage(batch('bad', [decision(), decision('missing')])));
  expectError('unknown-part', () => ledger.recordCoverage(batch('bad', [decision('e1', 'missing')])));
  expectError('conflict', () => ledger.recordCoverage(batch('bad', [decision(), decision()])));
  assert.equal(count(db, 'memory_v1_coverage_batches'), 0);
  assert.equal(count(db, 'memory_v1_coverage'), 0);
  ledger.recordCoverage(batch());
  expectError('conflict', () => ledger.recordCoverage({ ...batch(), versionId: 'version-new' }));
  expectError('unknown-evidence', () => ledger.coverageFor('scope-1', decision('missing').ref));
  expectError('unknown-part', () => ledger.coverageFor('scope-1', decision('e1', 'missing').ref));
  expectError('unknown-part', () => ledger.readContent('e1', 'missing'));
});

test('同连接内批次写入的中途 SQL 故障回滚已有覆盖行并保留外层事务', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  record.coverage.parts.push({ key: 'second', status: 'available', reason: null });
  ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' });
  db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON memory_v1_coverage WHEN NEW.part_key='second'
    BEGIN SELECT RAISE(ABORT,'synthetic failure'); END; BEGIN`);
  assert.throws(() => ledger.recordCoverage(batch('bad', [decision(), decision('e1', 'second')])), /synthetic failure/);
  assert.equal(db.isTransaction, true);
  assert.equal(count(db, 'memory_v1_coverage'), 0);
  assert.equal(count(db, 'memory_v1_coverage_batches'), 0);
  db.exec('COMMIT');
});

test('重开新建私有数据库时证据、精确内容、待处理及审计一致，不改旧表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-v1-ledger-'));
  let db: DatabaseSync | undefined;
  try {
    const path = join(dir, 'fresh.sqlite');
    db = new DatabaseSync(path);
    db.exec("CREATE TABLE synthetic_legacy(text TEXT); INSERT INTO synthetic_legacy VALUES ('keep')");
    let ledger = new MemoryEvidenceLedger(db);
    receipt(ledger);
    ledger.putEvidence(evidence(), { body: '合成记录' });
    ledger.recordCoverage(batch('pending', [decision('e1', 'text', 'pending-review')]));
    const before = ledger.listPending('scope-1', later);
    const history = ledger.coverageFor('scope-1', decision().ref);
    db.close();
    db = new DatabaseSync(path);
    ledger = new MemoryEvidenceLedger(db);
    assert.equal(db.prepare('SELECT text FROM synthetic_legacy').get()!.text, 'keep');
    assert.deepEqual(ledger.readEvidence('e1'), evidence());
    assert.equal(ledger.readContent('e1'), '合成记录');
    assert.deepEqual(ledger.listPending('scope-1', later), before);
    assert.deepEqual(ledger.coverageFor('scope-1', decision().ref), history);
    assert.equal(ledger.evidenceHistory('e1').length, 1);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('缺 blob、内容摘要篡改、元数据摘要篡改均显式报错，不静默删除', t => {
  const { db, ledger } = memory(t);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  db.exec('SAVEPOINT damage');
  db.exec('DELETE FROM memory_v1_contents');
  expectError('corrupt', () => ledger.readContent('e1'));
  expectError('corrupt', () => ledger.readEvidence('e1'));
  assert.equal(count(db, 'memory_v1_evidence'), 1);
  db.exec('ROLLBACK TO damage');
  db.prepare('UPDATE memory_v1_contents SET data=?').run(new Uint8Array([1]));
  expectError('corrupt', () => ledger.readContent('e1'));
  db.exec('ROLLBACK TO damage');
  db.exec('UPDATE memory_v1_contents SET data=NULL');
  expectError('corrupt', () => ledger.readContent('e1'));
  db.exec('ROLLBACK TO damage');
  db.exec("UPDATE memory_v1_evidence SET record_json='{}'");
  expectError('corrupt', () => ledger.readEvidence('e1'));
  db.exec('ROLLBACK TO damage; RELEASE damage');
  ledger.recordCoverage(batch());
  db.exec("UPDATE memory_v1_coverage SET decision_json='{}'");
  expectError('corrupt', () => ledger.coverageFor('scope-1', decision().ref));
});

test('登记 ID 和登记别名不能复用到其他来源或范围', t => {
  const { db, ledger } = memory(t);
  const original = receipt(ledger);
  assert.equal(receipt(ledger, { ...evidence(), id: 'copy-1' }, 'scope-1', 'receipt-alias').id, original.id);
  expectError('conflict', () => receipt(ledger, evidence('e2'), 'scope-1', original.id));
  expectError('conflict', () => receipt(ledger, evidence('e2'), 'scope-1', 'receipt-alias'));
  expectError('conflict', () => receipt(ledger, evidence(), 'scope-2', original.id));
  assert.equal(ledger.readEvidence('e2'), undefined);
  assert.equal(count(db, 'memory_v1_receipts'), 1);
  assert.equal(count(db, 'memory_v1_receipt_ids'), 2);
});

test('已有部分证据补 blob 失败不留下修订，成功补齐后仍需独立覆盖决定', t => {
  const { ledger } = memory(t);
  const bytes = new Uint8Array([0, 7, 255]);
  const partial = evidence();
  partial.attachments = [{ sourceId: 'binary-1', sha256: hash(bytes), bytes: bytes.length, mediaType: 'application/octet-stream', derivedEvidenceIds: [] }];
  partial.coverage = { status: 'partial', parts: [{ key: 'text', status: 'available', reason: null }, { key: 'binary', status: 'unavailable', reason: '合成字节暂缺' }] };
  receipt(ledger, partial);
  ledger.putEvidence(partial, { body: '合成记录' });
  ledger.recordCoverage(batch('partial', [decision(), decision('e1', 'binary', 'pending-source')]));
  expectError('missing-content', () => ledger.readContent('e1', 'binary-1'));
  const full = structuredClone(partial);
  full.coverage = { status: 'complete', parts: full.coverage.parts.map(part => ({ ...part, status: 'available', reason: null })) };
  expectError('conflict', () => ledger.putEvidence(full, { body: '合成记录', attachments: [{ sourceId: 'binary-1', bytes: new Uint8Array([0, 7, 1]) }] }));
  assert.equal(ledger.readEvidence('e1')!.coverage.status, 'partial');
  assert.equal(ledger.evidenceHistory('e1').length, 1);
  assert.equal(ledger.readContent('e1'), '合成记录');
  ledger.putEvidence(full, { body: '合成记录', attachments: [{ sourceId: 'binary-1', bytes }] });
  assert.deepEqual(ledger.readContent('e1', 'binary-1'), bytes);
  assert.equal(ledger.listPending('scope-1', later)[0]!.gaps[0]!.reason, 'pending-source');
  ledger.recordCoverage(batch('filled', [decision('e1', 'binary')]));
  assert.deepEqual(ledger.listPending('scope-1', later), []);
  assert.equal(ledger.evidenceHistory('e1').length, 2);
});

test('登记声明完整但 blob 未到不能记作完成，完整声明也不能吞已有缺口', t => {
  const { ledger } = memory(t);
  const bytes = new Uint8Array([7]);
  const partial = evidence();
  partial.attachments = [{ sourceId: 'binary-1', sha256: hash(bytes), bytes: 1, mediaType: 'application/octet-stream', derivedEvidenceIds: [] }];
  partial.coverage = { status: 'partial', parts: [{ key: 'text', status: 'available', reason: null }, { key: 'binary', status: 'unavailable', reason: '合成字节暂缺' }] };
  receipt(ledger, partial);
  ledger.putEvidence(partial, { body: '合成记录' });
  ledger.recordCoverage(batch('partial', [decision(), decision('e1', 'binary', 'pending-source')]));
  const full = structuredClone(partial);
  full.coverage = { status: 'complete', parts: full.coverage.parts.map(part => ({ ...part, status: 'available', reason: null })) };
  receipt(ledger, full);
  expectError('unavailable-part', () => ledger.recordCoverage(batch('bad', [decision('e1', 'binary')])));
  assert.equal(ledger.listPending('scope-1', later).length, 1);
});

test('构造器在外层 SQLite 事务内不会提交既有业务写入', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE synthetic_accept(id TEXT); BEGIN; INSERT INTO synthetic_accept VALUES ('input-1')");
  const ledger = new MemoryEvidenceLedger(db);
  receipt(ledger);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
  assert.equal(count(db, 'synthetic_accept'), 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'memory_v1_%'").get()!.n, 0);
});

test('反例：混合部分可用不意味着附件字节已可读取', t => {
  const { ledger } = memory(t);
  const record = evidence();
  record.attachments = [{ sourceId: 'image-1', sha256: hash('x'), bytes: 1, mediaType: 'image/png', derivedEvidenceIds: [] }];
  record.coverage = { status: 'partial', parts: [
    { key: 'text', status: 'available', reason: null },
    { key: 'image', status: 'available', reason: null },
    { key: 'other', status: 'unavailable', reason: '合成缺口' },
  ] };
  receipt(ledger, record);
  ledger.putEvidence(record, { partBindings: fixtureBindings(record), body: '合成记录' });
  ledger.recordCoverage(batch('text', [decision()]));
  expectError('unavailable-part', () => ledger.recordCoverage(batch('image', [decision('e1', 'image')])));
  assert.deepEqual(ledger.listPending('scope-1', later)[0]!.gaps.map(gap => gap.ref.partKey), ['image', 'other']);
});

test('反例：旧审计回填不能吞掉时间更晚的待复核', t => {
  const { ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  const third = '2025-02-03T00:00:00Z';
  ledger.recordCoverage({ ...batch('review', [decision('e1', 'text', 'pending-review')]), auditedAt: third });
  ledger.recordCoverage(batch('backfill'));
  assert.equal(ledger.listPending('scope-1', third)[0]?.gaps[0]?.reason, 'pending-review');
});

test('反例：丢失最新批次明细在普通读取和幂等重放均报损坏', t => {
  const { db, ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  ledger.recordCoverage(batch('done'));
  const pending = batch('pending', [decision('e1', 'text', 'pending-review')]);
  ledger.recordCoverage(pending);
  db.exec("DELETE FROM memory_v1_coverage WHERE batch_id='pending'");
  expectError('corrupt', () => ledger.listPending('scope-1', later));
  expectError('corrupt', () => ledger.recordCoverage(pending));
});

test('反例：合法的其他来源修订不能复制到当前来源历史', t => {
  const { db, ledger } = memory(t);
  ledger.putEvidence(evidence('e1'), { body: '合成记录' });
  ledger.putEvidence(evidence('e2'), { body: '合成记录' });
  db.exec(`UPDATE memory_v1_evidence_revisions SET
    record_json=(SELECT record_json FROM memory_v1_evidence WHERE id='e2'),
    record_json_hash=(SELECT record_json_hash FROM memory_v1_evidence WHERE id='e2') WHERE evidence_id='e1'`);
  expectError('corrupt', () => ledger.evidenceHistory('e1'));
});

test('反例：保留决定不能用空条目引用关闭待处理资料', t => {
  const { ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  expectError('conflict', () => ledger.recordCoverage(batch('retained', [decision('e1', 'text', 'retained')])));
  assert.equal(ledger.listPending('scope-1', later).length, 1);
});

test('按调用方给出的可见时刻查询，不使用当前系统时间或未来审计决定', t => {
  const { ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  ledger.recordCoverage(batch('future'));
  assert.equal(ledger.listPending('scope-1', at)[0]!.gaps[0]!.reason, 'unprocessed');
  assert.deepEqual(ledger.listPending('scope-1', later), []);
});

test('映射未知时拒绝首次登记，多部分不能从名称推断内容槽', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  record.coverage.parts.push({ key: 'image', status: 'available', reason: null });
  expectError('conflict', () => ledger.registerReceipt({ id: 'r1', scopeId: 'scope-1', evidence: record }));
  expectError('conflict', () => ledger.putEvidence(record, { body: '合成记录' }));
  const bindings = fixtureBindings(record);
  expectError('conflict', () => ledger.putEvidence(record, { body: '合成记录', partBindings: bindings.slice(0, 1) }));
  expectError('conflict', () => ledger.putEvidence(record, { body: '合成记录', partBindings: [bindings[0]!, bindings[0]!] }));
  expectError('conflict', () => ledger.putEvidence(record, { body: '合成记录', partBindings: bindings.map(item => ({ ...item, slots: [{ kind: 'body', ref: 'missing' }] })) }));
  assert.equal(count(db, 'memory_v1_evidence'), 0);
  assert.equal(count(db, 'memory_v1_receipts'), 0);
});

test('正文和图像按各自槽部分完成，不能重绑附件到正文来清除缺口', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  const bytes = new Uint8Array([0, 4, 255]);
  record.attachments = [{ sourceId: 'image-1', sha256: hash(bytes), bytes: bytes.length, mediaType: 'image/png', derivedEvidenceIds: [] }];
  record.coverage = { status: 'partial', parts: [
    { key: 'text', status: 'available', reason: null }, { key: 'image', status: 'available', reason: null },
    { key: 'other', status: 'unavailable', reason: '合成缺口' },
  ] };
  receipt(ledger, record);
  ledger.putEvidence(record, { body: '合成记录' });
  ledger.recordCoverage(batch('text', [decision()]));
  assert.equal(ledger.readContent('e1'), '合成记录');
  expectError('missing-content', () => ledger.readContent('e1', 'image-1'));
  assert.deepEqual(ledger.listPending('scope-1', later)[0]!.gaps.map(item => [item.ref.partKey, item.reason]), [['image', 'missing-content'], ['other', 'unavailable-part']]);
  const rebound = fixtureBindings(record);
  rebound[1]!.slots = [{ kind: 'body', ref: record.contentRef }];
  rebound[2]!.slots = [{ kind: 'attachment', ref: 'image-1' }];
  expectError('conflict', () => ledger.putEvidence(record, { body: '合成记录', partBindings: rebound }));
  expectError('conflict', () => ledger.registerReceipt({ id: 'alias', scopeId: 'scope-2', evidence: { ...record, id: 'alias-e1' }, partBindings: rebound }));
  assert.equal(ledger.readEvidence('alias-e1'), undefined);
  assert.equal(count(db, 'memory_v1_evidence_revisions'), 1);
  // 再建账本实例仍沿用已有明确绑定，不允许重启后退回宽松推断。
  const restarted = new MemoryEvidenceLedger(db);
  expectError('unavailable-part', () => restarted.recordCoverage(batch('image-before', [decision('e1', 'image')])));
  restarted.putEvidence(record, { body: '合成记录', attachments: [{ sourceId: 'image-1', bytes }] });
  assert.deepEqual(restarted.readContent('e1', 'image-1'), bytes);
  restarted.recordCoverage(batch('image', [decision('e1', 'image')]));
  assert.deepEqual(restarted.listPending('scope-1', later)[0]!.gaps.map(item => item.ref.partKey), ['other']);
  assert.equal(restarted.evidenceHistory('e1').length, 1);
});

test('映射覆盖全部槽，单部分含附件时也不能用正文代替附件', t => {
  const { ledger } = memory(t);
  const record = evidence();
  record.attachments = [{ sourceId: 'a1', sha256: hash('x'), bytes: 1, mediaType: 'image/png', derivedEvidenceIds: [] }];
  expectError('conflict', () => ledger.registerReceipt({ id: 'r1', scopeId: 'scope-1', evidence: record }));
  expectError('conflict', () => ledger.registerReceipt({ id: 'r1', scopeId: 'scope-1', evidence: record,
    partBindings: [{ partKey: 'text', slots: [{ kind: 'body', ref: record.contentRef }] }] }));
  receipt(ledger, record);
  expectError('unavailable-part', () => ledger.recordCoverage(batch()));
});

test('合法旧审计、偏移时区与同刻后受理规则稳定且可重放', t => {
  const { db, ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  const review = { ...batch('review', [decision('e1', 'text', 'pending-review')]), auditedAt: '2025-02-03T00:30:00+01:00' };
  const backfill = { ...batch('backfill'), auditedAt: '2025-02-02T23:00:00Z' };
  ledger.recordCoverage(review);
  ledger.recordCoverage(backfill);
  assert.deepEqual(ledger.listPending('scope-1', backfill.auditedAt), []);
  assert.equal(ledger.listPending('scope-1', '2025-02-02T23:30:00Z')[0]!.gaps[0]!.reason, 'pending-review');
  assert.deepEqual(ledger.coverageFor('scope-1', decision().ref).map(row => row.batchId), ['backfill', 'review']);
  const sameInstant = { ...batch('same-instant'), auditedAt: '2025-02-02T23:30:00.000Z' };
  ledger.recordCoverage(sameInstant);
  assert.deepEqual(ledger.listPending('scope-1', review.auditedAt), []);
  const countBefore = count(db, 'memory_v1_coverage');
  ledger.recordCoverage(review);
  ledger.recordCoverage(backfill);
  assert.equal(count(db, 'memory_v1_coverage'), countBefore);
  assert.deepEqual(new MemoryEvidenceLedger(db).listPending('scope-1', review.auditedAt), []);
});

const coverageDamage: [string, (db: DatabaseSync) => void][] = [
  ['缺一个明细', db => db.exec("DELETE FROM memory_v1_coverage WHERE batch_id='pending' AND part_key='text'")],
  ['缺整批明细', db => db.exec("DELETE FROM memory_v1_coverage WHERE batch_id='pending'")],
  ['多出明细', db => db.exec(`INSERT INTO memory_v1_coverage(scope_id,batch_id,evidence_id,part_key,decision_json,decision_json_hash)
    SELECT scope_id,batch_id,evidence_id,'extra',decision_json,decision_json_hash FROM memory_v1_coverage LIMIT 1`)],
  ['明细跨批', db => db.exec("UPDATE memory_v1_coverage SET batch_id='orphan' WHERE batch_id='pending'")],
  ['明细跨范围', db => db.exec("UPDATE memory_v1_coverage SET scope_id='scope-2' WHERE batch_id='pending'")],
  ['索引字段串改', db => db.exec("UPDATE memory_v1_coverage SET evidence_id='e2' WHERE batch_id='pending'")],
  ['合法旧决定和摘要替换新决定', db => db.exec(`UPDATE memory_v1_coverage SET
    decision_json=(SELECT decision_json FROM memory_v1_coverage WHERE batch_id='done' AND part_key='text'),
    decision_json_hash=(SELECT decision_json_hash FROM memory_v1_coverage WHERE batch_id='done' AND part_key='text')
    WHERE batch_id='pending' AND part_key='text'`)],
  ['改明细顺序', db => db.exec("UPDATE memory_v1_coverage SET sequence=sequence+100 WHERE batch_id='pending'")],
  ['缺批次', db => db.exec("DELETE FROM memory_v1_coverage_batches WHERE batch_id='pending'")],
  ['只剩旧批次及旧明细', db => db.exec("DELETE FROM memory_v1_coverage WHERE batch_id='pending'; DELETE FROM memory_v1_coverage_batches WHERE batch_id='pending'")],
  ['批次索引串改', db => db.exec("UPDATE memory_v1_coverage_batches SET batch_index=99 WHERE batch_id='pending'")],
  ['物化摘要串改', db => db.exec("UPDATE memory_v1_coverage_batches SET materialized_json='[]' WHERE batch_id='pending'")],
  ['缺范围链头', db => db.exec('DELETE FROM memory_v1_coverage_scopes')],
];
for (const [name, damage] of coverageDamage) test(`批次完整性：${name}在读取、重放和重启均显式损坏`, t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  record.coverage.parts.push({ key: 'second', status: 'available', reason: null });
  receipt(ledger, record);
  ledger.putEvidence(record, { body: '合成记录' });
  ledger.recordCoverage(batch('done', [decision(), decision('e1', 'second')]));
  const pending = batch('pending', [decision('e1', 'text', 'pending-review'), decision('e1', 'second', 'pending-review')]);
  ledger.recordCoverage(pending);
  damage(db);
  expectError('corrupt', () => ledger.listPending('scope-1', later));
  expectError('corrupt', () => ledger.coverageFor('scope-1', decision().ref));
  expectError('corrupt', () => ledger.readEvidence('e1'));
  expectError('corrupt', () => ledger.recordCoverage(pending));
  const before = db.prepare('SELECT * FROM memory_v1_coverage').all();
  expectError('corrupt', () => new MemoryEvidenceLedger(db));
  assert.deepEqual(db.prepare('SELECT * FROM memory_v1_coverage').all(), before);
});

const revisionDamage: [string, (db: DatabaseSync) => void][] = [
  ['缺首修订', db => db.exec('DELETE FROM memory_v1_evidence_revisions WHERE revision_index=1')],
  ['缺中间修订', db => db.exec('DELETE FROM memory_v1_evidence_revisions WHERE revision_index=2')],
  ['缺末修订', db => db.exec('DELETE FROM memory_v1_evidence_revisions WHERE revision_index=3')],
  ['修订顺序串改', db => db.exec('UPDATE memory_v1_evidence_revisions SET revision_index=9 WHERE revision_index=2')],
  ['前修订链接串改', db => db.exec("UPDATE memory_v1_evidence_revisions SET previous_hash='bad' WHERE revision_index=2")],
  ['合法旧JSON和摘要复制到末修订', db => db.exec(`UPDATE memory_v1_evidence_revisions SET
    record_json=(SELECT record_json FROM memory_v1_evidence_revisions WHERE revision_index=1),
    record_json_hash=(SELECT record_json_hash FROM memory_v1_evidence_revisions WHERE revision_index=1) WHERE revision_index=3`)],
  ['跨来源别名', db => db.exec("UPDATE memory_v1_evidence_ids SET evidence_id='e2' WHERE id='alias-e1'")],
  ['缺规范别名', db => db.exec("DELETE FROM memory_v1_evidence_ids WHERE id='e1'")],
];
for (const [name, damage] of revisionDamage) test(`修订完整性：${name}不能被合法摘要或别名洗白`, t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  record.coverage = { status: 'partial', parts: [
    { key: 'text', status: 'available', reason: null }, { key: 'p2', status: 'unavailable', reason: '合成缺口二' },
    { key: 'p3', status: 'unavailable', reason: '合成缺口三' },
  ] };
  receipt(ledger, record);
  ledger.putEvidence(record, { body: '合成记录' });
  const middle = structuredClone(record);
  middle.coverage.parts[1] = { key: 'p2', status: 'available', reason: null };
  ledger.putEvidence(middle, { body: '合成记录' });
  const full = structuredClone(middle);
  full.coverage.status = 'complete'; full.coverage.parts[2] = { key: 'p3', status: 'available', reason: null };
  ledger.putEvidence(full, { body: '合成记录' });
  ledger.putEvidence({ ...full, id: 'alias-e1' }, { body: '合成记录' });
  ledger.putEvidence(evidence('e2'), { body: '合成记录' });
  assert.deepEqual(ledger.evidenceHistory('alias-e1').map(item => item.id), ['e1', 'e1', 'e1']);
  // 修订损坏只操作 e1，保留另一来源作为合法 JSON 的干扰项。
  db.exec('SAVEPOINT damage');
  damage(db);
  expectError('corrupt', () => ledger.evidenceHistory(name === '跨来源别名' ? 'alias-e1' : 'e1'));
  expectError('corrupt', () => new MemoryEvidenceLedger(db));
  db.exec('ROLLBACK TO damage; RELEASE damage');
  assert.equal(ledger.evidenceHistory('e1').length, 3);
});

test('保留与合并基数一致，但条目存在和版本发布仍由宿主验证', t => {
  const { db, ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  for (const kind of ['retained', 'merged'] as const) {
    expectError('conflict', () => ledger.recordCoverage(batch(kind, [decision('e1', 'text', kind)])));
    assert.equal(count(db, 'memory_v1_coverage'), 0);
  }
  const retained = { ...decision('e1', 'text', 'retained'), entryIds: ['host-entry-1'] };
  ledger.recordCoverage({ ...batch('retained', [retained]), versionId: 'host-version-1' });
  assert.deepEqual(ledger.listPending('scope-1', later), []);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='synthetic_versions'").get(), undefined);
});

test('范围链头写入故障回滚批次明细，外层业务事务仍可提交', t => {
  const { db, ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  db.exec(`CREATE TABLE synthetic_accept(id TEXT); BEGIN; INSERT INTO synthetic_accept VALUES ('keep');
    CREATE TRIGGER synthetic_head_failure BEFORE INSERT ON memory_v1_coverage_scopes BEGIN SELECT RAISE(ABORT,'synthetic head failure'); END`);
  assert.throws(() => ledger.recordCoverage(batch()), /synthetic head failure/);
  assert.equal(db.isTransaction, true);
  assert.equal(count(db, 'memory_v1_coverage'), 0);
  assert.equal(count(db, 'memory_v1_coverage_batches'), 0);
  assert.equal(count(db, 'memory_v1_coverage_scopes'), 0);
  db.exec('COMMIT');
  assert.equal(count(db, 'synthetic_accept'), 1);
});

test('SQL触发器静默漏写明细也必须在释放savepoint前报损坏并回滚', t => {
  const { db, ledger } = memory(t);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  db.exec('CREATE TRIGGER synthetic_ignore BEFORE INSERT ON memory_v1_coverage BEGIN SELECT RAISE(IGNORE); END; BEGIN');
  expectError('corrupt', () => ledger.recordCoverage(batch()));
  assert.equal(db.isTransaction, true);
  assert.equal(count(db, 'memory_v1_coverage_batches'), 0);
  assert.equal(count(db, 'memory_v1_coverage_scopes'), 0);
  db.exec('ROLLBACK');
});

test('native与import保留各自来源，同正文不能建立跨系统别名', t => {
  const { ledger } = memory(t);
  const native = evidence();
  ledger.putEvidence(native, { body: '合成记录' });
  const imported: EvidenceRecord = { ...native, id: 'import-1', contentRef: 'content-import-1',
    origin: { ...native.origin, system: 'import', capture: 'historical-record' } };
  ledger.putEvidence(imported, { body: '合成记录' });
  assert.equal(ledger.readEvidence('import-1')!.origin.system, 'import');
  assert.equal(ledger.evidenceHistory('import-1')[0]!.id, 'import-1');
  expectError('conflict', () => ledger.putEvidence({ ...imported, id: native.id }, { body: '合成记录' }));
});

test('小数秒不因毫秒截断而把较早回填当成同刻或提前可见', t => {
  const { ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  ledger.recordCoverage({ ...batch('review', [decision('e1', 'text', 'pending-review')]), auditedAt: '2025-02-02T00:00:00.0009Z' });
  ledger.recordCoverage({ ...batch('backfill'), auditedAt: '2025-02-02T01:00:00.0001+01:00' });
  assert.deepEqual(ledger.listPending('scope-1', '2025-02-02T00:00:00.0008Z'), []);
  assert.equal(ledger.listPending('scope-1', '2025-02-02T00:00:00.001Z')[0]!.gaps[0]!.reason, 'pending-review');
  const future = evidence('future'); future.visibleAfter = '2025-02-02T00:00:00.0009Z';
  receipt(ledger, future);
  ledger.putEvidence(future, { body: '合成记录' });
  expectError('not-visible', () => ledger.recordCoverage({ ...batch('early', [decision('future')]), auditedAt: '2025-02-02T00:00:00.0008Z' }));
  assert.equal(ledger.listPending('scope-1', '2025-02-02T00:00:00.0008Z').length, 0);
});

test('持久化映射连同合法摘要串改也不能解除修订链中的不可变绑定', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  record.attachments = [{ sourceId: 'a1', sha256: hash('x'), bytes: 1, mediaType: 'image/png', derivedEvidenceIds: [] }];
  record.coverage = { status: 'partial', parts: [
    { key: 'text', status: 'available', reason: null }, { key: 'image', status: 'unavailable', reason: '合成缺口' },
  ] };
  receipt(ledger, record);
  ledger.putEvidence(record, { body: '合成记录' });
  const rebound = fixtureBindings(record);
  [rebound[0]!.slots, rebound[1]!.slots] = [rebound[1]!.slots, rebound[0]!.slots];
  const raw = JSON.stringify(rebound);
  db.prepare('UPDATE memory_v1_evidence SET bindings_json=?,bindings_json_hash=?').run(raw, hash(raw));
  expectError('corrupt', () => ledger.evidenceHistory('e1'));
  expectError('corrupt', () => ledger.listPending('scope-1', later));
  expectError('corrupt', () => new MemoryEvidenceLedger(db));
});

for (const kind of ['coverage', 'revision'] as const) test(`实际关闭重开后${kind}损坏不被重新物化或修补`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-v1-ledger-damage-'));
  let db: DatabaseSync | undefined;
  try {
    const path = join(dir, 'fresh.sqlite');
    db = new DatabaseSync(path);
    const ledger = new MemoryEvidenceLedger(db);
    receipt(ledger);
    ledger.putEvidence(evidence(), { body: '合成记录' });
    ledger.recordCoverage(batch('done'));
    ledger.recordCoverage(batch('pending', [decision('e1', 'text', 'pending-review')]));
    if (kind === 'coverage') db.exec("DELETE FROM memory_v1_coverage WHERE batch_id='pending'");
    else db.exec('DELETE FROM memory_v1_evidence_revisions');
    const before = db.prepare('SELECT * FROM memory_v1_coverage_batches ORDER BY batch_index').all();
    db.close(); db = new DatabaseSync(path);
    const reopened = db;
    expectError('corrupt', () => new MemoryEvidenceLedger(reopened));
    assert.deepEqual(db.prepare('SELECT * FROM memory_v1_coverage_batches ORDER BY batch_index').all(), before);
    assert.equal(count(db, kind === 'coverage' ? 'memory_v1_coverage' : 'memory_v1_evidence_revisions'), kind === 'coverage' ? 1 : 0);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('缺少完整性元数据的旧合成原型库拒绝自动补链，保留业务表及原证据', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE synthetic_legacy(id TEXT); INSERT INTO synthetic_legacy VALUES ('keep');
    CREATE TABLE memory_v1_evidence(id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, record_json_hash TEXT NOT NULL)`);
  const raw = JSON.stringify(evidence());
  db.prepare('INSERT INTO memory_v1_evidence VALUES (?,?,?,?)').run('e1', 'synthetic-key', raw, hash(raw));
  expectError('corrupt', () => new MemoryEvidenceLedger(db));
  assert.equal(count(db, 'synthetic_legacy'), 1);
  assert.equal(count(db, 'memory_v1_evidence'), 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name LIKE 'memory_v1_%'").get()!.n, 1);
});

const receiptDamage: [string, (db: DatabaseSync) => void][] = [
  ['登记丢失但身份索引尚存', db => db.exec("DELETE FROM memory_v1_receipts WHERE id='receipt-e1'")],
  ['范围列串改隐藏原范围', db => db.exec("UPDATE memory_v1_receipts SET scope_id='scope-hidden' WHERE id='receipt-e1'")],
  ['来源列串改', db => db.exec("UPDATE memory_v1_receipts SET evidence_id='unregistered-source' WHERE id='receipt-e1'")],
  ['规范登记身份丢失', db => db.exec("DELETE FROM memory_v1_receipt_ids WHERE id='receipt-e1'")],
  ['登记别名悬空', db => db.exec("UPDATE memory_v1_receipt_ids SET receipt_id='missing' WHERE id='receipt-alias'")],
  ['登记别名转接另一合法登记', db => db.exec("UPDATE memory_v1_receipt_ids SET receipt_id='receipt-e2' WHERE id='receipt-alias'")],
  ['规范登记身份转接另一合法登记', db => db.exec("UPDATE memory_v1_receipt_ids SET receipt_id='receipt-e2' WHERE id='receipt-e1'")],
  ['完整登记JSON借用另一合法来源并重算摘要', db => {
    const row = db.prepare("SELECT receipt_json FROM memory_v1_receipts WHERE id='receipt-e1'").get()!;
    const value = JSON.parse(String(row.receipt_json));
    value.evidence.origin.contextRef = 'borrowed-context';
    const raw = JSON.stringify(value);
    db.prepare("UPDATE memory_v1_receipts SET receipt_json=?,receipt_json_hash=? WHERE id='receipt-e1'").run(raw, hash(raw));
  }],
  ['登记映射与来源映射分离并重算摘要', db => {
    const row = db.prepare("SELECT receipt_json FROM memory_v1_receipts WHERE id='receipt-e1'").get()!;
    const value = JSON.parse(String(row.receipt_json));
    value.partBindings[0].slots[0].ref = 'content-e2';
    const raw = JSON.stringify(value);
    db.prepare("UPDATE memory_v1_receipts SET receipt_json=?,receipt_json_hash=? WHERE id='receipt-e1'").run(raw, hash(raw));
  }],
];
for (const [name, damage] of receiptDamage) test(`登记双向关联：${name}不能被查询筛选或重构隐藏`, t => {
  const { db, ledger } = memory(t);
  receipt(ledger);
  receipt(ledger, evidence(), 'scope-1', 'receipt-alias');
  receipt(ledger, evidence('e2'));
  assert.equal(ledger.listPending('scope-1', later).length, 2);
  db.exec('SAVEPOINT damage');
  damage(db);
  const damaged = db.prepare('SELECT * FROM memory_v1_receipts').all();
  for (const read of [
    () => ledger.listPending('scope-1', later), () => ledger.listPending('unrelated-scope', later),
    () => ledger.readEvidence('e2'), () => ledger.readContent('e2'), () => ledger.evidenceHistory('e2'),
    () => ledger.coverageFor('scope-1', decision('e2').ref), () => new MemoryEvidenceLedger(db),
    () => receipt(ledger, evidence('new')), () => ledger.putEvidence(evidence('new'), { body: '合成记录' }),
    () => ledger.recordCoverage(batch('pending', [decision('e2', 'text', 'pending-source')])),
  ]) expectError('corrupt', read);
  assert.deepEqual(db.prepare('SELECT * FROM memory_v1_receipts').all(), damaged);
  assert.equal(count(db, 'memory_v1_evidence'), 2);
  db.exec('ROLLBACK TO damage; RELEASE damage');
  assert.equal(new MemoryEvidenceLedger(db).listPending('scope-1', later).length, 2);
});

function ledgerSnapshot(db: DatabaseSync) {
  return ['evidence', 'evidence_ids', 'evidence_revisions', 'contents', 'receipts', 'receipt_ids', 'coverage', 'coverage_batches', 'coverage_scopes']
    .map(name => db.prepare(`SELECT * FROM memory_v1_${name} ORDER BY rowid`).all());
}
const silentWrites: [string, string, (ledger: MemoryEvidenceLedger) => unknown][] = [
  ['首次来源修订漏写', 'BEFORE INSERT ON memory_v1_evidence_revisions BEGIN SELECT RAISE(IGNORE); END', ledger => ledger.putEvidence(evidence('new'), { body: '合成记录' })],
  ['来源规范身份漏写', 'BEFORE INSERT ON memory_v1_evidence_ids BEGIN SELECT RAISE(IGNORE); END', ledger => ledger.putEvidence(evidence('new'), { body: '合成记录' })],
  ['来源别名漏写', 'BEFORE INSERT ON memory_v1_evidence_ids BEGIN SELECT RAISE(IGNORE); END', ledger => ledger.putEvidence({ ...evidence(), id: 'alias-new' }, { body: '合成记录' })],
  ['登记行漏写', 'BEFORE INSERT ON memory_v1_receipts BEGIN SELECT RAISE(IGNORE); END', ledger => receipt(ledger, evidence('new'))],
  ['登记规范身份漏写', 'BEFORE INSERT ON memory_v1_receipt_ids BEGIN SELECT RAISE(IGNORE); END', ledger => receipt(ledger, evidence('new'))],
  ['登记别名漏写', 'BEFORE INSERT ON memory_v1_receipt_ids BEGIN SELECT RAISE(IGNORE); END', ledger => receipt(ledger, evidence(), 'scope-1', 'receipt-new')],
  ['写后删除来源别名', "AFTER INSERT ON memory_v1_evidence_ids WHEN NEW.id='alias-new' BEGIN DELETE FROM memory_v1_evidence_ids WHERE id=NEW.id; END", ledger => ledger.putEvidence({ ...evidence(), id: 'alias-new' }, { body: '合成记录' })],
  ['写后删除登记别名', "AFTER INSERT ON memory_v1_receipt_ids WHEN NEW.id='receipt-new' BEGIN DELETE FROM memory_v1_receipt_ids WHERE id=NEW.id; END", ledger => receipt(ledger, evidence(), 'scope-1', 'receipt-new')],
  ['写后篡改登记范围', "AFTER INSERT ON memory_v1_receipts BEGIN UPDATE memory_v1_receipts SET scope_id='hidden' WHERE id=NEW.id; END", ledger => receipt(ledger, evidence('new'))],
  ['写后篡改来源列', "AFTER INSERT ON memory_v1_evidence BEGIN UPDATE memory_v1_evidence SET source_key='wrong' WHERE id=NEW.id; END", ledger => ledger.putEvidence(evidence('new'), { body: '合成记录' })],
];
for (const [name, trigger, write] of silentWrites) test(`写入确认：${name}在savepoint内失败并保留宿主事务`, t => {
  const { db, ledger } = memory(t);
  receipt(ledger);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  db.exec('CREATE TABLE synthetic_accept(id TEXT)');
  const before = ledgerSnapshot(db);
  db.exec(`CREATE TRIGGER synthetic_silent ${trigger}; BEGIN; INSERT INTO synthetic_accept VALUES ('keep')`);
  expectError('corrupt', () => write(ledger));
  assert.equal(db.isTransaction, true);
  assert.deepEqual(ledgerSnapshot(db), before);
  db.exec('COMMIT; DROP TRIGGER synthetic_silent');
  assert.equal(count(db, 'synthetic_accept'), 1);
  assert.equal(new MemoryEvidenceLedger(db).listPending('scope-1', later).length, 1);
});

for (const fault of ['revision-ignore', 'head-ignore', 'body-ignore', 'body-reset'] as const) test(`补齐写入确认：${fault}不能返回未物化的新状态`, t => {
  const { db, ledger } = memory(t);
  const partial = evidence();
  partial.coverage = { status: 'partial', parts: [{ key: 'text', status: 'available', reason: null }, { key: 'other', status: 'unavailable', reason: '合成缺口' }] };
  receipt(ledger, partial);
  const before = ledgerSnapshot(db);
  const trigger = fault === 'revision-ignore' ? 'BEFORE INSERT ON memory_v1_evidence_revisions BEGIN SELECT RAISE(IGNORE); END'
    : fault === 'head-ignore' ? 'BEFORE UPDATE ON memory_v1_evidence BEGIN SELECT RAISE(IGNORE); END'
      : fault === 'body-ignore' ? 'BEFORE UPDATE ON memory_v1_contents BEGIN SELECT RAISE(IGNORE); END'
        : 'AFTER UPDATE ON memory_v1_contents BEGIN UPDATE memory_v1_contents SET loaded=0,codec=NULL,data=NULL WHERE evidence_id=NEW.evidence_id AND kind=NEW.kind AND ref=NEW.ref; END';
  db.exec(`CREATE TRIGGER synthetic_silent ${trigger}; BEGIN`);
  const full = structuredClone(partial);
  full.coverage = { status: 'complete', parts: full.coverage.parts.map(part => ({ ...part, status: 'available', reason: null })) };
  expectError('corrupt', () => ledger.putEvidence(fault.startsWith('body') ? partial : full, { body: '合成记录' }));
  assert.equal(db.isTransaction, true);
  assert.deepEqual(ledgerSnapshot(db), before);
  db.exec('ROLLBACK; DROP TRIGGER synthetic_silent');
  ledger.putEvidence(full, { body: '合成记录' });
  assert.equal(new MemoryEvidenceLedger(db).evidenceHistory('e1').length, 2);
});

for (const damage of ['receipt-missing', 'scope-column'] as const) test(`登记实际重开：${damage}保留损坏现场而不是补登记`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-v1-receipt-damage-'));
  let db: DatabaseSync | undefined;
  try {
    const path = join(dir, 'fresh.sqlite');
    db = new DatabaseSync(path);
    receipt(new MemoryEvidenceLedger(db));
    db.exec(damage === 'receipt-missing' ? 'DELETE FROM memory_v1_receipts' : "UPDATE memory_v1_receipts SET scope_id='hidden'");
    const before = ledgerSnapshot(db);
    db.close(); db = new DatabaseSync(path);
    const reopened = db;
    expectError('corrupt', () => new MemoryEvidenceLedger(reopened));
    assert.deepEqual(ledgerSnapshot(db), before);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const table of ['memory_v1_evidence', 'memory_v1_contents', 'memory_v1_evidence_revisions'] as const) test(`首次登记写入确认：${table}静默漏写不留下孤立登记`, t => {
  const { db, ledger } = memory(t);
  const before = ledgerSnapshot(db);
  db.exec(`CREATE TRIGGER synthetic_silent BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
  expectError('corrupt', () => receipt(ledger));
  assert.equal(db.isTransaction, false);
  assert.deepEqual(ledgerSnapshot(db), before);
  db.exec('DROP TRIGGER synthetic_silent');
  assert.deepEqual(new MemoryEvidenceLedger(db).listPending('scope-1', later), []);
});

for (const kind of ['revision', 'alias', 'content'] as const) test(`来源反向关联：孤立${kind}不能因未被查询而消失`, t => {
  const { db, ledger } = memory(t);
  ledger.putEvidence(evidence(), { body: '合成记录' });
  db.exec(kind === 'revision' ? "UPDATE memory_v1_evidence_revisions SET evidence_id='orphan'"
    : kind === 'alias' ? "UPDATE memory_v1_evidence_ids SET evidence_id='orphan'"
      : "INSERT INTO memory_v1_contents(evidence_id,kind,ref,expected_hash) VALUES ('orphan','attachment','orphan-content','invalid')");
  expectError('corrupt', () => ledger.listPending('empty-scope', later));
  expectError('corrupt', () => new MemoryEvidenceLedger(db));
});

test('附件写后使先前正文退回合法未加载状态也必须回滚本次操作', t => {
  const { db, ledger } = memory(t);
  const record = evidence();
  record.attachments = [{ sourceId: 'a1', sha256: hash('x'), bytes: 1, mediaType: 'image/png', derivedEvidenceIds: [] }];
  record.coverage = { status: 'partial', parts: [{ key: 'text', status: 'available', reason: null }, { key: 'image', status: 'unavailable', reason: '合成缺口' }] };
  receipt(ledger, record);
  const before = ledgerSnapshot(db);
  db.exec(`CREATE TRIGGER synthetic_reset AFTER UPDATE ON memory_v1_contents WHEN NEW.kind='attachment'
    BEGIN UPDATE memory_v1_contents SET loaded=0,codec=NULL,data=NULL WHERE evidence_id=NEW.evidence_id AND kind='body'; END`);
  expectError('corrupt', () => ledger.putEvidence(record, { body: '合成记录', attachments: [{ sourceId: 'a1', bytes: Buffer.from('x') }] }));
  assert.deepEqual(ledgerSnapshot(db), before);
});

test('合法来源和登记别名、部分补齐及外层提交后实际重开保持完整绑定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-v1-receipt-valid-'));
  let db: DatabaseSync | undefined;
  try {
    const path = join(dir, 'fresh.sqlite');
    db = new DatabaseSync(path);
    let ledger = new MemoryEvidenceLedger(db);
    const partial = evidence();
    partial.coverage = { status: 'partial', parts: [{ key: 'text', status: 'available', reason: null }, { key: 'other', status: 'unavailable', reason: '合成缺口' }] };
    db.exec('BEGIN');
    const registered = receipt(ledger, partial);
    ledger.putEvidence(partial, { body: '合成记录' });
    const full = structuredClone(partial);
    full.coverage = { status: 'complete', parts: full.coverage.parts.map(part => ({ ...part, status: 'available', reason: null })) };
    ledger.putEvidence({ ...full, id: 'alias-e1' }, { body: '合成记录' });
    assert.deepEqual(receipt(ledger, full, 'scope-1', 'receipt-alias'), registered);
    assert.equal(db.isTransaction, true);
    db.exec('COMMIT');
    const before = ledgerSnapshot(db);
    db.close(); db = new DatabaseSync(path);
    ledger = new MemoryEvidenceLedger(db);
    assert.equal(ledger.readEvidence('alias-e1')!.coverage.status, 'complete');
    assert.deepEqual(ledger.listPending('scope-1', later)[0]!.receipt, registered);
    assert.equal(ledger.evidenceHistory('alias-e1').length, 2);
    assert.equal(ledger.readContent('alias-e1'), '合成记录');
    assert.deepEqual(receipt(ledger, partial, 'scope-1', 'receipt-alias'), registered);
    assert.deepEqual(ledgerSnapshot(db), before);
    db.exec(`CREATE TRIGGER synthetic_silent BEFORE INSERT ON memory_v1_evidence_revisions BEGIN SELECT RAISE(IGNORE); END`);
    expectError('corrupt', () => ledger.putEvidence(evidence('new'), { body: '合成记录' }));
    assert.deepEqual(ledgerSnapshot(db), before);
    db.close(); db = new DatabaseSync(path);
    ledger = new MemoryEvidenceLedger(db);
    assert.equal(ledger.readEvidence('new'), undefined);
    assert.equal(ledger.evidenceHistory('alias-e1').length, 2);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('旧登记身份缺少绑定摘要时拒绝补造，保留现有登记与别名', t => {
  const { db, ledger } = memory(t);
  receipt(ledger);
  receipt(ledger, evidence(), 'scope-1', 'receipt-alias');
  db.exec('ALTER TABLE memory_v1_receipt_ids DROP COLUMN binding_hash');
  const before = ledgerSnapshot(db);
  expectError('corrupt', () => new MemoryEvidenceLedger(db));
  assert.deepEqual(ledgerSnapshot(db), before);
  assert.equal(count(db, 'memory_v1_receipt_ids'), 2);
});
