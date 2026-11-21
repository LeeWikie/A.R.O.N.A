import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

export async function mcpPaginationFixture() {
  const calls: Array<{ method: string; cursor?: string }> = [];
  const state = { repeatCursor: false, emptyCursor: false, failMethod: '', pageSize: 1 };
  let heldTool: { entered: () => void; wait: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const rpc = JSON.parse(text) as { id?: number; method: string; params?: { protocolVersion?: string; cursor?: string; name?: string; uri?: string } };
    calls.push({ method: rpc.method, cursor: rpc.params?.cursor });
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const send = (result: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    if (rpc.method === 'initialize') { send({ protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'pagination-fixture', version: '1' } }); return; }
    if (rpc.method.endsWith('/list')) {
      const page = rpc.params?.cursor ? Number(rpc.params.cursor.split('-')[1]) : 0;
      if (state.failMethod === rpc.method && page > 0) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Synthetic second-page failure.' } })); return; }
      const count = Math.max(1, state.pageSize), indexes = Array.from({ length: count }, (_, index) => page * count + index), nextCursor = state.emptyCursor ? '' : state.repeatCursor ? 'page-1' : page < 2 ? 'page-' + (page + 1) : undefined;
      if (rpc.method === 'tools/list') send({ tools: indexes.map(index => ({ name: `tool_${index}`, description: `Synthetic tool ${index}.`, inputSchema: { type: 'object', properties: {} } })), nextCursor });
      else if (rpc.method === 'resources/list') send({ resources: indexes.map(index => ({ uri: `fixture://resource/${index}`, name: `Resource ${index}` })), nextCursor });
      else if (rpc.method === 'resources/templates/list') send({ resourceTemplates: indexes.map(index => ({ uriTemplate: `fixture://template/${index}/{name}`, name: `Template ${index}` })), nextCursor });
      else if (rpc.method === 'prompts/list') send({ prompts: indexes.map(index => ({ name: `prompt_${index}` })), nextCursor });
      else send({});
      return;
    }
    if (rpc.method === 'tools/call') { if (heldTool) { const held = heldTool; heldTool = undefined; held.entered(); await held.wait; } send({ content: [{ type: 'text', text: 'Executed ' + rpc.params?.name }] }); }
    else if (rpc.method === 'resources/read') send({ contents: [{ uri: rpc.params?.uri, text: 'Read ' + rpc.params?.uri }] });
    else send({});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { calls, state, configuration: { id: 'pages', url: `http://127.0.0.1:${address.port}`, protocolVersion: 'legacy' as const },
    holdNextTool() { let entered!: () => void, release!: () => void; const seen = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; }); heldTool = { entered, wait }; return { entered: seen, release }; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
