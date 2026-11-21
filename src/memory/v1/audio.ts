import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../../domain.js';
import { evidenceRecordSchema } from './contracts.js';
import type { EvidenceRecord } from './contracts.js';
import type { PreparedMemorySource } from './source.js';
import { evidenceIdempotencyKey } from './validate.js';
import { measureMemoryText } from './tokens.js';
import { compareMemoryV1Time } from './version-index.js';

export const MEMORY_AUDIO_MAX_BYTES = 1_985_536;
export const MEMORY_AUDIO_MAX_TEXT_TOKENS = 8192;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const engineSchema = z.strictObject({ id: z.string().min(1).max(160), modelSha256: hashSchema, executableSha256: hashSchema });
export type MemoryAudioEngineIdentity = z.infer<typeof engineSchema>;
export interface MemoryAudioEngine {
  readonly identity: Readonly<MemoryAudioEngineIdentity>;
  transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<string>;
}
const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1), binding: hashSchema, evidenceId: z.string(), attachmentId: z.string(),
  audioSha256: hashSchema, audioBytes: z.number().int().positive(), durationSeconds: z.number().positive().max(60),
  engine: engineSchema, transcribedAt: z.iso.datetime({ offset: true }), text: z.string().max(131072), textSha256: hashSchema,
  textTokens: z.number().int().nonnegative().max(MEMORY_AUDIO_MAX_TEXT_TOKENS),
});
export type MemoryAudioTranscript = z.infer<typeof receiptSchema>;
const decodingSchema = receiptSchema.omit({ binding: true, evidenceId: true, attachmentId: true });
type AudioDecoding = z.infer<typeof decodingSchema>;
export interface MemoryAudioAssetProjection {
  nature: 'machine-transcript'; understanding: 'transcribed'; confirmation: 'unconfirmed'; text: string;
  provenance: Omit<AudioDecoding, 'text' | 'schemaVersion'> & { assetId: string };
}
export interface MemoryAudioSourceResult {
  failures: { evidenceId: string; attachmentId: string; code: string }[];
  omittedFailures: number;
}
const recoverableTranscriptionFailures = new Set([
  'memory_audio_engine_unavailable', 'memory_audio_transcription_failed', 'memory_audio_timeout',
  'memory_audio_transcript_empty', 'memory_audio_transcript_invalid', 'memory_audio_transcript_capacity',
  'memory_audio_engine_output_capacity', 'memory_audio_invalid_wav', 'memory_audio_no_signal',
]);
export interface MemoryAudioProjection {
  nature: 'machine-transcript';
  understanding: 'transcribed';
  confirmation: 'unconfirmed';
  text: string;
  provenance: Omit<MemoryAudioTranscript, 'text' | 'schemaVersion' | 'binding'>;
}
function fail(code: string): never { throw new AppError(`memory_audio_${code}`, 409); }
export function isMemoryAudio(mediaType: string): boolean { return ['audio/wav', 'audio/x-wav', 'audio/wave'].includes(mediaType); }

/** 完整检查 PCM WAV；元数据、填充和容器标记不能冒充有效音频。 */
export function validateMemoryAudioWav(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44 || bytes.byteLength > MEMORY_AUDIO_MAX_BYTES) fail('invalid_wav');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => Buffer.from(bytes.subarray(offset, offset + 4)).toString('latin1');
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.byteLength - 8) fail('invalid_wav');
  let offset = 12, format = false, data = false, samples = 0, nonzero = false;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) fail('invalid_wav');
    const name = tag(offset), length = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + length > bytes.byteLength) fail('invalid_wav');
    if (name === 'fmt ') {
      if (format || length !== 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 ||
          view.getUint32(start + 4, true) !== 16000 || view.getUint32(start + 8, true) !== 32000 ||
          view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) fail('invalid_wav');
      format = true;
    } else if (name === 'data') {
      if (!format || data || length % 2 || length < 3200 || length > 1_920_000) fail('invalid_wav');
      data = true; samples = length / 2;
      for (let i = start; i < start + length; i++) if (bytes[i] !== 0) nonzero = true;
    } else if (!['JUNK', 'LIST', 'FLLR'].includes(name)) fail('invalid_wav');
    offset = start + length + length % 2;
  }
  if (!format || !data || offset !== bytes.byteLength) fail('invalid_wav');
  if (!nonzero) fail('no_signal');
  return samples / 16000;
}

