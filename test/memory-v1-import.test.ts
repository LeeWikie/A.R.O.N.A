import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { MemoryChatExportImporter, MemoryImportError, prepareChatExportPrefix, readChatExportZipMember, parseChatExportJson } from '../src/memory/v1/import.js';
import type { ChatExportPrefixOptions } from '../src/memory/v1/import.js';
import { MemoryEvidenceLedger } from '../src/memory/v1/ledger.js';
import { projectRecentMemory } from '../src/memory/v1/recent.js';
import { resolveMemoryContextPolicy } from '../src/memory/v1/binding.js';
import { evidenceIdempotencyKey } from '../src/memory/v1/validate.js';

const now = '2026-05-01T00:00:00.000Z';
const event = '2026-04-30T00:00:00.000Z';
const options = (extra: Partial<ChatExportPrefixOptions> = {}): ChatExportPrefixOptions => ({ namespace: 'synthetic', sourceRef: 'export-source', conversation: { index: 0 }, maxNodes: 20, receivedAt: now, ...extra });
function message(id: string, role: string, text: string | unknown[] = 'synthetic', contentType = 'text', at: unknown = Date.parse(event) / 1000) {
  return { id, author: { role, name: null }, create_time: at, content: { content_type: contentType, parts: typeof text === 'string' ? [text] : text } };
}
function document(messages: ReturnType<typeof message>[]) {
  const mapping: Record<string, { id: string; parent: string | null; children: string[]; message: ReturnType<typeof message> | null }> = { root: { id: 'root', parent: null, children: messages.length ? ['n0'] : [], message: null } };
  messages.forEach((m, i) => { mapping[`n${i}`] = { id: `n${i}`, parent: i ? `n${i - 1}` : 'root', children: i + 1 < messages.length ? [`n${i + 1}`] : [], message: m }; });
  return [{ id: 'conversation-1', conversation_id: 'conversation-1', title: 'synthetic fixture', mapping, current_node: messages.length ? `n${messages.length - 1}` : 'root' }];
}
function memory(t: test.TestContext) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); return { db, importer: new MemoryChatExportImporter(db) }; }
function size(db: DatabaseSync, table: string) { return Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n); }
const expectCode = (code: MemoryImportError['code'], fn: () => unknown) => assert.throws(fn, e => e instanceof MemoryImportError && e.code === code);

test('exact text, event/receipt times and role boundaries survive ledger and recent projection', t => {
  const { db, importer } = memory(t); const raw = ' \r\n逐字\u0000e\u0301  ';
  const result = importer.importDocument(document([message('u1', 'user', raw), message('a1', 'assistant', 'suggestion'), message('t1', 'tool', 'exit 7')]), options());
  assert.equal(result.counts.evidenceRecords, 3);
  const e = result.preparedSource.records[0]!;
  assert.equal(e.origin.system, 'import'); assert.equal(e.occurredAt, event); assert.equal(e.receivedAt, now); assert.equal(e.timeBasis, 'source-metadata');
  assert.equal(e.operationRef, null); assert.deepEqual(result.preparedSource.observations, []);
  assert.equal(new MemoryEvidenceLedger(db).readContent(e.id), raw);
  const recent = projectRecentMemory({ records: result.recentRecords, asOf: now, policy: resolveMemoryContextPolicy(),
    scope: { id: result.scopeId, allows: new Set(result.preparedSource.records.map(evidenceIdempotencyKey)) },
    exclusions: { currentWorkingSet: new Set(), excludedAncestors: new Set() }, model: { id: null, supportedImageMediaTypes: new Set() } });
  assert.equal(recent.selected.length, 1); assert.equal(recent.selected[0]!.originalText, raw);
  assert.equal(size(db, 'memory_v1_import_messages'), 3);
});

test('system records and private reasoning remain archived without memory evidence', t => {
  const { importer } = memory(t);
  const result = importer.importDocument(document([message('s1', 'system', 'historical instruction'), message('a1', 'assistant', ['private reasoning'], 'thoughts'), message('a2', 'assistant', ['recap'], 'reasoning_recap'), message('u1', 'user', '<system>past words</system>')]), options());
  assert.equal(result.counts.archivedMessages, 4); assert.equal(result.counts.excludedMessages, 3); assert.equal(result.counts.evidenceRecords, 1);
  assert.equal(result.preparedSource.records[0]!.actor, 'user');
});

