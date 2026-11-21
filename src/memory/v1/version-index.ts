import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { memoryEntrySchema } from './contracts.js';
import { MemoryVersionFiles } from './version-files.js';
import type { MemoryVersionAnchor, MemoryVersionRead } from './version-files.js';
import { AppError } from '../../domain.js';
import { MemoryEvidenceLedger } from './ledger.js';
import { memoryWorkspaceExportSchema } from './workspace.js';
import type { MemoryWorkspaceExport } from './workspace.js';
import { evidenceIdempotencyKey, validateMemoryCandidate } from './validate.js';
import type { PreparedMemorySource } from './source.js';
import type { EvidenceRecord } from './contracts.js';
import type { EvidenceGap, EvidenceSource } from '../evidence.js';
import type { DeferredMemoryRecord, MemoryV1SourceBatch } from './organizer.js';

type SourceLocation = NonNullable<ReturnType<PreparedMemorySource['canonicalRefs']['get']>>;
interface SourceProof {
  record?: EvidenceRecord; canonical?: SourceLocation; attachmentOrder?: string[];
  attachmentRefs?: { sourceId: string; assetId: string }[];
}
interface DeferredObligation extends DeferredMemoryRecord, SourceProof {}
interface DeferredSource {
  source: EvidenceSource; deferred: DeferredObligation[]; gaps: EvidenceGap[];
  /** 部分已覆盖但来源仍报缺口时，继续保存原定位，不能随 deferred 解除而丢失。 */
  gapRecords?: SourceProof[];
}
const sourceLocation = (value: SourceLocation) => [value.contextId, value.runId, value.recordId, value.canonicalIdentity];
function matchesMessage(canonical: SourceLocation, messageId: string): boolean {
  if (canonical.recordId === messageId) return true;
  // Core 的原生消息定位是 [业务定位 JSON, 部件序号]，不按文本或模糊 ID 配对。
  try {
    const [key, ordinal] = JSON.parse(canonical.recordId) as [string, number];
    const location = JSON.parse(key) as unknown[];
    return Number.isInteger(ordinal) && location[0] === canonical.contextId && location[1] === canonical.runId && location[2] === messageId;
  } catch { return false; }
}
function matchesSource(proof: SourceProof, source: PreparedMemorySource, record: EvidenceRecord): boolean {
  const old = proof.record, canonical = source.canonicalRefs.get(record.id), content = source.contents.get(record.contentRef);
  return !!old && !!canonical && !!content?.partBindings &&
    (proof.canonical ? JSON.stringify(sourceLocation(proof.canonical)) === JSON.stringify(sourceLocation(canonical)) : evidenceIdempotencyKey(old) === canonical.canonicalIdentity) && old.id === record.id &&
    old.contentRef === record.contentRef && old.contentHash === record.contentHash &&
    JSON.stringify(old.coverage.parts.map(part => part.key).sort()) === JSON.stringify(record.coverage.parts.map(part => part.key).sort()) &&
    (!proof.attachmentOrder || JSON.stringify(proof.attachmentOrder) === JSON.stringify(content.attachmentOrder)) &&
    old.attachments.every(attachment => record.attachments.some(item => JSON.stringify(item) === JSON.stringify(attachment))) &&
    (proof.attachmentRefs ?? []).every(ref => source.attachmentRefs.get(ref.sourceId)?.assetId === ref.assetId);
}

