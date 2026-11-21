import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { coverageDecisionSchema, evidenceRecordSchema, evidenceReferenceSchema } from './contracts.js';
import type { CoverageDecision, EvidenceRecord, EvidenceReference } from './contracts.js';
import { evidenceIdempotencyKey } from './validate.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const timestamp = z.iso.datetime({ offset: true });
const partBindingSchema = z.strictObject({
  partKey: id,
  slots: z.array(z.strictObject({ kind: z.enum(['body', 'attachment']), ref: id })).min(1),
});
const partBindingsSchema = z.array(partBindingSchema).min(1);
const receiptSchema = z.strictObject({ id, scopeId: id, evidence: evidenceRecordSchema, partBindings: partBindingsSchema.optional() });
export type LedgerPartBinding = z.infer<typeof partBindingSchema>;
const batchSchema = z.strictObject({
  scopeId: id, batchId: id, versionId: id.nullable(), auditedAt: timestamp,
  decisions: z.array(coverageDecisionSchema).min(1),
});
const materializedSchema = z.array(z.strictObject({
  sequence: z.number().int().positive(), evidenceId: id, partKey: id, decisionHash: z.string().regex(/^[a-f0-9]{64}$/),
})).min(1);
export type LedgerReceipt = z.infer<typeof receiptSchema>;
export type LedgerCoverageBatch = z.infer<typeof batchSchema>;
export type LedgerContent = string | Uint8Array;
export interface LedgerContentInput {
  body: LedgerContent;
  attachments?: readonly { sourceId: string; bytes: Uint8Array }[];
  /** 多部分或含附件的首次登记必须由宿主明确提供；建立后不可重绑。 */
  partBindings?: LedgerPartBinding[];
}
export interface LedgerCoverage {
  sequence: number;
  scopeId: string;
  batchId: string;
  versionId: string | null;
  auditedAt: string;
  decision: CoverageDecision;
}
export interface LedgerGap {
  ref: EvidenceReference;
  reason: 'missing-content' | 'unavailable-part' | 'unprocessed' | 'pending-source' | 'pending-review';
}
export interface PendingLedgerReceipt { receipt: LedgerReceipt; gaps: LedgerGap[] }
export class MemoryLedgerError extends Error {
  constructor(readonly code: 'conflict' | 'corrupt' | 'missing-content' | 'unknown-evidence' | 'unknown-part' | 'not-visible' | 'unavailable-part', message: string) {
    super(message); this.name = 'MemoryLedgerError';
  }
}

