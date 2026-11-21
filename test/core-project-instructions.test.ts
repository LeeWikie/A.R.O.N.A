import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { until, removeTemp,authenticatedApp } from './helpers.js';

function streamed(action: { name: string; input: unknown } | undefined, id: string) {
  return { stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    if (action) controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: action.name, input: JSON.stringify(action.input) });
    controller.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }); controller.close();
  } }) };
}
function report(id: string) { return { name: 'task_report', input: { id, report: { outcome: 'succeeded', summary: 'Executed using scoped project instructions.', checks: [{ description: 'Actual nested file and instruction scope were checked.', passed: true }], deliveries: [], unresolved: [] } } }; }

test('nested project instructions reach the next request after a real read and stay frozen until the next run', { timeout: 40_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-scoped-instructions-')); const rounds = new Map<string, number>(); let core!: Core; let activeTask = ''; let expected = 'NESTED_RULE_V1'; let call = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    if (!request.tools?.some(tool => tool.name === 'task_report')) return streamed(undefined, 'main');
    const task = core.runtime.tasks().find(task => task.status === 'running'); if (!task) return streamed(undefined, 'idle');
    activeTask = task.id; const round = rounds.get(task.id) ?? 0; rounds.set(task.id, round + 1); const prompt = JSON.stringify(request.prompt);
    assert.ok(prompt.includes('ROOT_RULE')); assert.ok(!prompt.includes('SHADOWED_ROOT_RULE')); assert.ok(!prompt.includes('SHADOWED_NESTED_RULE'));
    if (round === 0) return streamed({ name: 'mastra_workspace_read_file', input: { path: 'nested/input.txt' } }, 'scope-' + (++call));
    if (round === 1) {
      assert.ok(prompt.includes(expected), 'the read directory instructions must reach this real model request');
      if (expected === 'NESTED_RULE_V1') { fs.writeFileSync(path.join(directory, 'workspace/nested/AGENTS.MD'), 'NESTED_RULE_V2'); fs.writeFileSync(path.join(directory, 'workspace/nested/AGENTS.override.md'), 'NESTED_RULE_V2'); }
      return streamed({ name: 'mastra_workspace_write_file', input: { path: `nested/${task.id}.txt`, content: 'Observed scoped instructions.' } }, 'scope-' + (++call));
    }
    if (round === 2) {
      assert.ok(prompt.includes(expected));
      if (expected === 'NESTED_RULE_V1') assert.ok(!prompt.includes('NESTED_RULE_V2'), 'mid-run changes must not rewrite the admitted scope');
      return streamed(report(task.id), 'scope-' + (++call));
    }
    return streamed(undefined, 'complete');
  } });
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const workspace = path.join(directory, 'workspace'); fs.mkdirSync(path.join(workspace, 'nested')); fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'SHADOWED_ROOT_RULE'); fs.writeFileSync(path.join(workspace, 'AGENTS.override.md'), 'ROOT_RULE'); fs.writeFileSync(path.join(workspace, 'nested/AGENTS.MD'), expected); fs.writeFileSync(path.join(workspace, 'nested/CLAUDE.md'), 'SHADOWED_NESTED_RULE'); fs.writeFileSync(path.join(workspace, 'nested/input.txt'), 'Source material.');
    const first = await core.submitTask({ title: 'Scoped read and write', content: 'Read nested/input.txt then create a file.', grants: { write: true, execute: false, mcp: false } }, 'scoped-first');
    await until(() => core.runtime.task(first.id), task => ['succeeded', 'failed', 'blocked', 'unreported'].includes(task.status));
    assert.equal(core.runtime.task(first.id).status, 'succeeded'); assert.equal(activeTask, first.id);
    assert.equal(fs.readFileSync(path.join(workspace, `nested/${first.id}.txt`), 'utf8'), 'Observed scoped instructions.');
    expected = 'NESTED_RULE_V2';
    const second = await core.submitTask({ title: 'Reload scope', content: 'Read nested/input.txt and create a second file.', contextId: first.contextId, grants: { write: true, execute: false, mcp: false } }, 'scoped-second');
    await until(() => core.runtime.task(second.id), task => ['succeeded', 'failed', 'blocked', 'unreported'].includes(task.status));
    assert.equal(core.runtime.task(second.id).status, 'succeeded'); assert.equal(activeTask, second.id);
    assert.equal(fs.readFileSync(path.join(workspace, `nested/${second.id}.txt`), 'utf8'), 'Observed scoped instructions.');
    assert.equal(core.runtime.approvals().filter(approval => approval.status === 'pending').length, 0);
  } finally { await core.close(); await removeTemp(directory); }
});

