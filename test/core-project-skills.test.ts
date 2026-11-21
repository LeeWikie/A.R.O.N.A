import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { removeTemp, until } from './helpers.js';

test('a worker loads workspace instructions and uses a standard skill and reference through native tools', { timeout: 40_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-workspace-skill-')); const prompts: string[] = []; const called: string[] = []; const reported = new Set<string>(); let counter = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt); prompts.push(prompt);
    const taskId = /\\?"taskId\\?":\\?"([0-9a-f-]{36})/.exec(prompt)?.[1];
    let action: { toolName: string; input: unknown } | undefined;
    if (taskId && !reported.has(taskId) && request.tools?.some(tool => tool.name === 'task_report')) {
      assert.ok(prompt.includes('SYNTHETIC_PROJECT_RULE'), 'project rule is present before model execution');
      assert.ok(prompt.includes('source-check'), 'native skill catalog reaches the model');
      assert.ok(request.tools.some(tool => tool.name === 'skill'));
      if (!prompt.includes('SYNTHETIC_LOADED_SKILL')) action = { toolName: 'skill', input: { name: 'source-check' } };
      else if (!prompt.includes('SYNTHETIC_LOADED_REFERENCE')) action = { toolName: 'skill_read', input: { skillName: 'source-check', path: 'references/details.txt' } };
      else { reported.add(taskId); action = { toolName: 'task_report', input: { id: taskId, report: { outcome: 'succeeded', summary: 'Loaded the standard skill and its actual reference.', checks: [{ description: 'Native reference contains the synthetic marker.', passed: true }], deliveries: [], unresolved: [] } } }; }
    }
    if (action) called.push(action.toolName);
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (action) controller.enqueue({ type: 'tool-call', toolCallId: 'standard-skill-' + (++counter), toolName: action.toolName, input: JSON.stringify(action.input) });
      controller.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const root = path.join(directory, 'workspace');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'SYNTHETIC_PROJECT_RULE');
    const skill = path.join(root, 'skills/source-check'); fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: source-check\ndescription: Check supplied sources.\n---\nSYNTHETIC_LOADED_SKILL');
    fs.writeFileSync(path.join(skill, 'references/details.txt'), 'SYNTHETIC_LOADED_REFERENCE');
    const task = await core.submitTask({ title: 'Use a standard skill', content: 'Use source-check and read its reference.' }, 'standard-workspace-skill');
    const result = await until(() => core.runtime.task(task.id), task => ['succeeded', 'failed', 'blocked', 'unreported'].includes(task.status));
    assert.equal(result.status, 'succeeded', JSON.stringify(core.runtime.events(task.contextId).filter(event => event.kind === 'tool_end')));
    assert.deepEqual(called.slice(0, 3), ['skill', 'skill_read', 'task_report']);
    assert.equal(core.runtime.approvals().filter(approval => approval.status === 'pending').length, 0);
    assert.ok(prompts.some(prompt => prompt.includes('SYNTHETIC_LOADED_REFERENCE')));
  } finally { await core.close(); await removeTemp(directory); }
});
