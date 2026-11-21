import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as pty from '@lydell/node-pty';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { writeCoreLocation } from '../src/startup.js';
import { until, removeTemp } from './helpers.js';

function output(action?: { name: string; input: unknown }, text?: string) {
  return { stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] });
    if (action) c.enqueue({ type: 'tool-call', toolCallId: 'project-' + Math.random(), toolName: action.name, input: JSON.stringify(action.input) });
    if (text) { c.enqueue({ type: 'text-start', id: 'text' }); c.enqueue({ type: 'text-delta', id: 'text', delta: text }); c.enqueue({ type: 'text-end', id: 'text' }); }
    c.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
  } }) };
}

test('real CLI opens its local project, delegates native work and returns the report to the same project conversation', { timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-project-cli-')), dataDir = path.join(directory, 'data'), a = path.join(directory, '项目 A'), b = path.join(directory, 'project B');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.writeFileSync(path.join(a, 'marker.txt'), 'PROJECT_A_SOURCE'); fs.writeFileSync(path.join(a, 'AGENTS.md'), 'PROJECT_A_INSTRUCTION'); fs.writeFileSync(path.join(b, 'marker.txt'), 'PROJECT_B_SOURCE');
  let core!: Core, created = false, notified=false, workerStep = 0, calls = 0, modelError: unknown;const mainPrompts:string[]=[];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    try {
      calls++; const prompt = JSON.stringify(request.prompt), worker = request.tools?.some(tool => tool.name === 'task_report');
      if (worker) {
        const task = core.runtime.tasks()[0]!; assert.equal(fs.realpathSync(core.capabilities.root(core.runtime.context(task.contextId)!.workspaceId).path), fs.realpathSync(a));
        assert.ok(prompt.includes('PROJECT_A_INSTRUCTION'));
        if (workerStep++ === 0) return output({ name: 'mastra_workspace_read_file', input: { path: 'marker.txt' } });
        assert.ok(prompt.includes('PROJECT_A_SOURCE')); assert.ok(!prompt.includes('PROJECT_B_SOURCE'));
        if (workerStep === 2) return output({ name: 'mastra_workspace_write_file', input: { path: 'result.txt', content: 'PROJECT_A_SOURCE_VERIFIED\n' } });
        if (workerStep === 3) return output({ name: 'task_report', input: { id: task.id, report: { outcome: 'succeeded', summary: 'PROJECT_A_VERIFIED_REPORT', checks: [{ description: 'Read the actual project source and wrote the verified result.', passed: true }], deliveries: [{ kind: 'file', title: 'Verified project result', value: 'result.txt' }], unresolved: [] } } });
        return output();
      }
      mainPrompts.push(prompt);
      if (!created) { created = true; return output({ name: 'task_create', input: { task: { title: 'Verify current project', content: 'Read marker.txt in this project, write result.txt, and report the actual delivered file.' } } }); }
      if (prompt.includes('PROJECT_A_VERIFIED_REPORT')&&!notified) {
        notified=true;
        if(request.tools?.some(tool=>tool.name==='emit_message')){
          const visible=request.prompt.flatMap(row=>typeof row.content==='string'?[row.content]:row.content.filter(part=>part.type==='text').map(part=>(part as {text:string}).text)).join('\n');
          const notification=/signal_id="([0-9a-f-]{36})"[^>]*source="task-result"/.exec(visible)?.[1];assert.ok(notification);
          return output({name:'emit_message',input:{signalIds:[notification],text:'PROJECT_A_RESULT_RETURNED'}});
        }
        return output(undefined, 'PROJECT_A_RESULT_RETURNED');
      }
      if(notified)return output();
      return output(undefined, 'PROJECT_A_TASK_STARTED');
    } catch (error) { modelError = error; throw error; }
  } });
  core = await Core.open({ dataDir, model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const unpublish = writeCoreLocation(dataDir, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, { storageId: core.storageId, instanceId: core.instanceId });
  const env:NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', SHITTIMCHEST_DATA_DIR: dataDir };
  for (const name of ['SHITTIMCHEST_CORE_URL', 'ARONA_CORE_URL', 'SHITTIMCHEST_CONTEXT_ID', 'ARONA_CONTEXT_ID', 'SHITTIMCHEST_CONTROL_TOKEN', 'ARONA_CONTROL_TOKEN']) delete env[name];
  let active: pty.IPty | undefined;
  async function window(cwd: string, args: string[] = [], task = false) {
    const child = pty.spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'chat', ...args], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env }); active = child;
    let raw = '', exited: { exitCode: number } | undefined;
    const done = new Promise<void>(resolve => child.onExit(value => { exited = value; resolve(); })); child.onData(value => { raw += value; });
    await until(() => { if (exited) throw Error(raw); if (modelError) throw modelError; return raw.includes('已连接'); }, Boolean);
    if (task) {
      child.write('请核对本项目并交付结果。\r');
      const approval = await until(() => { if (modelError) throw modelError; return core.runtime.approvals().find(row => row.status === 'pending' && row.toolName === 'mastra_workspace_write_file'); }, Boolean); assert.ok(approval);
      assert.deepEqual(approval.args, { path: 'result.txt', content: 'PROJECT_A_SOURCE_VERIFIED\n' });
      await until(() => raw.includes('同意此次'), Boolean); child.write('1');
      try{await until(() => { if (modelError) throw modelError; return raw.includes('PROJECT_A_RESULT_RETURNED'); }, Boolean);}
      catch(error){throw new Error(JSON.stringify({error:String(error),raw:raw.slice(-12000),mainPrompts,tasks:core.runtime.tasks(),notifications:core.runtime.pendingNotifications(),events:core.runtime.events(undefined,0,2000).filter(row=>['tool_end','agent_end','reply.commit','task_state'].includes(row.kind)).slice(-15)}));}
    }
    child.write('/quit\r'); let timer:NodeJS.Timeout|undefined;try{await Promise.race([done, new Promise((_, reject) => {timer=setTimeout(() => reject(Error('CLI did not exit naturally: ' + raw.slice(-1500))), 5000);})]);}finally{if(timer)clearTimeout(timer);}
    assert.equal(exited?.exitCode, 0, raw.slice(-2000)); active = undefined; return raw;
  }
  try {
    const originalDefault = { ...core.capabilities.root('default') }; await window(a, [], true);
    await until(()=>({running:Number(core.store.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='running'").get()!.count),notifications:core.runtime.pendingNotifications().length}),state=>state.running===0&&state.notifications===0);
    const task = core.runtime.tasks()[0]!; assert.equal(task.status, 'succeeded'); assert.equal(core.runtime.context(task.returnContextId)!.role, 'main'); assert.notEqual(task.returnContextId, 'main');
    assert.equal(core.runtime.context(task.returnContextId)!.workspaceId, core.runtime.context(task.contextId)!.workspaceId);
    assert.equal(fs.readFileSync(path.join(a, 'result.txt'), 'utf8'), 'PROJECT_A_SOURCE_VERIFIED\n'); assert.equal(fs.existsSync(path.join(b, 'result.txt')), false); assert.equal(fs.existsSync(path.join(originalDefault.path, 'result.txt')), false);
    const beforeCalls = calls; const resumed = await window(a, ['--continue']); assert.ok(resumed.includes('PROJECT_A_RESULT_RETURNED')); assert.equal(calls, beforeCalls);
    await window(b); assert.equal(calls, beforeCalls); assert.deepEqual(core.capabilities.root('default'), originalDefault);
    const listing=spawn(process.execPath,['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'workspaces','list'],{cwd:a,env,stdio:['ignore','pipe','pipe']});let listingOutput='',listingError='';listing.stdout.setEncoding('utf8').on('data',value=>listingOutput+=value);listing.stderr.setEncoding('utf8').on('data',value=>listingError+=value);assert.equal((await once(listing,'exit'))[0],0,listingError);assert.ok((JSON.parse(listingOutput)as{workspaces:Array<{id:string}>}).workspaces.some(root=>root.id===core.runtime.context(task.contextId)!.workspaceId));
    async function sendLiteral(){
      const child=spawn(process.execPath,['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'send','--id','fa91b59a-7d5e-41ad-a16b-c501a6311c0f','--','literal','--context','words'],{cwd:b,env,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',value=>stdout+=value);child.stderr.setEncoding('utf8').on('data',value=>stderr+=value);const [code]=await once(child,'exit');assert.equal(code,0,stderr);return JSON.parse(stdout) as{id:string;contextId:string;runId?:string};
    }
    const sent=await sendLiteral();assert.equal(core.store.getSignal(sent.id)!.content,'literal --context words');assert.equal(fs.realpathSync(core.capabilities.root(core.runtime.context(sent.contextId)!.workspaceId).path),fs.realpathSync(b));
    const contextCount=core.runtime.contexts().length,repeated=await sendLiteral();assert.equal(repeated.id,sent.id);assert.equal(repeated.contextId,sent.contextId);assert.equal(core.runtime.contexts().length,contextCount);
    assert.equal(core.runtime.tasks().length, 1); assert.equal(core.runtime.approvals().filter(row => row.status === 'pending').length, 0);
    assert.equal(core.runtime.events('main').some(row => row.kind === 'reply.start'), false);
  } finally { active?.kill(); unpublish(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
});
