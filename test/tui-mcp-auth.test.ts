import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SelectItem, Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';
import { webUrlCommand } from '../src/tui/open-url.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
type UI = { command(text: string): Promise<void>; capabilities: Set<string>; choose(title: string, items: SelectItem[]): Promise<string | undefined>; note(text: string): void; storageId: string; storageGeneration: number; pendingModal?: () => void; openWebUrl(url: string): Promise<void>; editMcp(id: string): Promise<void>; editStrings(title: string, initial: string[]): Promise<string[] | undefined>; prompt(title: string, initial?: string): Promise<string | undefined> };
function fixture() {
  const calls: Array<{ route: string; method?: string; body?: unknown; storage?: string | null }> = [], notes: string[] = [];
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, storage: new Headers(init?.headers).get('X-ShittimChest-Storage-Id') });
    if (route === '/mcp') return { servers: [{ id: 'fixture', transport: 'http', enabled: true, connected: false, authState: 'needs-auth' }] };
    if (route === '/mcp/fixture/auth') return { id: 'job.fixture', serverId: 'fixture', status: 'awaiting-authorization', authorizationUrl: 'https://example.invalid/authorize?state=synthetic' };
    if (route === '/mcp-auth/jobs/job.fixture') return { id: 'job.fixture', serverId: 'fixture', status: 'succeeded' };
    if (route === '/configuration') return { mcpConfigurations: [{ id: 'fixture', enabled: true, url: 'https://example.invalid/mcp', args: [], headersEnv: {}, env: {} }] };
    if (route === '/configuration/mcp') return {};
    throw new Error(route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as UI; ui.capabilities = new Set(['mcp-oauth']); ui.storageId = 'original'; ui.note = text => { notes.push(text); };
  return { app, ui, calls, notes };
}

test('MCP authorization is observed through completion without reconnecting or opening a browser automatically', { timeout: 3000 }, async () => {
  const { app, ui, calls, notes } = fixture(); let menus = 0, opened = 0;
  try {
    ui.openWebUrl = async () => { opened++; };
    ui.choose = async () => {
      if (++menus === 1) return 'server:fixture'; if (menus === 2) return 'auth';
      return new Promise(resolve => { ui.pendingModal = () => { ui.pendingModal = undefined; resolve(undefined); }; });
    };
    await ui.command('/mcp'); assert.equal(opened, 0); assert.equal(calls.some(call => call.route.endsWith('/connect')), false); assert.equal(calls.some(call => call.method === 'DELETE'), false);
    assert.match(notes.join('\n'), /https:\/\/example\.invalid\/authorize[\s\S]*工具已重新连接/);
  } finally { await app.stop(); }
});

test('MCP browser opening needs an explicit choice and cancellation addresses only the originating storage', async () => {
  const { app, ui, calls } = fixture(); let choices = ['server:fixture', 'auth', 'open', 'cancel']; const opened: string[] = [];
  try {
    ui.choose = async () => choices.shift(); ui.openWebUrl = async url => { opened.push(url); };
    await ui.command('/mcp'); assert.deepEqual(opened, ['https://example.invalid/authorize?state=synthetic']);
    assert.ok(calls.some(call => call.method === 'DELETE' && call.route === '/mcp-auth/jobs/job.fixture' && call.storage === 'original'));
    const before = calls.filter(call => call.method === 'DELETE').length; choices = ['server:fixture', 'auth'];
    ui.choose = async () => { const next = choices.shift(); if (next) return next; ui.storageId = 'replacement'; ui.storageGeneration++; return 'cancel'; };
    await ui.command('/mcp'); assert.equal(calls.filter(call => call.method === 'DELETE').length, before);
  } finally { await app.stop(); }
});

test('MCP OAuth configuration stores a secret reference and explicit connection settings', async () => {
  const { app, ui, calls } = fixture(); const choices = ['oauth', 'clientId', 'yes']; const inputs = ['fixture-client', 'MCP_SECRET_REFERENCE', '5533'];
  try {
    ui.choose = async () => choices.shift(); ui.prompt = async () => inputs.shift(); ui.editStrings = async () => ['tools'];
    await ui.editMcp('fixture');
    const config = calls.find(call => call.route === '/configuration/mcp')?.body as { oauth: unknown };
    assert.deepEqual(config.oauth, { clientId: 'fixture-client', clientSecretEnv: 'MCP_SECRET_REFERENCE', scopes: ['tools'], redirectPort: 5533 });
  } finally { await app.stop(); }
});

test('browser commands accept only explicit HTTP links and keep shell metacharacters as data', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.invalid/']) assert.throws(() => webUrlCommand(value), /invalid_auth_url/);
  const target = "https://example.invalid/?value=';&other=中文";
  const mac = webUrlCommand(target, 'darwin'); assert.equal(mac.command, 'open'); assert.deepEqual(mac.args, [new URL(target).href]);
  const linux = webUrlCommand(target, 'linux'); assert.equal(linux.command, 'xdg-open'); assert.deepEqual(linux.args, [new URL(target).href]);
  const windows = webUrlCommand(target, 'win32'); assert.equal(windows.command, 'powershell.exe'); assert.equal(windows.args.includes('-EncodedCommand'), true);
  const decoded = Buffer.from(windows.args.at(-1)!, 'base64').toString('utf16le'); assert.ok(decoded.includes(`::new('${new URL(target).href.replace(/'/g, "''")}')`)); assert.match(decoded, /UseShellExecute=\$true/);
});
