import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { until, removeTemp } from './helpers.js';

function modelForWork(onPrompt?: (request: unknown) => void) {
  const turns = new Map<string, number>();
  return new MastraLanguageModelV2Mock({ doStream: async request => {
    onPrompt?.(request);
    const prompt = JSON.stringify(request.prompt);
    const names = (request.tools ?? []).map(tool => tool.name);
    const read = names.find(name => /read_file|^view$/.test(name));
    if(names.includes('task_report')){assert.ok(!names.includes('emit_message'));assert.ok(!names.includes('save_artifact'));}
    const match = /\\?"taskId\\?":\\?"([0-9a-f-]{36})/.exec(prompt); const id = match?.[1];
    let action: { name: string; input: unknown } | undefined;
    if (read && id) {
      const turn = turns.get(id) ?? 0; turns.set(id, turn + 1);
      const reuse=prompt.includes('Read another fixture');
      const offset=reuse?1:0;
      if(reuse&&turn===0)action={name:'skill',input:{name:'read-fixture'}};
      const file=reuse?'input-2.txt':'input.txt';const content=reuse?'second fixture input':'fixture input';
      if(turn===offset)action={name:read,input:{path:file}};
      if(turn===offset+1)action={name:'task_report',input:{id,report:{outcome:'succeeded',summary:'Read the actual fixture file.',checks:[{description:'Read actual input',passed:prompt.includes(content)}],deliveries:[{kind:'text',title:'Result',value:content}],unresolved:[]}}};
      if(turn===offset+2)action={name:'method_save',input:{name:'read-fixture',description:'Read a fixture file and verify its content.',instructions:'Read the named input file, check content, then report the actual result.',evidenceTaskIds:[id],...(reuse?{revision:1}:{})}};

    }
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (action) controller.enqueue({ type: 'tool-call', toolCallId: `work-${id}-${turns.get(id ?? "main")}`, toolName: action.name, input: JSON.stringify(action.input) });
      controller.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }); controller.close();
    } }) };
  } });
}

test('whole tasks use independent native sessions, real filesystem tools and reusable methods', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-runtime-'));
  const requests: unknown[] = []; const core = await Core.open({ dataDir: dir, model: modelForWork(request => requests.push(request)), memoryEnabled: false });
  fs.writeFileSync(path.join(dir, 'workspace/input.txt'), 'fixture input');
  fs.writeFileSync(path.join(dir,'workspace/input-2.txt'),'second fixture input');
  try {
    const task = await core.createTask({ title: 'Read fixture', content: 'Read input.txt and report its content.' }, { sourceSignalIds: [], returnContextId: 'main' }, 'fixture-task');
    assert.ok(task.nativeTaskId); assert.notEqual(task.contextId, 'main');
    const result = await until(() => core.runtime.task(task.id), value => !['pending', 'running', 'waiting'].includes(value.status));
    assert.equal(result.status, 'succeeded', JSON.stringify(core.runtime.events(result.contextId).filter(x => /tool|error/.test(x.kind))));
    assert.equal(core.methods.get('read-fixture').revision, 1);
    const second = await core.createTask({ title: 'Read another fixture', content: 'Read input-2.txt using the known method.' }, { sourceSignalIds: [], returnContextId: 'main' }, 'fixture-task-2');
    assert.notEqual(second.contextId, task.contextId);
    assert.equal((await until(() => core.runtime.task(second.id), value => value.status === 'succeeded')).status, 'succeeded');
    assert.ok(core.runtime.events(second.contextId,0,1000).some(event=>event.kind==='tool_end'&&JSON.stringify(event.data).includes('Read the named input file, check content')),'native Skill instructions must actually be loaded');
    assert.equal(core.methods.get('read-fixture').revision,2);
    assert.ok(core.projectMemory.snapshot(result.runIds[0]!).prompt.length > 0);
  } finally { await core.close(); await removeTemp(dir); }
});
