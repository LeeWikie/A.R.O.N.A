import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWorkspaceTools } from '@mastra/core/workspace';
import {makeCoreTool} from '@mastra/core/utils';
import {RequestContext} from '@mastra/core/request-context';
import {toStandardSchema} from '@mastra/core/schema';
import {validateToolInput} from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Capabilities } from '../src/capabilities.js';
import { Core } from '../src/core.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { authenticatedApp, until, removeTemp } from './helpers.js';

const grants = { write: false, execute: false, mcp: false };
function files(root: string, outside: string) {
  fs.mkdirSync(path.join(root, 'sub/deep'), { recursive: true }); fs.mkdirSync(path.join(root, '.private'));
  for (const [name, text] of Object.entries({ 'readme.md': 'NEEDLE public readme\n', 'sub/target-source.txt': 'NEEDLE violet-17\n', 'sub/deep/second.txt': 'needle nested\n', '.ordinary.txt': 'NEEDLE ordinary hidden\n', '.env': 'NEEDLE PRIVATE-ROOT-SECRET\n', '.private/canary.txt': 'NEEDLE PRIVATE-DIRECTORY-SECRET\n', 'sub/.env': 'NEEDLE PRIVATE-NESTED-SECRET\n', '.gitignore': 'ignored.txt\n', 'ignored.txt': 'NEEDLE ignored\n' })) fs.writeFileSync(path.join(root, name), text);
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'NEEDLE PRIVATE-OUTSIDE-SECRET\n');
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.linkSync(path.join(outside, 'outside.txt'), path.join(root, 'hardlink.txt'));
}
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-workspace-readonly-')), database = new DatabaseSync(':memory:');
  const runtime = new RuntimeStore(database), capabilities = new Capabilities(runtime, directory), record = runtime.createContext({ id: 'worker', name: 'Worker', role: 'work' });
  const outside = path.join(directory, 'outside'); fs.mkdirSync(outside); const root = path.join(directory, 'workspace'); files(root, outside);
  const workspace = capabilities.workspace(record, () => grants), tools = await createWorkspaceTools(workspace);
  return { directory, root, outside, runtime, capabilities, record, workspace, tools, async close() { await capabilities.close(); database.close(); await removeTemp(directory); } };
}

test('native directory listing and grep traverse ordinary files without exposing sensitive or linked entries', async () => {
  const f = await fixture();
  try {
    for (const target of ['.', '', f.root, 'sub']) assert.equal(f.capabilities.approvalCapability(f.record, 'mastra_workspace_list_files', { path: target }), 'read');
    for (const target of ['.', 'sub', 'sub/**/*.txt', '**/*.txt']) assert.equal(f.capabilities.approvalCapability(f.record, 'mastra_workspace_grep', { path: target, pattern: 'NEEDLE' }), 'read');
    assert.equal(f.capabilities.approvalCapability(f.record, 'mastra_workspace_read_file', { path: '.' }), null);
    const listing = String(await f.tools.mastra_workspace_list_files.execute({ path: '.', maxDepth: 4, showHidden: true, respectGitignore: true }, {}));
    assert.match(listing, /target-source.txt/); assert.match(listing, /second.txt/); assert.match(listing, /\.ordinary.txt/);
    assert.doesNotMatch(listing, /\.private|\.env|escape|hardlink|ignored.txt|PRIVATE/);
    const grep = String(await f.tools.mastra_workspace_grep.execute({ path: '.', pattern: 'needle', caseSensitive: false, includeHidden: true }, {}));
    assert.match(grep, /violet-17/); assert.match(grep, /needle nested/); assert.match(grep, /ordinary hidden/); assert.doesNotMatch(grep, /PRIVATE|ignored|escape|hardlink|\.env/);
    const glob = String(await f.tools.mastra_workspace_grep.execute({ path: 'sub/**/*.txt', pattern: 'NEEDLE', caseSensitive: false }, {}));
    assert.match(glob, /violet-17/); assert.match(glob, /needle nested/); assert.doesNotMatch(glob, /public readme|PRIVATE/);
    for (const target of ['.private', '.env', 'sub/.env', 'escape', 'hardlink.txt', '../outside']) {
      assert.equal(f.capabilities.approvalCapability(f.record, 'mastra_workspace_list_files', { path: target }), null);
      await assert.rejects(f.workspace.filesystem!.readFile(path.join(target, target === '.private' ? 'canary.txt' : '')), /not_allowed|outside_workspace|not found|ENOENT/);
    }
    await assert.rejects(f.tools.mastra_workspace_list_files.execute({ path: '.private', maxDepth: 4, showHidden: true }, {}), /not_allowed/);
    const denied = String(await f.tools.mastra_workspace_grep.execute({ path: '.env', pattern: 'NEEDLE', includeHidden: true }, {})); assert.doesNotMatch(denied, /PRIVATE/);
    const recursive = await f.workspace.filesystem!.readdir('.', { recursive: true, maxDepth: 4 }); assert.doesNotMatch(JSON.stringify(recursive), /\.private|\.env|escape|hardlink/); assert.ok(recursive.some(entry => entry.name === 'sub/deep/second.txt'));
  } finally { await f.close(); }
});

