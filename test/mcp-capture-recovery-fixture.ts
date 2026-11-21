import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import type { McpResultsHost } from '../src/tools/mcp-result-tools.js';

const [directory, endpoint, phase] = process.argv.slice(2);
if (!directory || !endpoint || !phase) throw new Error('missing fixture arguments');
if (phase === 'first') {
  const factory = Reflect.get(Core.prototype, 'mcpResultsHost') as () => McpResultsHost;
  Reflect.set(Core.prototype, 'mcpResultsHost', function (this: Core): McpResultsHost {
    const host = Reflect.apply(factory, this, []);
    return { ...host, capture: async (...args) => {
      const result = await host.capture(...args);
      process.send?.({ type: 'captured', result, runId: this.activeTool(args[3]).runId, nativeMessageId: args[3].agent?.messageId });
      await new Promise<never>(() => {});
      return result;
    } };
  });
}
let core: Core, step = 0;
const reply = (name?: string, input: unknown = {}) => ({ stream: new ReadableStream({ start(controller) {
  controller.enqueue({ type: 'stream-start', warnings: [] });
  if (name) controller.enqueue({ type: 'tool-call', toolCallId: `${phase}-call-${step++}`, toolName: name, input: JSON.stringify(input) });
  controller.enqueue({ type: 'finish', finishReason: name ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
} }) });
const model = new MastraLanguageModelV2Mock({ doStream: async request => {
  if (!request.tools?.some(tool => tool.name === 'task_report')) return reply();
  const task = core.runtime.tasks().find(row => ['running', 'waiting'].includes(row.status)); if (!task || task.report) return reply();
  if (phase === 'first') return reply('ext_capture_effect');
  const prompt = JSON.stringify(request.prompt), ref = prompt.match(/Full output: (mcp-result\.[0-9a-f-]{36})/)?.[1];
  const packetFailed=/remote tool reported an error|declared output validation failed|"isError":true|"status":"tool-error"|"status":"output-invalid"/.test(prompt);
  process.send?.({ type: 'resume-model', ref, packetFailed, prompt: request.prompt });
  if (step === 0) {
    if (!ref) throw new Error('The recovered native prompt lost the actually received MCP result.');
    return reply('read_mcp_result', { id: ref, signalIds: [task.signalId], offset: 2001, limit: 1 });
  }
  const verified = prompt.includes('SYNTHETIC_CAPTURED_ORIGINAL_MIDDLE');
  return reply('task_report', { id: task.id, report: { outcome: verified ? packetFailed?'failed':'succeeded' : 'blocked', summary: verified ? 'Verified the original received MCP data.' : 'The original received MCP data is unavailable.', checks: [{ description: 'The original received packet was retained and read without another remote call.', passed: verified }], deliveries: [], unresolved: packetFailed?['The original remote packet did not establish business success.']:verified ? [] : ['Original packet missing.'] } });
} });
core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
if (phase === 'first') { await core.capabilities.saveMCP({ id: 'capture', url: endpoint, protocolVersion: 'legacy' }); await core.capabilities.connect('capture'); }
const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => { const address = server.address(); if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port, token: core.controlToken }); });
process.on('message', value => { if (value && typeof value === 'object' && 'type' in value && value.type === 'inspect') process.send?.({ type: 'inspection', tasks: core.runtime.tasks(), runs: core.store.db.prepare('SELECT * FROM runs').all(), events: core.runtime.events(undefined, 0, 2000), sources:core.store.db.prepare('SELECT id,body FROM session_graph_sources').all(),captures: core.store.db.prepare("SELECT id,body FROM runtime_settings WHERE id LIKE 'mcp-capture:%'").all() }); });
process.once('SIGTERM', () => { server.close(); if ('closeAllConnections' in server) server.closeAllConnections(); void core.close().finally(() => process.exit(0)); });
