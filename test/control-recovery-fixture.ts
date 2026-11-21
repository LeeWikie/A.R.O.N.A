import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';

const directory = process.argv[2];
if (!directory || !process.send) throw new Error('fixture_requires_ipc_and_directory');
let calls = 0;
let workerCalls=0;
const approvalMode = process.argv[3] === 'approval';
const runningMode = process.argv[3] === 'running';
const mcpMode = process.argv[3] === 'mcp';
const model = new MastraLanguageModelV2Mock({ doStream: async request => {
  calls++;
  const worker=request.tools?.some(tool=>tool.name==='task_report')??false;if(worker)workerCalls++;
  const results = request.prompt.filter(message => message.role === 'tool').flatMap(message => message.content);
  const prompt = request.prompt.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
  const taskId = /task_id="([^"]+)"/.exec(prompt)?.[1];
  const configured = results.some(part => part.type === 'tool-result' && part.toolName === 'configuration_update');
  const reported = results.some(part => part.type === 'tool-result' && part.toolName === 'task_report');
  const questionAnswered = request.prompt.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('SYNTHETIC_RECOVERY_ANSWER'));
  const resourceRead = results.some(part => part.type === 'tool-result' && part.toolName === 'read_mcp_resource');
  const answered = approvalMode || mcpMode ? !taskId || reported : questionAnswered;
  process.send?.({ type: 'model-call', calls, workerCalls,worker, answered });
  if (runningMode) await new Promise<void>(() => {});
  return { stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    if (!answered) controller.enqueue(mcpMode && questionAnswered
      ? resourceRead
        ? { type: 'tool-call', toolCallId: 'synthetic-mcp-report', toolName: 'task_report', input: JSON.stringify({ id: taskId, report: { outcome: 'succeeded', summary: 'The original MCP source was read.', checks: [{ description: 'Native resource returned actual text.', passed: JSON.stringify(results).includes('Synthetic external notes') }], deliveries: [{ kind: 'text', title: 'Synthetic result', value: 'SYNTHETIC_RECOVERY_COMPLETE' }], unresolved: [] } }) }
        : { type: 'tool-call', toolCallId: 'synthetic-mcp-read', toolName: 'read_mcp_resource', input: JSON.stringify({ serverId: 'recovery-fixture', uri: 'fixture://notes/main' }) }
      : approvalMode
      ? configured
        ? { type: 'tool-call', toolCallId: 'synthetic-recovery-report', toolName: 'task_report', input: JSON.stringify({ id: taskId, report: { outcome: 'succeeded', summary: 'Synthetic configuration fixture completed.', checks: [{ description: 'The approved native call returned.', passed: true }], deliveries: [{ kind: 'text', title: 'Synthetic result', value: 'SYNTHETIC_RECOVERY_COMPLETE' }], unresolved: [] } }) }
        : { type: 'tool-call', toolCallId: 'synthetic-recovery-approval', toolName: 'configuration_update', input: JSON.stringify({ kind: 'runtime', configuration: { memoryEnabled: false } }) }
      : { type: 'tool-call', toolCallId: 'synthetic-recovery-question', toolName: 'ask_user', input: JSON.stringify({ question: 'Choose the synthetic document format', options: [{ label: 'SYNTHETIC_RECOVERY_ANSWER' }, { label: 'Other' }] }) });
    else {
      controller.enqueue({ type: 'text-start', id: 'result' });
      controller.enqueue({ type: 'text-delta', id: 'result', delta: 'SYNTHETIC_RECOVERY_COMPLETE' });
      controller.enqueue({ type: 'text-end', id: 'result' });
    }
    controller.enqueue({ type: 'finish', finishReason: answered ? 'stop' : 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    controller.close();
  } }) };
} });
const key = process.env.SHITTIMCHEST_STARTUP_MODEL_KEY;
const core = await Core.open({ dataDir: directory, model, memoryEnabled: false, concurrency: Number(process.env.SYNTHETIC_RECOVERY_CONCURRENCY) || 4, ...(key ? { modelConfig: { protocol: 'responses' as const, baseURL: 'http://127.0.0.1:9/v1', modelId: 'gpt-6-luna', apiKey: key, authHeader: 'bearer' as const } } : {}) });
if(process.env.SYNTHETIC_CLEANUP_FAILURE){const close=core.capabilities.close.bind(core.capabilities);core.capabilities.close=async()=>{await close();throw Error('synthetic_cleanup_failure');};}
if (process.env.SYNTHETIC_MCP_RECOVERY_URL && !core.capabilities.mcpConfigs().length) {
  await core.capabilities.saveMCP({ id: 'recovery-fixture', url: process.env.SYNTHETIC_MCP_RECOVERY_URL, protocolVersion: 'legacy' });
  await core.capabilities.connect('recovery-fixture');
}
const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port, token: core.controlToken, storageId: core.storageId, instanceId: core.instanceId });
});
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if(message.type==='graceful-close')void(async()=>{server.close();if('closeAllConnections'in server)server.closeAllConnections();await Promise.all([core.close(),core.close()]);process.send?.({type:'closed'});process.disconnect?.();})().catch(error=>{process.send?.({type:'fixture-error',error:String(error)});process.disconnect?.();});
  if (message.type === 'inspect') void (async () => {
    const native = await core.agent.listSuspendedRuns({ threadId: 'main', resourceId: 'local' });
    const workerNative = approvalMode || mcpMode ? await core.worker.listSuspendedRuns({ resourceId: 'local' }) : undefined;
    const recovery = native.runs.flatMap(run => run.runId ? [core.runtime.setting(`run-recovery:${run.runId}`, null)] : []);
    const workerRecovery = workerNative?.runs.flatMap(run => run.runId ? [core.runtime.setting(`run-recovery:${run.runId}`, null)] : []);
    const tasks=core.runtime.tasks(),manager=core.sessions.controller.getMastra()?.backgroundTaskManager;
    const resources=await Promise.all(tasks.map(async task=>{const resource=task.nativeTaskId?await manager?.getTask(task.nativeTaskId):undefined;return {taskId:task.id,nativeTaskId:task.nativeTaskId,status:resource?.status??null};}));
    process.send?.({ type: 'inspection', calls,workerCalls, interactions: core.interactions(), approvals: core.runtime.approvals(), native, workerNative, tasks, resources, recovery, workerRecovery, events: core.runtime.events('main', 0, 1000).filter(event => event.kind.startsWith('run_recover')) });
  })().catch(error => process.send?.({ type: 'fixture-error', error: String(error) }));
  if (message.type === 'resume-native') void (async () => {
    const native = await core.agent.listSuspendedRuns({ threadId: 'main', resourceId: 'local' });
    const parked = native.runs[0];
    const call = parked?.toolCalls.find(tool => tool.toolName === 'ask_user');
    if (!parked || !call || !parked.runId || !call.toolCallId) throw new Error('fixture_snapshot_missing');
    const context = core.runtime.context('main');
    if (!context) throw new Error('fixture_context_missing');
    const session = await core.sessions.get(context);
    session.subscribe(event => { process.send?.({ type: 'native-event', event }); });
    await session.respondToToolSuspension({ address: { resourceId: 'local', threadId: 'main', runId: parked.runId, toolCallId: call.toolCallId }, resumeData: 'SYNTHETIC_RECOVERY_ANSWER' });
    process.send?.({ type: 'native-resumed', calls });
  })().catch(error => process.send?.({ type: 'fixture-error', error: String(error) }));
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(); if ('closeAllConnections' in server) server.closeAllConnections();
  void core.close().finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
