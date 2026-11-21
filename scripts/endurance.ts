import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

const args = process.argv.slice(2);
const coreDirectory = new URL(args.includes('--compiled-core') ? '../dist/' : '../src/', import.meta.url);
const { Core } = await import(new URL(args.includes('--compiled-core') ? 'core.js' : 'core.ts', coreDirectory).href);
const { createApp } = await import(new URL(args.includes('--compiled-core') ? 'http.js' : 'http.ts', coreDirectory).href);
const option = (name: string, fallback?: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function codeDigest(directory: URL): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (name: string) => {
    for (const entry of (await fs.readdir(name, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(name, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) { hash.update(path.relative(fileURLToPath(directory), file)); hash.update(await fs.readFile(file)); }
    }
  };
  await visit(fileURLToPath(directory)); return hash.digest('hex');
}

async function worker() {
  let call = 0;
  const reported = new Set<string>();
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const last = request.prompt.filter(message => message.role === 'user').at(-1);
    const text = last ? last.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : '';
    if (text.includes('endurance-hold-crash') && request.tools?.length) await new Promise(() => {});
    const id = /"taskId":"([0-9a-f-]{36})/.exec(text)?.[1];
    const report = id && request.tools?.some(tool => tool.name === 'task_report') && !reported.has(id);
    if (report) reported.add(id!);
    const part = `endurance-${++call}`;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (report) controller.enqueue({ type: 'tool-call', toolCallId: part, toolName: 'task_report', input: JSON.stringify({ id, report: { outcome: 'succeeded', summary: 'Synthetic input acknowledged', checks: [{ description: 'Task identity present in model input', passed: true }], deliveries: [], unresolved: [] } }) });
      else {
        controller.enqueue({ type: 'text-start', id: part });
        controller.enqueue({ type: 'text-delta', id: part, delta: 'Synthetic endurance reply' });
        controller.enqueue({ type: 'text-end', id: part });
      }
      controller.enqueue({ type: 'finish', finishReason: report ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      controller.close();
    } }) };
  } });
  const dataDir = option('--data-dir'); if (!dataDir) throw new Error('data_directory_required');
  const core = await Core.open({ dataDir, model, memoryEnabled: false, modelConfig: {
    protocol: 'responses', baseURL: 'https://fixture.invalid/v1', modelId: 'synthetic-endurance', apiKey: 'synthetic-only',
    authHeader: 'bearer', contextWindow: 32000, maxTokens: 4096,
  } });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address() as { port: number };
  process.send?.({ type: 'ready', port: address.port, token: core.controlToken });
  process.on('message', message => {
    if (message !== 'stop') return;
    void (async () => {
      (server as Server).closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await core.close(); process.disconnect?.();
    })().catch(() => process.exit(1));
  });
}

