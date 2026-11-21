import type {BackgroundTask} from '@mastra/core/background-tasks';
import {AppError} from './domain.js';
import type {MemoryJob} from './memory/index.js';

export interface LegacyMemoryRecoveryHost {
 ready():boolean;
 allowed?(job:MemoryJob):boolean;
 jobs():readonly MemoryJob[];
 tasks(runId:string):Promise<readonly BackgroundTask[]>;
 task(id:string):Promise<BackgroundTask|null>;
 cancel(id:string):Promise<void>;
 validate(job:MemoryJob):void|Promise<void>;
 queue(runId:string,originalJob:MemoryJob):Promise<MemoryJob>;
 changed(job:MemoryJob,state:'admitted'|'blocked',detail:string):void;
}

/** Reconcile interrupted source work through the existing native manager. */
export async function recoverLegacyMemory(host:LegacyMemoryRecoveryHost):Promise<void>{
 if(!host.ready())return;
 const jobs=host.jobs(),latest=new Map<string,MemoryJob>(),byRun=new Map<string,MemoryJob[]>();
 for(const job of jobs){latest.set(job.runId,job);const group=byRun.get(job.runId)??[];group.push(job);byRun.set(job.runId,group);}
 for(const job of latest.values()){
  if(!host.ready())return;
  if(job.status!=='interrupted'||host.allowed&&!host.allowed(job))continue;
  try{
   await host.validate(job);
   if(!host.ready())return;
   const sourceJobs=new Map(byRun.get(job.runId)!.filter(row=>row.contextId===job.contextId).map(row=>[row.id,row]));
   const matches=(task:BackgroundTask)=>task.runId===job.runId&&task.agentId==='memory-organizer'&&task.toolName==='organize-memory'&&task.toolCallId===`memory:${job.runId}`&&typeof task.args.jobId==='string'&&sourceJobs.has(task.args.jobId);
   const tasks=await host.tasks(job.runId);
   for(const source of sourceJobs.values())if(source.nativeTaskId){
    const linked=tasks.find(task=>task.id===source.nativeTaskId)??await host.task(source.nativeTaskId);
    if(linked&&(!matches(linked)||linked.args.jobId!==source.id))throw new AppError('memory_recovery_binding_changed',409);
   }
   for(const task of tasks){
    if(!matches(task))throw new AppError('memory_recovery_binding_changed',409);
    if(task.status==='completed'&&task.args.jobId===job.id)throw new AppError('memory_recovery_publication_unconfirmed',409);
    if(['pending','running','suspended'].includes(task.status)){
     if(!host.ready())return;
     await host.cancel(task.id);
     const stopped=await host.task(task.id);
     if(!stopped||!matches(stopped)||!['cancelled','failed','timed_out','completed'].includes(stopped.status))throw new AppError('memory_recovery_task_unsettled',409);
     if(stopped.status==='completed'&&stopped.args.jobId===job.id)throw new AppError('memory_recovery_publication_unconfirmed',409);
    }
   }
   if(!host.ready())return;
   const admitted=await host.queue(job.runId,job);
   host.changed(job,'admitted',admitted.id);
  }catch(error){host.changed(job,'blocked',error instanceof AppError?error.code:'memory_recovery_unavailable');}
 }
}
