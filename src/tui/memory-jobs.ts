import type {PublicMemoryJob} from '../memory/job-view.js';

export function resolvedMemoryJob(jobs:readonly PublicMemoryJob[],job:PublicMemoryJob){
  if(!['failed','interrupted'].includes(job.status)||!job.resolvedBy||job.resolvedBy===job.id)return;
  return jobs.find(target=>target.id===job.resolvedBy&&target.contextId===job.contextId&&target.runId===job.runId&&target.status==='succeeded');
}
