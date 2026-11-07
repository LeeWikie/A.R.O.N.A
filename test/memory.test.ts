import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './helpers.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

test('memory inherits complete native context, publishes atomically, refreshes and keeps origins', { timeout: 40_000 }, async () => {
  const { Core } = await import('../src/core.js');
  const { until, finished, removeTemp } = await import('./helpers.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-runtime-'));
  const memoryPrompts: string[] = []; const mainPrompts: string[] = []; const turns = new Map<string, number>();
  let call = 0;
  type Action = { toolName: string; toolCallId: string; input: string };
  const choose = (request: { prompt: unknown; tools?: { name: string }[] }): Action | undefined => {
    call++; const prompt = JSON.stringify(request.prompt); const names = request.tools?.map(x => x.name) ?? [];
    if (names.includes('memory_write')) {
      memoryPrompts.push(prompt);
      const id = /来源运行是 ([0-9a-f-]{36})/.exec(prompt)?.[1]; assert.ok(id);
      const phase = turns.get(id) ?? 0; turns.set(id, phase + 1);
      if (phase === 0) return { toolName: 'memory_write', toolCallId: `memory-write-${call}`, input: JSON.stringify({ path: 'shared/preferences.md', content: prompt.includes('新偏好是合成红色') ? '# 偏好\n用户已更正为合成红色。' : '# 偏好\n用户偏好合成蓝色。' }) };
      if (phase === 1) return { toolName: 'memory_commit', toolCallId: `memory-commit-${call}`, input: JSON.stringify({ sourceRunId: id, note: 'Source-preserving synthetic update.' }) };
      return;
    }
    mainPrompts.push(prompt); assert.ok(!names.includes('memory_write'));
    const id = [...prompt.matchAll(/signal_id=\\?"([0-9a-f-]{36})/g)].at(-1)?.[1];
    if (!id) return;
    const phase = turns.get(id) ?? 0; turns.set(id, phase + 1);
    if (phase === 0) return { toolName: 'memory_request', toolCallId: `remember-${call}`, input: JSON.stringify({ signalIds: [id], request: '记住用户原话及后续更正。' }) };
    if (phase === 1) return { toolName: 'emit_message', toolCallId: `reply-${call}`, input: JSON.stringify({ signalIds: [id], text: '已交给后台处理。' }) };
  };
  const model = new MastraLanguageModelV2Mock({
    doStream: async request => { const action = choose(request); return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); if (action) c.enqueue({ type: 'tool-call', ...action });
      c.enqueue({ type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } }); c.close();
    } }) }; },
    doGenerate: async request => { const action = choose(request); return { content: action ? [{ type: 'tool-call' as const, ...action }] : [{ type: 'text' as const, text: 'done' }], finishReason: action ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 }, warnings: [] }; },
  });
  const core = await Core.open({ dataDir: dir, model, memoryEnabled: true });
  try {
    const first = await core.submitSignal({ version: 2, source: 'fixture', type: 'user-message', content: '我的偏好是合成蓝色。请记住。' });
    await finished(core, first.runId!);
    await until(() => core.projectMemory.jobs(), jobs => jobs.some(x => x.runId === first.runId && ['succeeded', 'failed'].includes(x.status)));
    assert.equal(core.projectMemory.jobs().find(x => x.runId === first.runId)?.status, 'succeeded', JSON.stringify(core.projectMemory.status()));
    assert.match(core.projectMemory.resident().text, /合成蓝色/);
    const firstVersion = core.projectMemory.version().id;
    const second = await core.submitSignal({ version: 2, source: 'fixture', type: 'user-message', content: '更正：新偏好是合成红色，不是蓝色。' });
    await finished(core, second.runId!);
    await until(() => core.projectMemory.jobs(), jobs => jobs.some(x => x.runId === second.runId && ['succeeded', 'failed'].includes(x.status)));
    assert.equal(core.projectMemory.jobs().find(x => x.runId === second.runId)?.status, 'succeeded');
    assert.notEqual(core.projectMemory.version().id, firstVersion);
    assert.match(core.projectMemory.resident().text, /合成红色/);
    assert.ok(memoryPrompts.some(p => p.includes('我的偏好是合成蓝色') && p.includes('新偏好是合成红色')));
    assert.ok(memoryPrompts.some(p => p.includes('awaiting_context_snapshot')), 'tool callbacks from the source context must reach the organizer');
    const snapshot = core.projectMemory.snapshot(second.runId!);
    const native = JSON.stringify(snapshot.nativeMessages);
    assert.ok(native.includes('我的偏好是合成蓝色'), 'original first-turn text must remain in the native archive');
    assert.ok(native.includes('新偏好是合成红色'));
    assert.ok(native.includes('awaiting_context_snapshot'), 'the native archive must retain tool results');
    assert.ok(JSON.stringify(snapshot.prompt).includes('我的偏好是合成蓝色'), 'the organizer source prompt must retain earlier original text');
    assert.ok(mainPrompts.some(p => p.includes('合成蓝色')), 'the long-lived conversation must receive the published memory');
    const jobsBefore = core.projectMemory.jobs().length;
    await core.queueMemory(first.runId!);
    assert.equal(core.projectMemory.jobs().length, jobsBefore, 'an already successful source run is not organized twice');
    assert.equal(core.projectMemory.version().generation, 2);
    assert.ok(core.usage().memory.length > 0);
  } finally { await core.close(); await removeTemp(dir); }
});