type Row = Record<string, unknown>;
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function compareTime(a: string, b: string): number {
  // 时区先归一到秒；小数秒单独比较，避免 Date.parse 的毫秒截断改变审计先后。
  const seconds = Math.floor(Date.parse(a) / 1000) - Math.floor(Date.parse(b) / 1000);
  if (seconds) return seconds;
  const fraction = (value: string) => /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  const af = fraction(a), bf = fraction(b), width = Math.max(af.length, bf.length);
  const left = af.padEnd(width, '0'), right = bf.padEnd(width, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}
function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${json(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function fail(code: MemoryLedgerError['code'], message: string): never { throw new MemoryLedgerError(code, message); }
function checkedJson(row: Row, field: string): unknown {
  const raw = row[field];
  if (typeof raw !== 'string' || digest(raw) !== row[`${field}_hash`]) fail('corrupt', '账本 JSON 摘要不一致');
  try { return JSON.parse(raw); } catch { return fail('corrupt', '账本 JSON 无法解析'); }
}
function checkedParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('corrupt', '账本记录不符合合同');
  return result.data;
}
function encoded(value: LedgerContent): { bytes: Buffer; codec: 'utf8' | 'binary' } {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new TypeError('内容必须是字符串或 Uint8Array');
  const bytes = Buffer.from(value);
  if (typeof value === 'string' && bytes.toString('utf8') !== value) throw new TypeError('文本包含不能无损 UTF-8 编码的字符');
  return { bytes, codec: typeof value === 'string' ? 'utf8' : 'binary' };
}

/** 在调用者提供的连接上工作；savepoint 不提交调用者已有的事务。内部关联校验不证明原生受理或收集完整性。 */
export class MemoryEvidenceLedger {
  constructor(private readonly db: DatabaseSync) {
    this.atomic(() => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS memory_v1_evidence (
        id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL, record_json_hash TEXT NOT NULL,
        bindings_json TEXT NOT NULL, bindings_json_hash TEXT NOT NULL,
        revision_count INTEGER NOT NULL, revision_head TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v1_evidence_ids (
        id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL, source_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v1_evidence_revisions (
        sequence INTEGER PRIMARY KEY, evidence_id TEXT NOT NULL,
        record_json TEXT NOT NULL, record_json_hash TEXT NOT NULL,
        revision_index INTEGER NOT NULL, previous_hash TEXT NOT NULL, link_hash TEXT NOT NULL,
        UNIQUE(evidence_id,revision_index)
      );
      CREATE TABLE IF NOT EXISTS memory_v1_contents (
        evidence_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('body','attachment')),
        ref TEXT NOT NULL, expected_hash TEXT NOT NULL, expected_bytes INTEGER,
        codec TEXT CHECK(codec IN ('utf8','binary')), loaded INTEGER NOT NULL DEFAULT 0 CHECK(loaded IN (0,1)),
        data BLOB, PRIMARY KEY(evidence_id,kind,ref)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_v1_body_ref ON memory_v1_contents(ref) WHERE kind='body';
      CREATE TABLE IF NOT EXISTS memory_v1_receipts (
        id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
        receipt_json TEXT NOT NULL, receipt_json_hash TEXT NOT NULL,
        UNIQUE(scope_id,evidence_id)
      );
      CREATE TABLE IF NOT EXISTS memory_v1_receipt_ids (
        id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, binding_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v1_coverage_batches (
        scope_id TEXT NOT NULL, batch_id TEXT NOT NULL,
        batch_json TEXT NOT NULL, batch_json_hash TEXT NOT NULL,
        materialized_json TEXT NOT NULL, materialized_json_hash TEXT NOT NULL,
        batch_index INTEGER NOT NULL, previous_hash TEXT NOT NULL, link_hash TEXT NOT NULL,
        PRIMARY KEY(scope_id,batch_id), UNIQUE(scope_id,batch_index)
      );
      CREATE TABLE IF NOT EXISTS memory_v1_coverage_scopes (
        scope_id TEXT PRIMARY KEY, batch_count INTEGER NOT NULL, head_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_v1_coverage (
        sequence INTEGER PRIMARY KEY, scope_id TEXT NOT NULL, batch_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL, part_key TEXT NOT NULL,
        decision_json TEXT NOT NULL, decision_json_hash TEXT NOT NULL,
        UNIQUE(scope_id,batch_id,evidence_id,part_key)
      );
      CREATE INDEX IF NOT EXISTS memory_v1_coverage_part ON memory_v1_coverage(scope_id,evidence_id,part_key,sequence);
      `);
      // 旧实验库没有可验证的链头，不能凭现存行补造缺失的历史。
      const columns = db.prepare('PRAGMA table_info(memory_v1_evidence)').all();
      if (!columns.some(column => column.name === 'revision_head')) fail('corrupt', '账本结构缺少完整性信息');
      const receiptColumns = db.prepare('PRAGMA table_info(memory_v1_receipt_ids)').all();
      if (!receiptColumns.some(column => column.name === 'binding_hash')) fail('corrupt', '登记身份缺少绑定信息');
    });
  }

  private atomic<T>(operation: () => T): T {
    const name = `memory_v1_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = operation();
      this.checkedIntegrity();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  private write(sql: string, ...params: SQLInputValue[]): void {
    const result = this.db.prepare(sql).run(...params);
    if (Number(result.changes) !== 1) fail('corrupt', '账本写入未物化');
  }

  // 来源别名已有 source_key；登记别名需绑定完整登记，才能区分指向不同合法范围的串接。
  private receiptBinding(aliasId: string, receipt: LedgerReceipt): string {
    return digest(json({ aliasId, receiptId: receipt.id, receiptHash: digest(json(receipt)) }));
  }

  private bindReceipt(aliasId: string, receipt: LedgerReceipt): void {
    this.write('INSERT INTO memory_v1_receipt_ids VALUES (?,?,?)', aliasId, receipt.id, this.receiptBinding(aliasId, receipt));
  }

  private confirmReceipt(aliasId: string, expected: LedgerReceipt): LedgerReceipt {
    const alias = this.db.prepare('SELECT * FROM memory_v1_receipt_ids WHERE id=?').get(aliasId);
    const row = this.db.prepare('SELECT * FROM memory_v1_receipts WHERE id=?').get(expected.id);
    if (!row || alias?.receipt_id !== expected.id || alias.binding_hash !== this.receiptBinding(aliasId, expected) ||
        json(checkedJson(row, 'receipt_json')) !== json(expected)) fail('corrupt', '登记或别名未按预期物化');
    return expected;
  }

  private confirmEvidence(aliasId: string, expected: EvidenceRecord): EvidenceRecord {
    const actual = this.stored(aliasId);
    if (!actual || json(actual) !== json(expected)) fail('corrupt', '来源或修订未按预期物化');
    return expected;
  }

  /** 从登记、身份索引和来源各端核对；不能先按范围过滤后再验证剩余行。 */
  private checkedRegistry(): LedgerReceipt[] {
    for (const row of this.db.prepare('SELECT id FROM memory_v1_evidence').all()) {
      if (!this.stored(checkedParse(id, row.id))) fail('corrupt', '规范来源身份缺失');
    }
    for (const row of this.db.prepare('SELECT id FROM memory_v1_evidence_ids').all()) this.canonicalId(checkedParse(id, row.id));
    if (this.db.prepare(`SELECT 1 FROM memory_v1_evidence_revisions r LEFT JOIN memory_v1_evidence e ON e.id=r.evidence_id WHERE e.id IS NULL
      UNION ALL SELECT 1 FROM memory_v1_evidence_ids a LEFT JOIN memory_v1_evidence e ON e.id=a.evidence_id WHERE e.id IS NULL
      UNION ALL SELECT 1 FROM memory_v1_contents c LEFT JOIN memory_v1_evidence e ON e.id=c.evidence_id WHERE e.id IS NULL`).get()) fail('corrupt', '证据历史、内容或别名缺少规范来源');
    const receipts = new Map<string, LedgerReceipt>();
    for (const row of this.db.prepare('SELECT * FROM memory_v1_receipts ORDER BY rowid').all()) {
      const receipt = checkedParse(receiptSchema, checkedJson(row, 'receipt_json'));
      if (receipt.id !== row.id || receipt.scopeId !== row.scope_id || receipt.evidence.id !== row.evidence_id) fail('corrupt', '登记索引不一致');
      const record = this.stored(receipt.evidence.id);
      if (!record || record.id !== receipt.evidence.id) fail('corrupt', '登记缺少规范来源');
      const head = this.db.prepare('SELECT * FROM memory_v1_evidence WHERE id=?').get(record.id)!;
      if (!this.checkHistory(head, record).some(revision => json(revision) === json(receipt.evidence)) ||
          json(receipt.partBindings) !== json(this.bindings(record))) fail('corrupt', '完整登记与来源修订或部分绑定不一致');
      this.confirmReceipt(receipt.id, receipt);
      receipts.set(receipt.id, receipt);
    }
    for (const alias of this.db.prepare('SELECT * FROM memory_v1_receipt_ids').all()) {
      checkedParse(id, alias.id);
      const receipt = receipts.get(String(alias.receipt_id));
      if (!receipt || alias.binding_hash !== this.receiptBinding(String(alias.id), receipt)) fail('corrupt', '登记别名缺少或跨越原登记');
    }
    return [...receipts.values()];
  }

  private checkedIntegrity(): { receipts: LedgerReceipt[]; coverage: LedgerCoverage[] } {
    const receipts = this.checkedRegistry();
    return { receipts, coverage: this.checkedCoverage() };
  }

  private canonicalId(evidenceId: string): string | undefined {
    id.parse(evidenceId);
    const row = this.db.prepare(`SELECT a.*,e.source_key AS canonical_source_key FROM memory_v1_evidence_ids a
      LEFT JOIN memory_v1_evidence e ON e.id=a.evidence_id WHERE a.id=?`).get(evidenceId);
    if (!row) {
      if (this.db.prepare('SELECT 1 FROM memory_v1_evidence WHERE id=?').get(evidenceId)) fail('corrupt', '规范来源的身份索引缺失');
      return undefined;
    }
    if (row.source_key !== row.canonical_source_key || (row.evidence_id !== evidenceId &&
        this.db.prepare('SELECT 1 FROM memory_v1_evidence WHERE id=?').get(evidenceId))) fail('corrupt', '证据别名跨越规范来源');
    return String(row.evidence_id);
  }

  private stored(evidenceId: string): EvidenceRecord | undefined {
    const canonical = this.canonicalId(evidenceId);
    if (!canonical) return undefined;
    const row = this.db.prepare('SELECT * FROM memory_v1_evidence WHERE id=?').get(canonical);
    if (!row) fail('corrupt', '证据身份指向缺失记录');
    const record = checkedParse(evidenceRecordSchema, checkedJson(row, 'record_json'));
    if (record.id !== canonical || evidenceIdempotencyKey(record) !== row.source_key) fail('corrupt', '证据来源索引不一致');
    this.checkHistory(row, record);
    this.bindings(record);
    this.checkContents(record);
    return record;
  }

  private immutable(record: EvidenceRecord): string { return json({ ...record, coverage: null }); }

  private canFill(previous: EvidenceRecord, next: EvidenceRecord): boolean {
    const parts = new Map(previous.coverage.parts.map(part => [part.key, part]));
    return this.immutable(previous) === this.immutable(next) && parts.size === next.coverage.parts.length &&
      next.coverage.parts.every(part => {
        const old = parts.get(part.key);
        return old && (json(old) === json(part) || (old.status === 'unavailable' && part.status === 'available' && part.reason === null));
      });
  }

  private revisionLink(record: EvidenceRecord, index: number, previous: string, bindingsHash: string): string {
    return digest(json({ evidenceId: record.id, sourceKey: evidenceIdempotencyKey(record), index, previous, bindingsHash, recordHash: digest(json(record)) }));
  }

  private checkHistory(head: Row, record: EvidenceRecord): EvidenceRecord[] {
    const rows = this.db.prepare('SELECT * FROM memory_v1_evidence_revisions WHERE evidence_id=? ORDER BY revision_index').all(record.id);
    if (!rows.length || rows.length !== head.revision_count) fail('corrupt', '证据修订计数不一致');
    let previousHash = '';
    const history: EvidenceRecord[] = [];
    for (const [offset, row] of rows.entries()) {
      const revision = checkedParse(evidenceRecordSchema, checkedJson(row, 'record_json'));
      const previous = history.at(-1);
      const link = this.revisionLink(revision, offset + 1, previousHash, String(head.bindings_json_hash));
      if (revision.id !== record.id || evidenceIdempotencyKey(revision) !== head.source_key || this.immutable(revision) !== this.immutable(record) ||
          row.revision_index !== offset + 1 || row.previous_hash !== previousHash || row.link_hash !== link ||
          (previous && (!this.canFill(previous, revision) || json(previous) === json(revision)))) fail('corrupt', '证据修订来源或链不一致');
      history.push(revision);
      previousHash = link;
    }
    if (previousHash !== head.revision_head || json(history.at(-1)) !== json(record)) fail('corrupt', '证据修订链头不一致');
    return history;
  }

  private normalizedBindings(record: EvidenceRecord, input: LedgerPartBinding[]): LedgerPartBinding[] {
    const bindings = partBindingsSchema.parse(input).map(binding => ({ ...binding,
      slots: binding.slots.sort((a, b) => json(a).localeCompare(json(b))),
    })).sort((a, b) => a.partKey.localeCompare(b.partKey));
    const slots = new Set(this.slots(record).map(slot => json({ kind: slot.kind, ref: slot.ref })));
    const covered = new Set<string>();
    if (bindings.length !== record.coverage.parts.length || new Set(bindings.map(binding => binding.partKey)).size !== bindings.length ||
        bindings.some(binding => !record.coverage.parts.some(part => part.key === binding.partKey) ||
          new Set(binding.slots.map(json)).size !== binding.slots.length || binding.slots.some(slot => !slots.has(json(slot))))) fail('conflict', '部分与内容槽绑定不完整或无效');
    for (const binding of bindings) for (const slot of binding.slots) covered.add(json(slot));
    if (covered.size !== slots.size) fail('conflict', '部分绑定不能遗漏内容槽');
    return bindings;
  }

  private bindings(record: EvidenceRecord): LedgerPartBinding[] {
    const row = this.db.prepare('SELECT bindings_json,bindings_json_hash FROM memory_v1_evidence WHERE id=?').get(record.id)!;
    const parsed = checkedParse(partBindingsSchema, checkedJson(row, 'bindings_json'));
    try {
      const normalized = this.normalizedBindings(record, parsed);
      if (json(normalized) !== json(parsed)) fail('corrupt', '部分内容绑定顺序不一致');
      return normalized;
    } catch { return fail('corrupt', '部分内容绑定损坏'); }
  }

  private partLoaded(record: EvidenceRecord, partKey: string): boolean {
    return this.bindings(record).find(binding => binding.partKey === partKey)!.slots
      .every(slot => this.contentSlot(record, slot.kind, slot.ref).loaded === 1);
  }

  private slots(record: EvidenceRecord) {
    return [
      { kind: 'body', ref: record.contentRef, hash: record.contentHash, bytes: null as number | null },
      ...record.attachments.map(item => ({ kind: 'attachment', ref: item.sourceId, hash: item.sha256, bytes: item.bytes })),
    ];
  }

  private contentSlot(record: EvidenceRecord, kind: string, ref: string): Row {
    const row = this.db.prepare('SELECT * FROM memory_v1_contents WHERE evidence_id=? AND kind=? AND ref=?').get(record.id, kind, ref);
    if (!row) fail('corrupt', '证据内容索引缺失');
    return row;
  }

  private checkContents(record: EvidenceRecord): void {
    if (this.db.prepare('SELECT count(*) AS n FROM memory_v1_contents WHERE evidence_id=?').get(record.id)!.n !== this.slots(record).length) fail('corrupt', '内容槽数量不一致');
    for (const slot of this.slots(record)) {
      const row = this.contentSlot(record, slot.kind, slot.ref);
      if (row.expected_hash !== slot.hash || row.expected_bytes !== slot.bytes) fail('corrupt', '内容绑定摘要不一致');
      if (row.loaded === 0) {
        if (row.data !== null || row.codec !== null) fail('corrupt', '未写入内容的状态不一致');
      } else if (row.loaded === 1) {
        if (!(row.data instanceof Uint8Array) || digest(row.data) !== slot.hash ||
            (slot.bytes !== null && row.data.byteLength !== slot.bytes) ||
            (row.codec !== 'utf8' && row.codec !== 'binary') || (slot.kind === 'attachment' && row.codec !== 'binary')) {
          fail('corrupt', '内容缺失或摘要不一致');
        }
        if (row.codec === 'utf8' && !Buffer.from(Buffer.from(row.data).toString('utf8')).equals(Buffer.from(row.data))) fail('corrupt', '文本编码不一致');
      } else fail('corrupt', '未知内容状态');
    }
  }

  private ensureEvidence(input: EvidenceRecord, suppliedBindings?: LedgerPartBinding[]): EvidenceRecord {
    const record = evidenceRecordSchema.parse(input);
    const key = evidenceIdempotencyKey(record);
    const byId = this.canonicalId(record.id);
    const source = this.db.prepare('SELECT id FROM memory_v1_evidence WHERE source_key=?').get(key);
    if (byId && byId !== source?.id) fail('conflict', '证据 ID 已绑定其他来源');
    if (!source) {
      // 只有无附件的单一部分不存在映射歧义；其余情况不从名称推断正文或附件。
      if (!suppliedBindings && (record.coverage.parts.length !== 1 || record.attachments.length)) fail('conflict', '首次登记需要明确的部分内容绑定');
      const bindings = this.normalizedBindings(record, suppliedBindings ?? [{ partKey: record.coverage.parts[0]!.key, slots: [{ kind: 'body', ref: record.contentRef }] }]);
      const raw = json(record), bound = json(bindings);
      const link = this.revisionLink(record, 1, '', digest(bound));
      this.write(`INSERT INTO memory_v1_evidence(id,source_key,record_json,record_json_hash,bindings_json,bindings_json_hash,revision_count,revision_head)
        VALUES (?,?,?,?,?,?,?,?)`, record.id, key, raw, digest(raw), bound, digest(bound), 1, link);
      this.write('INSERT INTO memory_v1_evidence_ids VALUES (?,?,?)', record.id, record.id, key);
      this.write(`INSERT INTO memory_v1_evidence_revisions(evidence_id,record_json,record_json_hash,revision_index,previous_hash,link_hash)
        VALUES (?,?,?,?,?,?)`, record.id, raw, digest(raw), 1, '', link);
      for (const slot of this.slots(record)) {
        const bound = slot.kind === 'body' ? this.db.prepare("SELECT evidence_id FROM memory_v1_contents WHERE kind='body' AND ref=?").get(slot.ref) : undefined;
        if (bound) fail('conflict', '内容引用已绑定其他来源');
        this.write('INSERT INTO memory_v1_contents(evidence_id,kind,ref,expected_hash,expected_bytes) VALUES (?,?,?,?,?)', record.id, slot.kind, slot.ref, slot.hash, slot.bytes);
      }
      return this.confirmEvidence(record.id, record);
    }
    const old = this.stored(String(source.id))!;
    if (suppliedBindings && json(this.normalizedBindings(old, suppliedBindings)) !== json(this.bindings(old))) fail('conflict', '部分内容槽绑定不能改写');
    // 别名只复用规范来源，不用正文相似度推定同源。
    const next = { ...record, id: old.id };
    if (json({ ...old, coverage: null }) !== json({ ...next, coverage: null })) fail('conflict', '规范来源的正文或来源绑定冲突');
    if (json(old.coverage) !== json(next.coverage)) {
      const historical = this.db.prepare('SELECT * FROM memory_v1_evidence_revisions WHERE evidence_id=? ORDER BY sequence').all(old.id)
        .some(row => json(checkedParse(evidenceRecordSchema, checkedJson(row, 'record_json'))) === json(next));
      if (historical) {
        if (!byId) this.write('INSERT INTO memory_v1_evidence_ids VALUES (?,?,?)', record.id, old.id, key);
        return this.confirmEvidence(record.id, old);
      }
      if (!this.canFill(old, next)) fail('conflict', '证据部分只能补齐缺口');
      const raw = json(next);
      const head = this.db.prepare('SELECT revision_count,revision_head,bindings_json_hash FROM memory_v1_evidence WHERE id=?').get(old.id)!;
      const index = Number(head.revision_count) + 1, previous = String(head.revision_head);
      const link = this.revisionLink(next, index, previous, String(head.bindings_json_hash));
      this.write('UPDATE memory_v1_evidence SET record_json=?,record_json_hash=?,revision_count=?,revision_head=? WHERE id=?', raw, digest(raw), index, link, old.id);
      this.write(`INSERT INTO memory_v1_evidence_revisions(evidence_id,record_json,record_json_hash,revision_index,previous_hash,link_hash)
        VALUES (?,?,?,?,?,?)`, old.id, raw, digest(raw), index, previous, link);
    }
    if (!byId) this.write('INSERT INTO memory_v1_evidence_ids VALUES (?,?,?)', record.id, old.id, key);
    return this.confirmEvidence(record.id, next);
  }

  registerReceipt(input: LedgerReceipt): LedgerReceipt {
    const receipt = receiptSchema.parse(input);
    return this.atomic(() => {
      this.checkedIntegrity();
      const evidence = this.ensureEvidence(receipt.evidence, receipt.partBindings);
      const normalized = { ...receipt, evidence, partBindings: this.bindings(evidence) };
      const binding = this.db.prepare('SELECT receipt_id FROM memory_v1_receipt_ids WHERE id=?').get(receipt.id);
      const row = this.db.prepare('SELECT * FROM memory_v1_receipts WHERE scope_id=? AND evidence_id=?').get(receipt.scopeId, evidence.id);
      if (binding && binding.receipt_id !== row?.id) fail('conflict', '登记 ID 已绑定其他来源或范围');
      if (row) {
        const previous = checkedParse(receiptSchema, checkedJson(row, 'receipt_json'));
        if (row.scope_id !== previous.scopeId || row.evidence_id !== previous.evidence.id || row.id !== previous.id) fail('corrupt', '登记索引不一致');
        const comparable = (value: LedgerReceipt) => ({ ...value, id: receipt.id, evidence: { ...value.evidence, coverage: null } });
        if (json(comparable(previous)) !== json(comparable(normalized))) fail('conflict', '登记身份或内容冲突');
        if (!binding) this.bindReceipt(receipt.id, previous);
        this.confirmEvidence(receipt.evidence.id, evidence);
        return this.confirmReceipt(receipt.id, previous);
      }
      const raw = json(normalized);
      this.write('INSERT INTO memory_v1_receipts VALUES (?,?,?,?,?)', receipt.id, receipt.scopeId, evidence.id, raw, digest(raw));
      this.bindReceipt(receipt.id, normalized);
      this.confirmEvidence(receipt.evidence.id, evidence);
      return this.confirmReceipt(receipt.id, normalized);
    });
  }

  putEvidence(input: EvidenceRecord, content: LedgerContentInput): EvidenceRecord {
    return this.atomic(() => {
      this.checkedIntegrity();
      const record = this.ensureEvidence(input, content.partBindings);
      const body = encoded(content.body);
      this.putSlot(record, 'body', record.contentRef, body.bytes, body.codec);
      const seen = new Set<string>();
      for (const attachment of content.attachments ?? []) {
        if (seen.has(attachment.sourceId) || !record.attachments.some(item => item.sourceId === attachment.sourceId)) fail('conflict', '附件身份不存在或重复');
        if (!(attachment.bytes instanceof Uint8Array)) throw new TypeError('附件必须是 Uint8Array');
        seen.add(attachment.sourceId);
        this.putSlot(record, 'attachment', attachment.sourceId, Buffer.from(attachment.bytes), 'binary');
      }
      // 后续附件写入也可能影响先前槽；释放 savepoint 前再次确认本次所有内容。
      this.confirmSlot(record, 'body', record.contentRef, body.bytes, body.codec);
      for (const attachment of content.attachments ?? []) this.confirmSlot(record, 'attachment', attachment.sourceId, attachment.bytes, 'binary');
      if (record.coverage.status === 'complete' && this.slots(record).some(slot => this.contentSlot(record, slot.kind, slot.ref).loaded !== 1)) {
        fail('missing-content', '完整证据仍缺少内容');
      }
      return this.confirmEvidence(input.id, record);
    });
  }

  private putSlot(record: EvidenceRecord, kind: string, ref: string, bytes: Uint8Array, codec: string): void {
    const row = this.contentSlot(record, kind, ref);
    if (digest(bytes) !== row.expected_hash || (row.expected_bytes !== null && bytes.byteLength !== row.expected_bytes)) fail('conflict', '内容摘要或长度不符');
    if (row.loaded === 1) {
      if (row.codec !== codec || !(row.data instanceof Uint8Array) || !Buffer.from(row.data).equals(bytes)) fail('conflict', '内容冲突，不能覆盖');
      return;
    }
    this.write('UPDATE memory_v1_contents SET loaded=1,codec=?,data=? WHERE evidence_id=? AND kind=? AND ref=?', codec, bytes, record.id, kind, ref);
    this.confirmSlot(record, kind, ref, bytes, codec);
  }

  private confirmSlot(record: EvidenceRecord, kind: string, ref: string, bytes: Uint8Array, codec: string): void {
    const actual = this.contentSlot(record, kind, ref);
    if (actual.loaded !== 1 || actual.codec !== codec || !(actual.data instanceof Uint8Array) ||
        !Buffer.from(actual.data).equals(bytes)) fail('corrupt', '内容未按预期物化');
  }

  readEvidence(evidenceId: string): EvidenceRecord | undefined { this.checkedIntegrity(); return this.stored(evidenceId); }

  /** 文本为逐字 UTF-8；二进制为原始字节。摘要均针对原始字节，不读取路径或 URL。 */
  readContent(evidenceId: string, attachmentSourceId?: string): LedgerContent {
    this.checkedIntegrity();
    const record = this.stored(evidenceId);
    if (!record) fail('unknown-evidence', '未知证据');
    if (attachmentSourceId !== undefined && !record.attachments.some(item => item.sourceId === attachmentSourceId)) fail('unknown-part', '未知附件');
    const row = this.contentSlot(record, attachmentSourceId === undefined ? 'body' : 'attachment', attachmentSourceId ?? record.contentRef);
    if (row.loaded !== 1) fail('missing-content', '来源内容尚未补齐');
    const bytes = Buffer.from(row.data as Uint8Array);
    return row.codec === 'utf8' ? bytes.toString('utf8') : new Uint8Array(bytes);
  }

  evidenceHistory(evidenceId: string): EvidenceRecord[] {
    this.checkedIntegrity();
    const record = this.stored(evidenceId);
    if (!record) fail('unknown-evidence', '未知证据');
    const head = this.db.prepare('SELECT * FROM memory_v1_evidence WHERE id=?').get(record.id)!;
    return this.checkHistory(head, record);
  }

  private batchLink(row: Row): string {
    return digest(json({ scopeId: row.scope_id, batchId: row.batch_id, index: row.batch_index, previous: row.previous_hash,
      batchHash: row.batch_json_hash, materializedHash: row.materialized_json_hash }));
  }

  /** 同时从批次和明细两端校验，不以剩余明细推断批次曾经只有这些部分。 */
  private checkedCoverage(): LedgerCoverage[] {
    const scopes = this.db.prepare('SELECT * FROM memory_v1_coverage_scopes').all();
    const batches = this.db.prepare('SELECT * FROM memory_v1_coverage_batches ORDER BY batch_index').all();
    const rows = this.db.prepare('SELECT * FROM memory_v1_coverage ORDER BY sequence').all();
    const claimed = new Set<number>();
    const result: LedgerCoverage[] = [];
    const scopeIds = new Set(scopes.map(scope => scope.scope_id));
    if (batches.some(row => !scopeIds.has(row.scope_id))) fail('corrupt', '覆盖批次缺少范围链头');
    for (const scope of scopes) {
      const history = batches.filter(row => row.scope_id === scope.scope_id);
      if (!history.length || history.length !== scope.batch_count) fail('corrupt', '覆盖批次计数不一致');
      let previous = '';
      for (const [offset, row] of history.entries()) {
        const batch = checkedParse(batchSchema, checkedJson(row, 'batch_json'));
        const materialized = checkedParse(materializedSchema, checkedJson(row, 'materialized_json'));
        const details = rows.filter(detail => detail.scope_id === row.scope_id && detail.batch_id === row.batch_id);
        const link = this.batchLink(row);
        if (batch.scopeId !== scope.scope_id || batch.batchId !== row.batch_id || row.batch_index !== offset + 1 || row.previous_hash !== previous || row.link_hash !== link ||
            details.length !== batch.decisions.length || materialized.length !== batch.decisions.length) fail('corrupt', '覆盖批次链或明细数量不一致');
        const refs = new Set<string>();
        for (const [index, decision] of batch.decisions.entries()) {
          const detail = details[index], bound = materialized[index]!;
          if (!detail) fail('corrupt', '覆盖明细缺失');
          const parsed = checkedParse(coverageDecisionSchema, checkedJson(detail, 'decision_json'));
          const sequence = Number(detail.sequence), key = json(decision.ref);
          if (refs.has(key) || claimed.has(sequence) || bound.sequence !== sequence || bound.evidenceId !== detail.evidence_id || bound.partKey !== detail.part_key ||
              bound.decisionHash !== detail.decision_json_hash || decision.ref.evidenceId !== detail.evidence_id || decision.ref.partKey !== detail.part_key ||
              json(parsed) !== json(decision) || (['retained', 'merged'].includes(decision.decision) && !decision.entryIds.length)) fail('corrupt', '覆盖明细链接或决定不一致');
          const record = this.stored(decision.ref.evidenceId);
          if (!record || record.id !== decision.ref.evidenceId || !record.coverage.parts.some(part => part.key === decision.ref.partKey) ||
              compareTime(record.visibleAfter, batch.auditedAt) > 0) fail('corrupt', '覆盖明细引用来源无效');
          claimed.add(sequence); refs.add(key);
          result.push({ sequence, scopeId: batch.scopeId, batchId: batch.batchId, versionId: batch.versionId, auditedAt: batch.auditedAt, decision });
        }
        previous = link;
      }
      if (previous !== scope.head_hash) fail('corrupt', '覆盖批次链头不一致');
    }
    if (claimed.size !== rows.length) fail('corrupt', '覆盖明细不属于已验证批次');
    // 允许旧审计回填；按实际时刻排序，同一时刻以后受理的批次为准，sequence 不覆盖较新时刻。
    return result.sort((a, b) => compareTime(a.auditedAt, b.auditedAt) || a.sequence - b.sequence);
  }

  /** 仅记录处理审计；条目存在、语义、保护检查、版本可发布性仍须由宿主在同一事务验证。 */
  recordCoverage(input: LedgerCoverageBatch): void {
    const batch = batchSchema.parse(input);
    this.atomic(() => {
      this.checkedIntegrity();
      const seen = new Set<string>();
      const decisions = batch.decisions.map(decision => {
        if (['retained', 'merged'].includes(decision.decision) && !decision.entryIds.length) fail('conflict', '保留与合并需要条目引用');
        const record = this.stored(decision.ref.evidenceId);
        if (!record) fail('unknown-evidence', '覆盖引用未知证据');
        const part = record.coverage.parts.find(item => item.key === decision.ref.partKey);
        if (!part) fail('unknown-part', '覆盖引用未知部分');
        if (compareTime(record.visibleAfter, batch.auditedAt) > 0) fail('not-visible', '覆盖引用尚未可见的证据');
        const ref = { evidenceId: record.id, partKey: part.key };
        const key = json(ref);
        if (seen.has(key)) fail('conflict', '同批部分重复');
        seen.add(key);
        const pending = decision.decision === 'pending-source' || decision.decision === 'pending-review';
        if (!pending && (part.status !== 'available' || !this.partLoaded(record, part.key))) fail('unavailable-part', '缺来源不能记为已覆盖');
        return { ...decision, ref };
      });
      const normalized = { ...batch, decisions }, raw = json(normalized);
      const old = this.db.prepare('SELECT * FROM memory_v1_coverage_batches WHERE scope_id=? AND batch_id=?').get(batch.scopeId, batch.batchId);
      if (old) {
        if (json(checkedParse(batchSchema, checkedJson(old, 'batch_json'))) !== raw) fail('conflict', '覆盖批次不能改写');
        return;
      }
      const materialized: z.infer<typeof materializedSchema> = [];
      for (const decision of decisions) {
        const encodedDecision = json(decision), decisionHash = digest(encodedDecision);
        const inserted = this.db.prepare('INSERT INTO memory_v1_coverage(scope_id,batch_id,evidence_id,part_key,decision_json,decision_json_hash) VALUES (?,?,?,?,?,?)')
          .run(batch.scopeId, batch.batchId, decision.ref.evidenceId, decision.ref.partKey, encodedDecision, decisionHash);
        materialized.push({ sequence: Number(inserted.lastInsertRowid), evidenceId: decision.ref.evidenceId, partKey: decision.ref.partKey, decisionHash });
      }
      const head = this.db.prepare('SELECT * FROM memory_v1_coverage_scopes WHERE scope_id=?').get(batch.scopeId);
      const index = Number(head?.batch_count ?? 0) + 1, previous = String(head?.head_hash ?? '');
      const materializedRaw = json(materialized), batchHash = digest(raw), materializedHash = digest(materializedRaw);
      const link = this.batchLink({ scope_id: batch.scopeId, batch_id: batch.batchId, batch_index: index, previous_hash: previous,
        batch_json_hash: batchHash, materialized_json_hash: materializedHash });
      this.db.prepare(`INSERT INTO memory_v1_coverage_batches(scope_id,batch_id,batch_json,batch_json_hash,materialized_json,materialized_json_hash,batch_index,previous_hash,link_hash)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(batch.scopeId, batch.batchId, raw, batchHash, materializedRaw, materializedHash, index, previous, link);
      this.db.prepare(`INSERT INTO memory_v1_coverage_scopes VALUES (?,?,?) ON CONFLICT(scope_id)
        DO UPDATE SET batch_count=excluded.batch_count,head_hash=excluded.head_hash`).run(batch.scopeId, index, link);
    });
  }

  coverageFor(scopeId: string, input: EvidenceReference): LedgerCoverage[] {
    id.parse(scopeId);
    const ref = evidenceReferenceSchema.parse(input);
    const { coverage } = this.checkedIntegrity();
    const record = this.stored(ref.evidenceId);
    if (!record) fail('unknown-evidence', '未知证据');
    if (!record.coverage.parts.some(part => part.key === ref.partKey)) fail('unknown-part', '未知证据部分');
    return coverage.filter(row => row.scopeId === scopeId && row.decision.ref.evidenceId === record.id && row.decision.ref.partKey === ref.partKey);
  }

  /** 返回该时刻仍缺来源或处理决定的登记；空列表不是版本发布许可。 */
  listPending(scopeId: string, asOf: string): PendingLedgerReceipt[] {
    id.parse(scopeId); timestamp.parse(asOf);
    const { receipts, coverage } = this.checkedIntegrity();
    const result: PendingLedgerReceipt[] = [];
    for (const receipt of receipts) {
      if (receipt.scopeId !== scopeId) continue;
      const record = this.stored(receipt.evidence.id);
      if (!record) fail('corrupt', '登记的证据索引缺失');
      if (compareTime(record.visibleAfter, asOf) > 0) continue;
      const gaps: LedgerGap[] = [];
      for (const part of record.coverage.parts) {
        const ref = { evidenceId: record.id, partKey: part.key };
        const history = coverage.filter(item => item.scopeId === scopeId && item.decision.ref.evidenceId === record.id &&
          item.decision.ref.partKey === part.key && compareTime(item.auditedAt, asOf) <= 0);
        const last = history.at(-1)?.decision;
        const reason = part.status === 'unavailable' ? 'unavailable-part' : !this.partLoaded(record, part.key) ? 'missing-content'
          : !last ? 'unprocessed' : last.decision === 'pending-source' || last.decision === 'pending-review' ? last.decision : null;
        if (reason) gaps.push({ ref, reason });
      }
      if (gaps.length) result.push({ receipt, gaps });
    }
    return result;
  }
}