function audioBinding(record: EvidenceRecord, attachmentId: string) {
  const parsed = evidenceRecordSchema.parse(record), attachment = parsed.attachments.find(item => item.sourceId === attachmentId);
  if (!attachment || !isMemoryAudio(attachment.mediaType)) fail('binding_invalid');
  if (parsed.coverage.parts.find(part => part.key === attachmentId)?.status !== 'available') fail('source_unavailable');
  const binding = digest(JSON.stringify([evidenceIdempotencyKey(parsed), parsed.id, parsed.contentHash, attachmentId, attachment.sha256, attachment.bytes]));
  return { binding, attachment };
}
function checkedText(text: unknown): { text: string; textSha256: string; textTokens: number } {
  if (typeof text !== 'string' || text.length > 131072) fail('transcript_invalid');
  const bytes = Buffer.from(text);
  if (bytes.toString('utf8') !== text) fail('transcript_invalid');
  if (!text.trim()) fail('transcript_empty');
  const textTokens = measureMemoryText(text).textTokens!;
  if (textTokens > MEMORY_AUDIO_MAX_TEXT_TOKENS) fail('transcript_capacity');
  return { text, textSha256: digest(bytes), textTokens };
}

/** 宿主持有转写账本；读取必须再次匹配原始来源及音频字节。模型不能提交转写回执。 */
export class MemoryAudioTranscripts {
  private readonly inFlight = new Map<string, Promise<MemoryAudioTranscript>>();
  private readonly decodings = new Map<string, Promise<AudioDecoding>>();
  private readonly identity: MemoryAudioEngineIdentity | undefined;
  constructor(private readonly db: DatabaseSync, private readonly engine?: MemoryAudioEngine, private readonly clock = () => new Date().toISOString()) {
    this.identity = engine ? engineSchema.parse(engine.identity) : undefined;
    db.exec('CREATE TABLE IF NOT EXISTS memory_v1_audio_transcripts (binding TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, receipt_hash TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS memory_v1_audio_decodings (id TEXT PRIMARY KEY, decoding_json TEXT NOT NULL, decoding_hash TEXT NOT NULL)');
  }
  private async decode(audio: Uint8Array, signal?: AbortSignal): Promise<AudioDecoding> {
    if (!this.engine || !this.identity) fail('engine_unavailable');
    signal?.throwIfAborted();
    const audioSha256 = digest(audio), durationSeconds = validateMemoryAudioWav(audio);
    const key = digest(JSON.stringify([audioSha256, audio.byteLength, this.identity]));
    const read = (): AudioDecoding | null => {
      const row = this.db.prepare('SELECT decoding_json,decoding_hash FROM memory_v1_audio_decodings WHERE id=?').get(key);
      if (!row) return null;
      if (typeof row.decoding_json !== 'string' || digest(row.decoding_json) !== row.decoding_hash) fail('receipt_corrupt');
      let data: AudioDecoding;
      try { data = decodingSchema.parse(JSON.parse(row.decoding_json)); } catch { return fail('receipt_corrupt'); }
      const text = checkedText(data.text);
      if (data.audioSha256 !== audioSha256 || data.audioBytes !== audio.byteLength || data.durationSeconds !== durationSeconds ||
          JSON.stringify(data.engine) !== JSON.stringify(this.identity) || text.textSha256 !== data.textSha256 || text.textTokens !== data.textTokens) fail('receipt_corrupt');
      return data;
    };
    const cached = read(); if (cached) return cached;
    const running = this.decodings.get(key);
    if (running) { const result = await running; signal?.throwIfAborted(); return structuredClone(result); }
    const operation = (async () => {
      const text = checkedText(await this.engine!.transcribe(new Uint8Array(audio), signal));
      signal?.throwIfAborted();
      const decoded = decodingSchema.parse({ schemaVersion: 1, engine: this.identity, audioSha256, audioBytes: audio.byteLength,
        durationSeconds, transcribedAt: this.clock(), ...text });
      const payload = JSON.stringify(decoded);
      const result = this.db.prepare('INSERT OR IGNORE INTO memory_v1_audio_decodings VALUES (?,?,?)').run(key, payload, digest(payload));
      const written = read(); if (!written || (result.changes === 1 && JSON.stringify(written) !== payload)) fail('receipt_corrupt');
      return written;
    })();
    this.decodings.set(key, operation);
    try { return structuredClone(await operation); } finally { this.decodings.delete(key); }
  }
  async transcribeAsset(metadata: { id: string; sha256: string; bytes: number; mediaType: string }, input: Uint8Array, signal?: AbortSignal): Promise<MemoryAudioAssetProjection> {
    if (!metadata || typeof metadata.id !== 'string' || !metadata.id || !isMemoryAudio(metadata.mediaType) ||
        !hashSchema.safeParse(metadata.sha256).success || !(input instanceof Uint8Array) || metadata.bytes !== input.byteLength || digest(input) !== metadata.sha256) fail('source_mismatch');
    const audio = new Uint8Array(input), assetId = metadata.id;
    try {
      const { text, schemaVersion: _schema, ...provenance } = await this.decode(audio, signal);
      return { nature: 'machine-transcript', understanding: 'transcribed', confirmation: 'unconfirmed', text, provenance: { assetId, ...provenance } };
    } finally { audio.fill(0); }
  }
  read(record: EvidenceRecord, attachmentId: string, audio: Uint8Array): MemoryAudioTranscript | null {
    const { binding, attachment } = audioBinding(record, attachmentId);
    if (!(audio instanceof Uint8Array) || audio.byteLength !== attachment.bytes || digest(audio) !== attachment.sha256) fail('source_mismatch');
    const row = this.db.prepare('SELECT receipt_json,receipt_hash FROM memory_v1_audio_transcripts WHERE binding=?').get(binding);
    if (!row) return null;
    if (typeof row.receipt_json !== 'string' || digest(row.receipt_json) !== row.receipt_hash) fail('receipt_corrupt');
    let receipt: MemoryAudioTranscript;
    try { receipt = receiptSchema.parse(JSON.parse(row.receipt_json)); } catch { return fail('receipt_corrupt'); }
    const text = checkedText(receipt.text);
    if (receipt.binding !== binding || receipt.evidenceId !== record.id || receipt.attachmentId !== attachmentId ||
        receipt.audioSha256 !== attachment.sha256 || receipt.audioBytes !== audio.byteLength ||
        receipt.durationSeconds !== validateMemoryAudioWav(audio) || text.textSha256 !== receipt.textSha256 || text.textTokens !== receipt.textTokens) fail('receipt_corrupt');
    return receipt;
  }
  project(record: EvidenceRecord, attachmentId: string, audio: Uint8Array): MemoryAudioProjection | null {
    const receipt = this.read(record, attachmentId, audio);
    if (!receipt) return null;
    const { text, schemaVersion: _schema, binding: _binding, ...provenance } = receipt;
    return { nature: 'machine-transcript', understanding: 'transcribed', confirmation: 'unconfirmed', text, provenance };
  }
  async transcribe(record: EvidenceRecord, attachmentId: string, input: Uint8Array, signal?: AbortSignal): Promise<MemoryAudioTranscript> {
    signal?.throwIfAborted();
    const recordCopy = structuredClone(record), audio = new Uint8Array(input);
    const { binding, attachment } = audioBinding(recordCopy, attachmentId);
    if (audio.byteLength !== attachment.bytes || digest(audio) !== attachment.sha256) fail('source_mismatch');
    const durationSeconds = validateMemoryAudioWav(audio);
    const prior = this.read(recordCopy, attachmentId, audio);
    if (prior) return prior;
    if (!this.engine || !this.identity) fail('engine_unavailable');
    // 共用相同原件时只运行一次；每个调用者取消只影响自己的等待，首调用控制实际引擎。
    const current = this.inFlight.get(binding);
    if (current) { const result = await current; signal?.throwIfAborted(); return structuredClone(result); }
    const operation = (async () => {
      const decoding = await this.decode(audio, signal);
      signal?.throwIfAborted();
      const receipt = receiptSchema.parse({ ...decoding, binding, evidenceId: recordCopy.id, attachmentId });
      const payload = JSON.stringify(receipt);
      const result = this.db.prepare('INSERT OR IGNORE INTO memory_v1_audio_transcripts VALUES (?,?,?)').run(binding, payload, digest(payload));
      const written = this.read(recordCopy, attachmentId, audio);
      if (!written || (result.changes === 1 && JSON.stringify(written) !== payload)) fail('receipt_corrupt');
      return written;
    })();
    this.inFlight.set(binding, operation);
    try { return structuredClone(await operation); } finally { this.inFlight.delete(binding); audio.fill(0); }
  }
  async transcribeSource(source: PreparedMemorySource, cutoff: string, signal?: AbortSignal): Promise<MemoryAudioSourceResult> {
    z.iso.datetime({ offset: true }).parse(cutoff);
    const result: MemoryAudioSourceResult = { failures: [], omittedFailures: 0 };
    for (const record of source.records) {
      if (compareMemoryV1Time(record.visibleAfter, cutoff) > 0) continue;
      for (const attachment of record.attachments) {
        if (!isMemoryAudio(attachment.mediaType) || record.coverage.parts.find(part => part.key === attachment.sourceId)?.status !== 'available') continue;
        const audio = source.contents.get(record.contentRef)?.attachments.find(item => item.sourceId === attachment.sourceId)?.bytes;
        if (!audio) fail('source_unavailable');
        try { await this.transcribe(record, attachment.sourceId, audio, signal); }
        catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof AppError) || !recoverableTranscriptionFailures.has(error.code)) throw error;
          if (result.failures.length < 64) result.failures.push({ evidenceId: record.id, attachmentId: attachment.sourceId, code: error.code });
          else result.omittedFailures++;
        }
      }
    }
    return result;
  }
}

