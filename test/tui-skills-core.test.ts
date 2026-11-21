import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Terminal } from '@earendil-works/pi-tui';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import type { AssetInfo } from '../src/assets.js';
import type { SignalRecord } from '../src/domain.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp } from './helpers.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;

test('terminal skill invocation preserves the actual input and carries attachments and shared results into the native model request', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-skill-core-')), prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    prompts.push(JSON.stringify(request.prompt)); return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Synthetic skill done' }); controller.enqueue({ type: 'text-end', id: 'reply' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  const skill = path.join(directory, 'workspace', 'skills', 'manual-only'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: manual-only\ndescription: A synthetic manually invoked action.\ndisable-model-invocation: true\n---\nSYNTHETIC_EXPLICIT_SKILL_CONTENT');
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), observed: { receipt?: SignalRecord } = {};
  const original = client.request.bind(client);
  client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => { const result = await original<T>(route, init); if (route.endsWith('/invoke')) observed.receipt = result as SignalRecord; return result; };
  const app = new TerminalApp(client, 'main', terminal);
  const ui = app as unknown as { capabilities: Set<string>; command(text: string): Promise<void>; choose(): Promise<string>; contextReady: boolean; contextRole: string; isMainContext: boolean; pendingAttachments: Map<string, AssetInfo[]>; sharedShell: Map<string, string[]> };
  try {
    ui.capabilities = new Set((await client.handshake()).capabilities); ui.contextReady = true; ui.contextRole = 'main'; ui.isMainContext = true; ui.choose = async () => 'yes';
    const attachment = await core.assets.put(new Response('SYNTHETIC_ATTACHMENT_CONTENT').body, 'fixture.txt'); ui.pendingAttachments.set('main', [attachment]); ui.sharedShell.set('main', ['SYNTHETIC_SHARED_SHELL_CONTENT']);
    const text = '/skill:manual-only   使用这个附件'; await ui.command(text);
    assert.ok(observed.receipt, 'the UI must reach the actual invocation endpoint'); assert.equal((await finished(core, observed.receipt.runId!))!.status, 'succeeded');
    assert.equal(core.store.getSignal(observed.receipt.id)!.content, text); assert.deepEqual(core.store.getSignal(observed.receipt.id)!.attachments, [attachment.id]);
    assert.match(prompts[0]!, /SYNTHETIC_EXPLICIT_SKILL_CONTENT/); assert.match(prompts[0]!, /SYNTHETIC_ATTACHMENT_CONTENT/); assert.match(prompts[0]!, /SYNTHETIC_SHARED_SHELL_CONTENT/);
    assert.equal(ui.pendingAttachments.get('main')?.length ?? 0, 0); assert.equal(ui.sharedShell.has('main'), false);
  } finally {
    await app.stop(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
  }
});

test('the terminal exposes actual Skill discovery warnings and source collisions without treating an ordinary note as a Skill',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tui-skill-diagnostics-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});let app:TerminalApp|undefined;const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 try{const root=core.capabilities.root('default').path;for(const location of['.agents/skills/duplicate','skills/duplicate']){const directory=path.join(root,location);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'SKILL.md'),'---\nname: duplicate\ndescription: Synthetic discovery fixture.\n---\ncontent');}const invalid=path.join(root,'.agents/skills/invalid');fs.mkdirSync(invalid,{recursive:true});fs.writeFileSync(path.join(invalid,'SKILL.md'),'---\nname: [unterminated\ndescription: Invalid fixture.\n---\ncontent');fs.writeFileSync(path.join(root,'.agents/skills','notes.md'),'ordinary synthetic notes');
  const client=new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,core.controlToken),catalog=await client.request<{diagnostics:Array<{type:string;path:string;winnerPath?:string}>}>('/contexts/main/skills');assert.ok(catalog.diagnostics.some(row=>row.type==='collision'));assert.ok(catalog.diagnostics.some(row=>row.path==='.agents/skills/invalid/SKILL.md'));assert.equal(catalog.diagnostics.some(row=>row.path.endsWith('notes.md')),false);
  app=new TerminalApp(client,'main',terminal);const ui=app as any,notes:string[]=[];let offered=false;ui.capabilities=new Set((await client.handshake()).capabilities);ui.note=(text:string)=>notes.push(text);ui.choose=async(title:string,items:Array<{value:string;label:string}>)=>{assert.equal(title,'工作区 Skills');assert.ok(items.some(row=>row.value==='diagnostics'&&row.label.includes(String(catalog.diagnostics.length))));offered=true;return'diagnostics';};await ui.command('/skills');assert.equal(offered,true);for(const row of catalog.diagnostics)assert.ok(notes.join('\n').includes(row.path));assert.ok(notes.join('\n').includes('名称冲突'));assert.equal(notes.join('\n').includes('notes.md'),false);
 }finally{await app?.stop();if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await core.close();await removeTemp(directory);}
});
