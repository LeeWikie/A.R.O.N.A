import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { Core } from '../src/core.js';

const config = readConfig();
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arona-live-'));
const core = await Core.open({ dataDir: directory, modelConfig: config.model });
async function wait(runId: string) {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const run = core.store.getRun(runId);
    if (run && run.status !== 'running') {
      assert.equal(run.status, 'succeeded', run.errorCode ?? run.status);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('run_timeout');
}
try {
  const message = await core.submitSignal({ source: 'smoke', type: 'user-message', content: '你好，请简单打个招呼。' });
  await wait(message.runId!);
  const artifact = await core.submitSignal({ source: 'smoke-event', type: 'external-event',
    content: '资料整理已完成，共处理三份示例文档。请将这项结果保存为一份简短的 Markdown 记录。' });
  await wait(artifact.runId!);
  const outputs = core.store.listOutputs({ after: 0 });
  assert.ok(outputs.some(output => output.kind === 'message' && output.signalIds.includes(message.id)));
  assert.ok(outputs.some(output => output.kind === 'artifact' && output.signalIds.includes(artifact.id)));
  assert.ok((await core.history('main')).messages.length > 0);
  console.log(JSON.stringify({ protocol: config.model.protocol, model: config.model.modelId, messages: outputs.filter(o => o.kind === 'message').length, artifacts: outputs.filter(o => o.kind === 'artifact').length, passed: true }));
} catch {
  console.error(JSON.stringify({ protocol: config.model.protocol, passed: false, error: 'live_smoke_failed' }));
  process.exitCode = 1;
} finally {
  await core.close();
  if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('arona-live-')) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
