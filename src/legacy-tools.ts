import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import type { Core } from './core.js';
import { createScheduleSchema, updateScheduleSchema } from './schedules.js';
import{acceptedSourceIds}from'./accepted-sources.js';
const outputSources = acceptedSourceIds;
const outputText = z.string().min(1).max(1_000_000);
export function messageDeliveryTools(core: Core) {
  return {
      emit_message: createTool({
        id: 'emit_message', description: 'Send a complete message to the destination of its source signals.',
        inputSchema: z.object({ signalIds: outputSources, text: outputText }),
        execute: async (input, context) => core.publish('message', input.signalIds, input.text, context),
      }),
  };
}
export function artifactDeliveryTools(core: Core) {
  return {
      save_artifact: createTool({
        id: 'save_artifact', description: 'Save an independent Markdown artifact for its source signals.',
        inputSchema: z.object({ signalIds: outputSources, title: z.string().min(1).max(200), markdown: outputText }),
        execute: async (input, context) => core.publish('artifact', input.signalIds, input.markdown, context, input.title),
      }),
  };
}
export function scheduleManagementTools(core: Core) {
    const authorization = { signalIds: outputSources };
    return {
      schedule_list: createTool({
        id: 'schedule_list', description: 'Read current time, default timezone and saved duties before arranging or changing a schedule.',
        inputSchema: z.object(authorization),
        execute: async (input, context) => {
          core.authorize(input.signalIds, context);
          return { ...core.schedules.now(), schedules: core.schedules.list() };
        },
      }),
      schedule_create: createTool({
        id: 'schedule_create', description: 'Save an authorized duty. once uses an absolute ISO time; interval uses anchorAt and everyMs; cron uses a calendar expression. The timezone is an IANA name.',
        inputSchema: z.object({ ...authorization, schedule: createScheduleSchema.partial({ contextId: true }) }),
        execute: async (input, context) => {
          const auth = core.authorize(input.signalIds, context);
          return core.scheduleCreate(input.schedule, auth.key, auth.threadId, input.signalIds);
        },
      }),
      schedule_update: createTool({
        id: 'schedule_update', description: 'Modify a saved duty using the latest revision from schedule_list. Only future fires change.',
        inputSchema: z.object({ ...authorization, id: z.string().uuid(), patch: updateScheduleSchema }),
        execute: async (input, context) => {
          const auth = core.authorize(input.signalIds, context);
          return core.schedules.update(input.id, input.patch, auth.key);
        },
      }),
      schedule_control: createTool({
        id: 'schedule_control', description: 'Pause, resume, or cancel future fires of an existing duty. Already submitted work continues.',
        inputSchema: z.object({ ...authorization, id: z.string().uuid(), revision: z.number().int().positive(), action: z.enum(['pause', 'resume', 'cancel']) }),
        execute: async (input, context) => {
          const auth = core.authorize(input.signalIds, context);
          return core.schedules.control(input.id, input.action, input.revision, auth.key);
        },
      }),
      schedule_run: createTool({
        id: 'schedule_run', description: 'Run a saved duty now without changing its automatic timing.',
        inputSchema: z.object({ ...authorization, id: z.string().uuid() }),
        execute: async (input, context) => {
          const auth = core.authorize(input.signalIds, context);
          return core.schedules.run(input.id, auth.key);
        },
      }),
      schedule_history: createTool({
        id: 'schedule_history', description: 'Read occurrence receipts, reports and outputs of a saved duty.',
        inputSchema: z.object({ ...authorization, id: z.string().uuid(), offset: z.number().int().min(0).default(0) }),
        execute: async (input, context) => {
          core.authorize(input.signalIds, context);
          const occurrences = core.schedules.occurrences(input.id, input.offset);
          return { occurrences, nextOffset: input.offset + occurrences.length };
        },
      }),
  };
}
export function occurrenceReportTools(core: Core) {
  return {
      report_scheduled_task: createTool({
        id: 'report_scheduled_task', description: 'Report one scheduled occurrence after processing it. Does not publish a message or artifact.',
        inputSchema: z.object({ occurrenceId: z.string().uuid(), status: z.enum(['succeeded', 'failed']), summary: z.string().min(1).max(4000) }),
        execute: async (input, context) => {
          return core.reportLegacyOccurrence(input.occurrenceId, input.status, input.summary, context);
        },
      }),
    };
}
