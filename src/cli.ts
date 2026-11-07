#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { Client, OutputCursor, watchOutputs } from './client.js';
import { AppError } from './domain.js';
import {ensureCore} from './startup.js';

function jsonInput(args: string[]): unknown {
  const raw = args.join(' ');
  try { return JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw); }
  catch { throw new AppError('invalid_json_input'); }
}
async function readSecret() {
  if (!process.stdin.isTTY) {
    let value = ''; for await (const chunk of process.stdin) { value += String(chunk); if (value.length > 64002) throw new AppError('credential_too_large'); }
    return value.replace(/\r?\n$/, '');
  }
  console.error('输入密钥（不会显示）：');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  try { return await new Promise<string>(resolve => reader.question('', resolve)); } finally { reader.close(); console.error(''); }
}
async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const plainIndex=args.indexOf('--plain');const plain=plainIndex>=0;if(plain)args.splice(plainIndex,1);
  const idIndex = args.indexOf('--id'); let operationId = randomUUID() as string;
  if (idIndex >= 0) { if (!args[idIndex + 1]) throw new AppError('operation_id_required'); operationId = args[idIndex + 1]!; args.splice(idIndex, 2); }
  const command = args.shift() ?? 'chat';
  const baseURL = process.env.SHITTIMCHEST_CORE_URL ?? process.env.ARONA_CORE_URL ?? 'http://127.0.0.1:4111';
  const contextId = process.env.SHITTIMCHEST_CONTEXT_ID ?? process.env.ARONA_CONTEXT_ID ?? 'main';
  const directory = path.join(process.env.SHITTIMCHEST_DATA_DIR || process.env.ARONA_DATA_DIR || path.join(os.homedir(), '.arona'), 'client');
  const client = new Client(baseURL);
  const print = (body: unknown) => console.log(JSON.stringify(body, null, 2));
  const write = (route: string, body: unknown, method = 'POST') => client.request(route, { method,
    headers: { 'content-type': 'application/json', 'Idempotency-Key': operationId }, body: JSON.stringify(body) });
  const id = () => { const value = args.shift(); if (!value) throw new AppError('id_required'); return encodeURIComponent(value); };
  if (command === 'help') {
    console.log('ShittimChest\nchat | send TEXT | event TEXT | status | history [PAGE] | outputs [message|artifact] [CURSOR]\ntasks list|get|create|message|pause|resume|cancel|retry\ncontexts list|create|archive|unarchive|model\nmodels list|save | configuration show|runtime | workspaces list|add\nmcp list|add|connect|reconnect|disconnect | approvals list|approve|decline\nmethods list|get|save|enable|disable|rollback | workflows list|run\nmemory status|resident|request|retry | events [CONTEXT] [CURSOR] | usage [CONTEXT]\ncredentials list|set|remove | schedules list|get|create|update|pause|resume|cancel|run|history\nJSON 参数支持 @文件；--id 标识用于安全重试同一创建操作。密钥通过 credentials set NAME 的隐藏输入或标准输入设置，不放进命令参数。'); return;
  }
  if(command==='tui'||(command==='chat'&&process.stdin.isTTY&&!plain)){
    const controller=new AbortController();
    const interrupt=()=>controller.abort();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
    try{const ready=await ensureCore({signal:controller.signal});for(const code of ready.diagnostics)console.error(`配置待修复：${code}；已以管理模式启动。`);const {runTui}=await import('./tui/index.js');await runTui(ready.client,contextId,controller.signal);}
    finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}return;
  }
  if (command === 'status') { print({ health: await client.request('/health'), configuration: await client.request('/configuration'), approvals: await client.request('/approvals') }); return; }
  if (command === 'credentials') {
    const action = args.shift() ?? 'list';
    if (action === 'list') print(await client.request('/credentials'));
    else if (action === 'set') { const name = id(); if (args.length) throw new AppError('credential_value_must_use_stdin'); print(await write(`/credentials/${name}`, { value: await readSecret() }, 'PUT')); }
    else if (action === 'remove') print(await client.request(`/credentials/${id()}`, { method: 'DELETE' }));
    else throw new AppError('unknown_credential_command'); return;
  }
  if (command === 'tasks') {
    const action = args.shift() ?? 'list';
    if (action === 'list') print(await client.request('/tasks' + (args.length ? `?query=${encodeURIComponent(args.join(' '))}` : '')));
    else if (action === 'get') print(await client.request(`/tasks/${id()}`));
    else if (action === 'create') {
      const raw = args.join(' '); const body = raw.startsWith('@') || raw.startsWith('{') ? jsonInput(args) : { title: raw.slice(0, 160), content: raw };
      print(await write('/tasks', body));
    } else if (action === 'message') { const taskId = id(); print(await write(`/tasks/${taskId}/messages`, { content: args.join(' ') })); }
    else if (['pause', 'resume', 'cancel', 'retry'].includes(action)) { const taskId = id(); print(await write(`/tasks/${taskId}/${action}`, { revision: Number(args.shift()) })); }
    else throw new AppError('unknown_task_command'); return;
  }
  if (command === 'contexts') {
    const action = args.shift() ?? 'list';
    if (action === 'list') print(await client.request('/contexts' + (args.length ? `?query=${encodeURIComponent(args.join(' '))}` : '')));
    else if (action === 'create') print(await write('/contexts', jsonInput(args)));
    else if (action === 'archive' || action === 'unarchive') print(await write(`/contexts/${id()}`, { archived: action === 'archive' }, 'PATCH'));
    else if (action === 'model') { const context = id(); print(await write(`/contexts/${context}/model`, { profileId: args.shift(), ...(args[0] ? { thinkingLevel: args[0] } : {}) })); }
    else throw new AppError('unknown_context_command'); return;
  }
  if(command==='notifications'){const action=args.shift()??'list';if(action==='list')print(await client.request('/notifications'));else if(action==='retry')print(await write(`/notifications/${id()}/retry`,{}));else throw new AppError('unknown_notification_command');return;}
  if (command === 'models' || command === 'configuration' || command === 'workspaces') {
    const action = args.shift() ?? (command === 'configuration' ? 'show' : 'list');
    if (action === 'list' || action === 'show') print(await client.request(command === 'configuration' ? '/configuration' : `/${command}`));
    else if (command === 'models' && action === 'save') print(await write('/configuration/model', jsonInput(args)));
    else if (command === 'workspaces' && action === 'add') print(await write('/configuration/workspace', jsonInput(args)));
    else if (command === 'configuration' && action === 'runtime') print(await write('/configuration/runtime', jsonInput(args)));
    else throw new AppError('unknown_configuration_command'); return;
  }
  if (command === 'mcp') {
    const action = args.shift() ?? 'list';
    if (action === 'list') print(await client.request('/mcp'));
    else if (action === 'add') print(await write('/configuration/mcp', jsonInput(args)));
    else if (['connect', 'reconnect', 'disconnect'].includes(action)) print(await write(`/mcp/${id()}/${action}`, {}));
    else throw new AppError('unknown_mcp_command'); return;
  }
  if (command === 'approvals') {
    const action = args.shift() ?? 'list';
    if (action === 'list') print(await client.request('/approvals'));
    else if (action === 'approve' || action === 'decline') { const approvalId = id(); print(await write(`/approvals/${approvalId}`, { decision: action, scope: args.shift() ?? 'once' })); }
    else throw new AppError('unknown_approval_command'); return;
  }
  if (command === 'methods' || command === 'skills') {
    const action = args.shift() ?? 'list';
    if (action === 'list') print(await client.request('/methods'));
    else if (action === 'get') print(await client.request(`/methods/${id()}`));
    else if (action === 'save') print(await write('/methods', jsonInput(args)));
    else if (action === 'enable' || action === 'disable') { const name = id(); print(await write(`/methods/${name}/control`, { revision: Number(args.shift()), enabled: action === 'enable' })); }
    else if (action === 'rollback') { const name = id(); print(await write(`/methods/${name}/rollback`, { revision: Number(args.shift()), restoreRevision: Number(args.shift()) })); }
    else throw new AppError('unknown_method_command'); return;
  }
  if (command === 'workflows') {
    const action = args.shift() ?? 'list'; if (action === 'list') print(await client.request('/workflows'));
    else if (action === 'run') { const workflow = id(); print(await write(`/workflows/${workflow}/run`, jsonInput(args))); }
    else throw new AppError('unknown_workflow_command'); return;
  }
  if (command === 'memory') {
    const action = args.shift() ?? 'status';
    if (action === 'status') print(await client.request('/memory'));
    else if (action === 'resident') print(await client.request('/memory/resident'));
    else if (action === 'request') print(await write('/memory/requests', { runId: args.shift() }));
    else if (action === 'retry') print(await write(`/memory/jobs/${id()}/retry`, {}));
    else throw new AppError('unknown_memory_command'); return;
  }
  if (command === 'events') { const context = args.shift(), after = args.shift() ?? '0'; print(await client.request(`/events?after=${encodeURIComponent(after)}${context ? `&contextId=${encodeURIComponent(context)}` : ''}`)); return; }
  if (command === 'usage') { print(await client.request(`/usage${args[0] ? `?contextId=${encodeURIComponent(args[0])}` : ''}`)); return; }
  if (command === 'schedules') {
    const action = args.shift() ?? 'list'; const scheduleId = action === 'list' || action === 'create' ? undefined : id();
    const route = scheduleId ? `/schedules/${scheduleId}` : '/schedules';
    if (action === 'create' || action === 'update') {
      const body = jsonInput(args); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('invalid_schedule_json');
      print(await write(route, action === 'create' ? { version: 2, ...body } : body, action === 'create' ? 'POST' : 'PATCH'));
    } else if (['pause', 'resume', 'cancel'].includes(action)) print(await write(`${route}/${action}`, { revision: Number(args.shift()) }));
    else if (action === 'run') print(await write(`${route}/run`, {}));
    else if (action === 'history') print(await client.request(`${route}/occurrences?offset=${encodeURIComponent(args[0] ?? '0')}`));
    else if (action === 'list' || action === 'get') print(await client.request(route));
    else throw new AppError('unknown_schedule_command'); return;
  }
  if (command === 'send' || command === 'event') {
    const text = args.join(' '); if (!text.trim()) throw new AppError('text_required');
    print(await client.submit(text, command === 'send' ? 'user-message' : 'external-event', contextId, operationId)); return;
  }
  if (command === 'run' || command === 'signal') { print(await client.request(`/${command}s/${id()}`)); return; }
  if (command === 'history') { print(await client.request(`/contexts/${encodeURIComponent(contextId)}/history?page=${encodeURIComponent(args[0] ?? '0')}`)); return; }
  if (command === 'outputs') { print(await client.outputs(Number(args[1] ?? 0), args[0] === 'artifact' ? 'artifact' : 'message', contextId)); return; }
  if (command !== 'chat' && command !== 'watch') throw new AppError('unknown_command');
  const kind = command === 'watch' && args[0] === 'artifact' ? 'artifact' : 'message';
  const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  const cursor = new OutputCursor(directory, baseURL, contextId, kind); cursor.read(); let warned = false;
  const watching = watchOutputs({ client, cursor, kind, contextId, signal: controller.signal,
    onOutput: output => { warned = false; console.log(output.kind === 'message' ? `\n阿罗娜> ${output.content}` : `\n${output.title}\n${output.content}`); },
    onError: () => { if (!warned) { console.error('连接暂不可用，正在重试。'); warned = true; } } });
  if (command === 'chat') {
    const reader = createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
    controller.signal.addEventListener('abort', () => reader.close(), { once: true }); reader.on('close', () => controller.abort()); reader.prompt();
    for await (const line of reader) {
      if (line.trim() === '/quit') { reader.close(); break; }
      if (line.trim()) try { await client.submit(line, 'user-message', contextId); } catch (error) { console.error(error instanceof AppError ? error.code : 'request_failed'); }
      reader.prompt();
    }
  }
  await watching;
}
main().catch((error: unknown) => { console.error(error instanceof AppError ? error.code : 'client_failed'); process.exitCode = 1; });