test('memory snapshots retain native tool exchanges and publication rolls back on failure or cancellation', { timeout: 40_000 }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { RuntimeStore } = await import('../src/runtime-store.js');
  const { ProjectMemory } = await import('../src/memory/index.js');
  const { MemoryFiles } = await import('../src/memory/files.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-atomic-'));
  const db = new DatabaseSync(':memory:'); const store = new RuntimeStore(db); const memory = new ProjectMemory(store, dir);
  const source = (runId: string, sequence: number) => ({ contextId: 'synthetic', runId, sequence, modelProfile: 'default', createdAt: new Date().toISOString(),
    prompt: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: '原始合成输入：蓝色' }] },
      { role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: 'original-call', toolName: 'source_tool', input: { query: '原始查询' } }] },
      { role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: 'original-call', toolName: 'source_tool', output: { type: 'text' as const, value: '原始工具结果' } }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: '原始更正：红色' }] },
    ], nativeMessages: { timestamp: new Date('2020-01-01T00:00:00Z'), bytes: Buffer.from('native-fixture'), source: '原始工具结果' }, providerOptions: {} });
  const first = source('synthetic-new', 2); memory.archive(first);
  assert.deepEqual(memory.snapshot(first.runId), first, 'v8 archive must preserve native types and original evidence');
  const job = memory.newJob(first.runId);
  let step = 0; let sawFullSource = false; let failPublication = true;
  const originalEvent = store.event.bind(store);
  store.event = input => { if (input.kind === 'memory_updated' && failPublication) throw new Error('synthetic event failure'); originalEvent(input); };
  const model = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    const prompt = JSON.stringify(request.prompt);
    sawFullSource ||= ['原始合成输入：蓝色', '原始更正：红色', 'original-call', '原始工具结果'].every(part => prompt.includes(part));
    const names = request.tools?.map(x => x.name) ?? [];
    assert.ok(prompt.includes('Maintain the project memory using the supplied source context as evidence'), 'organizer instructions must not be discarded');
    assert.ok(names.includes('memory_write')); assert.ok(!names.includes('source_tool'));
    assert.equal(memory.version().generation, 0, 'readers must not see a partly staged version');
    const action = step++ % 3 === 0 ? { toolName: 'memory_write', input: { path: 'first.md', content: 'one' } }
      : step % 3 === 2 ? { toolName: 'memory_write', input: { path: 'second.md', content: 'two' } }
      : { toolName: 'memory_commit', input: { sourceRunId: first.runId, note: 'synthetic' } };
    return { content: [{ type: 'tool-call' as const, toolName: action.toolName, toolCallId: `synthetic-${step}`, input: JSON.stringify(action.input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  try {
    await assert.rejects(memory.organize(job.id, () => model));
    assert.ok(sawFullSource, 'organizer must receive original input and native tool round trip');
    assert.equal(memory.version().generation, 0); assert.equal(memory.resident().text, '');
    assert.deepEqual(store.setting('memory-watermarks', {}), {});
    assert.equal(memory.jobs().find(x => x.id === job.id)?.status, 'failed');
    const orphaned = fs.readdirSync(path.join(memory.directory, 'versions')).filter(x => x !== 'initial');
    assert.equal(orphaned.length, 1, 'failed publication keeps its complete files for recovery');
    const abandoned = new MemoryFiles(path.join(memory.directory, 'versions', orphaned[0]!));
    assert.deepEqual(abandoned.list().map(x => x.path), ['first.md', 'second.md']);
    const retry = memory.newJob(first.runId); const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(memory.organize(retry.id, () => model, cancelled.signal));
    assert.equal(memory.jobs().find(x => x.id === retry.id)?.status, 'interrupted');
    assert.equal(memory.version().generation, 0);
    failPublication = false; step = 0;
    const success = memory.newJob(first.runId); await memory.organize(success.id, () => model);
    assert.equal(memory.version().generation, 1);
    assert.deepEqual(memory.status().files.map(x => x.path), ['first.md', 'second.md']);
    assert.match(memory.resident().text, /one/); assert.match(memory.resident().text, /two/);
    const older = source('synthetic-older', 1); memory.archive(older); const stale = memory.newJob(older.runId);
    assert.deepEqual(await memory.organize(stale.id, () => { throw new Error('older source must not run'); }), { superseded: true });
    assert.equal(memory.version().generation, 1); assert.equal(memory.jobs().find(x => x.id === stale.id)?.status, 'superseded');
  } finally { db.close(); await fs.promises.rm(dir, { recursive: true, force: true }); }
});


test('memory file enumeration refuses links instead of silently omitting them', async t => {
  const { MemoryFiles } = await import('../src/memory/files.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-links-'));
  try {
    const files = new MemoryFiles(path.join(dir, 'root')); files.write('visible.md', 'synthetic');
    fs.writeFileSync(path.join(dir, 'outside.md'), 'outside');
    try { fs.linkSync(path.join(dir, 'outside.md'), path.join(files.root, 'linked.md')); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('hard links unavailable'); return; } throw error; }
    assert.throws(() => files.list(), /memory_link_refused/);
    assert.throws(() => files.resident(), /memory_link_refused/);
  } finally { await removeTemp(dir); }
});

