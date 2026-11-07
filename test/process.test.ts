import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client, OutputCursor } from '../src/client.js';
import type { RunRecord, SignalRecord } from '../src/domain.js';
import type { Schedule, Occurrence } from '../src/schedules.js';
import { removeTemp, until } from './helpers.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function worker(directory: string) {
  const child = fork(path.join(root, 'test/child-core.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  let calls = 0;
  let port: number | undefined;
  let token: string | undefined;
  child.on('message', (message) => {
    const value = message as { type: string; port?: number; token?: string };
    if (value.type === 'ready') { port = value.port; token = value.token; }
    if (value.type === 'model-call') calls++;
  });
  await until(() => ({ port, exited: child.exitCode }), value => !!value.port || value.exited !== null);
  assert.ok(port, `worker failed: ${stderr}`);
  return { child, client: new Client(`http://127.0.0.1:${port}`, token, 1), calls: () => calls };
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
    // Display and the following durable checkpoint are separate operations; a hard
    // process kill between them may replay a delivered record (at-least-once).
    const replayCursor=new OutputCursor(path.join(directory,'client'),running.client.baseURL,'main','message');
    await until(()=>replayCursor.read(),value=>value>0);
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

test('scheduled artifacts and unfinished duties persist across process death without replay', { timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-process-schedules-'));
  let running = await worker(directory);
  const post = <T>(url: string, body: unknown) => running.client.request<T>(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const occurrences = (id: string) => running.client.request<{ occurrences: Occurrence[] }>(`/schedules/${id}/occurrences`);
  try {
    const saved = await post<Schedule>('/schedules', {
      name: 'Synthetic persistent artifact', task: 'Save the synthetic artifact.',
      timing: { kind: 'once', at: new Date(Date.now() + 3600_000).toISOString() }, output: { kind: 'artifact' },
    });
    const manual = await post<Occurrence>(`/schedules/${saved.id}/run`, {});
    await until(running.calls, count => count > 0);
    running.child.send('release');
    await until(() => running.client.request<RunRecord>(`/runs/${manual.signal!.runId}`), value => value.status !== 'running');
    assert.equal((await occurrences(saved.id)).occurrences[0]!.outputs[0]!.kind, 'artifact');
    await stop(running.child, true);
    running = await worker(directory);
    assert.equal((await occurrences(saved.id)).occurrences[0]!.outputs[0]!.kind, 'artifact');
    const inFlight = await post<Schedule>('/schedules', {
      name: 'Synthetic interrupted duty', task: 'Wait for synthetic processing.',
      timing: { kind: 'once', at: new Date(Date.now() + 100).toISOString() },
    });
    await until(running.calls, count => count > 0);
    const flight = (await occurrences(inFlight.id)).occurrences[0]!;
    const missed = await post<Schedule>('/schedules', {
      name: 'Synthetic missed duty', task: 'Do not replay this task.',
      timing: { kind: 'once', at: new Date(Date.now() + 100).toISOString() },
    });
    await stop(running.child, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    running = await worker(directory);
    assert.equal((await occurrences(inFlight.id)).occurrences[0]!.report.status, 'interrupted');
    assert.equal((await running.client.request<RunRecord>(`/runs/${flight.signal!.runId}`)).status, 'interrupted');
    assert.equal((await running.client.request<Schedule>(`/schedules/${missed.id}`)).status, 'expired');
    assert.equal((await occurrences(missed.id)).occurrences.length, 0);
    assert.equal(running.calls(), 0);
  } finally { await stop(running.child); await removeTemp(directory); }
});