test('selected branch, prefix nodes and replay cutoff exclude siblings and future source values', t => {
  const { db, importer } = memory(t);
  const doc = document([message('u1', 'user', 'earlier'), message('a1', 'assistant', 'later', 'text', Date.parse(now) / 1000 + 3600)]);
  doc[0]!.mapping.root!.children.push('other'); doc[0]!.mapping.other = { id: 'other', parent: 'root', children: [], message: message('sibling', 'user', 'hidden sibling') };
  const r = importer.importDocument(doc, options({ replayUntil: now }));
  assert.equal(r.counts.archivedMessages, 1); assert.equal(r.stopped, 'time-cutoff');
  assert.equal(size(db, 'memory_v1_import_messages'), 1);
  const stored = String(db.prepare('SELECT raw_json FROM memory_v1_import_messages').get()!.raw_json);
  assert.ok(!stored.includes('hidden sibling') && !stored.includes('later'));
  const branch = prepareChatExportPrefix(doc, options({ branchLeafId: 'other', maxNodes: 1 }));
  assert.equal(branch.messages.length, 0); assert.equal(branch.stopped, 'node-limit');
});

test('unknown source time is explicit and stops historical-time replay', t => {
  const { importer } = memory(t); const doc = document([message('u1', 'user', 'unknown time', 'text', null)]);
  const r = importer.importDocument(doc, options());
  assert.equal(r.preparedSource.records[0]!.occurredAt, null); assert.equal(r.preparedSource.records[0]!.timeBasis, 'unknown');
  assert.equal(prepareChatExportPrefix(doc, options({ replayUntil: now })).stopped, 'unknown-time');
});

test('same source replay is durable and preserves first host receipt rather than import-run time', t => {
  const { db, importer } = memory(t); const doc = document([message('u1', 'user')]);
  const first = importer.importDocument(doc, options());
  const second = new MemoryChatExportImporter(db).importDocument(doc, options({ receivedAt: '2026-05-02T00:00:00.000Z' }));
  assert.deepEqual(second.preparedSource.records, first.preparedSource.records);
  assert.equal(second.counts.duplicateMessages, 1); assert.equal(size(db, 'memory_v1_evidence'), 1);
});

test('source identity changes fail atomically, including a new prefix before a conflicting old message', t => {
  const { db, importer } = memory(t);
  importer.importDocument(document([message('existing', 'user', 'original')]), options());
  const oldRows = size(db, 'memory_v1_import_messages'); const oldEvidence = size(db, 'memory_v1_evidence');
  expectCode('identity', () => importer.importDocument(document([message('new', 'user', 'new prefix'), message('existing', 'user', 'tampered')]), options()));
  assert.equal(size(db, 'memory_v1_import_messages'), oldRows); assert.equal(size(db, 'memory_v1_evidence'), oldEvidence);
});

test('caller transaction rollback also removes imported raw registry, evidence and historical receipts', t => {
  const { db, importer } = memory(t); db.exec('BEGIN');
  importer.importDocument(document([message('u1', 'user')]), options()); db.exec('ROLLBACK');
  assert.equal(size(db, 'memory_v1_import_messages'), 0); assert.equal(size(db, 'memory_v1_evidence'), 0);
  assert.equal(size(db, 'memory_v1_import_batches'), 0);
});

test('locators never masquerade as media content and later supplied bytes can fill a source gap', t => {
  const { db, importer } = memory(t); const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const doc = document([message('u1', 'user', [{ content_type: 'image_asset_pointer', asset_pointer: 'local-image', mime_type: 'image/png', size_bytes: png.length }], 'multimodal_text')]);
  const missing = importer.importDocument(doc, options());
  assert.equal(missing.counts.unavailableParts, 1); assert.equal(missing.counts.evidenceRecords, 0); assert.equal(missing.preparedSource.gaps.length, 1);
  assert.equal(size(db, 'memory_v1_evidence'), 0);
  const loaded = importer.importDocument(doc, options({ assets: [{ locator: 'local-image', mediaType: 'image/png', bytes: png }] }));
  assert.equal(loaded.counts.unavailableParts, 0); assert.equal(loaded.counts.evidenceRecords, 1);
  const evidence = loaded.preparedSource.records[0]!;
  assert.deepEqual(new MemoryEvidenceLedger(db).readContent(evidence.id, evidence.attachments[0]!.sourceId), png);
  assert.equal(loaded.recentRecords[0]!.originalTextBytes, null);
});

