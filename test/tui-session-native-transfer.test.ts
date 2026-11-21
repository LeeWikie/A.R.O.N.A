import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { decodeSessionImport } from '../src/tui/session-transfer.js';
import { renderSessionHtml } from '../src/tui/session-html.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const header = { type: 'session', version: 3, id: 'synthetic-export', timestamp, cwd: '/synthetic/source' };
const user = (id: string, parentId: string | null, content: string) => ({ type: 'message', id, parentId, timestamp, message: { role: 'user', content, timestamp: 0 } });

test('native session detection preserves the original JSONL bytes for Core migration and validation', () => {
  const jsonl = '\uFEFF' + [header, user('first', null, '中文\nline'), { type: 'custom', id: 'extension', parentId: 'first', timestamp, customType: 'synthetic', data: { source: 'preserve data only' } }].map(entry => JSON.stringify(entry, null, 0)).join('\r\n') + '\r\n';
  assert.deepEqual(decodeSessionImport(jsonl), { format: 'pi', jsonl });
  for (const text of ['', '{}', '{broken', JSON.stringify({ type: 'session', format: 'foreign', id: 'x', cwd: '/x' })]) assert.throws(() => decodeSessionImport(text), /invalid_session_archive/);
});

test('the installed upstream HTML renderer retains both branches and its working offline tree viewer', async () => {
  const jsonl = [header, user('first', null, '中文 first'), user('left', 'first', 'left branch'), user('right', 'first', '</script><img src=x onerror=CANARY>'), { type: 'label', id: 'bookmark', parentId: 'right', timestamp, targetId: 'left', label: 'saved branch' }].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  const html = await renderSessionHtml(jsonl);
  const payload = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1]; assert.ok(payload);
  const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { entries: Array<{ id: string }>; systemPrompt?: string };
  assert.deepEqual(data.entries.map(entry => entry.id), ['first', 'left', 'right', 'bookmark']); assert.equal(data.systemPrompt, undefined);
  assert.doesNotMatch(html, /<img src=x onerror=CANARY>/); assert.match(html, /sanitizeMarkdownUrl/);
  const viewer = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1]; assert.ok(viewer);
  const api = runInContext(viewer.replace('let treeNodeMap = null;', 'let treeNodeMap = null; return { buildTree, buildActivePathIds, flattenTree, getPath };'), createContext({ atob, TextDecoder, URLSearchParams, document: { getElementById: () => ({ textContent: payload }), querySelector: () => null }, window: { location: { search: '' } } })) as { buildTree(): Array<{ entry: { id: string } }>; buildActivePathIds(id: string): Set<string>; flattenTree(tree: unknown, active: Set<string>): Array<{ node: { entry: { id: string } } }>; getPath(id: string): Array<{ id: string }> };
  assert.deepEqual(Array.from(api.getPath('left'), entry => entry.id), ['first', 'left']);
  assert.ok(api.flattenTree(api.buildTree(), api.buildActivePathIds('right')).some(row => row.node.entry.id === 'left'));
});
