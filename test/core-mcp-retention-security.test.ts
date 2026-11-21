import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import type { McpResultReference } from '../src/tools/mcp-results.js';
import { authenticatedApp, until, removeTemp } from './helpers.js';

const marker = 'SYNTHETIC_MCP_RETAINED_MIDDLE_CANARY';
function reply(name?: string, input: unknown = {}, id = 'empty') {
  return { stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    if (name) controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) });
    controller.enqueue({ type: 'finish', finishReason: name ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
  } }) };
}
for (const mode of ['same-source', 'supplement', 'source-rewrite', 'permission-revoked', 'mcp-key-revoked', 'once-receipt-rewrite', 'call-rewrite', 'other-context', 'other-workspace', 'before-result', 'unknown-reference', 'record-changed'] as const) test(`retained MCP pages preserve their actual source and selected native call: ${mode}`, { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-retained-proof-'));
  const text = Array.from({ length: 4000 }, (_, index) => index === 2000 ? marker : `original synthetic source row ${index} `.repeat(3)).join('\n');
  let calls = 0, core!: Core, phase: 'fetch' | 'after-fetch' | 'read' | 'after-read' = 'fetch', reference: McpResultReference | undefined, modelError: unknown, mutated = false;
  const prompts: string[] = [];
  const remote = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body) as { id?: string | number; method: string; params?: { protocolVersion: string } };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown = {};
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-proof', version: '1' } };
    if (rpc.method === 'tools/list') result = { tools: [{ name: 'source', inputSchema: { type: 'object', properties: {} } }] };
    if (rpc.method === 'tools/call') { calls++; result = { content: [{ type: 'text', text }], _meta: { private: 'SYNTHETIC_PRIVATE_PROTOCOL_CANARY' } }; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening'); const address = remote.address(); assert.ok(address && typeof address !== 'string');
  const model = new MastraLanguageModelV2Mock({ doStream: async request => { try {
    if (!request.tools?.some(tool => tool.name === 'task_report')) return reply();
    const task = core.runtime.tasks().find(row => ['running', 'waiting'].includes(row.status)); assert.ok(task);
    const prompt = JSON.stringify(request.prompt); prompts.push(prompt); assert.doesNotMatch(prompt, /SYNTHETIC_PRIVATE_PROTOCOL_CANARY/);
    if (phase === 'fetch') { phase = 'after-fetch'; return reply('ext_proof_source', {}, 'original-mcp-call'); }
    if (phase === 'after-fetch') {
      const event = core.runtime.events(task.contextId, 0, 1000).find(event => event.kind === 'tool_end' && (event.data as { toolCallId?: string }).toolCallId === 'original-mcp-call'); assert.ok(event);
      assert.equal((event.data as { isError?: boolean }).isError, false, JSON.stringify(event.data));
      reference = (event.data as { result: { references: McpResultReference[] } }).result.references.find(row => row.representation === 'mcp-model-text'); assert.ok(reference); return reply();
    }
    if (phase === 'read') {
      if (!mutated) {
        mutated = true; assert.ok(reference);
        if (mode === 'source-rewrite') { const binding = core.mcpResultStore().describe(reference.id).binding, id = binding.sourceSignalIds.find(id => !task.sourceSignalIds.includes(id)); assert.ok(id); const row = core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(id); assert.ok(row); const input = JSON.parse(String(row.body)); input.content += ' CHANGED_SOURCE'; core.store.db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(input), id); }
        if (mode === 'permission-revoked') core.runtime.updateTask(task.id, { grants: { ...task.grants, mcp: false } });
        if (mode === 'mcp-key-revoked') core.runtime.updateTask(task.id, { mcpKeys: [] });
        if (mode === 'once-receipt-rewrite') { const approval=core.runtime.approvals().find(row=>row.toolCallId==='original-mcp-call'); assert.ok(approval); const row=core.store.db.prepare('SELECT body FROM approvals WHERE id=?').get(approval.id); assert.ok(row); const value=JSON.parse(String(row.body)); value.args={changed:true}; core.store.db.prepare('UPDATE approvals SET body=? WHERE id=?').run(JSON.stringify(value),approval.id); }
        if (mode === 'call-rewrite') {
          const binding = core.mcpResultStore().describe(reference.id).binding;
          for (const row of core.store.db.prepare("SELECT seq,data FROM runtime_events WHERE context_id=? AND run_id=? AND kind IN ('message_start','message_update')").all(binding.contextId, binding.runId)) {
            const data = JSON.parse(String(row.data)), parts = data.message?.id === binding.nativeMessageId ? data.message.content.parts : data.id === binding.nativeMessageId && data.event?.type === 'part' ? [data.event.part] : [];
            let changed = false; for (const part of parts) if (part.type === 'tool-invocation' && part.toolInvocation.toolCallId === binding.toolCallId) { part.toolInvocation.args = { changed: true }; changed = true; }
            if (changed) core.store.db.prepare('UPDATE runtime_events SET data=? WHERE seq=?').run(JSON.stringify(data), row.seq!);
          }
        }
        if (mode === 'record-changed') { const row = core.store.db.prepare('SELECT body FROM mcp_result_records WHERE id=?').get(reference.id); assert.ok(row); const value = JSON.parse(String(row.body)); value.binding.proof = '0'.repeat(64); core.store.db.prepare('UPDATE mcp_result_records SET body=? WHERE id=?').run(JSON.stringify(value), reference.id); }
        if (mode === 'supplement') { await core.taskMessage(task.id, 'A genuinely accepted later supplement.', task.sourceSignalIds); return reply('list_attachments',{signalIds:[task.signalId]},'observe-new-supplement'); }
      }
      if (mode === 'supplement') assert.match(prompt, /A genuinely accepted later supplement/);
      phase = 'after-read'; return reply('read_mcp_result', { id: mode === 'unknown-reference' ? 'mcp-result.' + randomUUID() : reference!.id, signalIds: [task.signalId], offset: 2001, limit: 1 }, 'read-original-mcp');
    }
    return reply();
  } catch (error) { modelError = error; throw error; } } });
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    await core.capabilities.saveMCP({ id: 'proof', url: `http://127.0.0.1:${address.port}`, protocolVersion: 'legacy' }); await core.capabilities.connect('proof');
    const source = await core.submitTask({ title: 'Original synthetic MCP source', content: 'Obtain the original complete source.', grants: { write: false, execute: false, mcp: mode!=='once-receipt-rewrite' } }, 'mcp-proof-original');
    await until(async () => { if (modelError) throw modelError; if(mode==='once-receipt-rewrite')for(const approval of core.runtime.approvals().filter(row=>row.status==='pending')){assert.equal(approval.toolName,'ext_proof_source');const response=await authenticatedApp(core).request(`/approvals/${approval.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"decision":"approve"}'});assert.equal(response.status,200);}return core.runtime.task(source.id); }, row => ['unreported', 'failed', 'blocked'].includes(row.status)); assert.ok(reference); assert.equal(calls, 1); assert.ok(prompts.every(prompt => !prompt.includes(marker)));
    const original = core.runtime.task(source.id), oldRun = original.runIds.at(-1)!; await core.sessions.waitForNativePersistence(oldRun, AbortSignal.timeout(1000));
    if (mode === 'before-result') { const row = core.sessionGraph.records(original.contextId).find(row => row.source?.runId === oldRun && row.entry.type === 'message' && row.entry.message.role === 'assistant' && row.entry.message.content.some(part => part.type === 'toolCall' && part.id === 'original-mcp-call')); assert.ok(row); core.sessionGraph.select(original.contextId, row.entry.id); }
    phase = 'read'; let targetId = source.id;
    if (mode === 'other-context' || mode === 'other-workspace') {
      let workspaceId: string | undefined; if (mode === 'other-workspace') { const root = path.join(directory, 'other'); fs.mkdirSync(root); core.configure('workspace', { id: 'other', name: 'Other', path: root }); workspaceId = 'other'; }
      targetId = (await core.submitTask({ title: 'Other source', content: 'Try reading an unrelated reference.', ...(workspaceId ? { workspaceId } : {}) }, 'mcp-proof-other')).id;
    } else await core.tasks.control(original.id, 'retry', original.revision);
    await until(() => { if (modelError) throw modelError; return core.runtime.task(targetId); }, row => row.runIds.at(-1)!==oldRun&&['unreported', 'failed', 'interrupted', 'blocked'].includes(row.status));
    const target = core.runtime.task(targetId), event = core.runtime.events(target.contextId, 0, 2000).find(event => event.runId === target.runIds.at(-1) && event.kind === 'tool_end' && (event.data as { toolCallId?: string }).toolCallId === 'read-original-mcp'); assert.ok(event, 'the actual native read boundary is observed');
    const success = mode === 'same-source' || mode === 'supplement'; assert.equal((event.data as { isError?: boolean }).isError, !success, JSON.stringify(event.data));
    if (success) { assert.match(JSON.stringify((event.data as { result: unknown }).result), new RegExp(marker)); assert.ok(prompts.some(prompt => prompt.includes(marker))); }
    else { assert.ok(prompts.every(prompt => !prompt.includes(marker))); assert.match(JSON.stringify((event.data as { result: unknown }).result), /mcp_result_(?:not_authorized|source_changed|origin_unavailable|changed)|session_artifact_not_authorized/); }
    assert.equal(calls, 1, 'reading retained bytes never replays the remote call');
  } finally { await core.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); await removeTemp(directory); }
});
