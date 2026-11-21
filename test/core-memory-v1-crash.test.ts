import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import test from 'node:test';
import type { MemoryJob } from '../src/memory/index.js';
import type { ContextSnapshot } from '../src/memory/index.js';
import { until, removeTemp } from './helpers.js';

interface Ready { type: 'ready'; port: number; token: string; storageId: string }
interface Inspection {
  type: 'inspection'; version: { id: string; generation: number; source: { runId: string } | null };
  memory: { pendingRecords: number; intake: { accepted: number; pendingSource: number } };
  jobs: MemoryJob[]; views: Array<{ run_id: string; body: string }>;
  runs: Array<{ id: string; status: string }>; intake: Array<{ run_id: string; signal_id: string }>;
  receipts: Array<{ id: string; evidence_id: string; receipt_json: string }>;
  processing: Array<{ job_id: string; source_json: string; result_json: string }>;
  versions: Array<{ id: string }>; events: Array<{ kind: string; runId: string; data: unknown }>;
  nativeTasks: { tasks: Array<{ id: string; status: string }>; total: number };
  snapshots: ContextSnapshot[];
}
async function launch(directory: string, phase: string, memoryEnabled = true) {
  const child = fork(fileURLToPath(new URL('./memory-v1-crash-fixture.ts', import.meta.url)), [directory, phase], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, SYNTHETIC_MEMORY_ENABLED: String(memoryEnabled) } });
  const messages: Array<Record<string, unknown>> = []; let logs = '';
  child.on('message', value => { if (value && typeof value === 'object') messages.push(value as Record<string, unknown>); });
  child.stderr?.on('data', value => { logs = (logs + String(value)).slice(-12000); }); child.stdout?.on('data', value => { logs = (logs + String(value)).slice(-12000); });
  const ready = await until(() => { if (child.exitCode !== null || child.signalCode !== null) throw Error(`fixture_exited: ${logs}`); return messages.find(row => row.type === 'ready') as unknown as Ready | undefined; }, Boolean, 20000);
  return { child, ready: ready!, messages, get logs() { return logs; },
    async request<T = unknown>(route: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${ready!.port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: await response.json() as T };
    },
    async inspect() { const start = messages.length; child.send({ type: 'inspect' }); const result = await until(() => messages.slice(start).find(row => row.type === 'inspection') as unknown as Inspection | undefined, Boolean, 10000) as Inspection; fs.writeFileSync(path.join(directory, `inspection-${child.pid}.json`), JSON.stringify(result, null, 2)); return result; },
  };
}

