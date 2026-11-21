import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { MemoryAudioTranscripts, createLocalWhisperMemoryTranscriber, validateMemoryAudioWav } from '../src/memory/v1/audio.js';
import type { MemoryAudioEngine } from '../src/memory/v1/audio.js';
import { prepareNativeMemorySource } from '../src/memory/v1/source.js';
import { MemoryEvidenceLedger } from '../src/memory/v1/ledger.js';
import { prepareMemoryV1Batch, organizeMemoryV1Candidate } from '../src/memory/v1/organizer.js';
import { createDefaultMemoryContextPolicy } from '../src/memory/v1/policy.js';
import { resolveMemoryContextPolicy } from '../src/memory/v1/binding.js';
import { currentMemoryView, scopedReview } from './memory-v1-synthetic-model.js';
import { Core } from '../src/core.js';
import { finished, until, removeTemp } from './helpers.js';
import { windowsAudioExecutable } from './native-audio-fixture.js';
import { AppError } from '../src/domain.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const at = '2026-01-01T00:00:00.000Z';
const engineIdentity = { id: 'synthetic-asr', executableSha256: hash('synthetic-binary'), modelSha256: hash('synthetic-model') };
function wav() {
  const bytes = Buffer.alloc(44 + 3200), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.write('RIFF', 0); view.setUint32(4, bytes.length - 8, true); bytes.write('WAVEfmt ', 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.write('data', 36); view.setUint32(40, 3200, true); view.setInt16(44, 3276, true);
  return bytes;
}
function source(audio = wav(), location = 'record:one', id = 'asset-one', body = '') {
  return prepareNativeMemorySource({ namespace: 'synthetic:audio', source: { contextId: 'main', runId: 'run', sequence: 1 }, events: [], gaps: [], entries: [{
    business: { kind: 'user-statement', origin: 'signal', content: body, provenance: { contextId: 'main', runId: 'run', signalId: 'signal:one' } },
    location: { contextId: 'main', runId: 'run', recordId: location, receivedAt: at, visibleAfter: at },
    original: { text: body, attachments: [{ id, bytes: audio, metadata: { sha256: hash(audio), mediaType: 'audio/wav', bytes: audio.byteLength } }] },
  }] });
}
function fixture(t: test.TestContext, text = '  Synthetic recognition: a possible future trip.\r\n') {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let calls = 0;
  const engine: MemoryAudioEngine = { identity: engineIdentity, async transcribe(audio) { calls++; assert.equal(validateMemoryAudioWav(audio), .1); return text; } };
  const transcripts = new MemoryAudioTranscripts(db, engine, () => at);
  const s = source(), record = s.records[0]!, attachment = record.attachments[0]!, audio = s.contents.get(record.contentRef)!.attachments[0]!.bytes;
  return { db, engine, transcripts, s, record, attachment, audio, calls: () => calls };
}

test('WAV validation checks PCM data, duration, complete RIFF and rejects silence', () => {
  assert.equal(validateMemoryAudioWav(wav()), .1);
  for (const bytes of [Buffer.alloc(0), wav().subarray(0, 40), Buffer.concat([wav(), Buffer.from([0])])]) assert.throws(() => validateMemoryAudioWav(bytes));
  const silence = wav(); silence.fill(0, 44); assert.throws(() => validateMemoryAudioWav(silence), /memory_audio_no_signal/);
  const stereo = wav(); stereo.writeUInt16LE(2, 22); assert.throws(() => validateMemoryAudioWav(stereo), /memory_audio_invalid_wav/);
  const duration = wav(); duration.writeUInt32LE(3198, 40); assert.throws(() => validateMemoryAudioWav(duration));
  const highBit = wav(); highBit[0] = 0xd2; assert.throws(() => validateMemoryAudioWav(highBit));
});

test('transcript preserves exact text and binds original audio, source and engine without user confirmation', async t => {
  const f = fixture(t), before = structuredClone(f.s);
  await f.transcripts.transcribeSource(f.s, at);
  assert.deepEqual(f.s, before);
  const transcript = f.transcripts.project(f.record, f.attachment.sourceId, f.audio)!;
  assert.equal(transcript.text, '  Synthetic recognition: a possible future trip.\r\n');
  assert.equal(transcript.nature, 'machine-transcript'); assert.equal(transcript.confirmation, 'unconfirmed');
  assert.equal(transcript.provenance.audioSha256, f.attachment.sha256); assert.equal(transcript.provenance.textSha256, hash(transcript.text));
  assert.deepEqual(transcript.provenance.engine, engineIdentity);
  assert.equal(f.record.kind, 'user-statement'); assert.equal(f.record.contentHash, hash(''));
});

test('asset transcription and accepted source share a single decoding without fabricating source identity', async t => {
  const f = fixture(t);
  const asset = await f.transcripts.transcribeAsset({ id: 'asset-one', bytes: f.audio.byteLength, sha256: hash(f.audio), mediaType: 'audio/wav' }, f.audio);
  assert.equal(asset.confirmation, 'unconfirmed'); assert.equal(asset.provenance.assetId, 'asset-one');
  assert.equal('evidenceId' in asset.provenance, false);
  assert.equal(f.transcripts.read(f.record, f.attachment.sourceId, f.audio), null);
  await f.transcripts.transcribeSource(f.s, at);
  assert.equal(f.calls(), 1);
  assert.ok(f.transcripts.read(f.record, f.attachment.sourceId, f.audio));
});

test('idempotent transcript survives database reopen without rerunning the engine', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-audio-'));
  const file = path.join(directory, 'records.sqlite'), db = new DatabaseSync(file), s = source(), record = s.records[0]!, attachment = record.attachments[0]!, audio = s.contents.get(record.contentRef)!.attachments[0]!.bytes;
  let reopened: DatabaseSync | undefined;
  t.after(async () => { if (reopened?.isOpen) reopened.close(); if (db.isOpen) db.close(); await removeTemp(directory); });
  const first = new MemoryAudioTranscripts(db, { identity: engineIdentity, async transcribe() { return 'Cached synthetic transcript.'; } }, () => at);
  const receipt = await first.transcribe(record, attachment.sourceId, audio); db.close();
  reopened = new DatabaseSync(file);
  const next = new MemoryAudioTranscripts(reopened);
  assert.deepEqual(await next.transcribe(record, attachment.sourceId, audio), receipt);
});

