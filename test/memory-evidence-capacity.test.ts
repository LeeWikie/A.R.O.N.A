import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getEncoding } from 'js-tiktoken';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { RuntimeStore } from '../src/runtime-store.js';
import { ProjectMemory, type ContextSnapshot } from '../src/memory/index.js';
import { MemoryEvidencePages } from '../src/memory/evidence-reader.js';
import { buildMemoryEvidence } from '../src/memory/evidence.js';
import { removeTemp } from './helpers.js';

const source = {contextId: 'synthetic-memory', runId: 'synthetic-capacity-run', sequence: 1};
const provenance = {contextId: source.contextId, runId: source.runId, signalId: 'original-user'};
const oldEvidence = '过去发生的完整事实和原始条件。🙂\r\n'.repeat(20000) + '\nUSER_CORRECTION_FINAL: RED';
const evidence = () => buildMemoryEvidence({source, gaps: [], entries: [
  {kind: 'user-statement', origin: 'signal', provenance, content: oldEvidence},
  {kind: 'assistant-statement', provenance, content: '绿色只是一项未经确认的建议。'},
]});

test('large business evidence remains ordered, exactly pageable and separate from instruction authority', async () => {
  const original = evidence(), pages = new MemoryEvidencePages(original);
  assert.ok(Buffer.byteLength(JSON.stringify(pages.prompt())) < 3000);
  assert.equal(pages.prompt()[0]!.role, 'user'); assert.doesNotMatch(JSON.stringify(pages.prompt()), /USER_CORRECTION_FINAL/);
  const tools = pages.tools(), listing = await tools.memory_source_list.execute!({offset: 0, limit: 100}, {} as never) as {parts: {index: number; characters?: number}[]; nextOffset: number | null};
  const text = listing.parts.find(part => part.characters === oldEvidence.length)!; assert.ok(text);
  let offset: number | null = 0, recovered = '';
  while (offset !== null) {
    const page = await tools.memory_source_read.execute!({index: text.index, offset, limit: 48000}, {} as never) as {source: typeof source; content: string; nextOffset: number | null};
    assert.deepEqual(page.source, source); assert.ok(Buffer.byteLength(page.content) <= 12000);
    recovered += page.content; offset = page.nextOffset;
  }
  assert.equal(recovered, oldEvidence); assert.deepEqual(original, evidence());
  const aborted = new AbortController(); aborted.abort(new Error('synthetic cancel'));
  await assert.rejects(tools.memory_source_read.execute!({index: text.index, offset: 0, limit: 1}, {abortSignal: aborted.signal} as never), /synthetic cancel/);
});

test('media discovered behind large text is supplied as the exact typed historical file', async () => {
  const file = {type: 'file' as const, data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', filename: '原图.png'};
  const second = {...file, filename: '第二张.png', data: new Uint8Array([137, 80, 78, 71, 2])};
  const input = buildMemoryEvidence({source, gaps: [], entries: [{kind: 'user-statement', origin: 'signal', provenance, content: [{type: 'text', text: oldEvidence}, file, second, file]}]});
  const pages = new MemoryEvidencePages(input), tools = pages.tools();
  const list = await tools.memory_source_list.execute!({offset: 0, limit: 100}, {} as never) as {parts: {index: number; type: string}[]};
  const found = list.parts.filter(part => part.type === 'file'); assert.equal(found.length, 3);
  await Promise.all([...found].reverse().map(part => tools.memory_source_read.execute!({index: part.index, offset: 0, limit: 1}, {} as never)));
  const prompt = pages.prompt(), row = prompt[0]!; assert.equal(row.role, 'user');
  if (row.role !== 'user') return assert.fail();
  const actual = row.content.filter(part => part.type === 'file'); assert.deepEqual(actual, [file, second, file]);
  assert.doesNotMatch(JSON.stringify(prompt), /USER_CORRECTION_FINAL/);
});

test('whole-source pages preserve every ordered metadata/text part without one request per small part', async () => {
  const input = buildMemoryEvidence({source, gaps: [], entries: Array.from({length: 60}, (_, i) => ({kind: 'user-statement' as const, origin: 'signal' as const, provenance: {...provenance, signalId: `input-${i}`}, content: `原文 ${i}：\"换行\"\n🙂\t`.repeat(60)}))});
  const pages = new MemoryEvidencePages(input), tools = pages.tools();
  let next: {index: number; offset: number} | null = {index: 0, offset: 0}, calls = 0;
  const recovered = new Map<number, string>();
  while (next !== null) {
    const page = await tools.memory_source_page.execute!(next, {} as never) as {parts: {index: number; offset: number; content: string}[]; next: {index: number; offset: number} | null};
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 12500); assert.ok(page.parts.length > 0);
    for (const part of page.parts) {const before = recovered.get(part.index) ?? ''; assert.equal(before.length, part.offset); recovered.set(part.index, before + JSON.parse(JSON.stringify(part.content)));}
    next = page.next; calls++;
  }
  const row = input.prompt[0]!; if (row.role !== 'user') return assert.fail();
  assert.deepEqual([...recovered.values()], row.content.map(part => part.type === 'text' ? part.text : assert.fail()));
  assert.ok(calls < 32, `every original part was read in ${calls} native pages`);
});

