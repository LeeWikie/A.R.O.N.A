import * as pty from '@lydell/node-pty';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { removeTemp } from './helpers.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-cli-'));
const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
  controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' });
  controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'CLI fixture reply' }); controller.enqueue({ type: 'text-end', id: 'reply' });
  controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
} }) }) });
const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await once(server, 'listening');
const require = createRequire(import.meta.url);
const env = { ...process.env, TERM: 'xterm-256color', SHITTIMCHEST_DATA_DIR: directory, SHITTIMCHEST_CORE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SHITTIMCHEST_CONTROL_TOKEN: core.controlToken };
const child = pty.spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'chat'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env });
let output = ''; let asked = false; let quitting = false;
const timeout = setTimeout(() => { child.kill(); console.error('CLI_PTY_TIMEOUT'); process.exitCode = 1; }, 12_000);
child.onData(data => {
  output += data;
  if (!asked && output.includes('ShittimChest') && output.includes('已连接')) { asked = true; setTimeout(() => child.write('CLI fixture question\r'), 100); }
  if (!quitting && output.includes('CLI fixture reply')) { quitting = true; setTimeout(() => child.write('/quit\r'), 200); }
});
child.onExit(({ exitCode }) => {
  clearTimeout(timeout); child.kill();
  void (async () => {
    try {
      if (!asked || !quitting || exitCode !== 0) { console.error(`CLI_PTY_FAILURE asked=${asked} quitting=${quitting} exit=${exitCode} output=${JSON.stringify(output.slice(-4000))}`); process.exitCode = 1; }
      else console.log('CLI_PTY_PASSED');
    } finally { (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
});