test('concurrent aliases decode once but keep separate evidence bindings and original audio support group', async t => {
  const f = fixture(t), other = source(wav(), 'record:two', 'asset-two'), record = other.records[0]!;
  await Promise.all([f.transcripts.transcribeSource(f.s, at), f.transcripts.transcribeSource(other, at)]);
  assert.equal(f.calls(), 1);
  const a = f.transcripts.read(f.record, f.attachment.sourceId, f.audio)!, b = f.transcripts.read(record, record.attachments[0]!.sourceId, f.audio)!;
  assert.notEqual(a.binding, b.binding); assert.notEqual(a.evidenceId, b.evidenceId); assert.equal(a.textSha256, b.textSha256);
  const ledger = new MemoryEvidenceLedger(f.db), combined = { ...f.s, records: [...f.s.records, ...other.records], contents: new Map([...f.s.contents, ...other.contents]), canonicalRefs: new Map([...f.s.canonicalRefs, ...other.canonicalRefs]), attachmentRefs: new Map([...f.s.attachmentRefs, ...other.attachmentRefs]) };
  const batch = prepareMemoryV1Batch(combined, ledger, 'memory', at, [], { audioTranscripts: f.transcripts });
  assert.equal(batch.complete, true); assert.equal(batch.records.length, 2);
  const groups = batch.groups.filter(group => group.ref.partKey !== 'body'); assert.equal(groups[0]!.group, groups[1]!.group);
});

test('audio bytes or source mutation cannot reuse a valid receipt', async t => {
  const f = fixture(t); await f.transcripts.transcribeSource(f.s, at);
  const changedAudio = new Uint8Array(f.audio); changedAudio[45] = 1;
  assert.throws(() => f.transcripts.read(f.record, f.attachment.sourceId, changedAudio), /memory_audio_source_mismatch/);
  const other = structuredClone(f.record); other.contentHash = hash('different body');
  assert.equal(f.transcripts.read(other, f.attachment.sourceId, f.audio), null);
  const wrong = structuredClone(f.record); wrong.attachments[0]!.sha256 = hash('different audio');
  await assert.rejects(() => f.transcripts.transcribe(wrong, f.attachment.sourceId, f.audio), /memory_audio_source_mismatch/);
});