function records(value: unknown, key: string): Record<string, any>[] {
  if (typeof value === 'string') {try { return records(JSON.parse(value), key); } catch { return []; }}
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [...(key in row ? [row] : []), ...Object.values(row).flatMap(child => records(child, key))];
}

test('the native organizer discovers and recalls remote tails under a real independent token bound', {timeout: 30000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-evidence-capacity-')), db = new DatabaseSync(':memory:');
  const store = new RuntimeStore(db), memory = new ProjectMemory(store, dir), encoding = getEncoding('o200k_base');
  const archive = '原归档内容。\n'.repeat(30000) + 'ARCHIVE_FINAL_ORIGINAL';
  fs.writeFileSync(path.join(memory.version().filesDirectory, 'old.md'), archive);
  const snapshot: ContextSnapshot = {...source, modelProfile: 'synthetic', createdAt: '2020-01-01T00:00:00Z', prompt: [], nativeMessages: {}, providerOptions: {}};
  memory.archive(snapshot); const job = memory.newJob(source.runId); let step = 0, selected = -1;
  const model = new MastraLanguageModelV2Mock({doGenerate: async request => {
    assert.ok(encoding.encode(JSON.stringify(request.prompt)).length < 40000, 'the provider rejects oversized requests independently of our estimator');
    const serialized = JSON.stringify(request.prompt); let toolName: string, input: unknown;
    switch (step++) {
      case 0: assert.doesNotMatch(serialized, /USER_CORRECTION_FINAL|ARCHIVE_FINAL_ORIGINAL/); toolName = 'memory_source_list'; input = {}; break;
      case 1: {
        const list = records(request.prompt, 'parts').find(row => Array.isArray(row.parts) && row.parts.some((part: any) => part.characters === oldEvidence.length)); assert.ok(list);
        selected = list.parts.find((part: any) => part.characters === oldEvidence.length).index;
        toolName = 'memory_source_read'; input = {index: selected - 1}; break;
      }
      case 2: assert.ok(serialized.includes('user-statement') && serialized.includes('original-user')); toolName = 'memory_source_read'; input = {index: selected, offset: oldEvidence.length - 64}; break;
      case 3: assert.match(serialized, /USER_CORRECTION_FINAL: RED/); toolName = 'memory_list'; input = {}; break;
      case 4: assert.ok(records(request.prompt, 'files').some(row => row.files.some((file: any) => file.path === 'old.md'))); toolName = 'memory_read'; input = {path: 'old.md', limit: 1}; break;
      case 5: {
        const first = records(request.prompt, 'totalCharacters').find(row => row.path === 'old.md'); assert.ok(first);
        toolName = 'memory_read'; input = {path: 'old.md', offset: first.totalCharacters - 64}; break;
      }
      case 6: assert.match(serialized, /ARCHIVE_FINAL_ORIGINAL/); toolName = 'memory_write'; input = {path: 'facts.md', content: '用户已更正为红色；绿色只是助手建议。来源 synthetic-capacity-run/original-user；旧归档末尾 ARCHIVE_FINAL_ORIGINAL 已核对。'}; break;
      case 7: toolName = 'memory_commit'; input = {sourceRunId: source.runId, note: 'Checked original source metadata and both retained tails.'}; break;
      default: return {content: [{type: 'text', text: 'done'}], finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2}, warnings: []};
    }
    return {content: [{type: 'tool-call', toolName, toolCallId: `source-page-${step}`, input: JSON.stringify(input)}], finishReason: 'tool-calls', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2}, warnings: []};
  }});
  try {
    const result = await memory.organize(job.id, () => model, undefined, undefined, () => evidence());
    assert.equal(result.changed, true); assert.equal(memory.jobs()[0]!.status, 'succeeded');
    assert.equal(fs.readFileSync(path.join(memory.version().filesDirectory, 'old.md'), 'utf8'), archive);
    assert.match(fs.readFileSync(path.join(memory.version().filesDirectory, 'facts.md'), 'utf8'), /红色.*绿色只是助手建议/);
    assert.equal(memory.version().generation, 1); assert.equal(step, 8, 'the native loop finishes after memory_commit without another provider call');
  } finally {db.close(); await removeTemp(dir);}
});
