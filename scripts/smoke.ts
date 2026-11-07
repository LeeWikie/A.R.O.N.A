import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { Core } from '../src/core.js';

if (process.env.SHITTIMCHEST_ALLOW_LIVE_TESTS !== '1') throw new Error('live_test_authorization_required');
const config = readConfig();
if (!config.model) throw new Error('live_model_not_configured');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arona-live-'));
const core = await Core.open({ dataDir: directory, modelConfig: config.model, memoryEnabled: false, maxSteps: 16 });
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean) {
  const end = Date.now() + 120_000;
  while (Date.now() < end) { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('live_test_timeout');
}
try {
  await fs.writeFile(path.join(directory, 'workspace/input.txt'), 'Synthetic source: violet-17.');
  const greeting = await core.submitSignal({ version: 2, source: 'smoke', type: 'user-message', content: '你好，只需要简短打个招呼。' });
  await until(() => core.store.getRun(greeting.runId!), value => !!value && value.status !== 'running');
  const task = await core.submitTask({ title: 'Synthetic file task', content: '读取工作区 input.txt，将其内容原样写入 result.txt。实际检查文件后报告完成并引用实际文件。不要执行命令或连接外部服务。',
    grants: { write: true, execute: false, mcp: false } }, 'live-file-task');
  const result = await until(() => core.runtime.task(task.id), value => !['pending', 'running', 'waiting'].includes(value.status));
  assert.equal(result.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(directory, 'workspace/result.txt'), 'utf8'), 'Synthetic source: violet-17.');
  assert.ok(result.report?.deliveries.some(x => x.kind === 'file' && x.sha256));
  assert.ok((await core.history(result.contextId)).messages.length);
  console.log(JSON.stringify({ protocol: config.model.protocol, model: config.model.modelId, task: result.status, actualFileVerified: true, usage: core.usage(), passed: true }));
} catch {
  console.error(JSON.stringify({ protocol: config.model.protocol, passed: false, error: 'live_smoke_failed' })); process.exitCode = 1;
} finally {
  await core.close();
  if (process.platform === 'win32') global.gc?.();
  if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('arona-live-')) await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