test('corrupt receipts or cached text are refused rather than treated as valid transcription', async t => {
  const f = fixture(t); await f.transcripts.transcribeSource(f.s, at);
  f.db.prepare('UPDATE memory_v1_audio_transcripts SET receipt_json=?').run('{}');
  assert.throws(() => f.transcripts.read(f.record, f.attachment.sourceId, f.audio), /memory_audio_receipt_corrupt/);
  f.db.exec('DELETE FROM memory_v1_audio_transcripts'); f.db.prepare('UPDATE memory_v1_audio_decodings SET decoding_json=?').run('{}');
  await assert.rejects(() => f.transcripts.transcribe(f.record, f.attachment.sourceId, f.audio), /memory_audio_receipt_corrupt/);
});

for (const [name, text, code] of [['empty', '  \n', 'transcript_empty'], ['invalid UTF8', '\ud800', 'transcript_invalid'], ['over capacity', Array.from({length:9000}, (_, i) => `item${i} `).join(''), 'transcript_capacity']] as const) {
  test(`${name} ASR output leaves no successful decoding or transcript`, async t => {
    const f = fixture(t, text);
    await assert.rejects(() => f.transcripts.transcribe(f.record, f.attachment.sourceId, f.audio), new RegExp('memory_audio_' + code));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_audio_transcripts').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_v1_audio_decodings').get()!.n, 0);
  });
}

test('cancellation and engine failure preserve the original source and allow a later retry', async t => {
  const f = fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(() => f.transcripts.transcribeSource(f.s, at, abort.signal)); assert.equal(f.calls(), 0);
  const broken = new MemoryAudioTranscripts(f.db, { identity: engineIdentity, async transcribe() { throw new Error('synthetic engine failure'); } });
  await assert.rejects(() => broken.transcribeSource(f.s, at), /synthetic engine failure/);
  assert.equal(f.transcripts.read(f.record, f.attachment.sourceId, f.audio), null);
  await f.transcripts.transcribeSource(f.s, at); assert.equal(f.calls(), 1);
});

test('future source is not transcribed before the visible cutoff', async t => {
  const f = fixture(t); await f.transcripts.transcribeSource(f.s, '2025-12-31T23:59:59.999Z');
  assert.equal(f.calls(), 0); assert.equal(f.transcripts.read(f.record, f.attachment.sourceId, f.audio), null);
});

test('known ASR failures leave audio pending while a real mixed source batch continues its independent text', async t => {
  const f = fixture(t), textSource = prepareNativeMemorySource({ namespace: 'synthetic:audio', source: f.s.source, events: [], gaps: [], entries: [{
    business: { kind: 'user-statement', origin: 'signal', content: 'Independent text stays available.', provenance: { contextId: 'main', runId: 'run', signalId: 'signal:text' } },
    location: { contextId: 'main', runId: 'run', recordId: 'record:text', receivedAt: at, visibleAfter: at }, original: { text: 'Independent text stays available.', attachments: [] },
  }] });
  const combined = { ...f.s, records: [...f.s.records, ...textSource.records], contents: new Map([...f.s.contents, ...textSource.contents]), canonicalRefs: new Map([...f.s.canonicalRefs, ...textSource.canonicalRefs]), attachmentRefs: new Map([...f.s.attachmentRefs, ...textSource.attachmentRefs]) };
  for (const code of ['memory_audio_engine_unavailable', 'memory_audio_transcription_failed', 'memory_audio_timeout', 'memory_audio_transcript_empty']) {
    const transcripts = new MemoryAudioTranscripts(f.db, { identity: engineIdentity, async transcribe() { throw new AppError(code, 409); } });
    const result = await transcripts.transcribeSource(combined, at);
    assert.deepEqual(result, { failures: [{ evidenceId: f.record.id, attachmentId: f.attachment.sourceId, code }], omittedFailures: 0 });
    assert.equal(transcripts.read(f.record, f.attachment.sourceId, f.audio), null);
    const ledger = new MemoryEvidenceLedger(f.db), batch = prepareMemoryV1Batch(combined, ledger, 'memory', at, [], { audioTranscripts: transcripts });
    assert.deepEqual(batch.records.map(record => record.id), [textSource.records[0]!.id]);
    assert.equal(batch.deferred[0]!.reason, 'pending-transcription'); assert.equal(batch.complete, false);
    assert.deepEqual(ledger.readContent(f.record.id, f.attachment.sourceId), f.audio);
    assert.ok(ledger.listPending('memory', at).some(item => item.receipt.evidence.id === f.record.id));
  }
  await f.transcripts.transcribeSource(combined, at);
  const resumed = prepareMemoryV1Batch(combined, new MemoryEvidenceLedger(f.db), 'memory', at, [], { audioTranscripts: f.transcripts });
  assert.equal(resumed.records.length, 2); assert.equal(resumed.complete, true);
});

