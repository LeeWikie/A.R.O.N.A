import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { AppError } from '../src/domain.js';
import { createApp } from '../src/http.js';
import { submitLogicalInput, type LogicalInputIntent } from '../src/tui/logical-input.js';
import { QueueLocalEdits } from '../src/tui/queue-local-edits.js';
import { finished, until, removeTemp } from './helpers.js';
import type { ConversationPage } from '../src/protocol.js';
import { splitQueueText } from '../src/queue-content.js';

for (const busy of [false, true]) test(`one logical input keeps all original text, nine files and native Skill material through ${busy ? 'busy queue' : 'idle admission'} and a lost acknowledgement`, { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-direct-logical-')), localDirectory = path.join(directory, 'client'), workspace = path.join(directory, 'project');
  fs.mkdirSync(path.join(workspace, '.agents', 'skills', 'example'), { recursive: true }); fs.writeFileSync(path.join(workspace, '.agents', 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: A synthetic explicitly selected workflow.\n---\nSYNTHETIC_SELECTED_SKILL_BODY\n');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => { prompts.push(JSON.stringify(request.prompt)); if (busy && prompts.length === 1) await held; return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close(); } }) }; } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false, modelConfig: { protocol: 'responses', baseURL: 'https://fixture.invalid/v1', apiKey: 'synthetic-only', authHeader: 'bearer', modelId: 'logical-fixture', contextWindow: 512000, maxTokens: 1024 } });
  core.capabilities.saveRoot({ id: 'project', name: 'Project', path: workspace }); const context = core.createConversationContext({ name:'Project input',workspaceId: 'project' }); const http = createApp(core);
  let local = new QueueLocalEdits(localDirectory, 'opaque-control-scope'), lose = true;
  const call = async <T>(route: string, init?: { body?: unknown; method?: string; key?: string }): Promise<T> => { const response = await http.request(route, { method: init?.method ?? 'GET', headers: { Authorization: `Bearer ${core.controlToken}`, 'X-ShittimChest-Storage-Id': core.storageId, ...(init?.key ? { 'Idempotency-Key': init.key } : {}), 'content-type': 'application/json' }, ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }) }); const result = await response.json(); if (!response.ok) throw new AppError(String((result as { error?: string }).error ?? 'request_failed'), response.status); return result as T; };
  const host = () => ({ local, validate() {}, request: <T>(route: string) => call<T>(route), write: async (route: string, body: unknown, method='POST', key=randomUUID()) => { const result = await call(route, { body, method, key }); if (lose && route.endsWith('/submit')) { lose = false; throw new AppError('synthetic_lost_ack', 502); } return result; } });
  try {
    const heldInput = busy ? await core.submitMessage({ contextId: context.id, content: 'SYNTHETIC_HELD_REQUEST' }) : undefined; if (busy) await until(() => prompts.length, count => count === 1);
    const assets = []; for (let i = 0; i < 9; i++) assets.push(await core.assets.put(new Response(`SYNTHETIC_ORIGINAL_FILE_${i}`).body, `${i}.txt`));
    const content = '/skill:example ' + Array.from({length:8000},(_,index)=>`完整中文🙂${index.toString(16).padStart(6,'0')};`).join(''), intent: LogicalInputIntent = { id: randomUUID(), storageId: core.storageId, contextId: context.id, content, attachments: assets.map(row => row.id), selectedSkillName: 'example', localContext: 'SYNTHETIC_CLIENT_MATERIAL', mode: 'queue' };
    await assert.rejects(submitLogicalInput(host(), intent), /synthetic_lost_ack/);
    assert.equal(local.captures(core.storageId, context.id).length, 1, 'unconfirmed Enter retains its full local envelope');
    local = new QueueLocalEdits(localDirectory, 'opaque-control-scope'); const saved = local.captures(core.storageId, context.id)[0]!; assert.equal(saved.content, content); assert.equal(saved.selectedSkillName, 'example'); assert.deepEqual(saved.attachments, intent.attachments);
    const receipt = await submitLogicalInput(host(), intent); if (busy) { assert.equal(prompts.length, 1); assert.equal(receipt.submission!.entries[0]!.status, 'queued'); release(); await finished(core, heldInput!.runId!); }
    await until(() => core.queueEditor().page(context.id, receipt.id).draft.status, status => status === 'submitted');
    const final = core.queueEditor().page(context.id, receipt.id).draft; await finished(core, final.submission!.runId!);
    assert.equal(prompts.length, busy ? 2 : 1, 'one Enter makes one native model input group and retry does not replay it');
    const prompt = prompts.at(-1)!; let prior=-1;for(const part of splitQueueText(content)){const position=prompt.indexOf(part);assert.ok(position>prior,'all bounded original text parts reach the first native request in order');assert.equal(prompt.indexOf(part,position+part.length),-1,'no original part is replayed twice');prior=position;} for (let i = 0; i < 9; i++) assert.match(prompt, new RegExp(`SYNTHETIC_ORIGINAL_FILE_${i}`));
    assert.equal(prompt.split('SYNTHETIC_SELECTED_SKILL_BODY').length - 1, 1); assert.equal(prompt.split('SYNTHETIC_CLIENT_MATERIAL').length - 1, 1);
    const history=await call<ConversationPage>(`/conversation?contextId=${context.id}&limit=200`),user=history.messages.filter(row=>row.role==='user').at(-1)!; assert.equal(user.content, content); assert.deepEqual(user.attachments, intent.attachments);
    assert.equal(local.captures(core.storageId, context.id).length, 0); const calls = prompts.length; await submitLogicalInput(host(), intent); assert.equal(prompts.length, calls);
  } finally { release(); await core.close(); await removeTemp(directory); }
});

