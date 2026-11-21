import type {Core} from './core.js';
import {AppError} from './domain.js';

/** Validate and abort synchronously; a delayed command cannot target the successor run. */
export async function interruptForeground(core:Core,contextId:string,expectedRunId:string){
  const context=core.runtime.context(contextId);if(!context)throw new AppError('context_not_found',404);
  if(context.role!=='main')throw new AppError('use_task_control',409);
  const session=core.sessions.peek(contextId);const run=core.store.getRun(expectedRunId);
  if(!session||session.getCurrentRunId()!==expectedRunId||run?.contextId!==contextId||run.status!=='running')throw new AppError('run_changed',409);
  await core.abortExecution(contextId,expectedRunId);
  if(session.run.getRunId()===expectedRunId){
    const deadline=AbortSignal.timeout(10000);await session.run.waitForTeardown(deadline);
  }
  const record=core.store.getRun(expectedRunId);
  core.runtime.event({contextId,runId:expectedRunId,kind:'foreground_control',data:{action:'interrupt',status:record?.status??'unknown'}});
  return {runId:expectedRunId,status:record?.status==='running'?'cancelling':record?.status??'unknown',externalSideEffectsMayRemain:true};
}
