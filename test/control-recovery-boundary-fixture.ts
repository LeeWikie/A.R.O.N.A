import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';

const requestedDirectory = process.argv[2], mode = process.argv[3] ?? 'sequence';
if (!requestedDirectory || !process.send) throw Error('fixture_requires_directory_and_ipc');
const directory = requestedDirectory;
fs.mkdirSync(directory, { recursive: true });
const observe = (kind: string, value: unknown) => fs.appendFileSync(path.join(directory, 'control-observations.jsonl'), JSON.stringify({ pid: process.pid, at: Date.now(), kind, value }) + '\n');
let executing: { threadId: string; runId: string } | undefined;
const requireWorker = Core.prototype.requireWorker;
Core.prototype.requireWorker = function (context) { const value = requireWorker.call(this, context); executing = { threadId: value.threadId, runId: value.runId }; return value; };
const configure = Core.prototype.configure;
Core.prototype.configure = function (kind, value) { const result = configure.call(this, kind, value); if (kind === 'runtime' && value && typeof value === 'object' && 'memoryEnabled' in value && value.memoryEnabled === false) observe('configuration-effect', { identity: executing, configuration: value }); return result; };
let core: Core, calls = 0, workerCalls = 0;
const model = new MastraLanguageModelV2Mock({ doStream: async request => {
  calls++; const worker = request.tools?.some(tool => tool.name === 'task_report'); if (worker) workerCalls++; observe('model-request', { worker, prompt: request.prompt });
  const result = request.prompt.filter(message => message.role === 'tool').flatMap(message => message.content);
  const has = (id: string) => result.some(part => part.type === 'tool-result' && part.toolCallId === id);
  const task = worker ? core.runtime.tasks().find(task => task.status === 'running' && request.prompt.some(message => JSON.stringify(message).includes(task.id))) : undefined;
  const question = (suffix: string) => ({ name: 'ask_user', id: `question-${suffix}`, input: { question: `Choose synthetic ${suffix}`, options: [{ label: 'A' }, { label: 'B' }] } });
  const approval = (suffix: string) => ({ name: 'configuration_update', id: `approval-${suffix}`, input: { kind: 'runtime', configuration: { memoryEnabled: false } } });
  let actions: Array<{ name: string; id: string; input: unknown }> = [];
  if (task) {
    if (mode === 'parallel' && !has('question-A') && !has('question-B')) actions = [question('A'), question('B')];
    else if (mode === 'parallel' && (!has('question-A') || !has('question-B'))) throw Error('parallel_gate_incomplete_resume');
    else if (!has('question-A')) actions = [question('A')];
    else if (mode !== 'deadline' && !has('approval-A')) actions = [approval('A')];
    else if (mode !== 'deadline' && !has('question-B')) actions = [question('B')];
    else if (mode !== 'deadline' && !has('approval-B')) actions = [approval('B')];
    else if (!result.some(part => part.type === 'tool-result' && part.toolName === 'task_report')) {
      const denied = /denied|not approved/i.test(JSON.stringify(result));
      actions = [{ name: 'task_report', id: 'boundary-report', input: { id: task.id, report: { outcome: denied ? 'blocked' : 'succeeded', summary: denied ? 'A requested configuration action was denied.' : 'Both synthetic questions and approvals completed.', checks: [{ description: 'Native question and approval results were observed.', passed: !denied }], deliveries: [], unresolved: denied ? ['Configuration was not approved.'] : [] } } }];
    }
  }
  return { stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] }); for (const action of actions) c.enqueue({ type: 'tool-call', toolName: action.name, toolCallId: action.id, input: JSON.stringify(action.input) });
    c.enqueue({ type: 'finish', finishReason: actions.length ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
  } }) };
} });
core = await Core.open({ dataDir: directory, model, memoryEnabled: false, concurrency: 4 });
const manager = core.sessions.controller.getMastra()!.backgroundTaskManager!;
if (process.env.SYNTHETIC_TASK_TIMEOUT_MS) manager.config.defaultTimeoutMs = Number(process.env.SYNTHETIC_TASK_TIMEOUT_MS);
const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => { const address = server.address(); if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port, token: core.controlToken, storageId: core.storageId }); });
process.on('message', message => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'inspect') return;
  void (async () => {
    const tasks = core.runtime.tasks();
    process.send?.({ type: 'inspection', calls, workerCalls, tasks, interactions: core.interactions(), approvals: core.runtime.approvals(), recoveries: tasks.flatMap(task => task.runIds.map(id => core.runtime.setting(`run-recovery:${id}`, null))), nativeTasks: await Promise.all(tasks.map(async task => task.nativeTaskId ? await manager.getTask(task.nativeTaskId) : null)), suspensions: await core.worker.listSuspendedRuns({ resourceId: 'local' }), history: await Promise.all(tasks.map(async task => ({ contextId: task.contextId, messages: (await core.memory.recall({ threadId: task.contextId, page: 0, perPage: 100, hideSignals: false })).messages }))), events: core.runtime.events(undefined, 0, 1000) });
  })().catch(error => process.send?.({ type: 'fixture-error', error: String(error) }));
});
let closing = false;
process.once('SIGTERM', () => { if (closing) return; closing = true; if ('closeAllConnections' in server) server.closeAllConnections(); server.close(); void core.close().finally(() => process.exit(0)); });