test('workspace permission classification uses the same native provider codec without changing raw arguments',async()=>{
  const f=await fixture(),model=new MastraLanguageModelV2Mock({provider:'openai.responses',modelId:'gpt-6-luna'});
  try{
    const cases:Array<{name:string;raw:unknown;capability:'read'|'write'|null}>=[
      {name:'list_files',raw:{path:null,mode:'directory',limit:500,maxDepth:null,showHidden:true,dirsOnly:false,exclude:null,extension:null,pattern:null,respectGitignore:false},capability:'read'},
      {name:'grep',raw:{path:null,pattern:'NEEDLE',contextLines:null,maxCount:null,caseSensitive:true,includeHidden:null,glob:null,ignoreCase:null,literal:null,context:null,limit:null},capability:'read'},
      {name:'read_file',raw:{path:'sub/target-source.txt',offset:null,limit:null,showLineNumbers:null,encoding:null,byteOffset:null,maxBytes:null},capability:'read'},
      {name:'file_stat',raw:{path:'readme.md'},capability:'read'},
      {name:'write_file',raw:{path:'new-file.txt',content:'synthetic',overwrite:null},capability:'write'},
      {name:'write_file',raw:{path:null,content:'synthetic',overwrite:null},capability:null},
      {name:'edit_file',raw:{path:'readme.md',edits:null,old_string:'public',new_string:'checked',oldText:null,newText:null,replace_all:null},capability:'write'},
      {name:'read_file',raw:{path:null},capability:null},
      {name:'grep',raw:{path:null,pattern:null},capability:null},
      {name:'list_files',raw:{path:17},capability:null},
      {name:'list_files',raw:{path:null,mode:'unknown'},capability:null},
      {name:'list_files',raw:{path:'.env',mode:'directory'},capability:null},
      {name:'list_files',raw:{path:'.',unexpected:true},capability:null},
    ];
    for(const row of cases){
      const name=`mastra_workspace_${row.name}`,original=f.tools[name];assert.ok(original);const raw=structuredClone(row.raw),native=makeCoreTool(original,{name,model,requestContext:new RequestContext(),workspace:f.workspace});
      const parameters=native.parameters;assert.ok(parameters&&typeof parameters==='object'&&'validate'in parameters&&typeof parameters.validate==='function');
      const actual:unknown=await Reflect.apply(parameters.validate,parameters,[structuredClone(raw)]),canonical=validateToolInput(toStandardSchema(original.inputSchema!),structuredClone(raw),name);
      assert.ok(actual&&typeof actual==='object'&&'success'in actual);assert.equal(actual.success,!canonical.error,`${name}: native provider and host schema disagree`);
      if(actual.success){assert.ok('value'in actual);assert.ok(actual.value&&typeof actual.value==='object');assert.ok(canonical.data&&typeof canonical.data==='object');const defined=(value:object)=>Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined));assert.deepEqual(defined(actual.value),defined(canonical.data));for(const [key,value]of Object.entries(actual.value))assert.equal(value===undefined||Object.hasOwn(canonical.data,key),true,'only absent optional properties can differ');}
      assert.equal(f.capabilities.approvalCapability(f.record,name,raw),row.capability);assert.deepEqual(raw,row.raw,'authorization leaves the original model arguments intact');
    }
  }finally{await f.close();}
});

