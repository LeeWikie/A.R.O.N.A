import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { documentFixture } from './document-fixture.js';
import { until, removeTemp } from './helpers.js';

test('a real core run reads an Office document through native read_file and writes its checked delivery without manual conversion', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-documents-')); let core!: Core; let round = 0; const actions: string[] = [];
  const output = 'Synthetic 中文 document: violet-17; Table value 42\n';
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const task = core.runtime.tasks().find(task => task.status === 'running');
    const worker = task && request.tools?.some(tool => tool.name === 'task_report');
    let action: { name: string; input: unknown } | undefined;
    if (worker && round === 0) action = { name: 'mastra_workspace_read_file', input: { path: 'source.docx' } };
    if (worker && round === 1) {
      const prompt = JSON.stringify(request.prompt); assert.match(prompt, /external-document-data/); assert.match(prompt, /violet-17/); assert.match(prompt, /Table value 42/);
      assert.ok(!request.prompt.some(message => message.role === 'user' && message.content.some(part => part.type === 'text' && part.text.includes('Table value 42'))));
      action = { name: 'mastra_workspace_write_file', input: { path: 'result.txt', content: output } };
    }
    if (worker && round === 2) action = { name: 'task_report', input: { id: task.id, report: { outcome: 'succeeded', summary: 'Read the document and wrote the requested text.', checks: [{ description: 'Document marker and table value were read.', passed: true }], deliveries: [], unresolved: [] } } };
    if (worker) round++;
    if (action) actions.push(action.name);
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (action) controller.enqueue({ type: 'tool-call', toolCallId: `doc-${round}`, toolName: action.name, input: JSON.stringify(action.input) });
      controller.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } }); controller.close();
    } }) };
  } });
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const bytes = documentFixture(), file = path.join(directory, 'workspace/source.docx'); fs.writeFileSync(file, bytes);
    const task = await core.submitTask({ title: 'Read an Office document', content: 'Read source.docx and write its marker and table value into result.txt.', grants: { write: true, execute: false, mcp: false } }, 'document-task');
    await until(() => core.runtime.task(task.id), value => ['succeeded', 'failed', 'blocked', 'unreported'].includes(value.status));
    assert.equal(core.runtime.task(task.id).status, 'succeeded'); assert.deepEqual(actions, ['mastra_workspace_read_file', 'mastra_workspace_write_file', 'task_report']);
    assert.equal(fs.readFileSync(path.join(directory, 'workspace/result.txt'), 'utf8'), output); assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(core.runtime.approvals().filter(approval => approval.status === 'pending').length, 0);
  } finally { await core.close(); await removeTemp(directory); }
});
