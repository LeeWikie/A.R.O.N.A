import type { MemoryJob } from './index.js';

export type PublicMemoryJob = Pick<MemoryJob, 'id' | 'runId' | 'contextId' | 'status' | 'error' | 'createdAt' | 'resolvedBy'>;

// 只投影宿主任务信封；错误正文按原样保留，不递归清洗业务数据。
export function publicMemoryJob(job: MemoryJob): PublicMemoryJob {
  return { id: job.id, runId: job.runId, contextId: job.contextId, status: job.status, error: job.error, createdAt: job.createdAt,...(job.resolvedBy?{resolvedBy:job.resolvedBy}:{}) };
}