async function supervise() {
  const durationMs = Number(option('--duration-ms', String(24 * 60 * 60_000)));
  const intervalMs = Number(option('--interval-ms', '60000'));
  if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || !Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('invalid_duration');
  const runDirectory = option('--run-dir');
  const directory = runDirectory ? path.resolve(runDirectory) : await fs.mkdtemp(path.join(os.tmpdir(), 'arona-endurance-'));
  if (runDirectory) await fs.mkdir(directory, { mode: 0o700 });
  const dataDir = path.join(directory, 'data');
  const source = await fs.readFile(fileURLToPath(import.meta.url));
  const initialCodeSha256 = await codeDigest(coreDirectory);
  const started = Date.now(), observations: unknown[] = [], failures: string[] = [];
  const monotonicStarted = process.hrtime.bigint();
  const monotonicElapsed = () => Number((process.hrtime.bigint() - monotonicStarted) / 1000000n);
  let child: ChildProcess | undefined, port = 0, token = '', cycle = 0, restarts = 0, crashes = 0;
  let lastObservationAt = started, maxObservationGapMs = 0;
  const observationGapLimitMs = Math.max(60000, intervalMs * 3);
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const checkpoint = async (complete = false) => {
    const elapsedMs = Date.now() - started;
    const monotonicElapsedMs = monotonicElapsed();
    const state = { directory, startedAt: new Date(started).toISOString(), durationMs, elapsedMs, monotonicElapsedMs, intervalMs, cycle, restarts, crashes,
      syntheticModel: true, memoryEnabled: false, sourceSha256: createHash('sha256').update(source).digest('hex'), complete,
      coreMode: args.includes('--compiled-core') ? 'compiled' : 'source', initialCodeSha256,
      maxObservationGapMs, observationGapLimitMs,
      passed: complete && failures.length === 0, qualifiesFor24Hours: complete && failures.length === 0 && cycle > 0 && maxObservationGapMs <= observationGapLimitMs && durationMs >= 24 * 60 * 60_000 && elapsedMs >= durationMs && monotonicElapsedMs >= durationMs,
      observations, failures };
    const temporary = path.join(directory, 'result.next.json');
    const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(directory, 'result.json'));
  };
  const start = async () => {
    if (await codeDigest(coreDirectory) !== initialCodeSha256) throw new Error('code_changed');
    child = fork(fileURLToPath(import.meta.url), ['--worker', '--data-dir', dataDir, ...(args.includes('--compiled-core') ? ['--compiled-core'] : [])], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const current = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { current.kill('SIGKILL'); reject(new Error('worker_start_timeout')); }, 30000);
      const fail = () => { clearTimeout(timer); reject(new Error('worker_start_failed')); };
      current.once('error', fail); current.once('exit', fail);
      current.on('message', value => {
        const message = value as { type?: string; port?: number; token?: string };
        if (message.type !== 'ready' || !message.port || !message.token) return;
        clearTimeout(timer); current.removeListener('error', fail); current.removeListener('exit', fail);
        port = message.port; token = message.token; resolve();
      });
    });
  };
  const stop = async (crash = false) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child, exited = once(current, 'exit');
    if (crash) current.kill('SIGKILL'); else current.send('stop');
    const timer = setTimeout(() => current.kill('SIGKILL'), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response.json() as Promise<any>;
  };
  const waitFor = async (route: string, ready: (value: any) => boolean) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const value = await request(route); if (ready(value)) return value; await pause(50); }
    throw new Error('state_timeout');
  };
  const historyHas = async (text: string) => {
    let cursor: string | undefined;
    for (;;) {
      const page = await request(`/conversation?contextId=main&limit=200${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
      if (page.messages.some((message: { content: string }) => message.content.includes(text))) return true;
      if (!page.hasMore) return false;
      if (!page.nextCursor || page.nextCursor === cursor) throw new Error('history_cursor_stalled');
      cursor = page.nextCursor;
    }
  };
  const attachTerminal = async () => {
    const pty = await import('@lydell/node-pty');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('SHITTIMCHEST_') || key.startsWith('ARONA_')) delete env[key];
    Object.assign(env, { SHITTIMCHEST_DATA_DIR: dataDir, SHITTIMCHEST_CORE_URL: `http://127.0.0.1:${port}`, SHITTIMCHEST_CONTROL_TOKEN: token, SHITTIMCHEST_CONTEXT_ID: 'main', TERM: 'xterm-256color' });
    const terminal = pty.spawn(process.execPath, [...(args.includes('--compiled-core') ? [] : ['--import', 'tsx']), fileURLToPath(new URL(args.includes('--compiled-core') ? 'cli.js' : 'cli.ts', coreDirectory)), 'tui'], { cwd: path.dirname(fileURLToPath(import.meta.url)), cols: 100, rows: 30, name: 'xterm-256color', env });
    await new Promise<void>((resolve, reject) => {
      let text = '', connected = false, statusSent = false;
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('terminal_timeout')); }, 15000);
      terminal.onData(chunk => {
        text = (text + chunk).slice(-64000);
        if (!connected && text.includes('已连接')) {
          connected = true; statusSent = true; terminal.write('/status\r');
          setTimeout(() => terminal.write('/quit\r'), 300).unref();
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (connected && statusSent && exitCode === 0) resolve(); else reject(new Error('terminal_exit_failed'));
      });
    });
  };
  try {
    await checkpoint();
    await start();
    const duty = await request('/schedules', { version: 2, name: 'Synthetic endurance duty', task: 'Acknowledge synthetic input', timing: { kind: 'interval', anchorAt: new Date(Date.now() + 1000).toISOString(), everyMs: Math.max(1000, intervalMs) }, output: { kind: 'none' } });
    observations.push({ type: 'duty-created', id: duty.id });
    console.log(JSON.stringify({ directory, durationMs, intervalMs }));
    while (!interrupted && (Date.now() - started < durationMs || monotonicElapsed() < durationMs)) {
      const observedAt = Date.now(), gapMs = observedAt - lastObservationAt;
      if (gapMs < 0) throw new Error('clock_moved_backwards');
      maxObservationGapMs = Math.max(maxObservationGapMs, gapMs); lastObservationAt = observedAt;
      if (gapMs > observationGapLimitMs) throw new Error('observation_gap');
      const nonce = `endurance-${cycle}-${randomUUID()}`;
      const receipt = await request('/messages', { content: nonce });
      if (!receipt.runId) throw new Error('missing_run_identity');
      const run = await waitFor(`/runs/${receipt.runId}`, value => value.status !== 'running');
      if (run.status !== 'succeeded') throw new Error('message_run_failed');
      if (!await historyHas(nonce)) throw new Error('message_history_missing');
      observations.push({ type: 'message', cycle, runId: receipt.runId, observedAt: new Date(observedAt).toISOString() });
      cycle++;
      if (cycle === 1 || cycle % 10 === 0) {
        await attachTerminal();
        observations.push({ type: 'terminal-attach-detach', cycle });
      }
      if (cycle % 10 === 0) {
        await stop(); await start(); restarts++;
        if (!await historyHas(nonce)) throw new Error('restart_history_missing');
      }
      if (cycle % 20 === 0) {
        const pending = request('/messages', { content: 'endurance-hold-crash' }).catch(() => undefined);
        await pause(200); await stop(true); await pending; await start(); crashes++;
        if (!await historyHas(nonce)) throw new Error('crash_history_missing');
      }
      await checkpoint();
      await pause(Math.min(intervalMs, Math.max(0, durationMs - (Date.now() - started))));
    }
    if (interrupted) throw new Error('interrupted');
    maxObservationGapMs = Math.max(maxObservationGapMs, Date.now() - lastObservationAt);
    if (maxObservationGapMs > observationGapLimitMs) throw new Error('observation_gap');
    const latestDuty = await request(`/schedules/${duty.id}`);
    await request(`/schedules/${duty.id}/pause`, { revision: latestDuty.revision });
    const tasks = await waitFor('/tasks', value => (Array.isArray(value) ? value : value.tasks).every((task: { status: string }) => !['pending', 'running', 'waiting'].includes(task.status)));
    observations.push({ type: 'final-tasks', value: tasks });
    const rows = Array.isArray(tasks) ? tasks : tasks.tasks;
    if (!Array.isArray(rows) || !rows.some((task: { status: string }) => task.status === 'succeeded') || rows.some((task: { status: string }) => ['failed', 'unreported', 'blocked'].includes(task.status))) throw new Error('scheduled_work_not_completed');
    const occurrences = rows.map((task: { occurrenceId?: string }) => task.occurrenceId).filter(Boolean);
    if (new Set(occurrences).size !== occurrences.length) throw new Error('duplicate_scheduled_work');
  } catch (error) { failures.push(error instanceof Error ? error.message : 'endurance_failed'); }
  finally {
    await stop();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (await codeDigest(coreDirectory) !== initialCodeSha256) failures.push('code_changed');
    await checkpoint(true);
  }
  console.log(JSON.stringify({ directory, passed: failures.length === 0, cycle, restarts, crashes }));
  if (failures.length) process.exitCode = 1;
}

if (args.includes('--worker')) await worker(); else await supervise();
