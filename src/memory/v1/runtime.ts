import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../domain.js';
import type { BackgroundTask } from '@mastra/core/background-tasks';
import type { RuntimeStore } from '../../runtime-store.js';
import type { ProjectMemory, MemoryJob } from '../index.js';
import type { PreparedMemoryContextPolicy } from './binding.js';
import type { MemoryV1RecoveryPlan } from './version-index.js';
import type { PreparedMemorySource } from './source.js';
import type { MemoryV1Model, MemoryV1ProviderOptions } from './review.js';

// 摘要只依赖资料值，不依赖 TypedArray 的 backing store 或对象共享布局。
function canonical(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('base64') };
  if (value instanceof Map) return [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, item]) => [key, canonical(item)]);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export interface NativeMemoryV1Host {
  enabled(): boolean;
  processed?(runId: string): void;
  policy(): PreparedMemoryContextPolicy;
  scopeId: string;
  sourceScope?(runId: string): string;
  prepare(runId: string, recovery?: MemoryV1RecoveryPlan): Promise<PreparedMemorySource>;
  model(runId: string): { model: MemoryV1Model; options: MemoryV1ProviderOptions; identity: string; supportedImageMediaTypes: readonly string[];
    contextWindow?: number; maxOutputTokens?: number };
  task(nativeTaskId: string): Promise<BackgroundTask | null>;
  tasks(runId: string): Promise<BackgroundTask[]>;
  ownerId: string;
  cancel(nativeTaskId: string): Promise<void>;
  enqueue(runId: string, key: string, jobId: string, execute: (signal?: AbortSignal) => Promise<unknown>): Promise<string>;
}

/** 原生 manager 持有执行身份；此处只互斥既有单写者，不另建执行队列或重试器。 */
export class NativeMemoryV1Runtime {
  private readonly admissions = new Map<string, Promise<MemoryJob>>();
  private writer: Promise<unknown> = Promise.resolve();
  private readonly coldTerminalJobs: Set<string>;
  get admitting() { return this.admissions.size > 0; }
  constructor(private readonly store: RuntimeStore, private readonly memory: ProjectMemory, private readonly host: NativeMemoryV1Host) {
    this.coldTerminalJobs = new Set(memory.jobs().filter(job => !['pending', 'running'].includes(job.status)).map(job => job.id));
  }