test('a changed project identity blocks a not-yet-admitted input without rebinding its original source, and restoring that identity safely resumes the same input',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-input-source-')),replacement=path.join(directory,'replacement');fs.mkdirSync(replacement);let calls=0;
  const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}}),core=await Core.open({dataDir:path.join(directory,'core'),model,memoryEnabled:false}),http=createApp(core),source=core.projectDirectory('main'),local=new QueueLocalEdits(path.join(directory,'client'),'control');
  const intent:LogicalInputIntent={id:randomUUID(),storageId:core.storageId,contextId:'main',content:'SYNTHETIC_ORIGINAL_PROJECT_INPUT',attachments:[],mode:'queue',expectedSource:{workspaceId:source.workspaceId,directory:source.directory}};
  const call=async<T>(route:string,body?:unknown,method='GET',key?:string):Promise<T>=>{const response=await http.request(route,{method,headers:{Authorization:`Bearer ${core.controlToken}`,'X-ShittimChest-Storage-Id':core.storageId,'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new AppError((value as {error:string}).error,response.status);return value as T;};const host={local,validate(){},request:<T>(route:string)=>call<T>(route),write:(route:string,body:unknown,method='POST',key=randomUUID())=>call(route,body,method,key)};
  try{await core.updateWorkspace('default',{path:replacement,expectedPath:core.capabilities.root('default').path});await assert.rejects(submitLogicalInput(host,intent),/queue_configuration_changed/);assert.equal(calls,0);assert.equal(core.runtime.queueEditDocuments().length,0);assert.equal(local.captures(core.storageId,'main')[0]!.content,intent.content);assert.deepEqual(local.captures(core.storageId,'main')[0]!.expectedSource,intent.expectedSource);
    await core.updateWorkspace('default',{path:source.directory.path,expectedPath:core.capabilities.root('default').path});const receipt=await submitLogicalInput(host,intent);await until(()=>core.queueEditor().page('main',receipt.id).draft.status,status=>status==='submitted');await finished(core,core.queueEditor().page('main',receipt.id).draft.submission!.runId!);assert.equal(calls,1);assert.equal(local.captures(core.storageId,'main').length,0);
  }finally{await core.close();await removeTemp(directory);}
});