test('recovered evidence requires its host proof and cannot acquire origin through an import or rewritten source', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovered-origin-')); const children: ChildProcess[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } }); c.close(); } }) }) });
  let baseline: Core | undefined;
  try {
    const first = await launch(directory, 'view-bound', false); children.push(first.child); const submitted = first.request('/messages', { content: input }).catch(() => null);
    await until(() => fs.existsSync(path.join(directory, 'checkpoint.json')), Boolean, 20000); await stop(first.child, true); await submitted;
    baseline = await Core.open({ dataDir: directory, model, memoryEnabled: false });
    const runId = String(baseline.store.db.prepare('SELECT id FROM runs ORDER BY rowid LIMIT 1').get()!.id), snapshot = baseline.projectMemory.snapshot(runId);
    const original = await baseline.prepareMemorySource(runId); const canonicalId = original.records.find(row => row.kind === 'user-statement')!.id;
    assert.equal(original.gaps.length, 0); const sourceId = snapshot.recovery!.sourceMessageIds[0]!;
    const proofKey = `session-recovered-source:main:${sourceId}`, proof = baseline.runtime.setting<Record<string, unknown>>(proofKey, {});
    assert.equal(proof.messageId, sourceId); assert.equal(typeof proof.digest, 'string');
    const exported = await baseline.exportPiContext('main', true); const originalEntryIds = baseline.sessionGraph.records('main').map(row => row.entry.id);
    await baseline.close(); baseline = undefined;
    for (const kind of ['missing-proof', 'forged-proof', 'rewritten-raw', 'import-same-ids'] as const) await t.test(kind, async () => {
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-recovered-origin-copy-')); fs.cpSync(directory, clone, { recursive: true }); let core: Core | undefined;
      try {
        core = await Core.open({ dataDir: clone, model, memoryEnabled: false });
        if (kind === 'import-same-ids') {
          const imported = await core.importPiContext({ id: 'chat.imported', name: 'Synthetic import', jsonl: exported.jsonl, modelProfile: 'default' });
          assert.ok(core.sessionGraph.records(imported.id).some(row => originalEntryIds.includes(row.entry.id)));
          core.runtime.setSetting(`session-recovered-source:${imported.id}:${sourceId}`, proof);
          const receipt = await core.submitMessage({ contextId: imported.id, content: 'A fresh, independent input.' });
          await until(() => core!.store.getRun(receipt.runId!)?.status, status => status !== 'running');
          const source = await core.prepareMemorySource(receipt.runId!);
          assert.ok(!source.records.some(row => row.id === canonicalId)); assert.ok(source.gaps.some(row => row.reason === 'unresolved-origin'));
        } else {
          if (kind === 'missing-proof') core.store.db.prepare('DELETE FROM runtime_settings WHERE id=?').run(proofKey);
          if (kind === 'forged-proof') core.runtime.setSetting(proofKey, { ...proof, digest: '0'.repeat(64) });
          if (kind === 'rewritten-raw') {
            const raw = core.sessionGraph.source('main', sourceId) as { content: { parts: unknown[] } };
            raw.content.parts = [{ type: 'text', text: 'SYNTHETIC_FORGED_FACT' }]; core.store.db.prepare('UPDATE session_graph_sources SET body=? WHERE context_id=? AND id=?').run(JSON.stringify(raw), 'main', sourceId);
          }
          const source = await core.prepareMemorySource(runId);
          assert.ok(!source.records.some(row => row.id === canonicalId)); assert.ok(source.gaps.some(row => row.reason === 'unresolved-origin'));
          assert.doesNotMatch(JSON.stringify([...source.contents.values()]), /SYNTHETIC_FORGED_FACT/);
          assert.deepEqual(core.projectMemory.snapshot(runId), snapshot, 'source verification does not rewrite the preserved recovery archive');
        }
      } finally { await core?.close(); await removeTemp(clone); }
    });
  } finally { await baseline?.close(); for (const child of children) await stop(child); await removeTemp(directory); }
});
async function stop(child: ChildProcess, hard = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(hard ? 'SIGKILL' : 'SIGTERM'); let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 7000); })]); } finally { clearTimeout(timer); }
}
function observations(directory: string) {
  const filename = path.join(directory, 'model-observations.jsonl');
  return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number; kind: string; value: unknown }) : [];
}
const input = 'SYNTHETIC_USER_INTENT: I plan violet-17 training; it has not started.\nKeep this exact final newline.\n';

