import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/runtime-store.js';
import { ProjectMemory } from '../src/memory/index.js';
import { MemoryFiles } from '../src/memory/files.js';
import { memoryFileTools } from '../src/memory/file-reader.js';
import { removeTemp } from './helpers.js';

test('large file readers preserve every character and expose all files and matching lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-pages-'));
  try {
    const files = new MemoryFiles(dir), original = ('中文🙂\r\n' + 'x'.repeat(99)).repeat(1200) + '\n' + 'a'.repeat(70000) + 'Needle尾部';
    files.write('archive/original.md', original);
    for (let index = 0; index < 257; index++) files.write(`目录/${String(index).padStart(4, '0')}.md`, `# ${index}\nNeedle\n`);
    const tools = files.tools();
    const read = async (offset: number) => await tools.memory_read.execute!({ path: 'archive/original.md', offset, limit: 48000 }, {} as never) as {content: string; nextOffset: number | null};
    let offset: number | null = 0, recovered = '', pages = 0;
    while (offset !== null) {
      const page = await read(offset); assert.ok(Buffer.byteLength(page.content) <= 12000);
      assert.ok(page.nextOffset === null || page.nextOffset > offset); recovered += page.content; offset = page.nextOffset; pages++;
    }
    assert.equal(recovered, original); assert.ok(pages > 10);
    offset = 0; const paths: string[] = [];
    while (offset !== null) {
      const page = await tools.memory_list.execute!({path: '', offset, limit: 17}, {} as never) as {files: {path: string}[]; nextOffset: number | null};
      paths.push(...page.files.map(file => file.path)); offset = page.nextOffset;
    }
    assert.deepEqual(paths, files.list().map(file => file.path));
    offset = 0; const matches: {path: string; text: string; matchOffset: number; excerpt: boolean}[] = [];
    while (offset !== null) {
      const page = await tools.memory_search.execute!({query: 'Needle', offset, limit: 19}, {} as never) as {matches: typeof matches; nextOffset: number | null};
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 15000); matches.push(...page.matches); offset = page.nextOffset;
    }
    assert.equal(matches.length, 258); const lastLine = matches.find(match => match.path === 'archive/original.md')!;
    assert.equal(original.slice(lastLine.matchOffset, lastLine.matchOffset + 6), 'Needle');
    assert.equal(lastLine.excerpt, true); assert.ok(lastLine.text.includes('Needle'));
  } finally { await removeTemp(dir); }
});

test('small resident text stays exact; large files cannot crowd small remembered facts out', async () => {
  const reader = {list: () => [{path: 'a-archive.md', bytes: 100000}, {path: 'portrait.md', bytes: 13}], read: (name: string) => name === 'portrait.md' ? '完整的小事实' : 'x'.repeat(100000)};
  const { memoryFileResident } = await import('../src/memory/file-reader.js');
  const text = memoryFileResident(reader); assert.ok(Buffer.byteLength(text) <= 12000);
  assert.ok(text.includes('完整的小事实')); assert.ok(text.includes('memory_read')); assert.ok(text.includes('a-archive.md'));
  assert.equal(memoryFileResident({list: () => [{path: 'a.md', bytes: 3}], read: () => 'abc'}), '<file path="a.md">\nabc\n</file>');
});

