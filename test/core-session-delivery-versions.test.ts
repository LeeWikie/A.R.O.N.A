import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { until, finished, removeTemp } from './helpers.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function reply(tool?: { name: string; input: unknown }, text = '') {
  return { stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    if (tool) controller.enqueue({ type: 'tool-call', toolCallId: `delivery-version-${Math.random()}`, toolName: tool.name, input: JSON.stringify(tool.input) });
    if (text) { controller.enqueue({ type: 'text-start', id: 'text' }); controller.enqueue({ type: 'text-delta', id: 'text', delta: text }); controller.enqueue({ type: 'text-end', id: 'text' }); }
    controller.enqueue({ type: 'finish', finishReason: tool ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
  } }) };
}
for(const duplicatePath of [false,true])test(`a private Main backup retains both real delivery attempts${duplicatePath?' including identical bytes at different paths':''}`, { timeout: 40000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-delivery-versions-')), targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-imported-delivery-versions-'));
  const versions = ['FIRST_VERIFIED_ORIGINAL_BYTES', 'SECOND_VERIFIED_ORIGINAL_BYTES']; let core!: Core, target: Core | undefined, delegated = false, sourceError: unknown, targetError: unknown;
  const turns = new Map<number, number>();
  const model = new MastraLanguageModelV2Mock({ doStream: async request => { try {
    if (!request.tools?.some(tool => tool.name === 'task_report')) { if (!delegated) { delegated = true; return reply({ name: 'task_create', input: { task: { title: 'Produce original versions', content: 'Write deliverable.txt and report the verified original.' } } }); } return reply(); }
    const task = core.runtime.tasks().find(task => ['running', 'waiting'].includes(task.status))!; if (task.report) return reply();
    const turn = turns.get(task.attempt) ?? 0; turns.set(task.attempt, turn + 1);
    if (task.attempt > 1 && turn === 0) return reply({ name: 'mastra_workspace_read_file', input: { path: 'deliverable.txt' } });
    if (turn === (task.attempt === 1 ? 0 : 1)) return reply({ name: 'mastra_workspace_write_file', input: { path: 'deliverable.txt', content: versions[task.attempt - 1], overwrite: true } });
    if(duplicatePath&&task.attempt===1&&turn===1)return reply({name:'mastra_workspace_write_file',input:{path:'alias.txt',content:versions[0],overwrite:true}});
    assert.equal(fs.readFileSync(path.join(directory, 'workspace', 'deliverable.txt'), 'utf8'), versions[task.attempt - 1], JSON.stringify(core.runtime.events(task.contextId).findLast(row=>row.kind==='tool_end')?.data));
    return reply({ name: 'task_report', input: { id: task.id, report: { outcome: task.attempt === 1 ? 'blocked' : 'succeeded', summary: `Original attempt ${task.attempt}`, checks: [{ description: 'The file contains the verified original bytes.', passed: true }], deliveries: [{ kind: 'file', title: 'Verified version', value: 'deliverable.txt' },...(duplicatePath&&task.attempt===1?[{kind:'file',title:'Identical original at a second path',value:'alias.txt'}]:[])], unresolved: task.attempt === 1 ? ['A follow-up revision is required.'] : [] } } });
  } catch (error) { sourceError = error; throw error; } } });
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const settle = async (status: string) => until(async () => { if (sourceError) throw sourceError; for (const approval of core.runtime.approvals().filter(row => row.status === 'pending')) await core.approve(approval.id, 'approve', 'once'); return core.runtime.tasks()[0]; }, task => task?.status === status, 30000);
  try {
    await core.submitMessage({ content: 'Produce the first original verified file.' }); const first = await settle('blocked'); await until(() => core['activeRuns'].size === 0 && core['dispatchTails'].size === 0, Boolean);
    const originalReport = structuredClone(first!.report); await core.tasks.control(first!.id, 'retry', first!.revision); const second = await settle('succeeded'); await until(() => core['activeRuns'].size === 0 && core['dispatchTails'].size === 0, Boolean);
    assert.equal(second!.attempt, 2); assert.equal(fs.readFileSync(path.join(directory, 'workspace', 'deliverable.txt'), 'utf8'), versions[1]);
    const archive = await core.exportContinuationContext('main', true), deliveries = archive.continuation!.artifacts!.filter(row => row.kind === 'task-delivery');
    assert.equal(deliveries.length, duplicatePath?3:2); assert.deepEqual(new Set(deliveries.map(row => row.sha256)), new Set(versions.map(hash))); assert.equal(originalReport!.deliveries[0]!.sha256, hash(versions[0]!));
    if(duplicatePath)assert.deepEqual(new Set(deliveries.filter(row=>row.sha256===hash(versions[0]!)).map(row=>row.name)),new Set(['deliverable.txt','alias.txt']));
    for (const version of versions) assert.equal(Buffer.concat(deliveries.find(row => row.sha256 === hash(version))!.parts.map(part => Buffer.from(part.data, 'base64'))).toString(), version);
    let asked = false, read = 0;
    const targetModel = new MastraLanguageModelV2Mock({ doStream: async request => { try {
      if (!request.tools?.some(tool => tool.name === 'task_report')) { if (!asked) { asked = true; return reply({ name: 'task_create', input: { task: { title: 'Read both historical versions', content: 'Read the original two verified file versions from this session history.' } } }); } return reply(); }
      const task = target!.runtime.tasks().find(task => ['running', 'waiting'].includes(task.status))!; if (task.report) return reply();
      const text = JSON.stringify(request.prompt); if (read > 0) assert.ok(text.includes(Buffer.concat(deliveries[read-1]!.parts.map(part=>Buffer.from(part.data,'base64'))).toString()));
      if (read < deliveries.length) { const row = deliveries[read++]!; assert.ok(text.includes(row.id)); return reply({ name: 'read_session_artifact', input: { signalIds: [task.signalId], id: row.id, maxBytes: 1000 } }); }
      return reply({ name: 'task_report', input: { id: task.id, report: { outcome: 'succeeded', summary: 'Read both original imported versions.', checks: [{ description: 'Both historical original byte sequences are present.', passed: true }], deliveries: [], unresolved: [] } } });
    } catch (error) { targetError = error; throw error; } } });
    target = await Core.open({ dataDir: targetDirectory, model: targetModel, memoryEnabled: false }); const imported = await target.importContext({ archive }); assert.equal(target.runtime.tasks().length, 0); assert.equal(fs.existsSync(path.join(targetDirectory, 'workspace', 'deliverable.txt')), false);
    const source = await target.submitMessage({ contextId: imported.id, content: 'Read and compare the two imported original file versions.' }); assert.equal((await finished(target, source.runId!))?.status, 'succeeded');
    await until(() => { if (targetError) throw targetError; return target!.runtime.tasks()[0]; }, task => task?.status === 'succeeded', 30000); assert.equal(target.runtime.approvals().length, 0); assert.equal(read, deliveries.length);
  } finally { await target?.close(); await core.close(); await removeTemp(directory); await removeTemp(targetDirectory); }
});
