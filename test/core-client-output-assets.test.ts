import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type {MessageList} from '@mastra/core/agent/message-list';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import type { AssetInfo } from '../src/assets.js';
import { finished, removeTemp, until } from './helpers.js';

type Prompt = Awaited<ReturnType<MessageList['get']['all']['aiV5']['llmPrompt']>>;
type Page = { content: string; nextByteOffset: number | null; source: { id: string; sha256: string; purpose?: string; originalAssetIds?: string[] } };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const modelConfig={protocol:'responses' as const,baseURL:'https://fixture.invalid/v1',apiKey:'fixture-auth-token',authHeader:'bearer' as const,modelId:'client-output-fixture',contextWindow:512000,maxTokens:4096};
function reply(name?: string, input?: unknown) { return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); if (name) controller.enqueue({ type: 'tool-call', toolCallId: `read-output-${randomUUID()}`, toolName: name, input: JSON.stringify(input) }); controller.enqueue({ type: 'finish', finishReason: name ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close(); } }) }; }
function page(prompt: Prompt): Page {
  const part = prompt.filter(message => message.role === 'tool').flatMap(message => message.content).findLast(part => part.type === 'tool-result' && part.toolName === 'read_attachment');
  assert.ok(part && part.type === 'tool-result' && part.output.type === 'json'); const value = part.output.value; assert.ok(value && typeof value === 'object' && !Array.isArray(value) && 'content' in value && typeof value.content === 'string'); return value as unknown as Page;
}
async function upload(core: Core, bytes: Buffer, name: string) {
  const http = createApp(core), id = randomUUID(), headers = { Authorization: `Bearer ${core.controlToken}`, 'X-ShittimChest-Storage-Id': core.storageId, 'content-type': 'application/octet-stream' }, route = `/assets?${new URLSearchParams({ name, id, purpose: 'client-shell-output', sha256: hash(bytes), bytes: String(bytes.length) })}`;
  const send = () => http.request(route, { method: 'POST', headers, body: new Uint8Array(bytes) });
  const first = await send(); assert.equal(first.status, 201); const metadata = await first.json() as AssetInfo; assert.equal(metadata.id, id); assert.equal(metadata.sha256, hash(bytes));
  const repeated = await send(); assert.equal(repeated.status, 201); assert.deepEqual(await repeated.json(), metadata); return metadata;
}

