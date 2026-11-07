import { z } from 'zod';
import {workflowCatalog,workflowInvocationSchema} from './workflows.js';
import { createTool } from '@mastra/core/tools';
import type { Core } from './core.js';
import { taskInputSchema, taskReportSchema } from './tasks.js';
import { thinkingLevels } from './models.js';
import { AppError, contextIdSchema } from './domain.js';

const sources = z.array(z.string().uuid()).min(1).max(64);
export function managementTools(core: Core, worker: boolean) {
  const tools = {
    context_list: createTool({ id: 'context_list', description: 'Find reusable contexts by purpose, name, or identifier.', inputSchema: z.object({ query: z.string().default('') }), execute: async ({ query }) => core.runtime.contexts(query) }),
    context_create: createTool({ id: 'context_create', description: 'Create a persistent work context using a configured workspace.', inputSchema: z.object({ signalIds: sources, name: z.string().min(1).max(200), purpose: z.string().max(8000), workspaceId: z.string().default('default') }), execute: async (input, context) => {
      core.authorize(input.signalIds, context); return core.createWorkContext(input);
    } }),
    context_history: createTool({ id: 'context_history', description: 'Read a page of a context history. Follow hasMore instead of assuming the page is complete.', inputSchema: z.object({ id: contextIdSchema, page: z.number().int().min(0).default(0) }), execute: async ({ id, page }) => core.history(id, page, 40) }),
    context_archive: createTool({ id: 'context_archive', description: 'Archive an idle context without deleting history.', inputSchema: z.object({ signalIds: sources, id: contextIdSchema, archived: z.boolean() }), execute: async (input, context) => { core.authorize(input.signalIds, context); return core.archiveContext(input.id, input.archived); } }),
    task_create: createTool({ id: 'task_create', description: 'Dispatch a complete task in the background. Returns admission, not completion. Workers submit verified business reports; the originating conversation handles user notification. Reuse a context for a continuing duty.', inputSchema: z.object({ signalIds: sources, task: taskInputSchema }), execute: async (input, context) => {
      const auth = core.authorize(input.signalIds, context); return core.createTask(input.task, { sourceSignalIds: input.signalIds, returnContextId: auth.threadId }, auth.key);
    } }),
    task_list: createTool({ id: 'task_list', description: 'Find tasks and their actual states.', inputSchema: z.object({ query: z.string().optional(), contextId: contextIdSchema.optional(), status: z.string().optional() }), execute: async input => core.runtime.tasks(input) }),
    task_get: createTool({ id: 'task_get', description: 'Read actual task state, report and execution references; run completion is not business success.', inputSchema: z.object({ id: z.string().uuid() }), execute: async ({ id }) => core.taskDetails(id) }),
    task_message: createTool({ id: 'task_message', description: 'Send a real supplement to a task context and return its delivery receipt.', inputSchema: z.object({ signalIds: sources, id: z.string().uuid(), content: z.string().min(1).max(64000) }), execute: async (input, context) => {
      core.authorize(input.signalIds, context); return core.taskMessage(input.id, input.content, input.signalIds);
    } }),
    task_control: createTool({ id: 'task_control', description: 'Pause, resume, cancel, or retry a task. Cancellation does not reverse completed external operations.', inputSchema: z.object({ signalIds: sources, id: z.string().uuid(), revision: z.number().int().positive(), action: z.enum(['pause', 'resume', 'cancel', 'retry']) }), execute: async (input, context) => {
      const auth = core.authorize(input.signalIds, context);
      if (core.runtime.task(input.id).contextId === auth.threadId) throw new AppError('cannot_control_own_active_context', 409);
      return core.tasks.control(input.id, input.action, input.revision);
    } }),
    memory_request: createTool({ id: 'memory_request', description: 'Ask background memory processing to handle the complete current context, including an explicit correction or remember request. Does not directly write memory.', inputSchema: z.object({ signalIds: sources, request: z.string().min(1).max(8000) }), execute: async (input, context) => {
      const auth = core.authorize(input.signalIds, context); return core.requestMemory(auth.threadId, auth.runId, input.request, input.signalIds);
    } }),
    method_list: createTool({ id: 'method_list', description: 'Discover reusable methods and revisions. Workers load their full native Skills when relevant.', inputSchema: z.object({}), execute: async () => core.methods.list().map(({ instructions: _, references: __, ...record }) => record) }),
    model_list: createTool({ id: 'model_list', description: 'List configured models without exposing credentials.', inputSchema: z.object({}), execute: async () => core.models.list() }),
    model_switch: createTool({ id: 'model_switch', description: 'Select a configured model and supported thinking level for a context. Applies to subsequent requests.', inputSchema: z.object({ signalIds: sources, contextId: contextIdSchema, profileId: z.string(), thinkingLevel: z.enum(thinkingLevels).nullable().optional() }), execute: async (input, context) => {
      core.authorize(input.signalIds, context); return core.switchModel(input.contextId, input.profileId, input.thinkingLevel);
    } }),
    capability_status: createTool({ id: 'capability_status', description: 'Inspect configured workspaces, MCP connection state, and workflow input contracts.', inputSchema: z.object({}), execute: async () => ({ workspaces: core.capabilities.roots(), mcp: core.capabilities.mcpStatus(), workflows: workflowCatalog }) }),
  };
  if (!worker) return tools;
  return { ...tools,
    task_report: createTool({ id: 'task_report', description: 'Report this task with completion checks, actual deliveries and unresolved items. The report returns results to the originating conversation for user communication; direct chat delivery is not a prerequisite.', inputSchema: z.object({ id: z.string().uuid(), report: taskReportSchema }), execute: async (input, context) => {
      const auth = core.activeTool(context); const task = await core.tasks.report(input.id, input.report, auth.runId, (task, report) => core.verifyReport(task, report,context?.abortSignal));
      return task;
    } }),
    method_save: createTool({ id: 'method_save', description: 'Save or improve a reusable method from successfully checked work. Preserve applicability and verification; do not promote failed guesses.', inputSchema: z.object({ name: z.string(), description: z.string(), instructions: z.string(), references: z.record(z.string(), z.string()).default({}), evidenceTaskIds: z.array(z.string().uuid()).min(1), revision: z.number().int().positive().optional() }), execute: async (input, context) => {
      const auth=core.requireWorker(context); const { revision, ...body } = input; return core.methods.propose(body,revision,auth.threadId,auth.runId,auth.key);
    } }),
    method_control: createTool({ id: 'method_control', description: 'Enable, disable, or roll back a reusable method without deleting its history.', inputSchema: z.object({ name: z.string(), revision: z.number().int().positive(), enabled: z.boolean().optional(), restoreRevision: z.number().int().positive().optional() }), execute: async (input, context) => {
      core.requireWorker(context);
      return input.restoreRevision === undefined ? core.methods.control(input.name, input.enabled ?? false, input.revision) : core.methods.rollback(input.name, input.restoreRevision, input.revision);
    } }),
    workflow_run: createTool({ id: 'workflow_run', description: 'Verify existing workspace files: input.paths is the list of relative paths; returns bytes and SHA-256. Does not copy files or run commands.', inputSchema:workflowInvocationSchema, execute: async (input, context) => {
      const auth = core.requireWorker(context); return core.runWorkflow(input.id, input.input, auth.threadId,context?.abortSignal);
    } }),
    configuration_update: createTool({ id: 'configuration_update', description: 'Change model, MCP, or workspace configuration after explicit approval. Credentials are environment references, not literals.', inputSchema: z.object({ kind: z.enum(['model', 'mcp', 'workspace', 'runtime', 'web']), configuration: z.record(z.string(), z.unknown()) }), requireApproval: true,
      execute: async (input, context) => { core.requireWorker(context); return core.configure(input.kind, input.configuration); } }),
    mcp_connection: createTool({ id: 'mcp_connection', description: 'Connect, reconnect, or disconnect a configured MCP server. A stdio connection starts the configured process.', inputSchema: z.object({ id: z.string(), action: z.enum(['connect', 'reconnect', 'disconnect']) }), requireApproval: true,
      execute: async ({ id, action }, context) => { core.requireWorker(context); if (action !== 'connect') await core.capabilities.disconnect(id); return action === 'disconnect' ? core.capabilities.mcpStatus() : core.capabilities.connect(id); } }),
  };
}