test('source mismatch, corrupt cache and cancellation are never hidden as a recoverable ASR failure', async t => {
  const f = fixture(t);
  const mismatch = structuredClone(f.s); mismatch.contents.get(f.record.contentRef)!.attachments[0]!.bytes[45] = 1;
  await assert.rejects(() => f.transcripts.transcribeSource(mismatch, at), /memory_audio_source_mismatch/);
  await f.transcripts.transcribeSource(f.s, at);
  f.db.prepare('UPDATE memory_v1_audio_transcripts SET receipt_json=?').run('{}');
  await assert.rejects(() => f.transcripts.transcribeSource(f.s, at), /memory_audio_receipt_corrupt/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => f.transcripts.transcribeSource(f.s, at, aborted.signal));
});

test('missing transcription remains pending and transcript text participates in the complete source budget', async t => {
  const f = fixture(t, 'long synthetic transcript '.repeat(500)), ledger = new MemoryEvidenceLedger(f.db);
  const missing = prepareMemoryV1Batch(f.s, ledger, 'memory', at, [], { audioTranscripts: f.transcripts });
  assert.equal(missing.complete, false); assert.equal(missing.records.length, 0); assert.equal(missing.deferred[0]!.reason, 'pending-transcription');
  await f.transcripts.transcribeSource(f.s, at);
  const limited = prepareMemoryV1Batch(f.s, ledger, 'memory', at, [], { audioTranscripts: f.transcripts, sourceTextTokens: 1024 });
  assert.equal(limited.records.length, 0); assert.equal(limited.deferred[0]!.reason, 'source-text-capacity');
  const ready = prepareMemoryV1Batch(f.s, ledger, 'memory', at, [], { audioTranscripts: f.transcripts });
  assert.equal(ready.complete, true); assert.equal(ready.records.length, 1);
  assert.deepEqual(ledger.readContent(f.record.id, f.attachment.sourceId), f.audio);
});