test('transcripts without original audio remain an explicit pending source and never typed original text', t => {
  const { importer } = memory(t);
  const r = importer.importDocument(document([message('u1', 'user', [{ content_type: 'audio_transcription', text: 'derived transcript' }], 'multimodal_text')]), options());
  assert.equal(r.counts.unavailableParts, 1); assert.equal(r.recentRecords.length, 1); assert.equal(r.recentRecords[0]!.originalTextBytes, null); assert.equal(r.preparedSource.gaps.length, 1);
  const body = JSON.parse(Buffer.from(r.preparedSource.contents.values().next().value!.body).toString());
  assert.deepEqual(body, { type: 'historical-transcription', text: 'derived transcript', confirmation: 'unconfirmed', originalAudio: 'unavailable' });
});

test('broken graph links, cycles, context aliases and invalid UTF-8 fail with safe errors', () => {
  const doc = document([message('u1', 'user')]); doc[0]!.mapping.n0!.parent = 'missing';
  expectCode('graph', () => prepareChatExportPrefix(doc, options()));
  const alias = document([message('u1', 'user')]); alias[0]!.id = 'different';
  expectCode('identity', () => prepareChatExportPrefix(alias, options()));
  expectCode('format', () => parseChatExportJson(new Uint8Array([255])));
  expectCode('format', () => prepareChatExportPrefix(document([message('u1', 'user', '\ud800')]), options()));
  const cycle = document([message('u1', 'user')]); cycle[0]!.mapping.root!.parent = 'n0'; cycle[0]!.mapping.n0!.children.push('root');
  expectCode('graph', () => prepareChatExportPrefix(cycle, options()));
});

test('support grouping conservatively shares imported branch and repeated-material source', t => {
  const { importer } = memory(t);
  const a = importer.importDocument(document([message('u1', 'user', 'same'), message('u2', 'user', 'same')]), options());
  assert.equal(a.counts.evidenceRecords, 2); assert.equal(a.supportGroups[0]!.group, a.supportGroups[1]!.group);
});

