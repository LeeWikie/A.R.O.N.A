import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import type { LoginDialogComponent } from '../src/tui/upstream/login-dialog.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
async function until(read: () => string, ready: (value: string) => boolean) { for (let i = 0; i < 100; i++) { if (ready(read())) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('auth dialog was not ready'); }
type Item = { value: string; label: string };
type Internals = {
  providerAuth(requested?: string): Promise<void>;
  loginDialog?: LoginDialogComponent;
  createTask(): Promise<void>;
  createContext(name?: string): Promise<void>;
  switchContext(id: string): void;
  models(): Promise<void>;
  createModel(): Promise<void>;
  pick(title: string, items: Item[], empty: string): Promise<string | undefined>;
  choose(title: string, items: Item[]): Promise<string | undefined>;
  prompt(title: string): Promise<string | undefined>;
  promptLong(title: string): Promise<string | undefined>;
  note(text: string): void;
};
function fixture(methods: Array<'api_key' | 'oauth'> = ['api_key'], configured = false) {
  const calls: Array<{ route: string; method?: string; body?: unknown }> = [];
  const menus: Array<{ title: string; values: string[] }> = [];
  const notes: string[] = [];
  const client = { async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (route === '/auth/providers') return { providers: [{ id: 'fixture', name: 'Fixture', methods: methods.map(type => ({ type, name: type })) }] };
    if (route === '/auth/status/fixture') return { configured, source: 'local' };
    if (route === '/auth/fixture/start') return { id: 'job', state: 'running' };
    if (route === '/auth/jobs/job') return { id: 'job', state: 'running', promptId: 'key', prompt: { type: 'secret', message: '输入 API key' } };
    if (route === '/auth/jobs/job/respond') return { id: 'job', state: 'completed' };
    if (route === '/workspaces') return { workspaces: [{ id: 'project', name: 'Project', path: '/fixture' }] };
    if (route === '/tasks') return { id: 'task', status: 'pending' };
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as Internals;
  let choices: Array<string | undefined> = [];
  target.choose = async (title, items) => { menus.push({ title, values: items.map(item => item.value) }); return choices.shift(); };
  target.note = text => { notes.push(text); };
  return { app, target, calls, menus, notes, select: (...values: Array<string | undefined>) => { choices = values; } };
}

test('唯一供应商和登录方式直接进入密钥输入', async () => {
  const { app, target, calls, menus } = fixture();
  try {
    const operation = target.providerAuth(); await until(() => target.loginDialog?.render(80).join('\n') ?? '', text => text.includes('输入 API key'));
    target.loginDialog!.handleInput('synthetic-key'); target.loginDialog!.handleInput('\r'); await operation;
    assert.deepEqual(menus, []);
    assert.deepEqual(calls.find(call => call.route.endsWith('/respond'))?.body, { value: 'synthetic-key', promptId: 'key' });
  } finally { await app.stop(); }
});

test('多个登录方式保留选择，取消不启动认证', async () => {
  const { app, target, calls, menus, select } = fixture(['api_key', 'oauth']);
  try {
    select(undefined); await target.providerAuth('fixture');
    assert.deepEqual(menus.map(menu => menu.values), [['api_key', 'oauth']]);
    assert.equal(calls.some(call => call.route.endsWith('/start')), false);
  } finally { await app.stop(); }
});

test('已有凭据时保留更新或移除的选择，并保留移除确认', async () => {
  const { app, target, calls, menus, select } = fixture(['api_key'], true);
  try {
    select('logout', 'no'); await target.providerAuth('fixture');
    assert.deepEqual(menus.map(menu => menu.values), [['api_key', 'logout'], ['no', 'yes']]);
    assert.equal(calls.some(call => call.method === 'DELETE'), false);
    select('logout', 'yes'); await target.providerAuth('fixture');
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  } finally { await app.stop(); }
});

test('只有取消操作的等待界面仍呈现，不作为唯一数据项执行', async () => {
  const { app, target, calls, menus, select } = fixture(['oauth']);
  const client = (app as unknown as { client: Client }).client;
  const request = client.request.bind(client);
  client.request = async (route, init) => route === '/auth/jobs/job' && !init?.method
    ? { id: 'job', state: 'running' } as never : request(route, init);
  try {
    const operation = target.providerAuth(); await until(() => target.loginDialog?.render(80).join('\n') ?? '', text => text.includes('等待供应商授权'));
    assert.match(target.loginDialog!.render(80).join('\n'), /Esc.*取消/); target.loginDialog!.handleInput('\x1b'); await operation;
    assert.deepEqual(menus, []);
    assert.equal(calls.some(call => call.route === '/auth/jobs/job' && call.method === 'DELETE'), true);
  } finally { await app.stop(); }
});

test('唯一工作区跳过数据选择，但任务权限和提交确认仍保留', async () => {
  const { app, target, calls, menus, select } = fixture();
  target.prompt = async () => '检查文件'; target.promptLong = async () => '读取文件并核对';
  try {
    select('safe', 'no'); await target.createTask();
    assert.deepEqual(menus.map(menu => menu.values), [['safe', 'custom'], ['yes', 'no']]);
    assert.equal(calls.some(call => call.route === '/tasks'), false);
    assert.match(menus[1]!.title, /工作区：Project\n路径：\/fixture/);
    select('safe', 'yes'); await target.createTask();
    assert.deepEqual(calls.find(call => call.route === '/tasks')?.body, { title: '检查文件', content: '读取文件并核对', workspaceId: 'project', returnContextId: 'main' });
  } finally { await app.stop(); }
});

test('空数据有明确反馈，停止后不继续自动选择', async () => {
  const { app, target, notes, menus } = fixture();
  try {
    assert.equal(await target.pick('模型', [], '还没有模型配置。'), undefined);
    assert.deepEqual(notes, ['还没有模型配置。']); assert.equal(menus.length, 0);
    await app.stop();
    assert.equal(await target.pick('模型', [{ value: 'only', label: 'Only' }], '空'), undefined);
  } finally { await app.stop(); }
});


test('未知供应商参数不自动替换成唯一供应商', async () => {
  const { app, target, calls, menus, notes } = fixture();
  try {
    await target.providerAuth('misspelled');
    assert.equal(calls.some(call => call.route.endsWith('/start')), false);
    assert.equal(menus.length, 0); assert.match(notes[0]!, /没有名为 misspelled 的供应商/);
  } finally { await app.stop(); }
});


test('选择模型立即生效，不再要求选择思考等级', async () => {
  const { app, target, calls, menus, select } = fixture();
  const client = (app as unknown as { client: Client }).client; const request = client.request.bind(client);
  client.request = async (route, init) => route === '/models'
    ? { models: [{ id: 'only', name: 'Only', modelId: 'model', thinking: { high: { reasoningEffort: 'high' } } }] } as never : request(route, init);
  try {
    select('only'); await target.models();
    assert.equal(menus.length, 1);
    assert.deepEqual(calls.find(call => call.route === '/contexts/main/model')?.body, { profileId: 'only' });
  } finally { await app.stop(); }
});

test('目录模型无思考等级时直接使用提供方默认，仅保存而不自动切换', async () => {
  const { app, target, calls, menus, select } = fixture();
  const client = (app as unknown as { client: Client }).client; const request = client.request.bind(client);
  client.request = async (route, init) => route === '/models' ? { models: [] } as never
    : route === '/provider-models' ? { models: [{ providerId: 'fixture', modelId: 'simple', name: 'Simple', thinkingLevels: [] }] } as never : request(route, init);
  const inputs = ['simple-config', 'Simple']; target.prompt = async () => inputs.shift();
  try {
    select('catalog'); await target.createModel();
    assert.deepEqual(menus.map(menu => menu.values), [['catalog', 'custom']]);
    assert.deepEqual(calls.find(call => call.route === '/configuration/model')?.body, { id: 'simple-config', name: 'Simple', providerId: 'fixture', modelId: 'simple' });
    assert.equal(calls.some(call => call.route === '/contexts/main/model'), false);
  } finally { await app.stop(); }
});

test('命名快捷命令与菜单新建均显式选择工作区，不静默回落 default', async () => {
  const { app, target, calls, menus, select } = fixture();
  const client = (app as unknown as { client: Client }).client; const request = client.request.bind(client);
  client.request = async (route, init) => route === '/workspaces'
    ? { workspaces: [{ id: 'default', name: 'Default' }, { id: 'project', name: 'Project' }] } as never : request(route, init);
  const inputs = ['Fresh', '']; target.prompt = async () => inputs.shift(); target.switchContext = () => {};
  try {
    select('project'); await target.createContext('Fresh');
    select('project'); await target.createContext();
    const bodies = calls.filter(call => call.route === '/contexts').map(call => call.body);
    assert.deepEqual(bodies, Array(2).fill({ name: 'Fresh', purpose: '', workspaceId: 'project', role: 'main' }));
    assert.deepEqual(menus.map(menu => menu.values), [['default', 'project'], ['default', 'project']]);
  } finally { await app.stop(); }
});