test('run-bound memory survives publication, file replacement, cold open and private database copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-frozen-'));
  let db = new DatabaseSync(path.join(dir, 'runtime.sqlite'));
  try {
    let store = new RuntimeStore(db), memory = new ProjectMemory(store, dir);
    const file = path.join(dir, 'memory/versions/initial/old.md'), original = '原版本🙂\r\n'.repeat(25000) + 'FINAL_ORIGINAL';
    fs.writeFileSync(file, original); const resident = memory.resident({runId: 'original-run', maxBytes: 8000});
    assert.ok(Buffer.byteLength(resident.text) <= 8000); assert.ok(resident.legacyViewId);
    fs.writeFileSync(file, '外部变化不得改写已绑定运行的资料');
    const fresh = memory.resident({runId: 'later-run'}); assert.notEqual(fresh.legacyViewId, resident.legacyViewId);
    const published = path.join(dir, 'memory/versions/published'); fs.mkdirSync(published); fs.writeFileSync(path.join(published, 'new.md'), 'new');
    store.setSetting('memory-version', {id: 'published', generation: 1, source: null, filesDirectory: published});
    db.close(); const restoredDatabase = path.join(dir, 'private-backup.sqlite');
    fs.copyFileSync(path.join(dir, 'runtime.sqlite'), restoredDatabase); fs.unlinkSync(file);
    db = new DatabaseSync(restoredDatabase); store = new RuntimeStore(db); memory = new ProjectMemory(store, path.join(dir, 'relocated'));
    const restored = memory.resident({runId: 'original-run'}); assert.deepEqual(restored, resident);
    const tools = memory.legacyReadTools(restored); assert.deepEqual(Object.keys(tools), ['memory_list', 'memory_read', 'memory_search']);
    assert.ok(tools.memory_read); let offset: number | null = 0, recovered = '';
    while (offset !== null) {
      const page = await tools.memory_read.execute!({path: 'old.md', offset, limit: 48000}, {} as never) as {content: string; nextOffset: number | null};
      recovered += page.content; offset = page.nextOffset;
    }
    assert.equal(recovered, original);
    await assert.rejects(tools.memory_read.execute!({path: '../outside', offset: 0, limit: 10}, {} as never), /memory_file_not_in_view/);
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM immutable_payload_records').get()!.n);
    for (let i = 0; i < 20; i++) memory.resident({runId: `same-publication-${i}`});
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM immutable_payload_records').get()!.n), before + 1);
  } finally { db.close(); await removeTemp(dir); }
});

test('a file with hundreds of extremely long matching lines never produces an unbounded search result', async () => {
  const content = ('start-' + 'x'.repeat(70000) + 'needle\n').repeat(211);
  const tools = memoryFileTools({list: () => [{path: 'a.md', bytes: Buffer.byteLength(content)}], read: () => content});
  let offset: number | null = 0, seen = 0;
  while (offset !== null) {
    const page = await tools.memory_search.execute!({query: 'needle', offset, limit: 100}, {} as never) as {matches: {matchOffset: number}[]; nextOffset: number | null};
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 15000); assert.ok(page.matches.length > 0);
    for (const match of page.matches) assert.equal(content.slice(match.matchOffset, match.matchOffset + 6), 'needle');
    seen += page.matches.length; offset = page.nextOffset;
  }
  assert.equal(seen, 211);
});

test('one-code-unit reads at supplementary characters always advance and reconstruct exactly', async () => {
  const content = '🙂𠮷中文', tools = memoryFileTools({list: () => [{path: 'a.md', bytes: Buffer.byteLength(content)}], read: () => content});
  let offset: number | null = 0, recovered = '';
  while (offset !== null) {
    const page = await tools.memory_read.execute!({path: 'a.md', offset, limit: 1}, {} as never) as {content: string; nextOffset: number | null};
    assert.ok(page.content.length > 0); assert.ok(page.nextOffset === null || page.nextOffset > offset);
    recovered += JSON.parse(JSON.stringify(page.content)); offset = page.nextOffset;
  }
  assert.equal(recovered, content);
});