test('a first nested write is deferred once so instructions are observed before any file changes', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-first-scoped-write-')); let core!: Core; const rounds = new Map<string, number>(); let call = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    if (!request.tools?.some(tool => tool.name === 'task_report')) return streamed(undefined, 'main');
    const task = core.runtime.tasks().find(task => task.status === 'running'); if (!task) return streamed(undefined, 'idle');
    const round = rounds.get(task.id) ?? 0; rounds.set(task.id, round + 1); const prompt = JSON.stringify(request.prompt);
    if (round === 0 || round === 1) {
      if (round === 1) { assert.ok(prompt.includes('NESTED_CREATE_RULE')); assert.ok(!fs.existsSync(path.join(directory, 'workspace/nested/result.txt')), 'the first call did not write before the rules were observed'); }
      return streamed({ name: 'mastra_workspace_write_file', input: { path: 'nested/result.txt', content: 'Scoped creation.' } }, 'first-write-' + (++call));
    }
    if (round === 2) { assert.equal(fs.readFileSync(path.join(directory, 'workspace/nested/result.txt'), 'utf8'), 'Scoped creation.'); return streamed(report(task.id), 'first-write-' + (++call)); }
    return streamed(undefined, 'complete');
  } });
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const workspace = path.join(directory, 'workspace'); fs.mkdirSync(path.join(workspace, 'nested')); fs.writeFileSync(path.join(workspace, 'nested/AGENTS.md'), 'NESTED_CREATE_RULE');
    const task = await core.submitTask({ title: 'Create with scoped rules', content: 'Create nested/result.txt.', grants: { write: true, execute: false, mcp: false } }, 'create-scoped');
    const result = await until(() => core.runtime.task(task.id), task => ['succeeded', 'failed', 'blocked', 'unreported'].includes(task.status));
    assert.equal(result.status, 'succeeded'); assert.equal(rounds.get(task.id), 4); assert.equal(core.runtime.approvals().filter(approval => approval.status === 'pending').length, 0);
  } finally { await core.close(); await removeTemp(directory); }
});

test('all writes planned before a new directory scope is observed are deferred without consuming user approvals',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-scope-planned-writes-'));let core!:Core,round=0,sequence=0,error:unknown;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    try{
      if(!request.tools?.some(tool=>tool.name==='task_report'))return streamed(undefined,'main');
      const task=core.runtime.tasks().find(task=>task.status==='running'||task.status==='waiting')!;if(task.report)return streamed(undefined,'done');
      const current=round++,root=path.join(directory,'workspace'),prompt=JSON.stringify(request.prompt);
      if(current===1){assert.match(prompt,/NESTED_PLANNING_RULE/);for(const file of ['a.txt','b.txt'])assert.equal(fs.existsSync(path.join(root,'nested',file)),false,'No call planned before observing the rules may change files.');}
      if(current<=1){const content=current===0?'BEFORE_SCOPE':'AFTER_SCOPE';return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});for(const file of ['a.txt','b.txt'])c.enqueue({type:'tool-call',toolCallId:`scope-planned-${++sequence}`,toolName:'mastra_workspace_write_file',input:JSON.stringify({path:'nested/'+file,content})});c.enqueue({type:'finish',finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}
      for(const file of ['a.txt','b.txt'])assert.equal(fs.readFileSync(path.join(root,'nested',file),'utf8'),'AFTER_SCOPE');return streamed(report(task.id),`scope-planned-${++sequence}`);
    }catch(caught){error=caught;throw caught;}
  }});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    const root=path.join(directory,'workspace');fs.mkdirSync(path.join(root,'nested'));fs.writeFileSync(path.join(root,'nested/AGENTS.md'),'NESTED_PLANNING_RULE');const app=authenticatedApp(core),response=await app.request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Create scoped files',content:'Create nested/a.txt and nested/b.txt according to their project rules.'})});assert.equal(response.status,202);const task=await response.json() as {id:string};const approvals=new Set<string>();
    const result=await until(async()=>{if(error)throw error;for(const approval of core.runtime.approvals().filter(row=>row.status==='pending')){approvals.add(approval.id);assert.equal((await app.request(`/approvals/${approval.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"decision":"approve"}'})).status,200);}return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));
    assert.equal(result.status,'succeeded');assert.equal(approvals.size,2,'Only the actual authorized writes require user approval.');assert.equal(result.grants.write,false);assert.equal(result.toolGrants?.length??0,0);
  }finally{await core.close();await removeTemp(directory);}
});