export const MEMORY_V1_FORMAT = 'shittimchest-memory-v1' as const;
export interface MemoryV1Head {
  id: string; filesDirectory: string; generation: number;
  format?: typeof MEMORY_V1_FORMAT; manifestHash?: string; parentVersionId?: string | null; versionIndex?: string;
  source: { contextId: string; runId: string; sequence: number } | null;
}
export interface MemoryV1RecoveryPlan {
  targetVersionId: string; expectedHead: string; expectedProcessingHead: string | null; cutoff: string;
  targetManifestHash: string; headManifestHash: string;
  requiredEvidenceIds: string[];
  pendingSourceEvidenceIds: string[];
  pendingSourceRuns: string[];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function compareMemoryV1Time(a: string, b: string): number {
  const seconds = Math.floor(Date.parse(a) / 1000) - Math.floor(Date.parse(b) / 1000);
  if (seconds) return seconds;
  const fraction = (value: string) => /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  const left = fraction(a), right = fraction(b), width = Math.max(left.length, right.length);
  return left.padEnd(width, '0') < right.padEnd(width, '0') ? -1 : left.padEnd(width, '0') > right.padEnd(width, '0') ? 1 : 0;
}

/** 只保存同一连接上的可信锚和发布时基线；发布权仍属于 ProjectMemory.operation。 */
export class MemoryV1VersionIndex {
  constructor(private readonly db: DatabaseSync, private readonly directory: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_v1_versions (
      id TEXT PRIMARY KEY, anchor_json TEXT NOT NULL, baseline_json TEXT NOT NULL,
      baseline_hash TEXT NOT NULL, published_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_v1_processing (
      job_id TEXT PRIMARY KEY, source_json TEXT NOT NULL, result_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_v1_deferred (run_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_v1_collection_refs (
      context_id TEXT NOT NULL, scope_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
      PRIMARY KEY(context_id,scope_id,evidence_id)
    );
    CREATE TABLE IF NOT EXISTS memory_v1_processing_head (
      slot INTEGER PRIMARY KEY CHECK(slot=1), job_id TEXT NOT NULL, version_id TEXT NOT NULL,
      manifest_hash TEXT NOT NULL, result_hash TEXT NOT NULL, scope_id TEXT NOT NULL
    );`);
  }
  private row(id: string) {
    const row = this.db.prepare('SELECT * FROM memory_v1_versions WHERE id=?').get(id);
    if (!row) throw new AppError('memory_version_unindexed', 409);
    const raw = String(row.baseline_json);
    if (digest(raw) !== row.baseline_hash) throw new AppError('memory_version_baseline_mismatch', 409);
    const previousEntries = z.array(memoryEntrySchema).parse(JSON.parse(raw));
    const anchor = JSON.parse(String(row.anchor_json)) as MemoryVersionAnchor;
    if (anchor.version.id !== id) throw new AppError('memory_version_identity_mismatch', 409);
    return { anchor, previousEntries };
  }
  read(id: string): MemoryVersionRead {
    const { anchor, previousEntries } = this.row(id);
    // 路径只从已校验 ID 计算，不采信数据库或文件自报的任意目录。
    memoryEntrySchema.options[0].shape.id.parse(id);
    return new MemoryVersionFiles(path.join(this.directory, 'versions', id)).read(anchor, previousEntries);
  }
  readHead(head: MemoryV1Head): MemoryVersionRead {
    if (head.format !== MEMORY_V1_FORMAT || head.versionIndex !== head.id || head.filesDirectory !== path.join(this.directory, 'versions', head.id)) throw new AppError('memory_version_pointer_invalid', 409);
    const value = this.read(head.id);
    if (head.manifestHash !== value.manifestHash || head.generation !== value.manifest.generation || head.parentVersionId !== value.manifest.parentVersionId) throw new AppError('memory_version_pointer_invalid', 409);
    return value;
  }
  record(version: MemoryVersionRead): void {
    const anchor: MemoryVersionAnchor = { manifestHash: version.manifestHash, version: { id: version.manifest.id, parentVersionId: version.manifest.parentVersionId, generation: version.manifest.generation } };
    const baseline = JSON.stringify(version.workspace.candidate.previousEntries);
    this.db.prepare('INSERT INTO memory_v1_versions VALUES(?,?,?,?,?)').run(version.manifest.id, JSON.stringify(anchor), baseline, digest(baseline), version.manifest.auditedAt);
  }
  processed(jobId: string, source: unknown, result: unknown): void {
    this.db.prepare('INSERT INTO memory_v1_processing VALUES(?,?,?)').run(jobId, JSON.stringify(source), JSON.stringify(result));
  }
  /** 正文版本与处理进度分离；只有同一发布事务内的成功结果能成为后续基线。 */
  processingHead(head: MemoryV1Head): { id: string; scopeId: string; resultHash: string; versionId: string; manifestHash: string; workspace: MemoryWorkspaceExport } | null {
    const row = this.db.prepare('SELECT * FROM memory_v1_processing_head WHERE slot=1').get();
    if (!row) return null;
    if (row.version_id !== head.id || row.manifest_hash !== head.manifestHash) throw new AppError('memory_processing_head_conflict', 409);
    const result = this.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(String(row.job_id));
    if (!result || digest(String(result.result_json)) !== row.result_hash) throw new AppError('memory_processing_head_invalid', 409);
    const workspace = memoryWorkspaceExportSchema.parse(JSON.parse(String(result.result_json)).workspace);
    const check = validateMemoryCandidate(workspace.candidate), published = this.readHead(head).workspace.candidate;
    if (!check.valid || !check.coverageComplete || !(['entries', 'entities', 'relations', 'organizations', 'overrides'] as const).every(name =>
      JSON.stringify(workspace.candidate[name]) === JSON.stringify(published[name]))) throw new AppError('memory_processing_head_invalid', 409);
    return { id: String(row.job_id), scopeId: String(row.scope_id), resultHash: String(row.result_hash), versionId: String(row.version_id), manifestHash: String(row.manifest_hash), workspace };
  }
  assertProcessingHead(expected: { id: string; resultHash: string; versionId: string; manifestHash: string; scopeId: string } | null): void {
    const actual = this.db.prepare('SELECT * FROM memory_v1_processing_head WHERE slot=1').get();
    if (!expected) {
      if (actual) throw new AppError('memory_processing_head_conflict', 409);
      return;
    }
    if (!actual || actual.job_id !== expected.id || actual.result_hash !== expected.resultHash ||
      actual.version_id !== expected.versionId || actual.manifest_hash !== expected.manifestHash || actual.scope_id !== expected.scopeId) throw new AppError('memory_processing_head_conflict', 409);
    const result = this.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(expected.id);
    if (!result || digest(String(result.result_json)) !== expected.resultHash) throw new AppError('memory_processing_head_invalid', 409);
  }
  publishProcessingHead(jobId: string, head: MemoryV1Head, scopeId: string, expected: Parameters<MemoryV1VersionIndex['assertProcessingHead']>[0]): void {
    this.assertProcessingHead(expected);
    const result = this.db.prepare('SELECT result_json FROM memory_v1_processing WHERE job_id=?').get(jobId);
    if (!result || !head.manifestHash) throw new AppError('memory_processing_head_invalid', 409);
    this.db.prepare(`INSERT INTO memory_v1_processing_head VALUES(1,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET
      job_id=excluded.job_id,version_id=excluded.version_id,manifest_hash=excluded.manifest_hash,result_hash=excluded.result_hash,scope_id=excluded.scope_id`)
      .run(jobId, head.id, head.manifestHash, digest(String(result.result_json)), scopeId);
  }
  private deferredSources(): { runId: string; pending: DeferredSource }[] {
    return this.db.prepare('SELECT run_id,body FROM memory_v1_deferred ORDER BY run_id').all()
      .map(row => ({ runId: String(row.run_id), pending: JSON.parse(String(row.body)) as DeferredSource }));
  }
  private saveDeferred(runId: string, pending: DeferredSource): void {
    this.db.prepare('INSERT INTO memory_v1_deferred VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(runId, JSON.stringify(pending));
  }
  /** 未能进账本的记录同样保留不可改写的正文和来源身份，防止补源先污染规范槽。 */
  assertDeferredSource(source: PreparedMemorySource): void {
    for (const { pending } of this.deferredSources()) for (const obligation of pending.deferred) {
      const old = obligation.record, record = source.records.find(row => row.id === obligation.evidenceId);
      if (!old || !record) continue;
      const content = source.contents.get(record.contentRef), canonical = source.canonicalRefs.get(record.id);
      if (evidenceIdempotencyKey(old) !== evidenceIdempotencyKey(record) || old.contentRef !== record.contentRef || old.contentHash !== record.contentHash ||
        JSON.stringify(old.coverage.parts.map(part => part.key).sort()) !== JSON.stringify(record.coverage.parts.map(part => part.key).sort()) ||
        !old.attachments.every(attachment => record.attachments.some(item => JSON.stringify(item) === JSON.stringify(attachment))) ||
        (content && obligation.attachmentOrder && JSON.stringify(content.attachmentOrder) !== JSON.stringify(obligation.attachmentOrder)) ||
        (canonical && obligation.canonical && JSON.stringify(sourceLocation(canonical)) !== JSON.stringify(sourceLocation(obligation.canonical)))) throw new AppError('memory_source_identity_conflict', 409);
    }
  }
  /** 接收阶段只增加义务，失败尝试不能撤销任何既有来源缺口。 */
  acceptDeferred(source: PreparedMemorySource, batch: MemoryV1SourceBatch, scopeId: string): void {
    for (const record of source.records) this.db.prepare('INSERT OR IGNORE INTO memory_v1_collection_refs VALUES(?,?,?)').run(source.source.contextId, scopeId, record.id);
    const old = this.deferredSources().find(row => row.runId === source.source.runId)?.pending;
    if (old && JSON.stringify(old.source) !== JSON.stringify(source.source)) throw new AppError('memory_source_identity_conflict', 409);
    const proof = (record: EvidenceRecord): SourceProof => ({
      record, canonical: source.canonicalRefs.get(record.id), attachmentOrder: source.contents.get(record.contentRef)?.attachmentOrder,
      attachmentRefs: record.coverage.parts.flatMap(part => {
        const ref = source.attachmentRefs.get(part.key);
        return ref ? [{ sourceId: part.key, assetId: ref.assetId }] : [];
      }),
    });
    const additions = batch.deferred.map(record => ({ ...record, ...proof(source.records.find(row => row.id === record.evidenceId)!) }));
    const unique = <T>(rows: T[]) => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];
    const gapRecords = source.records.map(proof).filter(row => row.canonical && source.gaps.some(gap =>
      gap.contextId === row.canonical!.contextId && (gap.runId ?? source.source.runId) === row.canonical!.runId && gap.messageId &&
      (matchesMessage(row.canonical!, gap.messageId) || row.attachmentRefs!.some(ref => ref.assetId === gap.messageId))));
    this.saveDeferred(source.source.runId, { source: source.source, deferred: unique([...(old?.deferred ?? []), ...additions]), gaps: unique([...(old?.gaps ?? []), ...source.gaps]),
      gapRecords: unique([...(old?.gapRecords ?? []), ...gapRecords]) });
  }
  /** 已覆盖但仍有精确来源义务的记录必须重新送审，不能被完成去重吞掉补源证明。 */
  recheckEvidenceIds(): ReadonlySet<string> {
    return new Set(this.deferredSources().flatMap(({ pending }) => [
      ...pending.deferred.map(row => row.evidenceId), ...(pending.gapRecords ?? []).flatMap(row => row.record ? [row.record.id] : []),
    ]));
  }
  /** 仅发布后按规范来源及原部分集合解除；空 gaps、缺席记录或模型判断均不是证明。 */
  resolveDeferred(source: PreparedMemorySource, batch: MemoryV1SourceBatch): void {
    for (const { runId, pending } of this.deferredSources()) {
      const proofs = [...(pending.gapRecords ?? []), ...pending.deferred];
      pending.deferred = pending.deferred.filter(obligation => !batch.records.some(record => matchesSource(obligation, source, record)));
      const matchesGap = (record: EvidenceRecord, gap: EvidenceGap) => {
        const canonical = source.canonicalRefs.get(record.id);
        if (!gap.messageId || !canonical || canonical.contextId !== gap.contextId || canonical.runId !== (gap.runId ?? pending.source.runId)) return false;
        if (matchesMessage(canonical, gap.messageId)) return true;
        if (gap.reason !== 'missing-source') return false;
        const content = source.contents.get(record.contentRef);
        // 附件读取失败使用原 assetId。必须属于原规范记录的原部件，并有实际内容与绑定证明。
        return proofs.some(proof => matchesSource(proof, source, record) && record.attachments.some(attachment => {
          const ref = source.attachmentRefs.get(attachment.sourceId);
          if (ref?.assetId !== gap.messageId || !proof.record!.coverage.parts.some(part => part.key === attachment.sourceId)) return false;
          const bytes = content?.attachments.find(item => item.sourceId === attachment.sourceId)?.bytes;
          return !!bytes && bytes.byteLength === attachment.bytes && createHash('sha256').update(bytes).digest('hex') === attachment.sha256 &&
            record.coverage.parts.some(part => part.key === attachment.sourceId && part.status === 'available') &&
            !!content?.partBindings?.some(binding => binding.partKey === attachment.sourceId && binding.slots.some(slot => slot.kind === 'attachment' && slot.ref === attachment.sourceId));
        }));
      };
      pending.gaps = pending.gaps.filter(gap => {
        if (!gap.messageId) return true;
        // 同一消息仍有任一缺口或未选中的部分时，不用完整子集替整条消息作证。
        if (source.gaps.some(item => item.contextId === gap.contextId && (item.runId ?? source.source.runId) === (gap.runId ?? pending.source.runId) && item.messageId === gap.messageId)) return true;
        if (pending.deferred.some(item => item.record && matchesGap(item.record, gap))) return true;
        const matched = source.records.filter(record => matchesGap(record, gap));
        return !matched.length || matched.some(record => !batch.records.some(selected => selected.id === record.id));
      });
      pending.gapRecords = pending.gaps.length ? [...new Map(proofs.map(proof => [JSON.stringify(proof), proof])).values()] : [];
      this.saveDeferred(runId, pending);
    }
  }
  pendingContext(contextId: string): { records: number; gaps: number } {
    const pending = this.deferredSources().filter(row => row.pending.source.contextId === contextId).map(row => row.pending);
    return { records: pending.reduce((sum, row) => sum + new Set(row.deferred.map(item => item.evidenceId)).size, 0), gaps: pending.reduce((sum, row) => sum + row.gaps.length, 0) };
  }
  /** 同一规范资料在本轮确实复核后，可结清它原来登记的范围；未入候选的旧来源不受影响。 */
  coverageTargets(scopeId: string, decisions: MemoryWorkspaceExport['candidate']['coverage']) {
    const refs = this.db.prepare('SELECT DISTINCT scope_id,evidence_id FROM memory_v1_collection_refs WHERE scope_id<>?').all(scopeId);
    return [{ scopeId, decisions }, ...[...new Set(refs.map(row => String(row.scope_id)))].map(scope => {
      const ids = new Set(refs.filter(row => row.scope_id === scope).map(row => String(row.evidence_id)));
      return { scopeId: scope, decisions: decisions.filter(decision => ids.has(decision.ref.evidenceId)) };
    })].filter(target => target.decisions.length > 0);
  }
  hasPendingCoverage(contextId: string, cutoff: string): boolean {
    const ledger = new MemoryEvidenceLedger(this.db);
    const refs = this.db.prepare('SELECT scope_id,evidence_id FROM memory_v1_collection_refs WHERE context_id=?').all(contextId);
    for (const scope of new Set(refs.map(row => String(row.scope_id)))) {
      const ids = new Set(refs.filter(row => row.scope_id === scope).map(row => String(row.evidence_id)));
      if (ledger.listPending(scope, cutoff).some(row => ids.has(row.receipt.evidence.id))) return true;
    }
    return false;
  }
  latestCutoff(): string | null {
    const times = this.db.prepare("SELECT json_extract(result_json,'$.workspace.candidate.auditedAt') AS at FROM memory_v1_processing").all().map(row => z.iso.datetime({ offset: true }).parse(row.at));
    return times.sort(compareMemoryV1Time).at(-1) ?? null;
  }
  list() {
    return this.db.prepare('SELECT id,published_at FROM memory_v1_versions ORDER BY rowid').all().map(row => ({ id: String(row.id), publishedAt: String(row.published_at) }));
  }
  diff(from: string, to: string) {
    const old = this.read(from).workspace.candidate, next = this.read(to).workspace.candidate;
    const changes: { collection: string; id: string; before: unknown; after: unknown }[] = [];
    for (const collection of ['entries', 'entities', 'relations', 'organizations'] as const) {
      const before = new Map(old[collection].map(row => [row.id, row]));
      const after = new Map(next[collection].map(row => [row.id, row]));
      for (const id of new Set([...before.keys(), ...after.keys()])) if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) changes.push({ collection, id, before: before.get(id) ?? null, after: after.get(id) ?? null });
    }
    return { from, to, changes };
  }
  recovery(head: MemoryV1Head, targetVersionId: string, cutoff: string): MemoryV1RecoveryPlan {
    z.iso.datetime({ offset: true }).parse(cutoff);
    const current = this.readHead(head), target = this.read(targetVersionId), processing = this.processingHead(head);
    const latestCutoff = this.latestCutoff();
    if (latestCutoff && compareMemoryV1Time(cutoff, latestCutoff) < 0) throw new AppError('memory_recovery_cutoff_conflict', 409);
    if (target.manifest.generation > current.manifest.generation || compareMemoryV1Time(cutoff, current.manifest.auditedAt) < 0 || (processing?.workspace ?? current.workspace).candidate.evidence.some(record => compareMemoryV1Time(record.visibleAfter, cutoff) > 0)) throw new AppError('memory_recovery_cutoff_conflict', 409);
    const old = new Set(target.workspace.candidate.evidence.map(record => record.id));
    const ledger = new MemoryEvidenceLedger(this.db);
    // no-op 和失败任务的真实来源也在账本中，不能只找当前 manifest 已承载的材料。
    const requiredEvidenceIds = this.db.prepare('SELECT id FROM memory_v1_evidence ORDER BY id').all().map(row => ledger.readEvidence(String(row.id))!).filter(record => compareMemoryV1Time(record.visibleAfter, cutoff) <= 0 && !old.has(record.id)).map(record => record.id);
    const pendingSourceEvidenceIds = new Set<string>(), pendingSourceRuns = new Set<string>();
    for (const row of this.db.prepare('SELECT run_id,body FROM memory_v1_deferred').all()) {
      const pending = JSON.parse(String(row.body)) as { deferred: { evidenceId: string; visibleAfter?: string }[]; gaps: unknown[] };
      for (const record of pending.deferred) if (!record.visibleAfter || compareMemoryV1Time(record.visibleAfter, cutoff) <= 0) pendingSourceEvidenceIds.add(record.evidenceId);
      if (pending.gaps.length) pendingSourceRuns.add(String(row.run_id));
    }
    return { targetVersionId, expectedHead: head.id, expectedProcessingHead: processing?.id ?? null, cutoff, targetManifestHash: target.manifestHash, headManifestHash: current.manifestHash,
      requiredEvidenceIds, pendingSourceEvidenceIds: [...pendingSourceEvidenceIds].sort(), pendingSourceRuns: [...pendingSourceRuns].sort() };
  }
}
