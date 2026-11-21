import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { readConfig } from '../src/config.js';
import { finished, removeTemp, scriptedModel } from './helpers.js';

function wav() {
  const data = Buffer.alloc(3244); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(3200, 40); data.writeInt16LE(100, 44);
  return data;
}
test('音频上传经真实 Core 机器转写投影与原件记忆来源复用一次解码', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-audio-core-'));
  const prompts: string[] = []; const model = scriptedModel({ onCall: text => prompts.push(text) }); let calls = 0;
  const core = await Core.open({ dataDir: directory, model: model.model, memoryEnabled: false, audioTranscriber: {
    identity: { id: 'fixture', executableSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) },
    transcribe: async () => { calls++; return '我想拍一次月球。'; },
  } });
  t.after(async () => { await core.close(); await removeTemp(directory); });
  const bytes = wav(); const asset = await core.assets.put(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), 'voice.wav');
  assert.equal(asset.mediaType, 'audio/wav');
  const signal = await core.submitMessage({ content: '', attachments: [asset.id] }); await finished(core, signal.runId!);
  assert.equal(calls, 1); assert.ok(prompts.some(text => text.includes('machine-transcript') && text.includes('unconfirmed')));
  const source = await core.prepareMemorySource(signal.runId!);
  const record = source.records.find(row => row.kind === 'user-statement')!;
  assert.ok(record); assert.equal(record.attachments[0]!.sha256, asset.sha256);
  assert.equal(Buffer.from(source.contents.get(record.contentRef)!.body).toString(), '');
  await core.projectMemory.audioTranscripts.transcribeSource(source, new Date().toISOString());
  assert.equal(calls, 1);
  const attachment = source.contents.get(record.contentRef)!.attachments[0]!;
  assert.deepEqual(Buffer.from(attachment.bytes), bytes);
  const transcript = core.projectMemory.audioTranscripts.project(record, attachment.sourceId, attachment.bytes)!;
  assert.equal(transcript.text, '我想拍一次月球。'); assert.equal(transcript.confirmation, 'unconfirmed');
});

test('本地音频引擎配置必须完整且绑定绝对路径与内容摘要', () => {
  assert.throws(() => readConfig({ SHITTIMCHEST_AUDIO_EXECUTABLE: '/tmp/engine' }), /invalid_audio_configuration/);
  assert.throws(() => readConfig({ SHITTIMCHEST_AUDIO_EXECUTABLE: 'relative', SHITTIMCHEST_AUDIO_MODEL: '/tmp/model', SHITTIMCHEST_AUDIO_EXECUTABLE_SHA256: 'a'.repeat(64), SHITTIMCHEST_AUDIO_MODEL_SHA256: 'b'.repeat(64) }), /invalid_audio_configuration/);
  assert.ok(readConfig({ SHITTIMCHEST_AUDIO_EXECUTABLE: '/tmp/engine', SHITTIMCHEST_AUDIO_MODEL: '/tmp/model', SHITTIMCHEST_AUDIO_EXECUTABLE_SHA256: 'a'.repeat(64), SHITTIMCHEST_AUDIO_MODEL_SHA256: 'b'.repeat(64) }).audio);
});
