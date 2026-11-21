import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { RuntimeStore, TaskRecord, TaskReport, ContextRecord } from './runtime-store.js';
import { AppError, contextIdSchema } from './domain.js';

export const taskInputSchema = z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(64_000),
  contextId: contextIdSchema.optional(), workspaceId: z.string().optional(), parentId: z.string().uuid().optional(),
}).strict();
export const taskReportSchema = z.object({ outcome: z.enum(['succeeded', 'failed', 'blocked']), summary: z.string().min(1).max(8000),
  checks: z.array(z.object({ description: z.string().min(1).max(1000), passed: z.boolean() }).strict()).min(1).max(100),
  deliveries:z.array(z.discriminatedUnion('kind',[
    z.object({kind:z.literal('file'),title:z.string().min(1).max(200),value:z.string().min(1).describe('Relative path of an actual file in this workspace. Use a string, not an object.')} ).strict(),
    z.object({kind:z.literal('text'),title:z.string().min(1).max(200),value:z.string()}).strict(),
    z.object({kind:z.literal('markdown'),title:z.string().min(1).max(200),value:z.string()}).strict(),
    z.object({kind:z.literal('json'),title:z.string().min(1).max(200),value:z.json()}).strict(),
  ])).max(100).default([]),
  unresolved: z.array(z.string().max(2000)).max(100).default([]),
}).strict();
export interface TaskOrigin { sourceSignalIds: string[]; returnContextId: string; parentId?: string; occurrenceId?: string; signalId?: string; grants?: TaskRecord['grants']; toolGrants?:TaskRecord['toolGrants'];mcpKeys?:string[] }
export class Tasks {
  private readonly admissions = new Map<string, Promise<TaskRecord>>();
  private readonly observations = new Map<string, Promise<void>>();
  private readonly executions = new Map<string, AbortController>();
  private readonly resourceControls=new Map<string,Set<symbol>>();
  private readonly deferredSettlements=new Set<string>();
  executionSignal(id: string, attempt: number) { return this.executions.get(`${id}:${attempt}`)?.signal; }
  constructor(private readonly store: RuntimeStore, private readonly options: {
    manager: () => BackgroundTaskManager;
    createContext: (input: { id: string; name: string; role: 'work'; workspaceId: string; purpose: string }) => ContextRecord;
    dispatch: (task: TaskRecord, signal?: AbortSignal) => Promise<{ runId: string }>;
    wait: (runId: string, signal?: AbortSignal) => Promise<'complete' | 'aborted' | 'error' | 'suspended'>;
    abort: (contextId: string, runId?: string) => void;
    settle: (contextId: string, runId?: string) => Promise<void>;
    active?: (contextId: string, runId: string) => boolean;
    cancelAdmissions?: (id: string, attempt: number) => void;
    stopResources?: (id:string)=>Promise<void>;
    detaching?: (id:string,attempt:number)=>boolean;
    changed: (task: TaskRecord) => Promise<void>;
    admissionSettled?: (taskId: string, attempt: number, error?: unknown) => void;
  }) {}
  create(body: unknown, origin: TaskOrigin, key: string, beforeCommit?: (task: TaskRecord) => void): TaskRecord {
    const parsed = taskInputSchema.safeParse(body); if (!parsed.success) throw new AppError('invalid_task');
    return this.store.operation(key, ['task-create', parsed.data, origin], () => {
      let parent: TaskRecord | undefined;
      if (origin.parentId) parent = this.store.task(origin.parentId);
      if (parsed.data.parentId && parsed.data.parentId !== origin.parentId) throw new AppError('task_parent_not_authorized', 403);
      if (parent?.parentId) throw new AppError('task_depth_limit', 409);
      const workspaceId=parsed.data.workspaceId??(parent?this.store.context(parent.contextId)!.workspaceId:'default');
      const contextId = parsed.data.contextId ?? `work.${randomUUID()}`;
      let context = this.store.context(contextId);
      if(context&&parsed.data.workspaceId!==undefined&&context.workspaceId!==workspaceId)throw new AppError('task_context_workspace_mismatch',409);
      if (!context) context = this.options.createContext({ id: contextId, name: parsed.data.title, role: 'work', workspaceId, purpose: parsed.data.content });
      if(parent?.contextId===contextId)throw new AppError('child_requires_independent_context',409);
      if (context.role !== 'work' || context.archived) throw new AppError('task_context_not_available', 409);
      if(parent&&this.store.context(parent.contextId)?.workspaceId!==context.workspaceId)throw new AppError('child_workspace_not_authorized',403);
      const grants = parent?.grants ?? origin.grants;
      const task = this.store.createTask({ title: parsed.data.title, content: parsed.data.content, contextId, returnContextId: origin.returnContextId,
        sourceSignalIds: origin.sourceSignalIds, ...(origin.signalId ? { signalId: origin.signalId } : {}), parentId: origin.parentId ?? null, occurrenceId: origin.occurrenceId ?? null,
        ...(grants ? { grants } : {}),toolGrants:parent?(parent.toolGrants??[]):(origin.toolGrants??[]),mcpKeys:parent?(parent.mcpKeys??[]):(origin.mcpKeys??[]) });
      beforeCommit?.(task);
      this.store.event({ contextId, taskId: task.id, kind: 'task_created', data: task }); return task;
    });
  }
  private runAttempts(id:string){return this.store.setting<Record<string,number>>(`task-run-attempts:${id}`,{});}
  runAttempt(id:string,runId:string){return this.runAttempts(id)[runId];}
  private ownedRun(task: TaskRecord) {
    const runId = task.runIds.at(-1);
    return runId && this.runAttempt(task.id, runId) === (task.attempt ?? 1) ? runId : undefined;
  }
  childFingerprint(id: string) {
    return JSON.stringify(this.store.tasks().filter(child => child.parentId === id).map(child => ({ id: child.id, attempt: child.attempt ?? 1, status: child.status, report: child.report, runIds: child.runIds })));
  }
  bindRun(id:string,attempt:number,runId:string){
    const task=this.store.task(id);const runs=this.runAttempts(id);
    if((task.attempt??1)!==attempt||!['running','waiting'].includes(task.status)||(runs[runId]!==undefined&&runs[runId]!==attempt))throw new AppError('task_attempt_changed',409);
    this.store.setSetting(`task-run-attempts:${id}`,{...runs,[runId]:attempt});
    if(!task.runIds.includes(runId))this.store.updateTask(id,{runIds:[...task.runIds,runId]});
  }
  observeRun(id:string,attempt:number,runId:string):Promise<void>{
    const key=`${id}:${attempt}:${runId}`;const existing=this.observations.get(key);if(existing)return existing;
    const operation=this.observeRunNow(id,attempt,runId);this.observations.set(key,operation);
    const cleanup=()=>{if(this.observations.get(key)===operation)this.observations.delete(key);};
    void operation.then(cleanup,cleanup);
    return operation;
  }
  private async observeRunNow(id:string,attempt:number,runId:string){
    if(this.runAttempt(id,runId)!==attempt||(this.store.task(id).attempt??1)!==attempt)return;
    const settledKey=`task-run-settled:${id}:${attempt}:${runId}`;
    if(this.store.setting(settledKey,false))return;
    const reason=await this.options.wait(runId);
    const current=this.store.task(id);
    if((current.attempt??1)!==attempt||this.runAttempt(id,runId)!==attempt||current.runIds.at(-1)!==runId||this.store.setting(settledKey,false))return;
    if(!['running','waiting','pausing','cancelling'].includes(current.status))return;
    if(['pausing','cancelling'].includes(current.status)&&this.resourceControls.has(`${id}:${attempt}`)){this.deferredSettlements.add(`${id}:${attempt}:${runId}`);return;}
    if(current.status==='pausing')this.store.updateTask(id,{status:'paused'});
    else if(current.status==='cancelling')this.store.updateTask(id,{status:'cancelled'});
    else if(reason==='suspended')this.store.updateTask(id,{status:'waiting'});
    else if(reason==='aborted'||reason==='error')this.store.updateTask(id,{status:reason==='aborted'?'interrupted':'failed'});
    else {
      const children=this.store.tasks().filter(child=>child.parentId===id);
      const pendingChildren=children.some(child=>['pending','running','waiting','pausing','cancelling'].includes(child.status));
      const needsChildContinuation = children.length > 0 && this.store.setting<string | null>(`task-child-continuation:${id}`, null) !== this.childFingerprint(id);
      this.store.updateTask(id,{status:pendingChildren?'waiting':current.report?.outcome??(needsChildContinuation?'waiting':'unreported')});
    }
    this.store.setSetting(settledKey,true);
    await this.options.changed(this.store.task(id));
  }
  async drain(preservedRuns:ReadonlySet<string>=new Set()){await Promise.allSettled([...this.observations].filter(([key])=>![...preservedRuns].some(runId=>key.endsWith(':'+runId))).map(([,operation])=>operation));}
  async start(id: string): Promise<TaskRecord> {
    const key=`${id}:${this.store.task(id).attempt??1}`;const existing=this.admissions.get(key);if(existing)return existing;
    const operation=this.startNow(id);this.admissions.set(key,operation);
    try{return await operation;}finally{this.admissions.delete(key);}
  }
  private async startNow(id: string) {
    const task = this.store.task(id); if (task.status !== 'pending') return task;
    const result = await this.options.manager().enqueue({ runId: `admission:${task.id}`, toolName: 'execute-task', toolCallId: `${task.id}:${task.attempt??1}`,
      agentId: 'work-execution', threadId: task.contextId, resourceId: 'local', args: { taskId: task.id }, maxRetries: 0,
    }, { executor: { execute: async (_args, options) => this.execute(task.id,task.attempt??1, options?.abortSignal) },
      onFailed: async () => {
        const current = this.store.task(id);
        this.options.admissionSettled?.(id, task.attempt ?? 1, new AppError('task_admission_failed', 409));
        if ((current.attempt??1)===(task.attempt??1)&&['pending', 'running', 'waiting'].includes(current.status)) { const failed = this.store.updateTask(id, { status: 'interrupted' }); await this.options.changed(failed); }
      },
    });
    if (result.fallbackToSync) throw new AppError('background_backpressure_configuration', 503);
    // The executor may finish before the enqueue acknowledgement. Do not restore an old status.
    return (this.store.task(id).attempt??1)===(task.attempt??1)?this.store.updateTask(id, { nativeTaskId: result.task.id }):this.store.task(id);
  }
  private async execute(id: string, attempt:number,nativeSignal?: AbortSignal) {
    let task = this.store.task(id);
    if (task.status !== 'pending'||(task.attempt??1)!==attempt) return { status: task.status };
    task = this.store.updateTask(id, { status: 'running' });
    const key = `${id}:${attempt}`; const controller = new AbortController();
    this.executions.set(key, controller);
    const nativeAbort = () => controller.abort(nativeSignal?.reason);
    nativeSignal?.addEventListener('abort', nativeAbort, { once: true });
    if (nativeSignal?.aborted) nativeAbort();
    const signal = controller.signal;
    let observed=false;
    try {
      signal.throwIfAborted();
      const abort = () => { const current = this.store.task(id); const runId = this.ownedRun(current); if ((current.attempt ?? 1) === attempt && runId) this.options.abort(current.contextId, runId); }; signal.addEventListener('abort', abort, { once: true });
      try {
        const { runId } = await this.options.dispatch(task, signal);
        signal.throwIfAborted();
        if((this.store.task(id).attempt??1)!==attempt)return {status:this.store.task(id).status};
        if(this.runAttempt(id,runId)!==attempt)this.bindRun(id,attempt,runId);
        this.options.admissionSettled?.(id, attempt);
        await this.options.wait(runId,signal);
        await this.observeRun(id,attempt,runId);observed=true;
      } finally { signal?.removeEventListener('abort', abort); }
    } catch (error) {
      if(signal.aborted&&this.options.detaching?.(id,attempt))throw error;
      this.options.admissionSettled?.(id, attempt, error);
      const current = this.store.task(id);
      if((current.attempt??1)!==attempt)return {status:current.status};
      if(this.store.setting(`task-run-settled:${id}:${attempt}:${current.runIds.at(-1)}`,false))observed=true;
      else if(['pausing','cancelling'].includes(current.status)&&!this.resourceControls.has(`${id}:${attempt}`)){
        const runId = this.ownedRun(current);
        const ownsSettlement = (latest: TaskRecord) => (latest.attempt ?? 1) === attempt && this.ownedRun(latest) === runId && ['pausing', 'cancelling'].includes(latest.status);
        try {
          await this.options.settle(current.contextId, runId); const latest=this.store.task(id);
          if(ownsSettlement(latest))this.store.updateTask(id,{status:latest.status==='pausing'?'paused':'cancelled'});
        } catch {
          const latest=this.store.task(id);
          if(ownsSettlement(latest))this.store.updateTask(id,{status:'interrupted'});
        }
      }
      else if (['pending','running','waiting'].includes(current.status)) this.store.updateTask(id, { status: signal?.aborted ? 'interrupted' : 'failed' });
      if ((this.store.task(id).attempt ?? 1) === attempt) this.store.event({ contextId: task.contextId, taskId: id, kind: 'task_execution_error', data: { code: error instanceof AppError ? error.code : 'task_execution_failed' } });
    } finally {
      nativeSignal?.removeEventListener('abort', nativeAbort);
      if (this.executions.get(key) === controller) this.executions.delete(key);
    }
    const current = this.store.task(id);
    if ((current.attempt ?? 1) === attempt && !observed) await this.options.changed(current);
    return { taskId: id, status: current.status, report: current.report };
  }
  async control(id: string, action: 'pause' | 'cancel' | 'resume' | 'retry', revision: number) {
    const task = this.store.task(id); if (task.revision !== revision) throw new AppError('task_revision_conflict', 409);
    if (action === 'pause' || action === 'cancel') {
      if (['succeeded', 'failed', 'cancelled', 'unreported', 'interrupted', 'blocked'].includes(task.status)) throw new AppError('task_not_active', 409);
      const controlKey=`${id}:${task.attempt??1}`,token=Symbol(),controls=this.resourceControls.get(controlKey)??new Set<symbol>();controls.add(token);this.resourceControls.set(controlKey,controls);
      const status = action==='cancel'?'cancelling':'pausing';
      this.store.updateTask(id, { status });
      const attempt = task.attempt ?? 1; const runId = this.ownedRun(task);
      const releaseResourceFence=()=>{controls.delete(token);if(!controls.size)this.resourceControls.delete(controlKey);};
      const resources=Promise.resolve().then(()=>this.options.stopResources?.(id)).then(()=>{
        releaseResourceFence();
        if(runId){const key=`${id}:${attempt}:${runId}`,existing=this.observations.get(key),deferred=this.deferredSettlements.delete(key),observe=()=>this.observeRun(id,attempt,runId);if(existing||deferred)void(existing?existing.then(observe,observe):observe()).catch(()=>{});}
      },error=>{
        const latest=this.store.task(id);if((latest.attempt??1)===attempt&&['cancelling','pausing'].includes(latest.status))this.store.updateTask(id,{status:'interrupted'});if(runId)this.deferredSettlements.delete(`${id}:${attempt}:${runId}`);releaseResourceFence();throw error;
      });void resources.catch(()=>{});
      // Admission is cancellable before a native receipt or run binding exists.
      this.executions.get(`${id}:${attempt}`)?.abort();
      this.options.cancelAdmissions?.(id, attempt);
      if (task.status !== 'pending' && runId) this.options.abort(task.contextId, runId);
      if (task.nativeTaskId) await this.options.manager().cancel(task.nativeTaskId);
      try{await resources;}catch(error){
        const latest=this.store.task(id);if((latest.attempt??1)===attempt&&['cancelling','pausing','cancelled','paused'].includes(latest.status))this.store.updateTask(id,{status:'interrupted'});
        this.store.event({contextId:task.contextId,taskId:id,runId,kind:'task_resource_cleanup_failed',data:{code:'task_resource_cleanup_failed'}});
        throw error;
      }
      const ownsControl = (current: TaskRecord) => (current.attempt ?? 1) === attempt && this.ownedRun(current) === runId && ['pausing', 'cancelling'].includes(current.status);
      let current=this.store.task(id);
      if(ownsControl(current)){
        try {
          await this.options.settle(task.contextId, runId);
          current=this.store.task(id);
          if(ownsControl(current))current=this.store.updateTask(id,{status:current.status==='pausing'?'paused':'cancelled'});
        } catch {
          current=this.store.task(id);
          if(ownsControl(current))current=this.store.updateTask(id,{status:'interrupted'});
        }
      }
      current=this.store.task(id);
      if ((current.attempt ?? 1) === attempt && this.ownedRun(current) === runId) await this.options.changed(current);
      return current;
    }
    if (!['paused', 'interrupted', 'failed', 'blocked', 'unreported', 'waiting'].includes(task.status)) throw new AppError('task_not_resumable', 409);
    const runId = this.ownedRun(task);
    if (runId && this.options.active?.(task.contextId, runId)) throw new AppError('task_run_still_active', 409);
    this.store.event({ contextId: task.contextId, taskId: id, kind: 'task_attempt_requested', data: { action, previousReport: task.report, previousRuns: task.runIds } });
    this.store.updateTask(id, { status: 'pending', report: null, nativeTaskId: null, signalId: randomUUID(),attempt:(task.attempt??1)+1 });
    return this.start(id);
  }
  async report(id: string, body: unknown, runId: string, verify: (task: TaskRecord, report: TaskReport) => Promise<TaskReport>) {
    const parsed = taskReportSchema.safeParse(body); if (!parsed.success) throw new AppError('invalid_task_report');
    const task = this.store.task(id);
    if (task.runIds.at(-1)!==runId || this.runAttempt(id,runId)!==(task.attempt??1) || !['running', 'waiting'].includes(task.status)) throw new AppError('task_report_not_in_run', 403);
    if (parsed.data.outcome === 'succeeded' && (parsed.data.checks.some(x => !x.passed) || parsed.data.unresolved.length)) throw new AppError('task_report_checks_failed', 409);
    if(parsed.data.outcome==='succeeded'&&this.store.tasks().some(child=>child.parentId===id&&['pending','running','waiting','pausing','cancelling'].includes(child.status)))throw new AppError('task_children_not_complete',409);
    const report = await verify(task, parsed.data);
    const current=this.store.task(id);if((current.attempt??1)!==(task.attempt??1)||current.runIds.at(-1)!==runId||this.runAttempt(id,runId)!==(current.attempt??1)||!['running','waiting'].includes(current.status))throw new AppError('task_report_not_in_run',403);
    this.store.event({ contextId: task.contextId, taskId: id, runId, kind: 'task_report', data: report });
    return this.store.updateTask(id, { report });
  }
}
