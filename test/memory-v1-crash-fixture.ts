import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { ProjectMemory } from '../src/memory/index.js';
import { MemoryV1Intake } from '../src/memory/v1/intake.js';
import { MemoryV1Views } from '../src/memory/v1/view.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { currentMemoryView, scopedReview, workingSetReader, requestObjects } from './memory-v1-synthetic-model.js';

const requestedDirectory = process.argv[2], phase = process.argv[3] ?? 'none';
if (!requestedDirectory || !process.send) throw Error('fixture_requires_directory_and_ipc');
const directory = requestedDirectory;
fs.mkdirSync(directory, { recursive: true });
let stopped = false;
function checkpoint(name: string, value: unknown = {}) {
  if (stopped || phase !== name) return;
  stopped = true;
  fs.writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify({ phase: name, value, pid: process.pid }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const record = (kind: string, value: unknown) => fs.appendFileSync(path.join(directory, 'model-observations.jsonl'), JSON.stringify({ pid: process.pid, kind, value }) + '\n');
const archive = ProjectMemory.prototype.archive;
ProjectMemory.prototype.archive = function (snapshot) { checkpoint('archive-before', snapshot); const result = archive.call(this, snapshot); checkpoint('archive-after', snapshot); return result; };
const bindView = MemoryV1Views.prototype.bind;
MemoryV1Views.prototype.bind = function (input) { const value = bindView.call(this, input); checkpoint('view-bound', value); return value; };
const prepare = Core.prototype.prepareMemorySource;
Core.prototype.prepareMemorySource = async function (runId) { const value = await prepare.call(this, runId); checkpoint('source-prepared', { source: value.source, records: value.records }); return value; };
const materialize = MemoryV1Intake.prototype.materialize;
MemoryV1Intake.prototype.materialize = function (runId, source) { const value = materialize.call(this, runId, source); checkpoint('intake-materialized', { runId, source: source.source }); return value; };
const bindJob = ProjectMemory.prototype.bind;
ProjectMemory.prototype.bind = function (jobId, nativeTaskId) { checkpoint('native-before-binding', { jobId, nativeTaskId }); const value = bindJob.call(this, jobId, nativeTaskId); checkpoint('native-enqueued', { jobId, nativeTaskId }); return value; };
const setting = RuntimeStore.prototype.setSetting;
RuntimeStore.prototype.setSetting = function (id, value) {
  if (phase === 'legacy-publication-committed' && this.db.isTransaction && id.startsWith('memory-v1-admission:') && value && typeof value === 'object' && 'complete' in value && 'fingerprint' in value && 'jobId' in value) return setting.call(this, id, { fingerprint: value.fingerprint, jobId: value.jobId });
  const result = setting.call(this, id, value);
  if (id === 'memory-version' && value && typeof value === 'object' && 'format' in value) checkpoint('publication-transaction', value);
  if (!this.db.isTransaction && id.startsWith('memory-v1-admission:') && value && typeof value === 'object' && 'complete' in value && value.complete === true) checkpoint('admission-ack', { id, value });
  return result;
};
const operation = RuntimeStore.prototype.operation;
RuntimeStore.prototype.operation = function <T>(key: string, request: unknown, action: () => T): T {
  const result = operation.call(this, key, request, action) as T;
  if (key.startsWith('memory-publication:')) {
    checkpoint('publication-committed', { key, request, result }); checkpoint('legacy-publication-committed', { key, request, result });
    if (Array.isArray(request) && request[1] && typeof request[1] === 'object' && 'runId' in request[1]) {
      const marker = this.setting<{ complete?: boolean } | null>(`memory-v1-admission:${request[1].runId}`, null);
      if (marker?.complete) checkpoint('admission-ack', { key, request, result });
    }
  }
  return result;
};
const rename = fs.renameSync;
fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { rename(from, to); if (String(from).includes(`${path.sep}memory${path.sep}staging${path.sep}`) && String(to).includes(`${path.sep}memory${path.sep}versions${path.sep}`)) checkpoint('published-files', { from, to }); }) as typeof rename;
const readOld = workingSetReader(); let generation = 0;
const model = new MastraLanguageModelV2Mock({
  doStream: async request => {
    record('conversation-request', request.prompt); checkpoint('provider-request', request.prompt);
    return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 'reply' }); c.enqueue({ type: 'text-delta', id: 'reply', delta: 'SYNTHETIC_VISIBLE_REPLY' }); c.enqueue({ type: 'text-end', id: 'reply' }); c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close(); } }) };
  },
  doGenerate: async request => {
    const writer = request.tools?.some(tool => tool.name === 'memory_ready');
    record(writer ? 'writer-request' : 'review-request', request.prompt); checkpoint(writer ? 'writer-request' : 'review-request', request.prompt);
    if (!writer) return { content: [{ type: 'text', text: JSON.stringify(scopedReview(request.prompt)) }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    if (request.prompt.at(-1)?.role === 'tool' && requestObjects(request.prompt.at(-1)).some(row => row.ready === true)) return { content: [{ type: 'text', text: 'Batch complete.' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    const view = currentMemoryView(request.prompt), candidate = view.candidate;
    let action = readOld(request.prompt);
    const evidence = candidate.evidence.find(row => row.kind === 'user-statement')!;
    const ref = evidence && { evidenceId: evidence.id, partKey: 'body' };
    const mutate = (name: string, input: Record<string, unknown>) => ({ name, input: { expectedDraftRevision: view.draftRevision, rationale: 'Synthetic source maintenance.', ...input } });
    if (!action && ref && !candidate.organizations.length) action = mutate('memory_organization_create', { organization: { title: 'Synthetic topic', parentId: null } });
    if (!action && ref && !candidate.entities.length) action = mutate('memory_entity_create', { entity: { name: 'Synthetic user', kind: 'person', aliases: [], identityEvidence: [ref] } });
    if (!action && ref && !candidate.entries.length) {
      const subjectId = candidate.entities[0]!.id;
      action = mutate('memory_entry_create', { entry: { text: 'SYNTHETIC_MEMORY_FACT: the user plans violet-17 training, which has not started.', primaryNodeId: candidate.organizations[0]!.id, relatedNodeIds: [], entityIds: [subjectId], nature: 'intent', certainty: 'reported', lifecycle: 'current', scope: { subjectId, dimension: 'learning', qualifier: 'violet-17' }, validFrom: null, validTo: null, retention: { score: 7, rationale: 'Explicit synthetic intent.' }, protectionAssessment: { decision: 'ineligible', rationale: 'An ordinary plan.', evidence: [ref] }, protection: { mode: 'none' }, followup: { attention: 'normal', outcome: 'unknown', outcomeEvidence: [] }, evidence: [{ ref, role: 'supports' }], abstraction: 'episode', derivedFromEntryIds: [], placement: 'resident', detailRefs: [], replacedBy: [] } });
    }
    if (!action) {
      const pending = candidate.evidence.flatMap(row => row.coverage.parts.map(part => ({ row, part }))).find(({ row, part }) => !candidate.coverage.some(decision => decision.ref.evidenceId === row.id && decision.ref.partKey === part.key && !['pending-source', 'pending-review'].includes(decision.decision)));
      if (pending) {
        const source = { evidenceId: pending.row.id, partKey: pending.part.key };
        const kept = candidate.entries.filter(entry => entry.format === 'reviewed' && entry.evidence.some(item => item.ref.evidenceId === source.evidenceId && item.ref.partKey === source.partKey)).map(entry => entry.id);
        action = { name: 'memory_coverage', input: { expectedDraftRevision: view.draftRevision, coverage: { ref: source, decision: kept.length ? 'retained' : 'no-effective-new-information', entryIds: kept, rationale: 'Synthetic coverage checked.' }, protection: { ref: source, decision: 'no-protectable-state', entryIds: [], rationale: 'No protected state.' } } };
      } else action = { name: 'memory_ready', input: { expectedDraftRevision: view.draftRevision } };
    }
    record('writer-tool', action);
    return { content: [{ type: 'tool-call', toolName: action.name, toolCallId: `memory-fixture-${++generation}`, input: JSON.stringify(action.input) }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  },
});
const core = await Core.open({ dataDir: directory, model, memoryContextMode: 'v1', memoryEnabled: process.env.SYNTHETIC_MEMORY_ENABLED !== 'false' });
const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => { const address = server.address(); if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port, token: core.controlToken, storageId: core.storageId }); });
process.on('message', message => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'inspect') return;
  void (async () => {
    const table = (name: string) => core.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) ? core.store.db.prepare(`SELECT * FROM ${name}`).all() : [];
    process.send?.({ type: 'inspection', version: core.projectMemory.version(), memory: core.memoryV1Status(), jobs: core.projectMemory.jobs(), views: table('memory_v1_run_views'), runs: table('runs'), intake: table('memory_v1_intake'), sourceRuns: table('memory_v1_source_runs'), sources: table('memory_v1_source_batches'), receipts: table('memory_v1_receipts'), processing: table('memory_v1_processing'), versions: table('memory_v1_versions'), coverage: table('memory_v1_coverage'), snapshots: table('runs').flatMap(row=>{try{return [core.projectMemory.snapshot(String(row.id))];}catch{return [];}}), events: core.runtime.events(undefined, 0, 10000).filter(event => ['memory_updated', 'memory_processed', 'context_snapshot'].includes(event.kind)), nativeTasks: await core.sessions.controller.getMastra()!.backgroundTaskManager!.listTasks({}) });
  })().catch(error => process.send?.({ type: 'fixture-error', error: String(error) }));
});
let closing = false;
process.once('SIGTERM', () => { if (closing) return; closing = true; if ('closeAllConnections' in server) server.closeAllConnections(); server.close(); void core.close().finally(() => process.exit(0)); });