function crc(bytes: Buffer) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function zipFile(files: { name: string; data: Buffer; badCrc?: boolean }[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const data = deflateRawSync(f.data); const hash = f.badCrc ? 1 : crc(f.data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8); head.writeUInt32LE(hash, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(f.data.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const row = Buffer.alloc(46); row.writeUInt32LE(0x02014b50); row.writeUInt16LE(20, 4); row.writeUInt16LE(20, 6); row.writeUInt16LE(8, 10); row.writeUInt32LE(hash, 16); row.writeUInt32LE(data.length, 20); row.writeUInt32LE(f.data.length, 24); row.writeUInt16LE(name.length, 28); row.writeUInt32LE(offset, 42); central.push(row, name);
    offset += head.length + name.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function temp(t: test.TestContext) { const dir = mkdtempSync(join(tmpdir(), 'memory-import-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('ZIP numeric shard selection reads actual compressed bytes into real ledger', async t => {
  const dir = temp(t); const path = join(dir, 'input.zip'); const { importer } = memory(t);
  writeFileSync(path, zipFile([{ name: 'conversations-010.json', data: Buffer.from('[]') }, { name: 'conversations-000.json', data: Buffer.from(JSON.stringify(document([message('u1', 'user', 'zipped')])) ) }]));
  const r = await importer.importZip({ ...options(), archivePath: path }); assert.equal(r.counts.evidenceRecords, 1);
  await assert.rejects(readChatExportZipMember({ archivePath: path, maxMemberBytes: 8 }), e => e instanceof MemoryImportError && e.code === 'limit');
});

test('ZIP duplicate names, unsafe members, CRC corruption, symlink and hardlink sources are rejected', async t => {
  const dir = temp(t); const path = join(dir, 'input.zip');
  for (const files of [
    [{ name: 'conversations.json', data: Buffer.from('[]') }, { name: 'conversations.json', data: Buffer.from('[]') }],
    [{ name: '../conversations.json', data: Buffer.from('[]') }],
    [{ name: 'conversations.json', data: Buffer.from('[]'), badCrc: true }],
  ]) { writeFileSync(path, zipFile(files)); await assert.rejects(readChatExportZipMember({ archivePath: path }), e => e instanceof MemoryImportError && e.code === 'archive'); }
  writeFileSync(path, zipFile([{ name: 'conversations.json', data: Buffer.from('[]') }]));
  const sym = join(dir, 'sym.zip'); symlinkSync(path, sym);
  await assert.rejects(readChatExportZipMember({ archivePath: sym }), MemoryImportError);
  const hard = join(dir, 'hard.zip'); linkSync(path, hard);
  await assert.rejects(readChatExportZipMember({ archivePath: hard }), MemoryImportError);
});

test('parent-only mapping exports release their actual selected path without requiring synthetic children arrays', t => {
  const { importer } = memory(t); const doc = document([message('u1', 'user')]);
  for (const node of Object.values(doc[0]!.mapping)) delete (node as { children?: string[] }).children;
  const r = importer.importDocument(doc, options()); assert.equal(r.counts.evidenceRecords, 1);
});

test('persistent recent reading requires explicit scope, preserves bytes and receipt clock, and verifies registry proof', t => {
  const { db, importer } = memory(t); const r = importer.importDocument(document([message('u1', 'user', 'persisted \r\n'), message('a1', 'assistant', 'suggestion')]), options());
  const reader = new MemoryChatExportImporter(db);
  assert.deepEqual(reader.scopes(), [r.scopeId]);
  assert.equal(reader.recentRecords({ asOf: now, scopeIds: new Set() }).length, 0);
  assert.equal(reader.recentRecords({ asOf: '2026-04-01T00:00:00.000Z', scopeIds: new Set([r.scopeId]) }).length, 0);
  const rows = reader.recentRecords({ asOf: now, scopeIds: new Set([r.scopeId]) });
  assert.equal(rows.length, 1); assert.equal(Buffer.from(rows[0]!.originalTextBytes!).toString(), 'persisted \r\n');
  assert.equal(size(db, 'memory_v1_import_messages'), 2, '助手原始资料仍独立归档，不占近期用户原文候选额度');
  db.prepare('UPDATE memory_v1_import_messages SET raw_json=? WHERE message_ref=?').run('{}', r.preparedSource.records[0]!.origin.lineageRoot);
  expectCode('identity', () => reader.recentRecords({ asOf: now, scopeIds: new Set([r.scopeId]) }));
});

test('registered imported prefixes rebuild exact source bindings and content slots after SQLite reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-import-reopen-')), filename = join(directory, 'records.sqlite');
  let db = new DatabaseSync(filename), importer = new MemoryChatExportImporter(db);
  t.after(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = importer.importDocument(document([
    message('u-source', 'user', [' raw user\r\n', { content_type: 'image_asset_pointer', asset_pointer: 'local-image', mime_type: 'image/png', size_bytes: png.length }], 'multimodal_text', '2026-04-30T00:00:00.000001Z'),
    message('assistant-source', 'assistant', 'An unconfirmed suggestion.'), message('tool-source', 'tool', 'Historical tool output.'), message('system-source', 'system', 'Excluded control data.'),
  ]), options({ assets: [{ locator: 'local-image', mediaType: 'image/png', bytes: png }] }));
  assert.deepEqual(importer.readSource(result.preparedSource.source.runId!), { preparedSource: structuredClone(result.preparedSource), scopeId: result.scopeId });
  db.close(); db = new DatabaseSync(filename); importer = new MemoryChatExportImporter(db);
  assert.deepEqual(importer.runs(), [result.preparedSource.source.runId]);
  assert.deepEqual(importer.readSource(result.preparedSource.source.runId!), { preparedSource: structuredClone(result.preparedSource), scopeId: result.scopeId });
  assert.equal(importer.readSource('not-a-host-registered-import'), null);
});

test('rebuilding an imported source retains missing audio and only resolves image gaps using independently admitted bytes', t => {
  const { importer } = memory(t), png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const input = document([message('gaps-source', 'user', ['text', { content_type: 'image_asset_pointer', asset_pointer: 'image', mime_type: 'image/png', size_bytes: png.length }, { content_type: 'audio_transcription', text: 'Unconfirmed historical ASR.' }], 'multimodal_text')]);
  const missing = importer.importDocument(input, options());
  assert.deepEqual(importer.readSource(missing.preparedSource.source.runId!)!.preparedSource, structuredClone(missing.preparedSource));
  assert.equal(missing.preparedSource.gaps.length, 2);
  const filled = importer.importDocument(input, options({ assets: [{ locator: 'image', mediaType: 'image/png', bytes: png }] }));
  assert.equal(filled.preparedSource.source.runId, missing.preparedSource.source.runId);
  assert.deepEqual(importer.readSource(filled.preparedSource.source.runId!)!.preparedSource, structuredClone(filled.preparedSource));
  assert.equal(filled.preparedSource.gaps.length, 1, '缺失原始音频仍保持缺口');
  importer.importDocument(input, options());
  assert.deepEqual(importer.readSource(filled.preparedSource.source.runId!)!.preparedSource, structuredClone(filled.preparedSource), '重复输入未携原图不能删除已核实的存储原件');
});

test('source reconstruction rejects detached raw/index/body proof even when an editable checksum is recomputed', t => {
  const changes = [
    (db: DatabaseSync, id: string) => db.prepare('UPDATE memory_v1_import_batches SET batch_json=? WHERE run_id=?').run('{}', id),
    (db: DatabaseSync, _id: string) => { const raw = '{"id":"foreign"}'; db.prepare('UPDATE memory_v1_import_messages SET raw_json=?,message_hash=?').run(raw, createHash('sha256').update(raw).digest('hex')); },
    (db: DatabaseSync, _id: string) => db.prepare('UPDATE memory_v1_import_evidence SET message_ref=?').run('foreign-message'),
    (db: DatabaseSync, _id: string) => db.prepare("UPDATE memory_v1_contents SET data=? WHERE kind='body'").run(Buffer.from('different original')),
  ];
  for (const change of changes) {
    const { db, importer } = memory(t), imported = importer.importDocument(document([message('bound-source', 'user', 'original')]), options());
    change(db, imported.preparedSource.source.runId!);
    assert.throws(() => importer.readSource(imported.preparedSource.source.runId!));
  }
});

test('persistent recent limit counts eligible user originals, never newer assistant records', t => {
  const { importer } = memory(t);
  const r = importer.importDocument(document([message('u1', 'user', 'eligible user'), message('a1', 'assistant', 'later suggestion', 'text', '2026-04-30T23:59:59.999999Z')]), options());
  const rows = importer.recentRecords({ asOf: now, scopeIds: new Set([r.scopeId]), limit: 1 });
  assert.equal(rows.length, 1); assert.equal(rows[0]!.evidence.actor, 'user'); assert.equal(Buffer.from(rows[0]!.originalTextBytes!).toString(), 'eligible user');
});

test('persistent recent ordering normalizes timezone offsets and preserves fractional seconds around the epoch', t => {
  const { importer } = memory(t);
  const r = importer.importDocument(document([
    message('u1', 'user', 'newer UTC', 'text', '2026-05-01T00:30:00.000001Z'),
    message('u2', 'user', 'older offset', 'text', '2026-05-01T01:00:00.999999+01:00'),
  ]), options({ receivedAt: '2026-05-01T02:00:00.000Z' }));
  const rows = importer.recentRecords({ asOf: '2026-05-01T02:00:00.000Z', scopeIds: new Set([r.scopeId]), limit: 1 });
  assert.equal(Buffer.from(rows[0]!.originalTextBytes!).toString(), 'newer UTC');
  const negative = importer.importDocument(document([
    message('before-epoch', 'user', 'before epoch', 'text', '1970-01-01T00:59:59.999999+01:00'),
    message('after-epoch', 'user', 'after epoch', 'text', '1970-01-01T00:00:00.000001Z'),
  ]), options({ sourceRef: 'negative-epoch', receivedAt: '1970-01-01T00:00:00.000001Z' }));
  const selected = importer.recentRecords({ asOf: '1970-01-01T00:00:00.000002Z', scopeIds: new Set([negative.scopeId]), limit: 1 });
  assert.equal(Buffer.from(selected[0]!.originalTextBytes!).toString(), 'after epoch');
});

test('sub-millisecond receipt and future occurrence cutoffs are applied before candidate limits', t => {
  const { importer } = memory(t), cutoff = '2026-05-01T00:00:00.000001Z';
  const first = importer.importDocument(document([message('eligible', 'user', 'available', 'text', '2026-05-01T00:00:00.000000Z')]), options({ receivedAt: '2026-05-01T00:00:00.000000Z' }));
  importer.importDocument(document([message('future-receipt', 'user', 'not received', 'text', '2026-05-01T00:00:00.000001Z')]), options({ receivedAt: '2026-05-01T00:00:00.000002Z' }));
  importer.importDocument(document([message('future-event', 'user', 'not occurred', 'text', '2026-05-01T00:00:00.000002Z')]), options({ receivedAt: '2026-05-01T00:00:00.000000Z' }));
  const rows = importer.recentRecords({ asOf: cutoff, scopeIds: new Set([first.scopeId]), limit: 1 });
  assert.equal(rows.length, 1); assert.equal(Buffer.from(rows[0]!.originalTextBytes!).toString(), 'available');
});

test('recent retrieval leaves out-of-scope raw bodies unread while still validating selected raw identity', t => {
  const { db, importer } = memory(t);
  const allowed = importer.importDocument(document([message('allowed', 'user', 'selected body')]), options());
  const excluded = importer.importDocument(document([message('excluded', 'user', 'unselected body')]), options({ sourceRef: 'different-source' }));
  db.prepare('UPDATE memory_v1_import_messages SET raw_json=? WHERE message_ref=? AND source_ref=?').run('{unparsed', excluded.preparedSource.records[0]!.origin.lineageRoot, 'different-source');
  const rows = importer.recentRecords({ asOf: now, scopeIds: new Set([allowed.scopeId]), limit: 1 });
  assert.equal(rows.length, 1); assert.equal(Buffer.from(rows[0]!.originalTextBytes!).toString(), 'selected body');
  expectCode('identity', () => importer.recentRecords({ asOf: now, scopeIds: new Set([excluded.scopeId]), limit: 1 }));
});

test('ZIP importer loads only released local image references with verified bytes; future and HTTPS stay unread', async t => {
  const dir = temp(t); const path = join(dir, 'input.zip'); const { importer } = memory(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLh8AAAAASUVORK5CYII=', 'base64');
  const part = { content_type: 'image_asset_pointer', asset_pointer: 'sediment://local-image', mime_type: 'image/png', size_bytes: png.length };
  const doc = document([message('u1', 'user', [part], 'multimodal_text'), message('u2', 'user', [{ ...part, asset_pointer: 'https://external.invalid/private.png' }], 'multimodal_text')]);
  writeFileSync(path, zipFile([{ name: 'conversations.json', data: Buffer.from(JSON.stringify(doc)) }, { name: 'media/local-image.png', data: png }]));
  const first = await importer.importZip({ ...options({ maxNodes: 2 }), archivePath: path });
  assert.equal(first.counts.evidenceRecords, 1); assert.equal(first.counts.unavailableParts, 0);
  assert.equal(first.preparedSource.records[0]!.attachments[0]!.bytes, png.length);
  const full = await importer.importZip({ ...options(), archivePath: path });
  assert.equal(full.counts.evidenceRecords, 1); assert.equal(full.counts.unavailableParts, 1);
});

test('ZIP assets with ambiguous local names or mismatched declared bytes remain explicit source gaps', async t => {
  const dir = temp(t); const path = join(dir, 'input.zip'); const { importer } = memory(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLh8AAAAASUVORK5CYII=', 'base64');
  const doc = document([message('u1', 'user', [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://image', mime_type: 'image/png', size_bytes: png.length }], 'multimodal_text')]);
  writeFileSync(path, zipFile([{ name: 'conversations.json', data: Buffer.from(JSON.stringify(doc)) }, { name: 'a/image.png', data: png }, { name: 'b/image.png', data: png }]));
  const r = await importer.importZip({ ...options(), archivePath: path }); assert.equal(r.counts.unavailableParts, 1); assert.equal(r.counts.evidenceRecords, 0);
});


test('fractional seconds and equivalent offset cutoffs do not release a sub-millisecond future', () => {
  const doc = document([message('u1', 'user', 'sub-millisecond', 'text', 0.0009)]);
  const denied = prepareChatExportPrefix(doc, options({ replayUntil: '1970-01-01T00:00:00.0005Z' }));
  assert.equal(denied.stopped, 'time-cutoff'); assert.equal(denied.messages.length, 0);
  const allowed = prepareChatExportPrefix(doc, options({ replayUntil: '1970-01-01T08:00:00.0009+08:00' }));
  assert.equal(allowed.messages[0]!.occurredAt, '1970-01-01T00:00:00.0009Z');
  const stringTime = document([message('u2', 'user', 'string time', 'text', '1970-01-01T08:00:00.0009001+08:00')]);
  assert.equal(prepareChatExportPrefix(stringTime, options({ replayUntil: '1970-01-01T00:00:00.0009000Z' })).messages.length, 0);
  assert.equal(prepareChatExportPrefix(stringTime, options({ replayUntil: '1970-01-01T00:00:00.0009001Z' })).messages[0]!.occurredAt, '1970-01-01T08:00:00.0009001+08:00');
});

test('negative epochs and exponent notation keep their decimal value across zero and second boundaries', () => {
  const negative = prepareChatExportPrefix(document([message('u1', 'user', 'negative epoch', 'text', -0.0001)]), options());
  assert.equal(negative.messages[0]!.occurredAt, '1969-12-31T23:59:59.9999Z');
  const exponent = document([message('u2', 'user', 'tiny epoch', 'text', 1e-7)]);
  assert.equal(prepareChatExportPrefix(exponent, options()).messages[0]!.occurredAt, '1970-01-01T00:00:00.0000001Z');
  assert.equal(prepareChatExportPrefix(exponent, options({ replayUntil: '1970-01-01T00:00:00.00000009Z' })).messages.length, 0);
  const large = prepareChatExportPrefix(document([message('u3', 'user', 'large epoch', 'text', 1e9)]), options());
  assert.equal(large.messages[0]!.occurredAt, '2001-09-09T01:46:40.000Z');
  expectCode('format', () => prepareChatExportPrefix(document([message('u4', 'user', 'out of range', 'text', 1e100)]), options()));
});


test('top-level historical transcription stays qualified across persistent reading and its original-audio gap remains', t => {
  const { db, importer } = memory(t);
  const raw = message('u1', 'user', [], 'audio_transcription');
  (raw.content as unknown as { text: string }).text = '  historical voice\r\n';
  delete (raw.content as { parts?: unknown[] }).parts;
  const r = importer.importDocument(document([raw]), options());
  assert.equal(r.counts.evidenceRecords, 1); assert.equal(r.counts.unavailableParts, 1); assert.equal(r.preparedSource.gaps.length, 1);
  assert.equal(r.recentRecords[0]!.originalTextBytes, null);
  const stored = new MemoryChatExportImporter(db).recentRecords({ asOf: now, scopeIds: new Set([r.scopeId]) });
  assert.equal(stored[0]!.originalTextBytes, null); assert.deepEqual(stored[0]!.evidence.attachments, []);
  const body = new MemoryEvidenceLedger(db).readContent(r.preparedSource.records[0]!.id);
  assert.equal(typeof body, 'object');
  if (typeof body === 'string') throw new Error('transcription_body_codec');
  const qualified = JSON.parse(Buffer.from(body).toString());
  assert.equal(qualified.text, '  historical voice\r\n'); assert.equal(qualified.confirmation, 'unconfirmed'); assert.equal(qualified.originalAudio, 'unavailable');
});

test('empty, malformed or unknown audio never creates a fabricated transcript or audio receipt', t => {
  const { db, importer } = memory(t);
  for (const [index, part] of [{ content_type: 'audio_transcription', text: '' }, { content_type: 'audio_transcription', text: '   ' }, { content_type: 'audio_transcription', text: 12 }, { content_type: 'audio', asset_pointer: 'opaque' }].entries()) {
    const r = importer.importDocument(document([message('u'+index, 'user', [part], 'multimodal_text')]), options());
    assert.equal(r.counts.evidenceRecords, 0); assert.equal(r.counts.unavailableParts, 1); assert.equal(r.preparedSource.gaps.length, 1);
  }
  const unknown = importer.importDocument(document([message('u-unknown', 'user', [], 'audio')]), options());
  assert.equal(unknown.counts.evidenceRecords, 0); assert.equal(unknown.preparedSource.gaps.length, 1);
  assert.equal(size(db, 'memory_v1_evidence'), 0);
});