test('a pre-stream source lease belongs only to its exact current task admission and drains before cancellation returns',async()=>{
  const f=await fixture();let active:ReturnType<Capabilities['beginResourceRead']>|undefined;
  try{
    const task=f.runtime.createTask({title:'Read admitted input',content:'Inspect the attached source.',contextId:f.record.id,returnContextId:f.record.id,sourceSignalIds:[],status:'running'}),other=f.runtime.createContext({id:'other-worker',name:'Other worker',role:'work'});
    for(const identity of [{taskId:task.id,attempt:task.attempt+1},{taskId:task.id,attempt:task.attempt}]){
      const context=identity.attempt===task.attempt?other:f.record;assert.throws(()=>f.capabilities.beginResourceRead(context,undefined,{agent:true,taskAdmission:identity}),/workspace_execution_changed/);
    }
    active=f.capabilities.beginResourceRead(f.record,undefined,{agent:true,taskAdmission:{taskId:task.id,attempt:task.attempt}});let returned=false;
    const stopping=f.capabilities.stopTaskResources(task.id).then(()=>{returned=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(active.signal.aborted,true);assert.equal(returned,false);active.finish();await stopping;assert.equal(returned,true);active=undefined;
    f.runtime.updateTask(task.id,{status:'cancelled'});assert.throws(()=>f.capabilities.beginResourceRead(f.record,undefined,{agent:true,taskAdmission:{taskId:task.id,attempt:task.attempt}}),/workspace_execution_changed/);
  }finally{active?.finish();await f.close();}
});

test('native grep cancellation and a replaced workspace cannot continue reading stale files', async () => {
  const f = await fixture();
  try {
    const cancelled = String(await f.tools.mastra_workspace_grep.execute({ path: '.', pattern: 'NEEDLE', includeHidden: true }, { abortSignal: AbortSignal.abort() }));
    assert.match(cancelled, /aborted|incomplete/i); assert.doesNotMatch(cancelled, /violet-17|PRIVATE/);
    const next = path.join(f.directory, 'replacement'); fs.mkdirSync(next); fs.writeFileSync(path.join(next, 'fresh.txt'), 'fresh');
    await f.capabilities.updateRoot('default', { expectedPath: f.root, path: next }, async () => {});
    await assert.rejects(f.workspace.filesystem!.readFile('readme.md'), /workspace_changed/);
    const current = f.capabilities.workspace(f.record, () => grants); assert.equal(String(await current.filesystem!.readFile('fresh.txt')), 'fresh');
  } finally { await f.close(); }
});

test('native stat and read_file retain image media and unsupported binary behavior', async () => {
  const f = await fixture();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(f.root, 'image.png'), png); fs.writeFileSync(path.join(f.root, 'archive.zip'), Buffer.from('PK\x03\x04binary'));
    assert.equal((await f.workspace.filesystem!.stat('image.png')).mimeType, 'image/png');
    const image: unknown = await f.tools.mastra_workspace_read_file.execute({ path: 'image.png' }, {});
    assert.deepEqual(image, { __workspaceMedia: true, text: `image.png (${png.length} bytes, image/png)`, mediaType: 'image/png', data: png.toString('base64') });
    const binary = String(await f.tools.mastra_workspace_read_file.execute({ path: 'archive.zip' }, {}));
    assert.match(binary, /binary file not readable as text/); assert.doesNotMatch(binary, /PK|binary$/);
    const explicit = String(await f.tools.mastra_workspace_read_file.execute({ path: 'archive.zip', encoding: 'base64' }, {})); assert.match(explicit, /UEsDBGJpbmFyeQ==/);
  } finally { await f.close(); }
});

test('ancestor replacement cannot leak file bytes or directory metadata during a read', async () => {
  const f = await fixture(); const parent = path.join(f.root, 'sub'), held = path.join(f.root, 'held');
  const target = path.join(fs.realpathSync(f.root), 'sub/target-source.txt'); const secret = 'SYNTHETIC-EXTERNAL-SECRET-DATA-LONGER';
  fs.writeFileSync(path.join(f.outside, 'target-source.txt'), secret);
  const swap = () => { fs.renameSync(parent, held); fs.symlinkSync(f.outside, parent, process.platform === 'win32' ? 'junction' : 'dir'); };
  const restore = () => { fs.unlinkSync(parent); fs.renameSync(held, parent); };
  const open = fs.openSync, lstat = fs.lstatSync, lstatDescriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync')!; let injected = false;
  try {
    fs.openSync = ((...args: Parameters<typeof open>) => {
      if (String(args[0]) === target && !injected) { injected = true; swap(); try { return open(...args); } finally { restore(); } }
      return open(...args);
    }) as typeof open;
    await assert.rejects(f.workspace.filesystem!.readFile('sub/target-source.txt'), /resource_changed/); assert.equal(injected, true);
    fs.openSync = open; injected = false; let targetStats = 0;
    Object.defineProperty(fs, 'lstatSync', { ...lstatDescriptor, value: (...args: Parameters<typeof lstat>) => {
      if (String(args[0]) === target && ++targetStats === 2) { injected = true; swap(); try { return lstat(...args); } finally { restore(); } }
      return lstat(...args);
    } });
    await assert.rejects(f.workspace.filesystem!.readdir('sub'), /resource_changed/); assert.equal(injected, true);
  } finally { fs.openSync = open; Object.defineProperty(fs, 'lstatSync', lstatDescriptor); await f.close(); }
});

