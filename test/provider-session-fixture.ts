import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { Core } from '../src/core.js';
import { finished } from './helpers.js';

const token = `aaa.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.bbb`;

export async function openProviderSession(directory: string, baseUrl: string): Promise<Core> {
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  try {
    const native = core.providerRegistry.getProvider('openai-codex')!;
    const model = core.providerRegistry.getModel('openai-codex', 'gpt-6-luna')!;
    core.providerRegistry.setProvider(createProvider({
      id: native.id, name: native.name, baseUrl, auth: native.auth,
      models: [{ ...model, baseUrl }], api: openAICodexResponsesApi(),
    }));
    await core.credentials.providerStore.modify('openai-codex', async () => ({ type: 'oauth', access: token, refresh: 'synthetic-refresh', expires: Date.now() + 3600000 }));
    core.models.save({ id: 'socket-fixture', name: 'Socket fixture', providerId: 'openai-codex', modelId: model.id, defaultThinkingLevel: 'max' });
    await core.switchModel('main', 'socket-fixture', 'max');
    return core;
  } catch (error) { await core.close(); throw error; }
}

export async function providerTurn(core: Core, contextId = 'main'): Promise<void> {
  const signal = await core.submitMessage({ id: randomUUID(), contextId, content: 'Return the synthetic answer.' });
  if (!signal.runId) throw new Error('Missing native run');
  const run = await finished(core, signal.runId);
  if (run?.status !== 'succeeded') throw new Error(`Provider run did not succeed: ${run?.errorCode}`);
  const output = core.store.listOutputs({ after: 0, contextId, kind: 'message' }).find(row => row.runId === signal.runId);
  if (output?.content !== 'Synthetic socket answer') throw new Error('Missing persisted provider answer');
}

export async function socketFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('Missing WebSocket port');
  let connections = 0, requests = 0;
  server.on('connection', socket => {
    connections++;
    socket.on('error', () => {});
    socket.on('message', raw => {
      const body = JSON.parse(raw.toString());
      if (body.type !== 'response.create') throw new Error('Unexpected WebSocket request');
      requests++;
      const id = `resp_${requests}`;
      const answer = { type: 'message', id: `msg_${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic socket answer', annotations: [] }] };
      for (const frame of [
        { type: 'response.created', response: { id, status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...answer, content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Synthetic socket answer' },
        { type: 'response.output_item.done', output_index: 0, item: answer },
        { type: 'response.completed', response: { id, status: 'completed', model: 'gpt-6-luna', output: [answer], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) socket.send(JSON.stringify(frame));
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}/backend-api`,
    get clients() { return server.clients.size; },
    get connections() { return connections; },
    get requests() { return requests; },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, baseUrl] = process.argv.slice(2);
  if (!directory || !baseUrl) throw new Error('Missing fixture arguments');
  const core = await openProviderSession(directory, baseUrl);
  await providerTurn(core);
  process.send?.({ type: 'ready' });
  process.once('message', () => {
    void core.close().then(() => { process.send?.({ type: 'closed' }); process.disconnect?.(); }, error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
  });
}