test('memory publication keeps unchanged versions, retains failed work and advances only committed watermarks', { timeout: 40_000 }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { RuntimeStore } = await import('../src/runtime-store.js');
  const { ProjectMemory } = await import('../src/memory/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-publication-'));
  const db = new DatabaseSync(':memory:');
  const store = new RuntimeStore(db);
  const memory = new ProjectMemory(store, dir);
  const prompts: string[] = [];
  const toolSets: string[][] = [];
  const readDuringSecond: string[] = [];
  type Action = { toolName: string; toolCallId: string; input: string };
  const run = async (runId: string, sequence: number, actions: Action[], abort?: AbortController) => {
    const nativeMessages = { date: new Date('2020-01-02T00:00:00.000Z'), bytes: new Uint8Array([0, 1, 255]), source: '完整合成来源' };
    const prompt = [
      { role: 'system', content: 'Original source system context' },
      { role: 'user', content: [{ type: 'text', text: '原话：合成蓝色。' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'source-call', toolName: 'source_tool', input: { query: '完整请求' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'source-call', toolName: 'source_tool', output: { type: 'text', value: '原始工具结果' } }] },
      { role: 'user', content: [{ type: 'text', text: '更正：合成红色。' }] },
    ] as import('../src/memory/index.js').ContextSnapshot['prompt'];
    memory.archive({ contextId: 'fixture', runId, sequence, modelProfile: 'fixture', createdAt: new Date().toISOString(), prompt, nativeMessages, providerOptions: {} });
    assert.deepEqual(memory.snapshot(runId).nativeMessages, nativeMessages);
    const job = memory.newJob(runId);
    let step = 0;
    const model = new MastraLanguageModelV2Mock({ doGenerate: async request => {
      prompts.push(JSON.stringify(request.prompt)); toolSets.push(request.tools?.map(x => x.name) ?? []);
      if (runId === 'second') readDuringSecond.push(memory.resident().text);
      if (abort && step === actions.length) abort.abort();
      const action = actions[step++];
      return { content: action ? [{ type: 'tool-call' as const, ...action }] : [{ type: 'text' as const, text: 'done' }], finishReason: action ? 'tool-calls' as const : 'stop' as const, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, warnings: [] };
    } });
    return { job, promise: memory.organize(job.id, () => model, abort?.signal) };
  };
  const write = (id: string, file: string, content: string): Action => ({ toolName: 'memory_write', toolCallId: id, input: JSON.stringify({ path: file, content }) });
  const commit = (id: string): Action => ({ toolName: 'memory_commit', toolCallId: `commit-${id}`, input: JSON.stringify({ sourceRunId: id, note: 'fixture' }) });
  try {
    const first = await run('first', 1, [write('w1', 'a.md', 'A1'), write('w2', 'b.md', 'B1'), commit('first')]);
    assert.equal((await first.promise).changed, true);
    const initial = memory.version();
    assert.match(memory.resident().text, /A1/); assert.match(memory.resident().text, /B1/);
    assert.ok(prompts.some(p => p.includes('原话：合成蓝色') && p.includes('原始工具结果') && p.includes('更正：合成红色')));
    assert.ok(toolSets.every(names => names.includes('memory_write') && !names.includes('source_tool')));
    assert.ok(prompts.every(p => p.includes('Maintain the project memory using the supplied source context as evidence')));

    const unchanged = await run('unchanged', 3, [commit('unchanged')]);
    assert.deepEqual(await unchanged.promise, { version: initial.id, generation: initial.generation, changed: false });
    assert.deepEqual(memory.version(), initial);
    assert.equal(store.setting<Record<string, number>>('memory-watermarks', {}).fixture, 3);
    const old = await run('old', 2, [write('old-write', 'a.md', 'stale'), commit('old')]);
    assert.deepEqual(await old.promise, { superseded: true });
    assert.equal(memory.jobs().find(x => x.id === old.job.id)?.status, 'superseded');
    assert.match(memory.resident().text, /A1/);

    const failed = await run('failed', 4, [write('bad-write', 'a.md', 'unpublished')]);
    await assert.rejects(failed.promise);
    assert.equal(memory.jobs().find(x => x.id === failed.job.id)?.status, 'failed');
    assert.equal(memory.version().id, initial.id);
    assert.equal(store.setting<Record<string, number>>('memory-watermarks', {}).fixture, 3);
    const failedDir = path.join(memory.directory, 'staging', failed.job.id);
    assert.equal(fs.readFileSync(path.join(failedDir, fs.readdirSync(failedDir)[0]!, 'a.md'), 'utf8'), 'unpublished');

    const abort = new AbortController();
    const cancelled = await run('cancelled', 5, [write('cancel-write', 'a.md', 'cancelled')], abort);
    await assert.rejects(cancelled.promise);
    assert.equal(memory.jobs().find(x => x.id === cancelled.job.id)?.status, 'interrupted');
    assert.equal(memory.version().id, initial.id);
    assert.equal(store.setting<Record<string, number>>('memory-watermarks', {}).fixture, 3);

    const originalEvent = store.event.bind(store);
    store.event = event => { if (event.kind === 'memory_updated') throw new Error('injected event failure'); return originalEvent(event); };
    const transactionFailure = await run('transaction-failure', 6, [write('tx-write', 'a.md', 'not committed'), commit('transaction-failure')]);
    await assert.rejects(transactionFailure.promise, /injected event failure/);
    store.event = originalEvent;
    assert.equal(memory.version().id, initial.id);
    assert.equal(memory.jobs().find(x => x.id === transactionFailure.job.id)?.status, 'failed');
    assert.equal(store.setting<Record<string, number>>('memory-watermarks', {}).fixture, 3);
    assert.match(memory.resident().text, /A1/);
    assert.match(memory.resident().text, /B1/);

    const second = await run('second', 7, [write('new-a', 'a.md', 'A2'), write('new-b', 'b.md', 'B2'), commit('second')]);
    assert.equal((await second.promise).changed, true);
    assert.ok(readDuringSecond.length >= 3);
    assert.ok(readDuringSecond.every(text => text.includes('A1') && text.includes('B1') && !text.includes('A2') && !text.includes('B2')));
    assert.equal(memory.version().generation, initial.generation + 1);
    assert.match(memory.resident().text, /A2/); assert.match(memory.resident().text, /B2/);
    assert.equal(fs.readFileSync(path.join(initial.filesDirectory, 'a.md'), 'utf8'), 'A1');
    assert.equal(fs.readFileSync(path.join(initial.filesDirectory, 'b.md'), 'utf8'), 'B1');
  } finally { db.close(); await fs.promises.rm(dir, { recursive: true, force: true }); }
});