async function checkedFile(file: string, expectedHash: string, maximum: number): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail('engine_unavailable'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) fail('engine_unavailable');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash) fail('engine_unavailable');
  } finally { await handle.close(); }
}

/** 固定 whisper.cpp JSON 协议，不经过 shell，不接收模型或资料指定的路径/参数。 */
export function createLocalWhisperMemoryTranscriber(options: {
  executable: string; model: string; executableSha256: string; modelSha256: string; workingDirectory: string; timeoutMs?: number;
}): MemoryAudioEngine {
  const config = { ...options }, identity = engineSchema.parse({ id: 'whisper.cpp', modelSha256: config.modelSha256, executableSha256: config.executableSha256 });
  const timeoutMs = config.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || [config.executable, config.model, config.workingDirectory].some(item => !path.isAbsolute(item))) fail('configuration_invalid');
  return {
    identity: Object.freeze(identity),
    async transcribe(input, signal) {
      signal?.throwIfAborted(); validateMemoryAudioWav(input);
      await checkedFile(config.executable, identity.executableSha256, 536870912);
      await checkedFile(config.model, identity.modelSha256, 2147483648);
      signal?.throwIfAborted();
      await mkdir(config.workingDirectory, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(path.join(config.workingDirectory, 'audio-'));
      try {
        const audio = path.join(directory, 'input.wav'), output = path.join(directory, 'transcript');
        await writeFile(audio, input, { flag: 'wx', mode: 0o600, signal });
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const child = spawn(config.executable, ['-m', config.model, '-f', audio, '-l', 'auto', '-t', '4', '-ng', '-np', '-nt', '-oj', '-of', output], {
            cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' },
          });
          let failure: unknown, killTimer: ReturnType<typeof setTimeout> | undefined, bytes = 0;
          const stop = (error: unknown) => { if (failure) return; failure = error; child.kill(); killTimer = setTimeout(() => child.kill('SIGKILL'), 300); killTimer.unref(); };
          const abort = () => stop(new AppError('memory_audio_cancelled', 409));
          const timeout = setTimeout(() => stop(new AppError('memory_audio_timeout', 409)), timeoutMs);
          signal?.addEventListener('abort', abort, { once: true });
          const drain = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 1048576) stop(new AppError('memory_audio_engine_output_capacity', 409)); };
          child.stdout?.on('data', drain); child.stderr?.on('data', drain);
          child.once('error', () => { failure ??= new AppError('memory_audio_engine_unavailable', 409); });
          child.once('close', code => {
            clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
            if (failure) reject(failure); else if (code !== 0) reject(new AppError('memory_audio_transcription_failed', 409)); else resolve();
          });
          if (signal?.aborted) abort();
        });
        signal?.throwIfAborted();
        let file: Awaited<ReturnType<typeof open>>;
        try { file = await open(output + '.json', constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail('transcript_invalid'); }
        try {
          const stat = await file.stat(); if (!stat.isFile() || stat.size > 262144) fail('transcript_invalid');
          const raw = await file.readFile('utf8');
          let result: unknown; try { result = JSON.parse(raw); } catch { return fail('transcript_invalid'); }
          const parsed = z.object({ transcription: z.array(z.object({ text: z.string() })) }).safeParse(result);
          if (!parsed.success) fail('transcript_invalid');
          return checkedText(parsed.data.transcription.map(segment => segment.text.trim()).join(' ').trim()).text;
        } finally { await file.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
