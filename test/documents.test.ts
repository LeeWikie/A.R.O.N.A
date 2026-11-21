import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWorkspaceTools } from '@mastra/core/workspace';
import { RuntimeStore } from '../src/runtime-store.js';
import { Capabilities } from '../src/capabilities.js';
import { readWorkspaceDocument } from '../src/tools/documents.js';
import { archiveFixture, documentFixture, pdfFixture, workbookFixture } from './document-fixture.js';
import { removeTemp } from './helpers.js';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-documents-')), database = new DatabaseSync(':memory:');
  const runtime = new RuntimeStore(database), capabilities = new Capabilities(runtime, directory), record = runtime.createContext({ id: 'worker', name: 'Worker', role: 'work' });
  const workspace = capabilities.workspace(record, () => ({ read: true, write: true, execute: false, mcp: false, mcpKeys: [] }));
  const tools = await createWorkspaceTools(workspace); const root = path.join(directory, 'workspace');
  return { root, capabilities, record, workspace, tools, async close() { await capabilities.close(); database.close(); await removeTemp(directory); } };
}

test('native workspace read_file extracts DOCX, XLSX, PDF, notebooks and SQLite through the same filesystem', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const documents = new Map([['sample.docx', documentFixture()], ['sample.xlsx', await workbookFixture()], ['sample.pdf', pdfFixture()], ['sample.ipynb', Buffer.from(JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'markdown', source: ['中文 notebook\n'] }, { cell_type: 'code', source: ['print("violet-17")'], outputs: [{ output_type: 'stream', text: ['violet-17\n'] }, { output_type: 'display_data', data: { 'text/plain': ['value 42'], 'image/png': 'UNTRUSTED_BASE64' } }] }] }))]]);
    const db = new DatabaseSync(path.join(f.root, 'sample.sqlite')); db.exec('CREATE TABLE "odd""name" (name TEXT, value INTEGER); INSERT INTO "odd""name" VALUES (\'violet-17\', 42);'); db.close();
    documents.set('sample.sqlite', fs.readFileSync(path.join(f.root, 'sample.sqlite')));
    for (const [file, bytes] of documents) {
      fs.writeFileSync(path.join(f.root, file), bytes);
      const output: unknown = await f.tools.mastra_workspace_read_file.execute({ path: file, showLineNumbers: false }, {});
      assert.equal(typeof output, 'string'); if (typeof output !== 'string') throw Error('Native output type');
      const result = JSON.parse(output);
      assert.equal(result.source.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(result.source.bytes, bytes.length);
      assert.equal(result.authority, 'external-document-data'); assert.equal(result.representation, 'extracted-text'); assert.match(result.content, /violet-17/);
      assert.doesNotMatch(result.content, /HIDDEN_CANARY|UNTRUSTED_BASE64/);
      assert.deepEqual(fs.readFileSync(path.join(f.root, file)), bytes);
      if (file.endsWith('.xlsx')) assert.match(result.content, /42.*formula: B2\*2/);
    }
  } finally { await f.close(); }
});

test('document line paging, explicit byte reads, malformed input, cancellation and native containment stay explicit', async () => {
  const f = await fixture();
  try {
    const bytes = documentFixture(); fs.writeFileSync(path.join(f.root, 'sample.docx'), bytes);
    const page = await readWorkspaceDocument(f.workspace, { path: 'sample.docx', offset: 2, limit: 1 });
    assert.equal(page.startLine, 2); assert.equal(page.endLine, 2); assert.equal(page.complete, false); assert.match(page.content, /^2\t/);
    const encoded: unknown = await f.tools.mastra_workspace_read_file.execute({ path: 'sample.docx', encoding: 'base64' }, {});
    assert.equal(typeof encoded, 'string'); assert.ok(String(encoded).includes(bytes.toString('base64')));
    fs.writeFileSync(path.join(f.root, 'bad.docx'), 'not a container'); await assert.rejects(readWorkspaceDocument(f.workspace, { path: 'bad.docx' }), /invalid_document_archive/);
    const aborted = AbortSignal.abort(); await assert.rejects(readWorkspaceDocument(f.workspace, { path: 'sample.docx' }, aborted), { name: 'AbortError' });
    await assert.rejects(readWorkspaceDocument(f.workspace, { path: '../outside.docx' }));
    fs.writeFileSync(path.join(f.root, 'too-big.pdf'), ''); fs.truncateSync(path.join(f.root, 'too-big.pdf'), 50 * 1024 * 1024 + 1);
    await assert.rejects(readWorkspaceDocument(f.workspace, { path: 'too-big.pdf' }), /document_too_large/);
    assert.equal(f.capabilities.approvalCapability(f.record, 'mastra_workspace_read_file', { path: '.private/private.docx' }), null);
    const archive = archiveFixture({ 'word/document.xml': 'small' }); const index = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); archive.writeUInt32LE(100 * 1024 * 1024, index + 24); fs.writeFileSync(path.join(f.root, 'bomb.docx'), archive);
    await assert.rejects(readWorkspaceDocument(f.workspace, { path: 'bomb.docx' }), /document_archive_limit/);
  } finally { await f.close(); }
});

test('text writes cannot corrupt structured documents or SQLite sidecars; normal text and new PDF creation still work', async () => {
  const f = await fixture();
  try {
    const original = documentFixture(); fs.writeFileSync(path.join(f.root, 'source.docx'), original); fs.writeFileSync(path.join(f.root, 'source.pdf'), pdfFixture());
    for (const file of ['source.docx', 'new.xlsx', 'source.pdf', 'state.db-wal', 'state.sqlite-shm']) {
      const output: unknown = await f.tools.mastra_workspace_write_file.execute({ path: file, content: 'plain text' }, {});
      assert.match(JSON.stringify(output), /binary_document_requires_format_writer/);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'source.docx')), original); assert.equal(fs.existsSync(path.join(f.root, 'state.db-wal')), false);
    const patch: unknown = await f.tools.mastra_workspace_apply_patch.execute({ patch: '*** Begin Patch\n*** Add File: patch.xlsx\n+plain text\n*** End Patch' }, {});
    assert.match(JSON.stringify(patch), /binary_document_requires_format_writer/); assert.equal(fs.existsSync(path.join(f.root, 'patch.xlsx')), false);
    await f.tools.mastra_workspace_write_file.execute({ path: 'notes.txt', content: '中文\r\n' }, {}); assert.equal(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8'), '中文\r\n');
    const pdf = pdfFixture(); await f.tools.mastra_workspace_write_file.execute({ path: 'new.pdf', content: pdf.toString('utf8') }, {}); assert.deepEqual(fs.readFileSync(path.join(f.root, 'new.pdf')), pdf);
  } finally { await f.close(); }
});