test('a real HTTP task lists, searches and reads with nullable native options and no manual approval', { timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-readonly-')); let core!: Core; let round = 0; const prompts: unknown[] = [];
  const model = new MastraLanguageModelV2Mock({ provider:'openai.responses',modelId:'gpt-6-luna', doStream: async request => {
    if (!request.tools?.some(tool => tool.name === 'task_report')) return output();
    if(round===0){const listed=request.tools?.find(tool=>tool.type==='function'&&tool.name==='mastra_workspace_list_files');assert.ok(listed&&listed.type==='function');const schema=listed.inputSchema;assert.ok(schema&&typeof schema==='object');assert.ok(schema.required?.includes('path'));assert.match(JSON.stringify(schema.properties?.path),/null/);assert.match(JSON.stringify(schema),/x-optional/);}
    const task = core.runtime.tasks().find(task => task.status === 'running'); assert.ok(task); prompts.push(request.prompt);
    const actions = [
      { name: 'mastra_workspace_list_files', input: { path: null, mode: 'directory', limit: 500, maxDepth: null, showHidden: true, dirsOnly: false, exclude: null, extension: null, pattern: null, respectGitignore: false } },
      { name: 'mastra_workspace_grep', input: { path: 'sub/**/*.txt', pattern: 'NEEDLE', contextLines: null, maxCount: null, caseSensitive: true, includeHidden: null } },
      { name: 'mastra_workspace_read_file', input: { path: 'sub/target-source.txt' } },
      { name: 'task_report', input: { id: task.id, report: { outcome: 'succeeded', summary: 'Found the source.', checks: [{ description: 'Listed, searched and read the source.', passed: true }], deliveries: [], unresolved: [] } } },
    ];
    if (round === 1) assert.match(JSON.stringify(request.prompt), /readme.md/);
    if (round >= 2) assert.match(JSON.stringify(request.prompt), /violet-17/);
    assert.doesNotMatch(JSON.stringify(request.prompt), /PRIVATE-(?:ROOT|DIRECTORY|NESTED|OUTSIDE)-SECRET/);
    return output(actions[round++]);
  } });
  function output(action?: { name: string; input: unknown }) { return { stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] }); if (action) c.enqueue({ type: 'tool-call', toolCallId: `read-${round}`, toolName: action.name, input: JSON.stringify(action.input) });
    c.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
  } }) }; }
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const outside = path.join(directory, 'outside'); fs.mkdirSync(outside); files(path.join(directory, 'workspace'), outside);
    const app = authenticatedApp(core), response = await app.request('/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Find source', content: 'List, find and read the source.', grants }) }); assert.equal(response.status, 202);
    const task = await response.json() as { id: string }; const result = await until(() => core.runtime.task(task.id), task => ['succeeded', 'failed', 'blocked', 'unreported'].includes(task.status));
    assert.equal(result.status, 'succeeded'); assert.equal(round, 5); assert.equal(prompts.length, 5); assert.equal(core.runtime.approvals().filter(row => row.status === 'pending').length, 0);
    assert.deepEqual(result.grants, grants);
  } finally { await core.close(); await removeTemp(directory); }
});