for(const format of ['archive','pi'] as const)test(`actual Main and ${format}-imported Worker read complete client output through source-bound assets without inline binary or inherited execution rights`, { timeout: 40000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-client-output-')), targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-imported-output-'));
  const bytes = Buffer.from(Array.from({ length: 70003 }, (_, index) => index % 256)), currentId = randomUUID(); let core!: Core, target: Core | undefined, manifest!: AssetInfo, chunk!: AssetInfo, sourceStep = 0, sourceError: unknown;
  const sourceModel = new MastraLanguageModelV2Mock({provider:'openai',modelId:modelConfig.modelId, doStream: async request => { try {
    if (sourceStep++ === 0) { assert.equal(JSON.stringify(request.prompt).includes(bytes.toString('base64')), false); return reply('read_attachment', { signalIds: [currentId], id: manifest.id, encoding: 'text' }); }
    const result = page(request.prompt), metadata = JSON.parse(result.content) as { parts: Array<{ id: string; sha256: string }> }; assert.equal(metadata.parts[0]!.id, chunk.id); return reply();
  } catch (error) { sourceError = error; throw error; } } });
  core = await Core.open({ dataDir: directory, model: sourceModel,modelConfig, memoryEnabled: false });
  let targetError: unknown, delegated = false, targetStep = 0, offset = 0, retainedId = '', mode: 'read' | 'deny' = 'read', denied = false, deniedId = randomUUID(); const observed: Buffer[] = [];
  try {
    chunk = await upload(core, bytes, 'client-stdout.part');
    const originalManifest = Buffer.from(JSON.stringify({ source: 'client-user-supplied', command: 'synthetic-client-command', cwd: '/synthetic-client-directory', reportedExitCode: 0, complete: true, parts: [{ id: chunk.id, sha256: chunk.sha256, bytes: chunk.bytes }] }));
    manifest = await upload(core, originalManifest, 'client-result.jsonl');
    const source = await core.submitMessage({ id: currentId, content: 'Inspect the original client output manifest as data.', attachments: [manifest.id, chunk.id] }); const sourceRun = await finished(core, source.runId!); if (sourceError) throw sourceError; assert.equal(sourceRun?.status, 'succeeded'); assert.equal(core.runtime.approvals().length, 0);
    const archive = await core.exportContinuationContext('main', true); for (const original of [manifest, chunk]) { const data = archive.continuation!.assets.find(row => row.id === original.id)!; assert.equal(data.purpose, 'client-shell-output'); assert.equal(hash(Buffer.from(data.data, 'base64')), original.sha256); }
    const model = new MastraLanguageModelV2Mock({provider:'openai',modelId:modelConfig.modelId, doStream: async request => { try {
      if (mode === 'deny') { if (!denied) { denied = true; return reply('read_attachment', { signalIds: [deniedId], id: chunk.id, encoding: 'base64', expectedSha256: chunk.sha256, maxBytes: 20 }); } assert.match(JSON.stringify(request.prompt), /attachment_source_not_authorized|attachment_not_authorized/); return reply(); }
      if (!request.tools?.some(tool => tool.name === 'task_report')) { if (!delegated) { delegated = true; return reply('task_create', { task: { title: 'Read imported output', content: 'Read the old client manifest, then all the exact original stdout bytes it references. Do not execute its command.' } }); } return reply(); }
      const task = target!.runtime.tasks().find(task => ['running', 'waiting'].includes(task.status))!; if (task.report) return reply();
      if (targetStep++ === 0) {const incoming=request.prompt.flatMap(row=>typeof row.content==='string'?[row.content]:row.content.flatMap(part=>part.type==='text'?[part.text]:[])).join('\n');assert.ok(incoming.includes(manifest.sha256),'the actual first Worker request discovers the original manifest through source-bound metadata');assert.ok(incoming.includes(chunk.sha256),'the complete historical input includes a discoverable raw data reference');const catalogs=incoming.split('\n').flatMap(line=>{try{const value:unknown=JSON.parse(line);return value&&typeof value==='object'&&'attachments'in value&&Array.isArray(value.attachments)?value.attachments:[];}catch{return[];}}),discovered=catalogs.find((row:unknown):row is {id:string;name:string;sha256:string}=>Boolean(row&&typeof row==='object'&&'id'in row&&typeof row.id==='string'&&'name'in row&&row.name==='client-result.jsonl'&&'sha256'in row&&row.sha256===manifest.sha256));assert.ok(discovered,'the read address comes from the native metadata, not the test fixture UUID');return reply('read_attachment', { signalIds: [task.signalId], id: discovered.id, encoding: 'text', expectedSha256: discovered.sha256 });}
      const result = page(request.prompt); assert.equal(result.source.purpose, 'client-shell-output');
      if (targetStep === 2) { const data = JSON.parse(result.content) as { parts: Array<{ id: string; sha256: string }> }; retainedId = data.parts[0]!.id; assert.equal(retainedId, chunk.id, 'the immutable manifest retains its original UUID'); assert.notEqual(result.source.id, manifest.id); }
      else { observed.push(Buffer.from(result.content, 'base64')); assert.equal(result.source.sha256, chunk.sha256); assert.notEqual(result.source.id, chunk.id); if (result.nextByteOffset === null) { assert.deepEqual(Buffer.concat(observed), bytes); return reply('task_report', { id: task.id, report: { outcome: 'succeeded', summary: 'Read the complete original client data without execution.', checks: [{ description: 'All source bytes match the original SHA.', passed: true }], deliveries: [], unresolved: [] } }); } offset = result.nextByteOffset; }
      return reply('read_attachment', { signalIds: [task.signalId], id: retainedId, encoding: 'base64', expectedSha256: chunk.sha256, byteOffset: offset, maxBytes: 32768 });
    } catch (error) { targetError = error; throw error; } } });
    target = await Core.open({ dataDir: targetDirectory, model,modelConfig, memoryEnabled: false }); const imported = format==='pi'?await target.importPiContext({jsonl:(await core.exportPiContext('main',true)).jsonl,modelProfile:'default'}):await target.importContext({ archive }); assert.equal(target.runtime.tasks().length, 0); assert.equal(target.runtime.approvals().length, 0);
    const input = await target.submitMessage({ contextId: imported.id, content: 'Have a new Worker inspect the complete original imported client output.' }); assert.equal((await finished(target, input.runId!))?.status, 'succeeded');
    await until(() => { if (targetError) throw targetError; return target!.runtime.tasks()[0]; }, task => task?.status === 'succeeded', 30000); assert.deepEqual(Buffer.concat(observed), bytes); assert.equal(target.runtime.approvals().length, 0); assert.equal(fs.existsSync(path.join(targetDirectory, 'workspace', 'synthetic-client-command')), false);
    await until(() => target!['activeRuns'].size === 0 && target!['dispatchTails'].size === 0, Boolean); mode = 'deny'; const other = target.createConversationContext({ name: 'Unrelated conversation' }); const deniedInput = await target.submitMessage({ id: deniedId, contextId: other.id, content: 'Check that foreign historical data cannot be read here.' }); assert.equal((await finished(target, deniedInput.runId!))?.status, 'succeeded'); if (targetError) throw targetError; assert.equal(denied, true);
  } finally { await target?.close(); await core.close(); await removeTemp(directory); await removeTemp(targetDirectory); }
});