test('writer and independent review receive identical machine transcript provenance, never raw audio', async t => {
  const f = fixture(t), ledger = new MemoryEvidenceLedger(f.db); await f.transcripts.transcribeSource(f.s, at);
  const batch = prepareMemoryV1Batch(f.s, ledger, 'memory', at, [], { audioTranscripts: f.transcripts });
  const writer: unknown[] = [], reviewer: unknown[] = []; let calls = 0;
  const done = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
  const model = new MastraLanguageModelV2Mock({ doGenerate: async request => {
    if (!request.tools?.some(tool => tool.name === 'memory_ready')) { reviewer.push(request.prompt); return done(JSON.stringify(scopedReview(request.prompt))); }
    writer.push(request.prompt);
    if (JSON.stringify(request.prompt.at(-1)).includes('"ready":true')) return done('done');
    const view = currentMemoryView(request.prompt);
    const ref = view.candidate.evidence.flatMap(record => record.coverage.parts.map(part => ({ evidenceId: record.id, partKey: part.key })))
      .find(ref => !view.candidate.coverage.some(item => item.ref.evidenceId === ref.evidenceId && item.ref.partKey === ref.partKey && !['pending-review', 'pending-source'].includes(item.decision)));
    const input = { expectedDraftRevision: view.draftRevision, ...(ref ? { coverage: { ref, decision: 'no-effective-new-information', entryIds: [], rationale: 'Synthetic ASR no new memory' }, protection: { ref, decision: 'no-protectable-state', entryIds: [], rationale: 'Synthetic ASR has no state' } } : {}) };
    return { content: [{ type: 'tool-call' as const, toolName: ref ? 'memory_coverage' : 'memory_ready', toolCallId: `audio-${++calls}`, input: JSON.stringify(input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
  } });
  await organizeMemoryV1Candidate({ previous: null, previousEntries: [], organizations: [], version: { id: 'version:one', parentVersionId: 'initial', generation: 1 },
    batch, ledger, policy: resolveMemoryContextPolicy(createDefaultMemoryContextPolicy()), batchId: 'batch:audio', cutoff: at, clock: () => at,
    model, providerOptions: {}, audioTranscripts: f.transcripts, onUsage() {}, onAttempt() {} });
  assert.ok(writer.length); assert.equal(reviewer.length, 1);
  const payload = (prompt: unknown) => {
    const messages = prompt as { content: unknown }[];
    const json = messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text!));
    return json.map(text => { try { return JSON.parse(text) as unknown; } catch { return null; } }).find(item => item && typeof item === 'object' && 'businessEvidence' in item);
  };
  assert.deepEqual(payload(writer[0]), payload(reviewer[0]));
  const text = JSON.stringify(payload(writer[0])); assert.ok(text.includes('machine-transcript')); assert.ok(text.includes('unconfirmed')); assert.ok(text.includes(engineIdentity.modelSha256));
  assert.ok(!JSON.stringify([...writer, ...reviewer]).includes('"type":"file"'));
});

test('local engine factory rejects unbounded deadlines and relative executable paths', () => {
  const options = { executable: '/missing/engine', model: '/missing/model', workingDirectory: '/tmp/synthetic-memory-audio', ...engineIdentity };
  assert.throws(() => createLocalWhisperMemoryTranscriber({ ...options, timeoutMs: 120001 }), /memory_audio_configuration_invalid/);
  assert.throws(() => createLocalWhisperMemoryTranscriber({ ...options, executable: 'engine' }), /memory_audio_configuration_invalid/);
});

function executableFixture(t: test.TestContext, mode: 'success' | 'fail' | 'invalid' | 'sleep') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-audio-engine-'));
  t.after(() => removeTemp(directory));
  let executable = path.join(directory, 'fixture-engine.cjs'); const model = path.join(directory, 'fixture-model.bin'), workingDirectory = path.join(directory, 'work');
  const code = `#!${process.execPath}\nconst fs = require('node:fs'); const out = process.argv[process.argv.indexOf('-of') + 1];\n` +
    (mode === 'success' ? `fs.writeFileSync(out + '.json', JSON.stringify({transcription:[{text:' Synthetic '},{text:' result. '}]}));\n` :
      mode === 'fail' ? `process.exit(1);\n` : mode === 'invalid' ? `fs.writeFileSync(out + '.json', '{');\n` : `setInterval(() => {}, 1000);\n`);
  if (process.platform === 'win32') executable = windowsAudioExecutable(directory, mode); else fs.writeFileSync(executable, code, { mode: 0o700 });
  fs.writeFileSync(model, 'synthetic model');
  return { directory, executable, model, workingDirectory, executableSha256: hash(fs.readFileSync(executable)), modelSha256: hash('synthetic model') };
}

test('local process adapter validates hashes, parses fixed JSON and removes temporary audio after success', async t => {
  const f = executableFixture(t, 'success'), engine = createLocalWhisperMemoryTranscriber(f);
  assert.equal(await engine.transcribe(wav()), 'Synthetic result.');
  assert.deepEqual(fs.readdirSync(f.workingDirectory), []);
  fs.writeFileSync(f.model, 'tampered');
  await assert.rejects(() => engine.transcribe(wav()), /memory_audio_engine_unavailable/);
  assert.deepEqual(fs.readdirSync(f.workingDirectory), []);
});

for (const mode of ['fail', 'invalid'] as const) {
  test(`local ${mode} engine result does not leave temporary audio or claim transcription`, async t => {
    const f = executableFixture(t, mode), engine = createLocalWhisperMemoryTranscriber(f);
    await assert.rejects(() => engine.transcribe(wav()), new RegExp(mode === 'fail' ? 'memory_audio_transcription_failed' : 'memory_audio_transcript_invalid'));
    assert.deepEqual(fs.readdirSync(f.workingDirectory), []);
  });
}

test('local process timeout waits for child exit and then removes temporary audio', async t => {
  const f = executableFixture(t, 'sleep'), engine = createLocalWhisperMemoryTranscriber({ ...f, timeoutMs: 50 });
  await assert.rejects(() => engine.transcribe(wav()), /memory_audio_timeout/);
  assert.deepEqual(fs.readdirSync(f.workingDirectory), []);
});

test('local process cancellation waits for child exit and then removes temporary audio', async t => {
  const f = executableFixture(t, 'sleep'), engine = createLocalWhisperMemoryTranscriber(f), controller = new AbortController();
  const task = engine.transcribe(wav(), controller.signal), timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(() => task, /memory_audio_cancelled/); } finally { clearTimeout(timer); }
  assert.deepEqual(fs.readdirSync(f.workingDirectory), []);
});