for (const target of ['.private', '.env', 'escape']) test(`real HTTP approval cannot expose a protected native listing: ${target}`, { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-protected-list-')); let core!: Core; let workerCalls = 0; const prompts: unknown[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const worker = request.tools?.some(tool => tool.name === 'task_report');
    if (worker) { prompts.push(request.prompt); workerCalls++; }
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      if (worker && workerCalls === 1) c.enqueue({ type: 'tool-call', toolCallId: 'protected-list', toolName: 'mastra_workspace_list_files', input: JSON.stringify({ path: target, maxDepth: 4, showHidden: true }) });
      c.enqueue({ type: 'finish', finishReason: worker && workerCalls === 1 ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) };
  } });
  core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const outside = path.join(directory, 'outside'); fs.mkdirSync(outside); files(path.join(directory, 'workspace'), outside);
    const app = authenticatedApp(core), response = await app.request('/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Inspect protected target', content: 'Check whether this target is available.', grants }) }); assert.equal(response.status, 202);
    const task = await response.json() as { id: string };
    const approval = (await until(() => core.runtime.approvals(), rows => rows.some(row => row.taskId === task.id && row.status === 'pending'))).find(row => row.taskId === task.id && row.status === 'pending')!;
    assert.deepEqual(core.approvalScopes(approval), ['once']);
    const decision = await app.request(`/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', scope: 'once' }) }); assert.equal(decision.status, 200);
    const settled = await until(() => core.runtime.task(task.id), row => ['failed', 'unreported', 'blocked'].includes(row.status)); assert.notEqual(settled.status, 'succeeded');
    assert.ok(workerCalls >= 2); assert.doesNotMatch(JSON.stringify(prompts), /PRIVATE-(?:ROOT|DIRECTORY|NESTED|OUTSIDE)-SECRET/);
    assert.match(JSON.stringify(prompts.at(-1)), /resource_path_not_allowed/); assert.deepEqual(settled.grants, grants);
  } finally { await core.close(); await removeTemp(directory); }
});

test('HTTP cancellation closes a protected listing approval without executing or resuming it', { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-core-list-cancel-')); let workerCalls = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const worker = request.tools?.some(tool => tool.name === 'task_report'); if (worker) workerCalls++;
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); if (worker) c.enqueue({ type: 'tool-call', toolCallId: 'cancel-list', toolName: 'mastra_workspace_list_files', input: JSON.stringify({ path: '.private' }) });
      c.enqueue({ type: 'finish', finishReason: worker ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    fs.mkdirSync(path.join(directory, 'workspace/.private')); fs.writeFileSync(path.join(directory, 'workspace/.private/canary.txt'), 'PRIVATE-CANCELLED-SECRET');
    const app = authenticatedApp(core), response = await app.request('/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Protected listing', content: 'Inspect target.', grants }) }); assert.equal(response.status, 202);
    const task = await response.json() as { id: string };
    const approval = (await until(() => core.runtime.approvals(), rows => rows.some(row => row.taskId === task.id && row.status === 'pending'))).find(row => row.taskId === task.id && row.status === 'pending')!;
    const context = core.runtime.context(core.runtime.task(task.id).contextId)!;
    const oldWorkspace = core.capabilities.workspace(context, () => grants);
    const replacement = path.join(directory, 'replacement'); fs.mkdirSync(replacement); fs.writeFileSync(path.join(replacement, 'fresh.txt'), 'fresh source');
    const update = () => app.request('/workspaces/default', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedPath: path.join(directory, 'workspace'), path: replacement }) });
    assert.equal((await update()).status, 409, 'an active approval prevents a workspace change');
    const cancel = await app.request(`/tasks/${task.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: core.runtime.task(task.id).revision }) }); assert.equal(cancel.status, 202);
    assert.equal(core.runtime.task(task.id).status, 'cancelled'); assert.notEqual(core.runtime.approval(approval.id).status, 'pending'); assert.equal(workerCalls, 1);
    const stale = await app.request(`/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }); assert.equal(stale.status, 409);
    await until(() => core.runtime.contexts().every(context => { const session = core.sessions.peek(context.id); return !session?.run.isRunning() && !session?.run.getRunId() && !session?.getCurrentRunId(); }), Boolean);
    const changed = await until(async () => { const result = await update(); if (result.status !== 200) { assert.equal(result.status, 409); assert.deepEqual(await result.clone().json(), { error: 'workspace_busy' }); } return result; }, result => result.status === 200);
    assert.equal(changed.status, 200);
    await assert.rejects(oldWorkspace.filesystem!.readFile('fresh.txt'), /workspace_changed/);
    const current = core.capabilities.workspace(context, () => grants), tools = await createWorkspaceTools(current);
    const listing = String(await tools.mastra_workspace_list_files.execute({ path: '.', maxDepth: 2 }, {})); assert.match(listing, /fresh.txt/); assert.doesNotMatch(listing, /canary/);
  } finally { await core.close(); await removeTemp(directory); }
});
