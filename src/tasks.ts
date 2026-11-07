import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { RuntimeStore, TaskRecord, TaskReport, ContextRecord } from './runtime-store.js';
import { AppError, contextIdSchema } from './domain.js';

export const taskInputSchema = z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(64_000),
  contextId: contextIdSchema.optional(), workspaceId: z.string().default('default'), parentId: z.string().uuid().optional(),
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
  constructor(private readonly store: RuntimeStore, private readonly options: {
    manager: () => BackgroundTaskManager;
    createContext: (input: { id: string; name: string; role: 'work'; workspaceId: string; purpose: string }) => ContextRecord;
    dispatch: (task: TaskRecord, signal?: AbortSignal) => Promise<{ runId: string }>;
    wait: (runId: string, signal?: AbortSignal) => Promise<'complete' | 'aborted' | 'error' | 'suspended'>;
    abort: (contextId: string) => void;settle:(contextId:string)=>Promise<void>;
    changed: (task: TaskRecord) => Promise<void>;
  }) {}
  create(body: unknown, origin: TaskOrigin, key: string): TaskRecord {
    const parsed = taskInputSchema.safeParse(body); if (!parsed.success) throw new AppError('invalid_task');
    return this.store.operation(key, ['task-create', parsed.data, origin], () => {
      let parent: TaskRecord | undefined;
      if (origin.parentId) parent = this.store.task(origin.parentId);
      if (parsed.data.parentId && parsed.data.parentId !== origin.parentId) throw new AppError('task_parent_not_authorized', 403);
      if (parent?.parentId) throw new AppError('task_depth_limit', 409);
      const workspaceId=parent&&(body as {workspaceId?:string}).workspaceId===undefined?this.store.context(parent.contextId)!.workspaceId:parsed.data.workspaceId;
      const contextId = parsed.data.contextId ?? `work.${randomUUID()}`;
      let context = this.store.context(contextId);
      if (!context) context = this.options.createContext({ id: contextId, name: parsed.data.title, role: 'work', workspaceId, purpose: parsed.data.content });
      if(parent?.contextId===contextId)throw new AppError('child_requires_independent_context',409);
      if (context.role !== 'work' || context.archived) throw new AppError('task_context_not_available', 409);
      if(parent&&this.store.context(parent.contextId)?.workspaceId!==context.workspaceId)throw new AppError('child_workspace_not_authorized',403);
      const grants = origin.grants ?? parent?.grants;
      const task = this.store.createTask({ title: parsed.data.title, content: parsed.data.content, contextId, returnContextId: origin.returnContextId,
        sourceSignalIds: origin.sourceSignalIds, ...(origin.signalId ? { signalId: origin.signalId } : {}), parentId: origin.parentId ?? null, occurrenceId: origin.occurrenceId ?? null,
        ...(grants ? { grants } : {}),toolGrants:origin.toolGrants??parent?.toolGrants??[],mcpKeys:origin.mcpKeys??parent?.mcpKeys??[] });
      this.store.event({ contextId, taskId: task.id, kind: 'task_created', data: task }); return task;
    });
  }
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
        if ((current.attempt??1)===(task.attempt??1)&&['pending', 'running', 'waiting'].includes(current.status)) { const failed = this.store.updateTask(id, { status: 'interrupted' }); await this.options.changed(failed); }
      },
    });
    if (result.fallbackToSync) throw new AppError('background_backpressure_configuration', 503);
    // The executor may finish before the enqueue acknowledgement. Do not restore an old status.
    return (this.store.task(id).attempt??1)===(task.attempt??1)?this.store.updateTask(id, { nativeTaskId: result.task.id }):this.store.task(id);
  }
  private async execute(id: string, attempt:number,signal?: AbortSignal) {
    let task = this.store.task(id);
    if (task.status !== 'pending'||(task.attempt??1)!==attempt) return { status: task.status };
    task = this.store.updateTask(id, { status: 'running' });
    try {
      signal?.throwIfAborted();
      const abort = () => this.options.abort(task.contextId); signal?.addEventListener('abort', abort, { once: true });
      try {
        const { runId } = await this.options.dispatch(task, signal);
        task = this.store.task(id); this.store.updateTask(id, { runIds: [...new Set([...task.runIds, runId])] });
        const reason = await this.options.wait(runId, signal);
        const current = this.store.task(id);
        if((current.attempt??1)!==attempt)return {status:current.status};
        if (current.status === 'pausing') this.store.updateTask(id, { status: 'paused' });
        else if(current.status==='cancelling')this.store.updateTask(id,{status:'cancelled'});
        else if (current.status !== 'cancelled') {
          if (reason === 'suspended') this.store.updateTask(id, { status: 'waiting' });
          else if (reason === 'aborted' || reason === 'error') this.store.updateTask(id, { status: reason === 'aborted' ? 'interrupted' : 'failed' });
          else {
            const children=this.store.tasks().filter(child=>child.parentId===id);
            const pendingChildren=children.some(child=>['pending','running','waiting','pausing','cancelling'].includes(child.status));
            this.store.updateTask(id,{status:pendingChildren?'waiting':current.report?.outcome??(children.length?'waiting':'unreported')});
          }
        }
      } finally { signal?.removeEventListener('abort', abort); }
    } catch (error) {
      const current = this.store.task(id);
      if((current.attempt??1)!==attempt)return {status:current.status};
      if(['pausing','cancelling'].includes(current.status)){
        try{await this.options.settle(current.contextId);this.store.updateTask(id,{status:current.status==='pausing'?'paused':'cancelled'});}
        catch{this.store.updateTask(id,{status:'interrupted'});}
      }
      else if (current.status !== 'cancelled') this.store.updateTask(id, { status: signal?.aborted ? 'interrupted' : 'failed' });
      this.store.event({ contextId: task.contextId, taskId: id, kind: 'task_execution_error', data: { code: error instanceof AppError ? error.code : 'task_execution_failed' } });
    }
    const current = this.store.task(id); await this.options.changed(current); return { taskId: id, status: current.status, report: current.report };
  }
  async control(id: string, action: 'pause' | 'cancel' | 'resume' | 'retry', revision: number) {
    const task = this.store.task(id); if (task.revision !== revision) throw new AppError('task_revision_conflict', 409);
    if (action === 'pause' || action === 'cancel') {
      if (['succeeded', 'failed', 'cancelled', 'unreported', 'interrupted', 'blocked'].includes(task.status)) throw new AppError('task_not_active', 409);
      const status = action==='cancel'?(task.status==='pending'?'cancelled':'cancelling'):task.status==='pending'?'paused':'pausing';
      this.store.updateTask(id, { status });
      if (task.nativeTaskId) await this.options.manager().cancel(task.nativeTaskId);
      if (task.status !== 'pending') this.options.abort(task.contextId);
      let current=this.store.task(id);
      if((current.attempt??1)===(task.attempt??1)&&['pausing','cancelling'].includes(current.status)){
        try{await this.options.settle(current.contextId);current=this.store.task(id);if((current.attempt??1)===(task.attempt??1)&&['pausing','cancelling'].includes(current.status))current=this.store.updateTask(id,{status:action==='pause'?'paused':'cancelled'});}
        catch{current=this.store.updateTask(id,{status:'interrupted'});}
      }
      await this.options.changed(current);return current;
    }
    if (!['paused', 'interrupted', 'failed', 'blocked', 'unreported', 'waiting'].includes(task.status)) throw new AppError('task_not_resumable', 409);
    this.store.event({ contextId: task.contextId, taskId: id, kind: 'task_attempt_requested', data: { action, previousReport: task.report, previousRuns: task.runIds } });
    this.store.updateTask(id, { status: 'pending', report: null, nativeTaskId: null, signalId: randomUUID(),attempt:(task.attempt??1)+1 });
    return this.start(id);
  }
  async report(id: string, body: unknown, runId: string, verify: (task: TaskRecord, report: TaskReport) => Promise<TaskReport>) {
    const parsed = taskReportSchema.safeParse(body); if (!parsed.success) throw new AppError('invalid_task_report');
    const task = this.store.task(id);
    if (!task.runIds.includes(runId) || !['running', 'waiting'].includes(task.status)) throw new AppError('task_report_not_in_run', 403);
    if (parsed.data.outcome === 'succeeded' && (parsed.data.checks.some(x => !x.passed) || parsed.data.unresolved.length)) throw new AppError('task_report_checks_failed', 409);
    if(parsed.data.outcome==='succeeded'&&this.store.tasks().some(child=>child.parentId===id&&['pending','running','waiting','pausing','cancelling'].includes(child.status)))throw new AppError('task_children_not_complete',409);
    const report = await verify(task, parsed.data);
    const current=this.store.task(id);if((current.attempt??1)!==(task.attempt??1)||!['running','waiting'].includes(current.status))throw new AppError('task_report_not_in_run',403);
    this.store.event({ contextId: task.contextId, taskId: id, runId, kind: 'task_report', data: report });
    return this.store.updateTask(id, { report });
  }
}
