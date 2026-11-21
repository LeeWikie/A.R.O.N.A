import { createHash } from 'node:crypto';
import type { Store, AcceptedSignal } from '../../store.js';
import type { TaskRecord } from '../../runtime-store.js';
import type { SQLOutputValue } from 'node:sqlite';
import { AppError } from '../../domain.js';
import { MemoryEvidenceLedger } from './ledger.js';
import type { PreparedMemorySource, NativeSourceLocation } from './source.js';
import type { RecentRecordInput } from './recent.js';
import { evidenceIdempotencyKey } from './validate.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const key = (signalId: string, runId: string) => hash(JSON.stringify([signalId, runId]));
export interface MemoryV1SourceReference extends NativeSourceLocation { canonicalIdentity: string; evidenceId: string }
export interface MemoryV1IntakeStatus {
  accepted: number; runs: number; materialized: number; pendingSource: number;
  diagnostics: { runId: string; code: string; gaps: number; unmapped: number }[];
  diagnosticsTruncated: boolean;
}

/** 资料义务账本只跟随 Store 的真实受理，不承载任务调度或执行状态。 */
export class MemoryV1Intake {
  readonly ledger: MemoryEvidenceLedger;
  constructor(private readonly store: Store, readonly scopeId: string) {
    this.ledger = new MemoryEvidenceLedger(store.db);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_v1_intake (
        id TEXT PRIMARY KEY, signal_id TEXT NOT NULL, run_id TEXT NOT NULL,
        context_id TEXT NOT NULL, source_context_id TEXT NOT NULL, body_hash TEXT NOT NULL,
        received_at TEXT NOT NULL, registered_at TEXT NOT NULL, UNIQUE(signal_id,run_id)
      );
      CREATE TABLE IF NOT EXISTS memory_v1_intake_native (intake_id TEXT PRIMARY KEY, native_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_v1_source_runs (
        run_id TEXT PRIMARY KEY, state TEXT NOT NULL, code TEXT NOT NULL,
        gaps INTEGER NOT NULL DEFAULT 0, unmapped INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_v1_source_issues (run_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_v1_source_batches (run_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_v1_source_refs (
        evidence_id TEXT PRIMARY KEY, location_json TEXT NOT NULL
      );
    `);
  }
  accept = (receipt: AcceptedSignal): void => {
    if (receipt.signal.status !== 'accepted') throw new AppError('memory_intake_not_accepted', 409);
    this.recordReceipt(receipt);
  };
  private recordReceipt({ signal, run }: AcceptedSignal): void {
    const row = this.store.db.prepare('SELECT body FROM signals WHERE id=?').get(signal.id);
    const admitted = signal.status === 'accepted' || (signal.status === 'interrupted' && run.status === 'interrupted');
    if (!row || !signal.nativeSignalId || !admitted || signal.runId !== run.id || !['wake', 'deliver'].includes(signal.action ?? '')) throw new AppError('memory_intake_not_accepted', 409);
    const values = [key(signal.id, run.id), signal.id, run.id, run.contextId, signal.contextId, hash(String(row.body)), signal.createdAt] as const;
    const canonical = this.store.db.prepare('SELECT * FROM memory_v1_intake WHERE signal_id=? ORDER BY rowid LIMIT 1').get(signal.id);
    if (canonical && (canonical.body_hash !== values[5] || canonical.source_context_id !== signal.contextId || canonical.received_at !== signal.createdAt)) throw new AppError('memory_intake_binding_conflict', 409);
    const existing = this.store.db.prepare('SELECT * FROM memory_v1_intake WHERE id=?').get(values[0]);
    if (existing) {
      if (existing.signal_id !== signal.id || existing.run_id !== run.id || existing.context_id !== run.contextId || existing.source_context_id !== signal.contextId || existing.body_hash !== values[5] || existing.received_at !== signal.createdAt) throw new AppError('memory_intake_binding_conflict', 409);
    } else this.store.db.prepare('INSERT INTO memory_v1_intake VALUES(?,?,?,?,?,?,?,?)').run(...values, new Date().toISOString());
    const nativeHash = hash(JSON.stringify([signal.nativeSignalId, signal.action]));
    const alias = this.store.db.prepare('SELECT native_hash FROM memory_v1_intake_native WHERE intake_id=?').get(values[0]);
    if ((existing && !alias) || (alias && alias.native_hash !== nativeHash)) throw new AppError('memory_intake_binding_conflict', 409);
    this.store.db.prepare('INSERT OR IGNORE INTO memory_v1_intake_native VALUES(?,?)').run(values[0], nativeHash);
    this.store.db.prepare("INSERT OR IGNORE INTO memory_v1_source_runs(run_id,state,code) VALUES(?,'pending-source','awaiting-stable-source')").run(run.id);
  };
  /** 受理账本是权威；不以 Ledger 的 pending 数量代替重启对账。 */
  reconcileAccepted(): void {
    this.store.transaction(() => {
      for (const row of this.store.db.prepare("SELECT id FROM signals WHERE status IN ('accepted','interrupted') AND native_id IS NOT NULL AND run_id IS NOT NULL AND action IN ('wake','deliver')").all()) {
        const signal = this.store.getSignal(String(row.id))!;
        const run = this.store.getRun(signal.runId!);
        if (!run || (signal.status === 'interrupted' && run.status !== 'interrupted')) continue;
        // 中断后仅还原资料登记事实，不改写原始 Store 收据。
        try { this.recordReceipt({ signal, run }); }
        catch (error) {
          if (!(error instanceof AppError) || error.code !== 'memory_intake_binding_conflict') throw error;
          this.blocked(run.id, error.code);
        }
      }
    });
  }
  /** 使用受理当时的别名绑定；根原始信号在重试后的当前 nativeId 不能替代旧收据。 */
  signalAliases(signalId: string, runId: string): string[] {
    return this.store.db.prepare('SELECT i.signal_id FROM memory_v1_intake i JOIN memory_v1_intake_native a ON a.intake_id=i.id WHERE i.run_id=? AND a.native_hash=(SELECT native_hash FROM memory_v1_intake_native WHERE intake_id=?)').all(runId, key(signalId, runId)).map(row => String(row.signal_id));
  }
  pendingSourceRuns(): string[] { return this.store.db.prepare("SELECT run_id FROM memory_v1_source_runs WHERE state='pending-source' ORDER BY rowid").all().map(row => String(row.run_id)); }
  stableRuns(): string[] {
    return this.store.db.prepare("SELECT DISTINCT i.run_id FROM memory_v1_intake i JOIN runs r ON r.id=i.run_id WHERE r.status!='running' ORDER BY r.rowid").all().map(row => String(row.run_id));
  }
  blocked(runId: string, code: string, gaps?: number, unmapped?: number): void {
    this.store.db.prepare("UPDATE memory_v1_source_runs SET state='pending-source',code=?,gaps=COALESCE(?,gaps),unmapped=COALESCE(?,unmapped) WHERE run_id=?").run(code, gaps ?? null, unmapped ?? null, runId);
  }
  private setting<T>(id: string, fallback: T): T {
    if (!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_settings'").get()) return fallback;
    const row = this.store.db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as T : fallback;
  }
  /** 只读复核历史尝试；当前 task.attempt 及 execution binding 可以已推进到下一次执行。 */
  private validateAttempt(signalId: string, runId: string, contextId: string, expectedTaskId?: string): void {
    const owners = this.setting<Record<string, string>>('task-signal-owners', {});
    const event = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_events'").get()
      ? this.store.db.prepare("SELECT task_id FROM runtime_events WHERE kind='input' AND event_key=?").get(`input:${signalId}`) : undefined;
    const taskId = expectedTaskId ?? (typeof event?.task_id === 'string' ? event.task_id : owners[signalId]);
    if (!taskId) return;
    const row = this.store.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId);
    const task = row && JSON.parse(String(row.body)) as TaskRecord | undefined;
    const attempt = this.setting<Record<string, number>>('task-signal-attempts', {})[signalId];
    const runAttempt = this.setting<Record<string, number>>(`task-run-attempts:${taskId}`, {})[runId];
    if (owners[signalId] !== taskId || !task || task.contextId !== contextId || !task.runIds.includes(runId)
      || !Number.isSafeInteger(attempt) || attempt! < 1 || attempt !== runAttempt || attempt! > (task.attempt ?? 1)) throw new AppError('memory_intake_binding_conflict', 409);
  }
  /** 完成证明必须在写入材料的同一事务内重验，不能依赖异步补源前的诊断。 */
  private validateReceipt(receipt: Record<string, SQLOutputValue>): void {
    const signalId = String(receipt.signal_id); const runId = String(receipt.run_id);
    const signal = this.store.getSignal(signalId); const run = this.store.getRun(runId);
    const row = this.store.db.prepare('SELECT body FROM signals WHERE id=?').get(signalId);
    const alias = this.store.db.prepare('SELECT native_hash FROM memory_v1_intake_native WHERE intake_id=?').get(String(receipt.id));
    const conflict = () => new AppError('memory_intake_binding_conflict', 409);
    if (!signal || !run || !row || !alias || receipt.id !== key(signalId, runId) || receipt.context_id !== run.contextId
      || signal.id !== signalId || receipt.source_context_id !== signal.contextId || receipt.received_at !== signal.createdAt
      || receipt.body_hash !== hash(String(row.body))) throw conflict();
    if (signal.runId === runId) {
      if (!signal.nativeSignalId || !['wake', 'deliver'].includes(signal.action ?? '')
        || !(signal.status === 'accepted' || (signal.status === 'interrupted' && run.status === 'interrupted'))
        || alias.native_hash !== hash(JSON.stringify([signal.nativeSignalId, signal.action]))) throw conflict();
      this.validateAttempt(signalId, runId, run.contextId);
      return;
    }
    // 只有根来源可以重新受理到新 run。旧执行别名及其受理哈希证明旧 run，
    // 新根收据证明当前绑定；不能拿当前 nativeId 回填旧收据，也不凭共享 nativeId 猜根身份。
    const binding = this.store.executionBinding(signalId);
    const current = signal.runId && this.store.db.prepare('SELECT * FROM memory_v1_intake WHERE id=?').get(key(signalId, signal.runId));
    if (!binding || binding.sourceSignalId !== signalId || binding.contextId !== run.contextId || binding.bodyHash !== receipt.body_hash || !current) throw conflict();
    this.validateReceipt(current);
    const aliases = this.store.db.prepare('SELECT i.* FROM memory_v1_intake i JOIN memory_v1_intake_native a ON a.intake_id=i.id WHERE i.run_id=? AND i.signal_id!=? AND a.native_hash=?').all(runId, signalId, String(alias.native_hash));
    const execution = aliases.filter(candidate => this.store.getSignal(String(candidate.signal_id))?.runId === runId);
    if (execution.length !== 1) throw conflict();
    this.validateReceipt(execution[0]!);
    this.validateAttempt(String(execution[0]!.signal_id), runId, run.contextId, binding.taskId);
  }
  validateBindings(runId: string): void {
    const receipts = this.store.db.prepare('SELECT * FROM memory_v1_intake WHERE run_id=?').all(runId);
    if (!receipts.length) throw new AppError('memory_intake_binding_conflict', 409);
    for (const receipt of receipts) this.validateReceipt(receipt);
  }
  materialize(runId: string, source: PreparedMemorySource): void {
    const run = this.store.getRun(runId);
    if (!run || run.status === 'running' || source.source.runId !== runId || source.source.contextId !== run.contextId) throw new AppError('memory_intake_source_mismatch', 409);
    let unmapped = 0;
    this.store.transaction(() => {
      this.validateBindings(runId);
      const missing: { evidenceId: string; contentRef: string }[] = [];
      for (const record of source.records) {
        const content = source.contents.get(record.contentRef);
        const location = source.canonicalRefs.get(record.id);
        if (!content?.partBindings || !location) { unmapped++; missing.push({ evidenceId: record.id, contentRef: record.contentRef }); continue; }
        this.ledger.putEvidence(record, { body: content.codec === 'utf8' ? Buffer.from(content.body).toString('utf8') : content.body, attachments: content.attachments, partBindings: content.partBindings });
        this.ledger.registerReceipt({ id: `receipt:${hash(JSON.stringify([this.scopeId, record.id]))}`, scopeId: this.scopeId, evidence: record, partBindings: content.partBindings });
        const encoded = JSON.stringify(location);
        const previous = this.store.db.prepare('SELECT location_json FROM memory_v1_source_refs WHERE evidence_id=?').get(record.id);
        if (previous && previous.location_json !== encoded) {
          const prior = JSON.parse(String(previous.location_json)) as NativeSourceLocation;
          const signalId = /^signal:(.+):(user-statement|task-request)$/.exec(location.recordId)?.[1];
          const first = signalId && prior.runId ? this.store.db.prepare('SELECT body_hash FROM memory_v1_intake WHERE id=?').get(key(signalId, prior.runId)) : undefined;
          const next = signalId && location.runId ? this.store.db.prepare('SELECT body_hash FROM memory_v1_intake WHERE id=?').get(key(signalId, location.runId)) : undefined;
          // 根任务重试可再次受理同一原始信号；保留首次规范定位，不把新执行别名洗成新事实。
          if (!first || !next || first.body_hash !== next.body_hash || JSON.stringify({ ...prior, runId: null }) !== JSON.stringify({ ...location, runId: null })) throw new AppError('memory_intake_origin_conflict', 409);
        }
        this.store.db.prepare('INSERT OR IGNORE INTO memory_v1_source_refs VALUES(?,?)').run(record.id, encoded);
      }
      // 批次保留规范证据集合和执行观察，后续仍由既有单写者消费；不是覆盖完成证明。
      this.store.db.prepare('INSERT INTO memory_v1_source_batches VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(runId, JSON.stringify({ source: source.source, evidenceIds: source.records.map(record => record.id), observations: source.observations }));
      this.store.db.prepare('INSERT INTO memory_v1_source_issues VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(runId, JSON.stringify({ gaps: source.gaps, unmapped: missing }));
      const pending = source.gaps.length > 0 || unmapped > 0;
      this.store.db.prepare('UPDATE memory_v1_source_runs SET state=?,code=?,gaps=?,unmapped=? WHERE run_id=?').run(pending ? 'pending-source' : 'materialized', pending ? 'source-incomplete' : 'awaiting-organization', source.gaps.length, unmapped, runId);
    });
  }
  references(): MemoryV1SourceReference[] {
    return this.store.db.prepare('SELECT * FROM memory_v1_source_refs ORDER BY rowid').all().map(row => {
      const location = JSON.parse(String(row.location_json)) as NativeSourceLocation & { canonicalIdentity: string };
      const evidenceId = String(row.evidence_id); const evidence = this.ledger.readEvidence(evidenceId);
      // 来源索引只是查询加速，不能自行改变 Ledger 已验证的规范身份或范围。
      if (!evidence || typeof location.contextId !== 'string' || typeof location.recordId !== 'string'
        || this.scopeId !== `native:${evidence.origin.namespace}` || evidence.origin.system !== 'native'
        || location.canonicalIdentity !== evidenceIdempotencyKey(evidence)
        || evidence.origin.contextRef !== `context:${hash(JSON.stringify(location.contextId))}`
        || evidence.origin.recordRef !== `record:${hash(JSON.stringify(location.recordId))}`
        || evidence.origin.sourceRef !== `source:${hash(JSON.stringify(location.recordId.startsWith('signal:') ? [location.contextId, location.recordId] : [location.contextId, location.runId]))}`
        || location.receivedAt !== evidence.receivedAt || location.visibleAfter !== evidence.visibleAfter) throw new AppError('memory_intake_origin_conflict', 409);
      return { ...location, evidenceId };
    });
  }
  recentRecords(): RecentRecordInput[] {
    return this.references().map(ref => {
      const evidence = this.ledger.readEvidence(ref.evidenceId);
      if (!evidence) throw new AppError('memory_intake_evidence_missing', 409);
      let originalTextBytes: Uint8Array | null = null;
      try { const body = this.ledger.readContent(evidence.id); originalTextBytes = typeof body === 'string' ? Buffer.from(body) : body; } catch { /* 投影显式保留缺正文。 */ }
      const attachments: NonNullable<RecentRecordInput['attachments']>[number][] = [];
      for (const attachment of evidence.attachments) {
        try { const bytes = this.ledger.readContent(evidence.id, attachment.sourceId); if (bytes instanceof Uint8Array) attachments.push({ sourceId: attachment.sourceId, mediaType: attachment.mediaType, bytes }); } catch { /* 投影负责说明未取得的附件。 */ }
      }
      return { evidence, originalTextBytes, attachments };
    });
  }
  status(): MemoryV1IntakeStatus {
    const counts = this.store.db.prepare("SELECT COUNT(*) AS runs, SUM(state='materialized') AS materialized,SUM(state='pending-source') AS pending FROM memory_v1_source_runs").get()!;
    const rows = this.store.db.prepare("SELECT * FROM memory_v1_source_runs WHERE state='pending-source' ORDER BY rowid DESC LIMIT 51").all();
    return { accepted: Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_intake').get()!.n), runs: Number(counts.runs), materialized: Number(counts.materialized ?? 0), pendingSource: Number(counts.pending ?? 0), diagnostics: rows.slice(0, 50).map(row => ({ runId: String(row.run_id), code: String(row.code), gaps: Number(row.gaps), unmapped: Number(row.unmapped) })), diagnosticsTruncated: rows.length > 50 };
  }
}