test('invalid UTF-8 remains an exact readable byte source without blocking other memory discovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-original-bytes-')), db = new DatabaseSync(':memory:');
  try {
    const memory = new ProjectMemory(new RuntimeStore(db), dir), root = memory.version().filesDirectory;
    const original = Buffer.from(Array.from({length: 27011}, (_, i) => i % 256));
    fs.writeFileSync(path.join(root, 'broken.md'), original); fs.writeFileSync(path.join(root, 'readable.md'), '完全保留的已确认事实');
    const view = memory.resident({runId: 'raw-bytes-run'}); assert.ok(view.text.includes('完全保留的已确认事实'));
    const tools = memory.legacyReadTools(view); assert.ok(tools.memory_read && tools.memory_search);
    const unreadable = await tools.memory_read.execute!({path: 'broken.md', offset: 0, limit: 24000}, {} as never) as {requiresByteRead: boolean; content?: unknown};
    assert.equal(unreadable.requiresByteRead, true); assert.equal(unreadable.content, undefined);
    let byteOffset: number | null = 0; const chunks: Buffer[] = [];
    while (byteOffset !== null) {
      const page = await tools.memory_read.execute!({path: 'broken.md', offset: 0, limit: 24000, encoding: 'base64', byteOffset, maxBytes: 511}, {} as never) as {content: string; nextByteOffset: number | null};
      chunks.push(Buffer.from(page.content, 'base64')); assert.ok(page.nextByteOffset === null || page.nextByteOffset > byteOffset); byteOffset = page.nextByteOffset;
    }
    assert.deepEqual(Buffer.concat(chunks), original);
    const search = await tools.memory_search.execute!({query: '已确认事实', offset: 0, limit: 100}, {} as never) as {matches: {path: string}[]; unreadable: {path: string}[]};
    assert.equal(search.matches[0]!.path, 'readable.md'); assert.equal(search.unreadable[0]!.path, 'broken.md');
  } finally {db.close(); await removeTemp(dir);}
});

test('a legacy native checkpoint binds its exact old version and cannot substitute another header or changed files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-memory-old-checkpoint-')), db = new DatabaseSync(':memory:');
  try {
    const store = new RuntimeStore(db), memory = new ProjectMemory(store, dir), old = new MemoryFiles(path.join(dir, 'memory/versions/旧标识-1'));
    old.write('portrait.md', '完整原来的共同事实');
    const suffix = '\n较早对话的结构化摘要（来自上下文 synthetic 的前 2 条消息；原文保留在来源上下文，摘要可能遗漏细节）：\n原摘要';
    const original = `自有框架正文\n常驻记忆（版本 旧标识-1，是可纠正的历史认识，不覆盖新用户要求）：\n${old.resident()}${suffix}`;
    const input = {runId: 'legacy-old-run', systemFrames: [original], suffix, checkpointHash: 'a'.repeat(64)};
    const restored = memory.recoverLegacyResident(input); assert.equal(restored.version, '旧标识-1');
    assert.ok(restored.text.includes('完整原来的共同事实'));
    assert.deepEqual(store.setting<any>('legacy-memory-run:legacy-old-run', null).source, {kind: 'native-checkpoint', sha256: input.checkpointHash});
    const tools = memory.legacyReadTools(restored); assert.ok(tools.memory_read);
    old.write('portrait.md', '外部篡改后不能冒充原冻结内容');
    const page = await tools.memory_read.execute!({path: 'portrait.md', offset: 0, limit: 24000}, {} as never) as {content: string};
    assert.equal(page.content, '完整原来的共同事实');
    assert.throws(() => memory.recoverLegacyResident({...input, runId: 'changed-old-file'}), /memory_legacy_view_unavailable/);
    old.write('portrait.md', '完整原来的共同事实');
    assert.throws(() => memory.recoverLegacyResident({...input, runId: 'wrong-suffix', suffix: ''}), /memory_legacy_view_unavailable/);
    assert.throws(() => memory.recoverLegacyResident({...input, runId: 'wrong-header', systemFrames: [original.replace('版本 旧标识-1', '版本 initial')]}), /memory_legacy_view_unavailable/);
    assert.throws(() => memory.recoverLegacyResident({...input, runId: 'no-checkpoint', checkpointHash: 'not-a-hash'}), /memory_legacy_view_unavailable/);
  } finally {db.close(); await removeTemp(dir);}
});
