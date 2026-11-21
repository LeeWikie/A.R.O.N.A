import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import type { TaskRecord } from '../src/runtime-store.js';
import { until, removeTemp } from './helpers.js';

async function launch(directory: string, endpoint: string, phase: string) {
  const child = fork(fileURLToPath(new URL('./mcp-capture-recovery-fixture.ts', import.meta.url)), [directory, endpoint, phase], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: Array<Record<string, unknown>> = []; let output = '';
  child.stdout?.on('data', bytes => { output += String(bytes); }); child.stderr?.on('data', bytes => { output += String(bytes); });
  child.on('message', value => { if (value && typeof value === 'object') messages.push(value as Record<string, unknown>); });
  const ready = await until(() => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(output); return messages.find(row => row.type === 'ready'); }, Boolean); assert.ok(ready);
  return { child, messages, output: () => output, async request<T>(route: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${ready.port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }, async inspect() { const start = messages.length; child.send({ type: 'inspect' }); return until(() => messages.slice(start).find(row => row.type === 'inspection'), Boolean); } };
}
async function stop(child: ChildProcess, hard = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(hard ? 'SIGKILL' : 'SIGTERM'); let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); })]); } finally { clearTimeout(timer); }
}
for(const mode of ['returned','tool-error','output-invalid','receipt-changed','source-changed','call-changed'] as const)test(`a received MCP packet survives SIGKILL before native tool_end without replaying its external effect: ${mode}`, { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-mcp-capture-crash-')), workers: Array<Awaited<ReturnType<typeof launch>>> = [];
  let effects = 0;
  const text = Array.from({ length: 4000 }, (_, index) => index === 2000 ? 'SYNTHETIC_CAPTURED_ORIGINAL_MIDDLE' : `original remote row ${index} `.repeat(3)).join('\n');
  const remote = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; } let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body) as { id?: string | number; method: string; params?: { protocolVersion: string } }; if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown = {};
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'capture-boundary', version: '1' } };
    if (rpc.method === 'tools/list') result = { tools: [{ name: 'effect', inputSchema: { type: 'object', properties: {} },...(mode==='output-invalid'?{outputSchema:{type:'object',properties:{requiredFact:{type:'string'}},required:['requiredFact']}}:{}) }] };
    if (rpc.method === 'tools/call') { effects++; result = { content: [{ type: 'text', text }],...(mode==='tool-error'?{isError:true}:mode==='output-invalid'?{structuredContent:{different:'original unvalidated data'}}:{}),_meta: { private: 'SYNTHETIC_CAPTURE_PRIVATE_METADATA' } }; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  }); remote.listen(0, '127.0.0.1'); await once(remote, 'listening'); const address = remote.address(); assert.ok(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const first = await launch(directory, endpoint, 'first'); workers.push(first);
    const created = await first.request<TaskRecord>('/tasks', { title: 'Recover received source', content: 'Use the original remote data without replaying completed effects.', grants: { write: false, execute: false, mcp: true } }); assert.equal(created.status, 202);
    const captured = await until(() => first.messages.find(row => row.type === 'captured'), Boolean); assert.ok(captured); assert.equal(effects, 1);
    const inspection = await first.inspect(); assert.ok(inspection); assert.equal((inspection.events as Array<{ kind: string }>).filter(row => row.kind === 'tool_end').length, 0, 'the crash occurs before native tool completion'); assert.equal((inspection.captures as unknown[]).length, 1);
    await stop(first.child, true);
    const rejected=['receipt-changed','source-changed','call-changed'].includes(mode);
    if(rejected){const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{const row=db.prepare("SELECT id,body FROM runtime_settings WHERE id LIKE 'mcp-capture:%'").get();assert.ok(row);const receipt=JSON.parse(String(row.body));if(mode==='receipt-changed'){receipt.result.references[0].sha256='0'.repeat(64);db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(receipt),row.id!);}if(mode==='source-changed'){const row=db.prepare("SELECT id,body FROM signals WHERE json_extract(body,'$.source')='authenticated-control'").get();assert.ok(row);const input=JSON.parse(String(row.body));input.content+=' CHANGED_SOURCE';db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(input),row.id!);}if(mode==='call-changed')for(const row of db.prepare("SELECT seq,data FROM runtime_events WHERE kind='message_start' AND json_extract(data,'$.message.id')=?").all(receipt.binding.nativeMessageId)){const data=JSON.parse(String(row.data));for(const part of data.message.content.parts)if(part.type==='tool-invocation'&&part.toolInvocation.toolCallId===receipt.binding.toolCallId)part.toolInvocation.args={changed:true};db.prepare('UPDATE runtime_events SET data=? WHERE seq=?').run(JSON.stringify(data),row.seq!);}}finally{db.close();}}
    const second = await launch(directory, endpoint, 'resume'); workers.push(second);
    const interrupted = (await second.request<TaskRecord>(`/tasks/${created.body.id}`)).body; assert.equal(interrupted.status, 'interrupted');
    assert.equal((await second.request(`/tasks/${created.body.id}/retry`, { revision: interrupted.revision })).status, 202);
    const result = await until(async () => (await second.request<TaskRecord>(`/tasks/${created.body.id}`)).body, row => ['succeeded', 'failed', 'blocked', 'unreported'].includes(row.status));
    if(rejected){assert.ok(['failed','blocked'].includes(result.status),JSON.stringify(result));assert.equal(effects,1);assert.ok(second.messages.filter(row=>row.type==='resume-model').every(row=>row.ref===undefined));const state=await second.inspect();assert.ok(state);assert.equal((state.events as Array<{runId:string;kind:string}>).filter(row=>row.runId===captured.runId&&row.kind==='session_tool_recovered').length,0);return;}
    assert.equal(result.status, mode==='returned'?'succeeded':'failed', JSON.stringify({ messages: second.messages.filter(row => row.type !== 'ready'), output: second.output() }));assert.equal(result.report?.outcome,mode==='returned'?'succeeded':'failed');
    assert.equal(effects, 1); assert.ok(second.messages.some(row => row.type === 'resume-model' && typeof row.ref === 'string'));
    assert.equal((await second.request<{ status: string }>(`/runs/${captured.runId}`)).body.status, 'interrupted');
    const after=await second.inspect();assert.ok(after);assert.deepEqual(after.captures,inspection.captures,'the original capture receipt remains byte-identical');
    const original=JSON.parse((inspection.captures as Array<{body:string}>)[0]!.body),source=(after.sources as Array<{id:string;body:string}>).find(row=>row.id===original.nativeMessage.id);assert.ok(source);assert.deepEqual(JSON.parse(source.body),original.nativeMessage,'the original native pending call is not rewritten');
    assert.equal((after.events as Array<{runId:string;kind:string}>).filter(row=>row.runId===captured.runId&&row.kind==='tool_end').length,0,'a recovered received packet does not create a native tool_end');
    const resumed=second.messages.find(row=>row.type==='resume-model');assert.ok(resumed);const prompt=JSON.stringify(resumed.prompt);assert.equal(prompt.split('"toolCallId":"first-call-0"').length-1,2,'the original call and its actual received result each appear once');assert.doesNotMatch(prompt,/No result provided/);
    assert.equal(resumed.packetFailed,mode!=='returned','the actual provider observes original error/validation state');
    assert.ok(second.messages.filter(row => row.type === 'resume-model').every(row => !JSON.stringify(row.prompt).includes('SYNTHETIC_CAPTURE_PRIVATE_METADATA')));
    await stop(second.child);const third=await launch(directory,endpoint,'resume');workers.push(third);const reopened=await third.inspect();assert.ok(reopened);
    assert.deepEqual(reopened.captures,inspection.captures);assert.equal(effects,1);assert.equal((reopened.events as Array<{runId:string;kind:string}>).filter(row=>row.runId===captured.runId&&row.kind==='session_tool_recovered').length,1,'the correction is published only once across another cold open');
    const snapshots=(value:Record<string,unknown>)=>(value.events as Array<{runId:string;kind:string}>).filter(row=>row.runId===captured.runId&&row.kind==='context_snapshot');assert.deepEqual(snapshots(reopened),snapshots(after),'the original archived snapshot evidence is unchanged');assert.equal(third.messages.some(row=>row.type==='resume-model'),false,'opening a completed task does not execute it again');
  } catch (error) {
    for (const worker of workers) await stop(worker.child);
    const evidence = process.env.SHITTIM_TEST_EVIDENCE_DIR; if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.cpSync(directory, fs.mkdtempSync(path.join(path.resolve(evidence), 'mcp-capture-')), { recursive: true }); } throw error;
  } finally { for (const worker of workers) await stop(worker.child); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); await removeTemp(directory); }
});
