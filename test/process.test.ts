import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '../src/client.js';
import type { RunRecord, SignalRecord } from '../src/domain.js';
import { removeTemp, until } from './helpers.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function worker(directory: string) {
  const child = fork(path.join(root, 'test/child-core.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  let calls = 0;
  let port: number | undefined;
  child.on('message', (message) => {
    const value = message as { type: string; port?: number };
    if (value.type === 'ready') port = value.port;
    if (value.type === 'model-call') calls++;
  });
  await until(() => ({ port, exited: child.exitCode }), value => !!value.port || value.exited !== null);
  assert.ok(port, `worker failed: ${stderr}`);
  return { child, client: new Client(`http://127.0.0.1:${port}`), calls: () => calls };
}

async function stop(child: ReturnType<typeof fork>, hard = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(hard ? 'SIGKILL' : 'SIGTERM');
  await exited;
}

test('independent CLI disconnect/reconnect, full history and crash interruption across real processes', { timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-process-'));
  let running = await worker(directory);
  try {
    const receipt = await running.client.submit('Synthetic persistent conversation', 'user-message');
    await until(running.calls, count => count > 0);
    const observer = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'watch'], {
      cwd: root, env: { ...process.env, ARONA_DATA_DIR: directory, ARONA_CORE_URL: running.client.baseURL }, stdio: 'pipe',
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    await stop(observer);
    assert.equal((await running.client.request<{ status: string }>('/health')).status, 'ok');
    running.child.send('release');
    const run = await until(() => running.client.request<RunRecord>(`/runs/${receipt.runId}`), value => value.status !== 'running');
    assert.equal(run.status, 'succeeded');
    const replay = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'watch'], {
      cwd: root, env: { ...process.env, ARONA_DATA_DIR: directory, ARONA_CORE_URL: running.client.baseURL }, stdio: 'pipe',
    });
    let shown = '';
    replay.stdout.on('data', chunk => { shown += String(chunk); });
    await until(() => shown, value => value.includes('Synthetic reply'));
    await stop(replay);
    const resumed = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'watch'], {
      cwd: root, env: { ...process.env, ARONA_DATA_DIR: directory, ARONA_CORE_URL: running.client.baseURL }, stdio: 'pipe',
    });
    let repeated = '';
    resumed.stdout.on('data', chunk => { repeated += String(chunk); });
    await new Promise(resolve => setTimeout(resolve, 1000));
    await stop(resumed);
    assert.equal(repeated.includes('Synthetic reply'), false);
    const firstPage = await running.client.request<{ messages: unknown[]; hasMore: boolean }>('/contexts/main/history?perPage=1&page=0');
    const secondPage = await running.client.request<{ messages: unknown[] }>('/contexts/main/history?perPage=1&page=1');
    assert.equal(firstPage.messages.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.equal(secondPage.messages.length, 1);
    await stop(running.child, true);
    running = await worker(directory);
    assert.equal((await running.client.outputs(0, 'message', 'main')).outputs.length, 1);
    assert.ok((await running.client.request<{ messages: unknown[] }>('/contexts/main/history')).messages.length > 0);
    const interrupted = await running.client.submit('Interrupt this run', 'external-event', 'background', randomUUID());
    await until(running.calls, count => count > 0);
    await stop(running.child, true);
    running = await worker(directory);
    assert.equal((await running.client.request<RunRecord>(`/runs/${interrupted.runId}`)).status, 'interrupted');
    assert.equal((await running.client.request<SignalRecord>(`/signals/${interrupted.id}`)).status, 'interrupted');
    assert.equal(running.calls(), 0, 'a restart must not call the model to replay interrupted work');
    assert.equal((await running.client.outputs(0, 'message', 'main')).outputs.length, 1);
  } finally { await stop(running.child); await removeTemp(directory); }
});