for (const phase of ['view-bound', 'provider-request', 'archive-before', 'archive-after', 'source-prepared', 'intake-materialized', 'native-before-binding', 'native-enqueued', 'writer-request', 'review-request', 'published-files', 'publication-transaction', 'publication-committed', 'legacy-publication-committed', 'admission-ack']) {
  test(`memory publication survives a real process kill at ${phase}`, { timeout: 45000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-crash-')); const children: ChildProcess[] = [];
    try {
      const first = await launch(directory, phase); children.push(first.child);
      const accepted = first.request('/messages', { content: input }).catch(() => null);
      await until(() => fs.existsSync(path.join(directory, 'checkpoint.json')), Boolean, 20000);
      const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.json'), 'utf8')) as { phase: string; value: unknown };
      assert.equal(checkpoint.phase, phase);
      const db = new DatabaseSync(path.join(directory, 'records.sqlite'), { readOnly: true });
      let runId: string, signalId: string;
      try { const row = db.prepare('SELECT id,run_id,body FROM signals ORDER BY rowid LIMIT 1').get()!; runId = String(row.run_id); signalId = String(row.id); assert.equal(JSON.parse(String(row.body)).content, input); }
      finally { db.close(); }
      await stop(first.child, true); await accepted;
      const after = await launch(directory, 'none'); children.push(after.child); assert.equal(after.ready.storageId, first.ready.storageId);
      const restored = await until(() => after.inspect(), state => state.memory.pendingRecords === 0 && state.jobs.some(job => job.runId === runId && job.status === 'succeeded') && state.jobs.every(job => !['pending', 'running'].includes(job.status)) && state.nativeTasks.tasks.every(task => !['pending', 'running', 'suspended'].includes(task.status)), 15000);
      assert.equal(restored.nativeTasks.tasks.length, restored.nativeTasks.total);
      if (['view-bound', 'provider-request', 'archive-before'].includes(phase)) {
        const snapshot = restored.snapshots.find(row => row.runId === runId)!; assert.ok(snapshot);
        assert.deepEqual(snapshot.promptState, { stage: 'recovery', status: 'unavailable' }); assert.deepEqual(snapshot.prompt, []); assert.equal(snapshot.lastRequestPrompt, undefined);
        assert.equal(snapshot.recovery?.requestEvidence.length, phase === 'view-bound' ? 0 : 1, 'persisted request hashes distinguish preparation from a model request without inventing prompt bytes');
        assert.ok(snapshot.recovery?.sourceMessageIds.length);
      }
      assert.ok(restored.intake.some(row => row.run_id === runId && row.signal_id === signalId));
      assert.equal(restored.version.generation, 1); assert.equal(restored.versions.length, 1);
      assert.equal(restored.events.filter(event => event.kind === 'memory_updated').length, 1);
      assert.ok(restored.processing.every(row => JSON.parse(row.source_json).runId === runId));
      if (['publication-committed', 'legacy-publication-committed', 'admission-ack'].includes(phase)) assert.equal(restored.processing.length, 1, 'committed processing is acknowledged without another writer or review');
      if (['publication-committed', 'legacy-publication-committed', 'admission-ack'].includes(phase)) assert.equal(observations(directory).filter(row => row.pid === after.child.pid && ['writer-request', 'review-request'].includes(row.kind)).length, 0, 'a committed receipt cannot repeat organization calls on restart');
      if (['publication-committed', 'legacy-publication-committed', 'admission-ack'].includes(phase)) { const value = checkpoint.value as { request: unknown[] }; assert.equal(JSON.parse(restored.processing[0]!.result_json).workspace.candidate.auditedAt, value.request[3]); }
      assert.equal(new Set(restored.receipts.map(row => row.evidence_id)).size, restored.receipts.length);
      assert.ok(restored.jobs.every(job => job.runId === runId));
      assert.equal(observations(directory).filter(row => row.kind === 'conversation-request').length, phase === 'view-bound' ? 0 : 1, 'restarting never repeats the original model execution');
      const frozen = JSON.stringify(restored.views.find(row => row.run_id === runId));
      const version = restored.version.id;
      await stop(after.child, true);
      const final = await launch(directory, 'none'); children.push(final.child);
      const stable = await until(() => final.inspect(), state => state.jobs.every(job => !['pending', 'running'].includes(job.status))); assert.equal(stable.version.id, version); assert.equal(stable.version.generation, 1); assert.equal(JSON.stringify(stable.views.find(row => row.run_id === runId)), frozen);
      assert.equal(stable.events.filter(event => event.kind === 'memory_updated').length, 1);
      const fresh = await final.request<{ id: string }>('/contexts', { id: 'chat.after', name: 'After recovery', role: 'main' }); assert.equal(fresh.status, 201);
      const next = await final.request('/messages', { contextId: 'chat.after', content: 'What is the current plan?' }); assert.equal(next.status, 202);
      await until(() => observations(directory).filter(row => row.pid === final.child.pid && row.kind === 'conversation-request'), rows => rows.length > 0);
      const prompt = observations(directory).filter(row => row.pid === final.child.pid && row.kind === 'conversation-request').at(-1)!.value;
      assert.match(JSON.stringify(prompt), /SYNTHETIC_MEMORY_FACT/); assert.match(JSON.stringify(prompt), /violet-17/);
      assert.ok(Array.isArray(prompt)); assert.doesNotMatch(JSON.stringify(prompt.filter(row => row?.role === 'system')), /SYNTHETIC_USER_INTENT/);
      assert.ok(prompt.filter(row => row?.role === 'user').some(row => Array.isArray(row.content) && row.content.some((part: { type?: string; text?: string }) => part.type === 'text' && part.text?.includes(input))), 'the exact original text and final newline reach the next real request');
    } finally {
      for (const child of children) await stop(child);
      if (process.env.ARONA_TEST_ARTIFACTS) { const destination = path.join(process.env.ARONA_TEST_ARTIFACTS, phase); fs.mkdirSync(destination, { recursive: true }); fs.cpSync(directory, destination, { recursive: true }); }
      await removeTemp(directory);
    }
  });
}
