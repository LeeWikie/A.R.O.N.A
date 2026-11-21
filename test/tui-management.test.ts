import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('management forms submit typed backend contracts and revisions', async () => {
  const calls: Array<{ route: string; method?: string; body?: unknown }> = [];
  const client = { async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
    if (route === '/workspaces') return { workspaces: [{ id: 'root', name: 'Root', path: 'C:/fixture' }] };
    if (route === '/tasks') return { id: 'task', status: 'pending' };
    if (route === '/schedules') return init?.method ? {} : { schedules: [{ id: 'duty', name: 'Duty', status: 'active', revision: 7 }] };
    if (route === '/mcp') return { servers: [{ id: 'server', connected: false, transport: 'stdio', enabled: true }] };
    if (route === '/methods') return { methods: [{ name: 'method', description: 'desc', instructions: 'text', revision: 4, enabled: true }] };
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal());
  const target = app as unknown as { choose: () => Promise<string | undefined>; prompt: () => Promise<string | undefined>; promptLong: () => Promise<string | undefined>; createTask: () => Promise<void>; schedules: () => Promise<void>; mcp: () => Promise<void>; methods: () => Promise<void>; workspaces: () => Promise<void> };
  let choices: string[] = [], prompts: string[] = [];
  target.choose = async () => choices.shift(); target.prompt = async () => prompts.shift(); target.promptLong = async () => prompts.shift();
  try {
    choices = ['safe', 'yes']; prompts = ['Title', 'Do work']; await target.createTask();
    assert.deepEqual(calls.find(x => x.route === '/tasks' && x.method === 'POST')?.body, { title: 'Title', content: 'Do work', workspaceId: 'root', returnContextId: 'main' });
    choices = ['duty', 'cancel', 'yes']; await target.schedules();
    assert.deepEqual(calls.find(x => x.route === '/schedules/duty/cancel')?.body, { revision: 7 });
    choices = ['__add__', 'interval', 'message', 'yes']; prompts = ['Repeated', 'Check work', '2027-01-01T00:00:00Z', '60000', 'UTC']; await target.schedules();
    assert.deepEqual(calls.find(x => x.route === '/schedules' && x.method === 'POST')?.body, { version: 2, name: 'Repeated', task: 'Check work', timing: { kind: 'interval', anchorAt: '2027-01-01T00:00:00Z', everyMs: 60000 }, timezone: 'UTC', output: { kind: 'message', contextId: 'main' } });
    choices = ['server:server', 'connect', 'yes']; await target.mcp();
    assert.deepEqual(calls.find(x => x.route === '/mcp/server/connect')?.body, {});
    choices = ['method', 'toggle']; await target.methods();
    assert.deepEqual(calls.find(x => x.route === '/methods/method/control')?.body, { revision: 4, enabled: false });
    choices = ['__add__', 'yes']; prompts = ['other', 'Other', 'C:/fixture']; await target.workspaces();
    assert.deepEqual(calls.find(x => x.route === '/configuration/workspace')?.body, { id: 'other', name: 'Other', path: 'C:/fixture' });
  } finally { await app.stop(); }
});
