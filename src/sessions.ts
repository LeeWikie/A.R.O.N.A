import { AgentController } from '@mastra/core/agent-controller';
import type { Session, AgentControllerEvent } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';
import type { Agent } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import type { LibSQLStore } from '@mastra/libsql';
import type { ContextRecord } from './runtime-store.js';

export class Sessions {
  readonly controller: AgentController;
  private readonly live = new Map<string, Session>();
  private readonly nativeCompletions=new Set<Promise<void>>();
  private readonly nativeRunIds=new Set<string>();
  private readonly opening = new Map<string, Promise<Session>>();
  constructor(options: {
    main: Agent; worker: Agent; storage: LibSQLStore; memory: Memory;
    concurrency: number; onEvent: (record: ContextRecord, session: Session, event: AgentControllerEvent) => void;
    onEnd: (record: ContextRecord, session: Session, event: Extract<AgentControllerEvent, { type: 'agent_end' }>) => Promise<void>;
    beforeStream?: (message: unknown, options: Record<string, unknown>) => Promise<void>;
    workspace: (record: ContextRecord) => ReturnType<Session['getWorkspace']>;
  }) {
    this.options = options;
    this.controller = new AgentController({ id: 'shittimchest', resourceId: 'local', storage: options.storage, memory: options.memory,
      agent: options.main, modes: [{ id: 'main', agent: options.main }, { id: 'work', agent: options.worker }], defaultModeId: 'main',
      disableBuiltinTools: ['ask_user', 'submit_plan', 'task_write', 'task_update', 'task_complete', 'task_check', 'subagent'],
      backgroundTasks: { enabled: true, globalConcurrency: options.concurrency, perAgentConcurrency: options.concurrency,
        perOwnerConcurrency: { 'memory-organizer': 1 }, backpressure: 'queue', defaultTimeoutMs: 30 * 60_000,
        defaultRetries: { maxRetries: 0 }, recoverStaleTasksOnStart: false },
      toolCategoryResolver: name => name.startsWith('mastra_workspace_') ? (name.includes('execute') || name.includes('kill_process') ? 'execute' : /write|edit|delete|mkdir|patch/.test(name) ? 'edit' : 'read')
        : name.includes('_') && !/^(task|context|memory|method|workflow|schedule|emit|save|report|send|model|capability|web)_/.test(name) ? 'mcp' : 'other',
    });
  }
  private readonly options;
  async init(){
    await this.controller.init();
    for(const agent of [this.options.main,this.options.worker])for(const method of ['stream','resumeStream'] as const){
      const original=agent[method].bind(agent) as (...args:unknown[])=>Promise<{_waitUntilFinished:()=>Promise<void>}>;
      // Observe the SDK's existing completion promise; never read or consume its stream here.
      Object.assign(agent,{[method]:(...args:unknown[])=>{
        const runId=args[1]&&typeof args[1]==='object'&&'runId' in args[1]?String(args[1].runId):undefined;if(runId)this.nativeRunIds.add(runId);
        const output=Promise.resolve().then(async()=>{if(args[1]&&typeof args[1]==='object')await this.options.beforeStream?.(args[0],args[1] as Record<string,unknown>);return original(...args);});const completed=output.then(value=>value._waitUntilFinished());this.nativeCompletions.add(completed);
        void completed.then(()=>this.nativeCompletions.delete(completed),()=>this.nativeCompletions.delete(completed));return output;
      }});
    }
  }
  peek(id: string) { return this.live.get(id); }
  /** Submit to the SDK queue without losing its native receipt. */
  async queueSignal(session: Session, signal: Parameters<Agent['queueSignal']>[0], requestContext?: RequestContext) {
    await session.machinery.authorizeExecute?.(requestContext);
    const threadId=await session.thread.ensureId({requestContext});
    await session.thread.ensureSubscription(threadId,undefined,requestContext);
    const streamOptions=await session.machinery.buildStreamOptions({requestContext,abortSignal:new AbortController().signal});
    return session.machinery.getAgent().queueSignal(signal,{resourceId:session.identity.getResourceId(),threadId,ifIdle:{streamOptions}});
  }
  async get(record: ContextRecord): Promise<Session> {
    const existing = this.live.get(record.id); if (existing) return existing;
    const opening = this.opening.get(record.id); if (opening) return opening;
    const promise = (async () => {
      const requestContext = new RequestContext(); requestContext.set('app.contextId', record.id); requestContext.set('app.role', record.role);
      const session = await this.controller.createSession({ id: record.id, resourceId: 'local', threadId: record.id, tags: { role: record.role },
        requestContext, workspace: record.role === 'work' ? this.options.workspace(record) : undefined });
      await session.mode.switch({ modeId: record.role === 'work' ? 'work' : 'main' });
      await session.state.set({yolo:false});
      for(const toolName of Object.keys(session.permissions.getRules().tools))await session.permissions.setForTool({toolName,policy:'ask'});
      for(const category of ['other','read','edit','execute','mcp'] as const) await session.permissions.setForCategory({category,policy:'ask'});
      for(const toolName of ['emit_message','save_artifact','schedule_list','schedule_create','schedule_update','schedule_control','schedule_run','schedule_history','report_scheduled_task',
        'context_list','context_create','context_history','context_archive','task_create','task_list','task_get','task_message','task_control','memory_request','method_list','model_list','model_switch','capability_status',
        'task_report','method_save','method_control','workflow_run']) await session.permissions.setForTool({toolName,policy:'allow'});
      await session.permissions.setForCategory({ category: 'mcp', policy: 'ask' });
      await session.permissions.setForTool({ toolName: 'configuration_update', policy: 'ask' });
      await session.permissions.setForTool({ toolName: 'mcp_connection', policy: 'ask' });
      this.live.set(record.id, session);
      session.subscribe(event => this.options.onEvent(record, session, event));
      session.onBeforeAgentEnd(event => this.options.onEnd(record, session, event));
      return session;
    })();
    this.opening.set(record.id, promise);
    try { return await promise; } finally { this.opening.delete(record.id); }
  }
  async close(){
    await Promise.allSettled(this.opening.values());
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),5000);});
    let waiting=true;
    const finished=(async()=>{
      while(waiting){
        await Promise.allSettled([...this.nativeCompletions]);
        const mastra=this.controller.getMastra();
        for(const id of this.nativeRunIds)if(!mastra?.__hasInternalWorkflow('agentic-loop',id)&&!mastra?.__hasInternalWorkflow('executionWorkflow',id))this.nativeRunIds.delete(id);
        if(!this.nativeCompletions.size&&!this.nativeRunIds.size)return true as const;
        // Abort can emit a terminal chunk before the SDK deletes its workflow snapshots.
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      return false as const;
    })();
    const drained=await Promise.race([finished,deadline]);waiting=false;clearTimeout(timer);
    for(const session of this.live.values())session.thread.detachFromCurrent();
    await this.controller.destroy();this.live.clear();return drained;
  }
}