  async queue(runId: string, force = false, recovery?: MemoryV1RecoveryPlan): Promise<MemoryJob> {
    return this.queueWithBudget(runId, force, recovery, 7);
  }
  private async queueWithBudget(runId: string, force: boolean, recovery: MemoryV1RecoveryPlan | undefined, remaining: number): Promise<MemoryJob> {
    const key = recovery ? `recovery:${recovery.targetVersionId}:${recovery.cutoff}` : runId;
    const existing = this.admissions.get(key); if (existing) return existing;
    if (recovery && this.admissions.size) throw new AppError('memory_writer_busy', 409);
    const admission = this.admit(runId, force, recovery, remaining); this.admissions.set(key, admission);
    try { return await admission; } finally { this.admissions.delete(key); }
  }
  /** 只投影原生终态；缺失、读取失败及仍存活的任务都不能推断为取消。 */
  settleNativeTask(task: BackgroundTask) {
    if (task.toolName !== 'organize-memory-v1' || task.agentId !== 'memory-organizer' || !task.toolCallId.startsWith('memory-v1:') ||
      !['completed', 'failed', 'cancelled', 'timed_out'].includes(task.status)) return;
    const job = this.memory.jobs().find(row => row.id === task.args.jobId);
    if (!job || job.runId !== task.runId || job.nativeTaskId !== task.id) return;
    // 原生完成不等于记忆发布成功；未取得发布回执的资料仍需重整。
    this.memory.interruptNativeJob(job, `memory_native_${task.status}`);
  }
  async reconcile() {
    for (const job of this.memory.jobs()) {
      if (!['pending', 'running'].includes(job.status) && !this.coldTerminalJobs.has(job.id)) continue;
      if (this.coldTerminalJobs.has(job.id) && !['pending', 'running'].includes(job.status)) {
        const matches = (value: BackgroundTask) => (!job.nativeTaskId || value.id === job.nativeTaskId) && value.runId === job.runId && value.toolName === 'organize-memory-v1' && value.agentId === 'memory-organizer' && value.toolCallId.startsWith('memory-v1:') && value.args.jobId === job.id;
        const bound = job.nativeTaskId ? await this.host.task(job.nativeTaskId) : null;
        const tasks = job.nativeTaskId ? (bound ? [bound] : []) : (await this.host.tasks(job.runId)).filter(matches);
        if (tasks.some(task => !matches(task) || task.ownerId === this.host.ownerId)) { this.coldTerminalJobs.delete(job.id); continue; }
        for (const task of tasks) {
          if (['pending', 'running'].includes(task.status)) {
            const current = await this.host.task(task.id);
            if (current && matches(current) && current.status === task.status && current.ownerId === task.ownerId && current.leaseExpiresAt?.getTime() === task.leaseExpiresAt?.getTime()) await this.host.cancel(task.id);
            else { this.coldTerminalJobs.delete(job.id); break; }
          }
        }
        const settled = await Promise.all(tasks.map(task => this.host.task(task.id)));
        if (settled.every(task => task && !['pending', 'running', 'suspended'].includes(task.status))) this.coldTerminalJobs.delete(job.id);
        continue;
      }
      if (!job.nativeTaskId) continue;
      const task = await this.host.task(job.nativeTaskId);
      if (!['pending', 'running'].includes(job.status)) continue;
      if (task) this.settleNativeTask(task);
    }
  }
  private async admit(runId: string, force: boolean, recovery: MemoryV1RecoveryPlan | undefined, remaining: number): Promise<MemoryJob> {
    if (!this.host.enabled()) throw new AppError('memory_disabled', 409);
    await this.reconcile();
    const source = await this.host.prepare(runId, recovery), policy = this.host.policy(), selected = this.host.model(runId);
    const scopeId = this.host.sourceScope?.(runId) ?? this.host.scopeId;
    if (!this.host.enabled()) throw new AppError('memory_disabled', 409);
    const fingerprintOf = (source: PreparedMemorySource) => createHash('sha256').update(JSON.stringify(canonical({ source, ...(scopeId !== this.host.scopeId ? { scopeId } : {}), policy, recovery, model: selected.identity, options: selected.options, supportedImageMediaTypes: selected.supportedImageMediaTypes, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens }))).digest('hex');
    const fingerprint = fingerprintOf(source);
    const setting = `memory-v1-admission:${runId}`;
    const previous = this.store.setting<{ fingerprint: string; jobId: string; complete?: boolean } | null>(setting, null);
    const priorJob = previous && this.memory.jobs().find(job => job.id === previous.jobId);
    // 原生终态不代替同一发布事务中已提交的完整业务回执。
    if (!force && !recovery && previous?.fingerprint === fingerprint && priorJob) {
      if (['pending', 'running'].includes(priorJob.status)) return priorJob;
      if (priorJob.status === 'succeeded') {
        const receipt = this.memory.committedV1Publication(priorJob.id, source.source);
        if (receipt) {
          if (previous.complete !== true) this.store.setSetting(setting, { fingerprint, jobId: priorJob.id, complete: true, publicationKey: receipt.key, cutoff: receipt.cutoff });
          return priorJob;
        }
        if (previous.complete === true) throw new AppError('memory_publication_receipt_unavailable', 409);
      }
    }
    const head = this.memory.version().id;
    const processing = this.memory.processingV1Head();
    if (recovery && this.memory.jobs().some(job => ['pending', 'running'].includes(job.status))) throw new AppError('memory_writer_busy', 409);
    const job = this.memory.newV1Job(runId, head);
    if (job.nativeTaskId) return job;
    this.store.setSetting(setting, { fingerprint, jobId: job.id });
    try {
      // 同 run 的补源、晚到终态及处理基线变化都不能命中旧的原生成功任务。
      const key = createHash('sha256').update(JSON.stringify([runId, fingerprint, processing, job.id])).digest('hex');
      const nativeTaskId = await this.host.enqueue(runId, `memory-v1:${key}`, job.id, signal => {
        const execute = this.writer.then(async () => {
          signal?.throwIfAborted();
          if (!this.host.enabled()) throw new AppError('memory_disabled', 409);
          const preparedSource = await this.host.prepare(runId, recovery);
          if ((this.host.sourceScope?.(runId) ?? this.host.scopeId) !== scopeId) throw new AppError('memory_source_scope_conflict', 409);
          signal?.throwIfAborted();
          if (!this.host.enabled()) throw new AppError('memory_disabled', 409);
          if (this.memory.jobs().find(row => row.id === job.id)?.status !== 'pending') throw new AppError('memory_execution_interrupted', 409);
          if (!recovery) this.store.setSetting(setting, { fingerprint: fingerprintOf(preparedSource), jobId: job.id });
          const result = await this.memory.organizeV1(job.id, {
            expectedHead: recovery?.expectedHead ?? this.memory.version().id,
            preparedSource, policy, cutoff: recovery?.cutoff ?? new Date().toISOString(), scopeId,
            resolveModel: () => selected.model, requestOptions: () => selected.options, signal,
            // 只接受宿主已绑定的真实目录能力；未知模型不靠声明推断媒体支持。
            supportedImageMediaTypes: selected.supportedImageMediaTypes,
            modelContextWindow: selected.contextWindow, modelMaxOutputTokens: selected.maxOutputTokens,
          }, recovery);
          if (!recovery && this.memory.jobs().find(row => row.id === job.id)?.status === 'succeeded') {
            const current = this.store.setting<{ jobId: string; fingerprint: string; complete?: boolean; publicationKey?: string; cutoff?: string } | null>(setting, null);
            if (current?.jobId === job.id && result.complete && !this.memory.committedV1Publication(job.id, preparedSource.source)) throw new AppError('memory_publication_receipt_unavailable', 409);
            if (result.complete) {
              // 宿主重新物化后会再次 queue；完整回执必须先持久化，不能以 no-op 的新处理头触发自身。
              if (this.host.processed) queueMicrotask(() => this.host.processed?.(runId));
            } else if (result.continuation !== false && result.processedRecords > 0 && remaining > 0) {
              // 每次外部 queue 最多衔接八个批次；零进度、失败和恢复均不自动重试。
              // 不占用 writer 等待 admission，也不在绑定完成前重入同 run。
              queueMicrotask(() => { void (async () => {
                await this.admissions.get(runId);
                if (signal?.aborted || !this.host.enabled() || this.memory.jobs().find(row => row.id === job.id)?.status !== 'succeeded') return;
                await this.queueWithBudget(runId, false, undefined, remaining - 1);
              })().catch(() => {}); });
            }
          }
          return result;
        });
        this.writer = execute.catch(() => {});
        return execute.catch(error => {
          const current = this.memory.jobs().find(row => row.id === job.id);
          if (current?.status === 'pending') this.memory.rejectAdmission(job.id, error instanceof AppError ? error.code : 'memory_execution_interrupted', signal?.aborted ? 'interrupted' : 'failed');
          throw error;
        });
      });
      this.memory.bind(job.id, nativeTaskId);
      // 取消回执可能早于绑定；绑定后补读，不依赖 executor 是否曾被调用。
      // 补读不延长 admission：已发布的 job 不应因终态查询尚未返回而继续占用配置门禁。
      void this.host.task(nativeTaskId).then(task => { if (task) this.settleNativeTask(task); }).catch(() => {});
      return this.memory.jobs().find(row => row.id === job.id)!;
    } catch (error) {
      this.memory.rejectAdmission(job.id, error instanceof AppError ? error.code : 'memory_admission_failed');
      throw error;
    }
  }
}

/** 恢复按真实来源重新送审；缺少完整快照不能用空材料冒充已重放。 */
export function mergeMemoryV1Sources(primary: PreparedMemorySource, others: PreparedMemorySource[]): PreparedMemorySource {
  const result = structuredClone(primary);
  for (const source of others) {
    for (const record of source.records) {
      const prior = result.records.find(row => row.id === record.id);
      if (!prior) result.records.push(record);
      else if (!isDeepStrictEqual(prior, record)) throw new AppError('memory_recovery_source_conflict', 409);
    }
    for (const name of ['contents', 'canonicalRefs', 'attachmentRefs'] as const) {
      for (const [key, value] of source[name]) {
        const previous = result[name].get(key);
        if (previous && !isDeepStrictEqual(previous, value)) throw new AppError('memory_recovery_source_conflict', 409);
        (result[name] as Map<string, unknown>).set(key, value);
      }
    }
    for (const observation of source.observations) {
      const old = result.observations.find(row => row.id === observation.id);
      if (old && !isDeepStrictEqual(old, observation)) throw new AppError('memory_recovery_source_conflict', 409);
      if (!old) result.observations.push(observation);
    }
    result.gaps.push(...source.gaps);
  }
  return result;
}
