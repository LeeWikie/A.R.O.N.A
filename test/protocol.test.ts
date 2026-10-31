import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createModel } from '../src/model.js';
import type { ModelConfig } from '../src/config.js';

const args = JSON.stringify({ signalIds: ['00000000-0000-4000-8000-000000000001'], text: 'Fixture reply' });
const tool = { type: 'function' as const, name: 'emit_message', description: 'Fixture tool', inputSchema: { type: 'object' as const, properties: { text: { type: 'string' as const } } } };

function events(protocol: ModelConfig['protocol']) {
  if (protocol === 'chat-completions') return [
    { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'emit_message', arguments: args } }] }, finish_reason: null }] },
    { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
  ].map(data => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n';
  if (protocol === 'responses') {
    const item = { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'emit_message', arguments: args, status: 'completed' };
    const response = { id: 'resp-1', object: 'response', created_at: 1, model: 'fixture', status: 'in_progress', output: [] as unknown[] };
    return [
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-1', output_index: 0, delta: args },
      { type: 'response.function_call_arguments.done', item_id: 'fc-1', output_index: 0, arguments: args },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } },
    ].map((data, sequence_number) => `event: ${data.type}\ndata: ${JSON.stringify({ ...data, sequence_number })}\n\n`).join('');
  }
  return [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'emit_message', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ].map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
  test(`${protocol}: explicit endpoint, authentication and streamed tool arguments`, async () => {
    let requestPath = '';
    let headers: Record<string, string | string[] | undefined> = {};
    let requestBody: Record<string, unknown> = {};
    const server = createServer(async (req, res) => {
      requestPath = req.url!;
      headers = req.headers;
      let body = '';
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events(protocol));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const model = createModel({ protocol, baseURL: `http://127.0.0.1:${address.port}/v1`, modelId: 'fixture-model', apiKey: 'fixture-only-key', authHeader: 'api-key' });
      const result = await model.doStream({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Call the fixture tool' }] },
          ...(protocol === 'responses' ? [{ role: 'assistant' as const, content: [{ type: 'reasoning' as const, text: '', providerOptions: { openai: { itemId: 'rs-fixture', reasoningEncryptedContent: 'encrypted-fixture' } } }] }] : []),
        ],
        tools: [tool], maxOutputTokens: 128,
        ...(protocol === 'chat-completions' ? { providerOptions: { openai: { reasoningEffort: 'none' } } }
          : protocol === 'responses' ? { providerOptions: { openai: { store: false, include: ['reasoning.encrypted_content'] } } } : {}),
      });
      const chunks: unknown[] = [];
      for await (const chunk of result.stream) chunks.push(chunk);
      const calls = chunks.filter((chunk): chunk is { type: string; toolName: string; input: string } => !!chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'tool-call');
      assert.equal(calls.length, 1, JSON.stringify(chunks));
      assert.equal(calls[0]!.toolName, 'emit_message');
      assert.deepEqual(JSON.parse(calls[0]!.input), JSON.parse(args));
      assert.equal(requestPath, `/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`);
      assert.equal(requestBody.model, 'fixture-model');
      assert.equal(requestBody.stream, true);
      assert.equal(protocol === 'messages' ? headers['x-api-key'] : headers.authorization,
        protocol === 'messages' ? 'fixture-only-key' : 'Bearer fixture-only-key');
      if (protocol === 'chat-completions') assert.equal(requestBody.reasoning_effort, 'none');
      if (protocol === 'responses') {
        assert.equal(requestBody.store, false);
        const input = requestBody.input as Array<{ type?: string; encrypted_content?: string }>;
        assert.ok(!input.some(item => item.type === 'item_reference'));
        assert.ok(input.some(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted-fixture'));
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