test('accepted WAV completes native background memory organization while retaining the original utterance and audio', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-audio-native-'));
  let transcriptions = 0, calls = 0, reviews = 0;
  const memoryPrompts: unknown[] = [];
  const finish = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] });
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => ({ stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
      c.enqueue({ type: 'text-delta', id: 't', delta: 'Synthetic audio acknowledged.' }); c.enqueue({ type: 'text-end', id: 't' });
      c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) }),
    doGenerate: async request => {
      memoryPrompts.push(request.prompt);
      if (!request.tools?.some(tool => tool.name === 'memory_ready')) { reviews++; return finish(JSON.stringify(scopedReview(request.prompt))); }
      if (JSON.stringify(request.prompt.at(-1)).includes('"ready":true')) return finish('done');
      const view = currentMemoryView(request.prompt);
      const ref = view.candidate.evidence.flatMap(record => record.coverage.parts.map(part => ({ evidenceId: record.id, partKey: part.key })))
        .find(ref => !view.candidate.coverage.some(item => item.ref.evidenceId === ref.evidenceId && item.ref.partKey === ref.partKey && !['pending-source', 'pending-review'].includes(item.decision)));
      const input = { expectedDraftRevision: view.draftRevision, ...(ref ? { coverage: { ref, decision: 'no-effective-new-information', entryIds: [], rationale: 'Synthetic source no new facts' }, protection: { ref, decision: 'no-protectable-state', entryIds: [], rationale: 'No protected state' } } : {}) };
      return { content: [{ type: 'tool-call' as const, toolName: ref ? 'memory_coverage' : 'memory_ready', toolCallId: `native-audio-${++calls}`, input: JSON.stringify(input) }], finishReason: 'tool-calls' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
  });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false, memoryContextMode: 'v1', audioTranscriber: { identity: engineIdentity, async transcribe() { transcriptions++; return 'A synthetic unconfirmed speech transcript.'; } } });
  t.after(async () => { await core.close(); await removeTemp(directory); });
  const audio = wav(), asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(audio); c.close(); } }), 'synthetic.wav');
  const row = await core.submitMessage({ contextId: 'main', content: '', attachments: [asset.id] });
  await finished(core, row.runId!);
  const prepared = await core.prepareMemorySource(row.runId!), original = prepared.records.find(record => record.kind === 'user-statement')!;
  assert.equal(original.contentHash, hash('')); assert.deepEqual(prepared.contents.get(original.contentRef)!.body, new Uint8Array());
  core.configure('runtime', { memoryEnabled: true });
  const job = await core.queueMemory(row.runId!);
  const settled = await until(() => core.projectMemory.jobs().find(item => item.id === job.id), item => !!item && ['succeeded', 'failed'].includes(item.status));
  assert.equal(settled!.status, 'succeeded', JSON.stringify(settled)); assert.equal(transcriptions, 1); assert.equal(reviews, 1);
  assert.ok(JSON.stringify(memoryPrompts).includes('machine-transcript')); assert.ok(JSON.stringify(memoryPrompts).includes('unconfirmed'));
  assert.ok(!JSON.stringify(memoryPrompts).includes('"type":"file"'));
  const ledger = new MemoryEvidenceLedger(core.store.db);
  assert.deepEqual(ledger.readContent(original.id, original.attachments[0]!.sourceId), new Uint8Array(audio));
  assert.ok(core.projectMemory.audioTranscripts.read(original, original.attachments[0]!.sourceId, audio));
});
