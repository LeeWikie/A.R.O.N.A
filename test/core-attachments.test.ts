import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import type { AssetInfo } from '../src/assets.js';
import { authenticatedApp, until, removeTemp } from './helpers.js';

function response(name: string | undefined, input: unknown, id: number) {
  return { stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    if (name) controller.enqueue({ type: 'tool-call', toolCallId: `attachment-${id}`, toolName: name, input: JSON.stringify(input) });
    controller.enqueue({ type: 'finish', finishReason: name ? 'tool-calls' : 'stop', usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } }); controller.close();
  } }) };
}

test('a normal uploaded document is delegated, paged and delivered through the native core without exposing unrelated uploads', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-attachment-')); let core!: Core; let attached!: AssetInfo; let unrelated!: AssetInfo; let dispatched = false, workerStep = 0, call = 0; let modelFailure: unknown;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    try {
    const worker = request.tools?.some(tool => tool.name === 'task_report'), prompt = JSON.stringify(request.prompt);
    if (!worker) {
      if (dispatched) return response(undefined, {}, ++call);
      dispatched = true; assert.match(prompt, /external-attachment-data/); assert.ok(prompt.includes(attached.id)); assert.ok(!prompt.includes('LAST_DOCUMENT_LINE'));
      return response('task_create', { task: { title: 'Read complete attached notebook', content: `Read attachment ${attached.id} through the last line and report its contents.` } }, ++call);
    }
    const task = core.runtime.tasks().find(task => task.status === 'running'); assert.ok(task);
    const step = workerStep++;
    if (step === 0) return response('read_attachment', { id: attached.id, signalIds: [task.signalId], offset: 2001, limit: 2000 }, ++call);
    if (step === 1) { assert.ok(prompt.includes('LAST_DOCUMENT_LINE')); return response('read_attachment', { id: unrelated.id, signalIds: [task.signalId] }, ++call); }
    if (step === 2) {
      assert.ok(prompt.includes('attachment_not_authorized')); assert.ok(!prompt.includes('UNRELATED_UPLOAD_CANARY'));
      return response('task_report', { id: task.id, report: { outcome: 'succeeded', summary: 'The last line is LAST_DOCUMENT_LINE.', checks: [{ description: 'The final document page was actually read.', passed: true }], deliveries: [], unresolved: [] } }, ++call);
    }
    return response(undefined, {}, ++call);
    } catch (error) { modelFailure = error; throw error; }
  } });
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const app = authenticatedApp(core), notebook = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'markdown', source: Array.from({ length: 2500 }, (_, index) => index === 2499 ? 'LAST_DOCUMENT_LINE\n' : `Synthetic line ${index + 1}\n`) }] });
    attached = await (await app.request('/assets?name=source.ipynb', { method: 'POST', body: notebook })).json() as AssetInfo;
    unrelated = await (await app.request('/assets?name=other.txt', { method: 'POST', body: 'UNRELATED_UPLOAD_CANARY' })).json() as AssetInfo;
    const submitted = await app.request('/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Read the entire attached notebook and report its last line.', attachments: [attached.id] }) }); assert.equal(submitted.status, 202);
    try {
      await until(() => { if (modelFailure) throw modelFailure; return core.runtime.tasks(); }, tasks => tasks.length === 1 && ['succeeded', 'failed', 'blocked', 'unreported'].includes(tasks[0]!.status));
    } catch (error) {
      throw new Error(JSON.stringify({ cause: String(error), dispatched, workerStep, tasks: core.runtime.tasks().map(task => ({ status: task.status, report: task.report })), pendingApprovals: core.runtime.approvals().filter(approval => approval.status === 'pending').map(approval => ({ toolName: approval.toolName, status: approval.status })) }));
    }
    assert.equal(core.runtime.tasks()[0]?.status, 'succeeded'); assert.match(core.runtime.tasks()[0]?.report?.summary??'', /LAST_DOCUMENT_LINE/);
    assert.equal(core.runtime.approvals().filter(approval => approval.status === 'pending').length, 0);
    assert.equal((await core.assets.read(attached.id)).bytes.toString('utf8'), notebook);
  } finally { await core.close(); await removeTemp(directory); }
});
