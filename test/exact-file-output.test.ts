import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Workspace, LocalFilesystem, createWorkspaceTools } from '@mastra/core/workspace';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { exactWorkspaceRead, projectExactFileReads } from '../src/tools/exact-file-output.js';

test('actual native read output can be presented as exact UTF-8 text without losing LF, CRLF or an absent final newline', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-exact-file-'));
  const workspace = new Workspace({ filesystem: new LocalFilesystem({ basePath: directory, contained: true }), tools: { enabled: false, mastra_workspace_read_file: { enabled: true } } });
  try {
    const tools = await createWorkspaceTools(workspace);
    for (const content of ['', 'violet-17\n', 'violet-17', '中文\r\n第二行\r\n', 'line one\r\nline two\nlast\r']) {
      fs.writeFileSync(path.join(directory, 'source.txt'), content);
      const input = { path: 'source.txt', showLineNumbers: true };
      const output: unknown = await tools.mastra_workspace_read_file.execute(input, { workspace });
      assert.equal(typeof output, 'string'); if (typeof output !== 'string') throw Error('Unexpected native output');
      const exact = exactWorkspaceRead(input, output)!;
      assert.equal(exact.text, content); assert.equal(exact.utf8Bytes, Buffer.byteLength(content)); assert.equal(exact.sha256, createHash('sha256').update(content).digest('hex'));
    }
  } finally { await workspace.destroy(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('partial, truncated, binary and malformed displays are never upgraded to complete file contents', () => {
  assert.equal(exactWorkspaceRead({ path: 'source.txt', offset: 2 }, 'source.txt (2 bytes)\n     1→ok'), undefined);
  assert.equal(exactWorkspaceRead({ path: 'source.txt' }, 'source.txt (100 bytes)\n     1→cut'), undefined);
  assert.equal(exactWorkspaceRead({ path: 'source.txt', encoding: 'base64' }, 'source.txt (2 bytes, base64)\nb2s='), undefined);
  assert.equal(exactWorkspaceRead({ path: 'source.txt' }, 'source.txt (2 bytes)\n     8→ok'), undefined);
});

test('request-only conversion preserves tool identity, original records and opaque replay metadata', () => {
  const prompt: ProcessLLMRequestArgs['prompt'] = [
    { role: 'assistant', providerOptions: { provider: { signature: 'source-signature' } }, content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'mastra_workspace_read_file', input: { path: 'source.txt', showLineNumbers: true } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'mastra_workspace_read_file', output: { type: 'text', value: 'source.txt (10 bytes)\n     1→violet-17\n     2→' } }] },
  ];
  const source = structuredClone(prompt); const projected = projectExactFileReads(prompt);
  assert.deepEqual(prompt, source); assert.deepEqual(projected[0], source[0]);
  const result = projected[1]; if (result?.role !== 'tool') throw Error('Expected result');
  assert.deepEqual(result.content[0]?.output, { type: 'json', value: { path: 'source.txt', text: 'violet-17\n', utf8Bytes: 10, sha256: createHash('sha256').update('violet-17\n').digest('hex'), lineEndings: 'lf', finalLineEnding: 'lf', source: 'workspace-file-content', authority: 'external-file-data', complete: true } });
});
