import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InteractionAnswerDrafts, unconfirmedAnswer } from '../src/tui/interaction-answers.js';
import { removeTemp } from './helpers.js';

const item = { id: 'synthetic-gate', contextId: 'main', runId: 'synthetic-run', toolCallId: 'synthetic-call', kind: 'question' as const, payload: { question: 'Synthetic local persistence?' } };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('independent client processes retain simultaneous confirmations and commit a selection against the exact reviewed versions', { timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-processes-'));
  try {
    const moduleURL = new URL('../src/tui/interaction-answers.ts', import.meta.url).href;
    const source = `import {InteractionAnswerDrafts,unconfirmedAnswer} from ${JSON.stringify(moduleURL)}; const [directory,answer]=process.argv.slice(1); const cache=new InteractionAnswerDrafts(directory,'synthetic'); cache.save(unconfirmedAnswer('storage',${JSON.stringify(item)},answer));`;
    const answers = ['process a\n'.repeat(1000), 'process b\n'.repeat(1000)];
    // Long input belongs in the environment of the child, not its OS command line.
    const child = source.replace('const [directory,answer]=process.argv.slice(1);', 'const directory=process.argv[1],answer=process.env.SYNTHETIC_ANSWER;');
    await Promise.all(answers.map(answer => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child, directory], { env: { ...process.env, SYNTHETIC_ANSWER: answer }, maxBuffer: 1024 * 1024 })));
    const cache = new InteractionAnswerDrafts(directory, 'synthetic'), rows = cache.list('storage');
    assert.deepEqual(new Set(rows.map(row => row.answer)), new Set(answers));
    cache.choose('storage', item.id, rows[1]!.localId!, rows.map(row => row.localId!));
    assert.equal(new InteractionAnswerDrafts(directory, 'synthetic').selected('storage', item.id), rows[1]!.localId);
    const stale = structuredClone(rows[0]!); cache.remove('storage', item.id, [stale.localId!]);
    assert.throws(() => cache.save(stale), /answer_draft_version_changed/);
    assert.deepEqual(cache.list('storage').map(row => row.answer), [rows[1]!.answer]);
  } finally { await removeTemp(directory); }
});

test('legacy answer files migrate once without changing original bytes or resurrecting an acknowledged answer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-migration-'));
  try {
    const endpoint = digest('synthetic'), scope = `interaction-answer-${digest([endpoint, 'storage'])}-`;
    const original = unconfirmedAnswer('storage', item, 'original legacy answer\n  '), bytes = JSON.stringify(original, null, 2);
    const file = path.join(directory, scope + digest(item.id) + '.json'); fs.writeFileSync(file, bytes, { mode: 0o600 });
    const cache = new InteractionAnswerDrafts(directory, 'synthetic'), imported = cache.list('storage');
    assert.equal(imported.length, 1); assert.equal(imported[0]!.answer, original.answer); assert.ok(imported[0]!.localId);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    cache.remove('storage', item.id, [imported[0]!.localId!]);
    assert.deepEqual(new InteractionAnswerDrafts(directory, 'synthetic').list('storage'), []);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  } finally { await removeTemp(directory); }
});

test('authenticated cache migration accepts only the explicitly known previous URL and exact storage for both historical filenames', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-url-migration-'));
  try {
    const url = 'http://127.0.0.1:18901', oldEndpoint = digest(url), files: Array<{ file: string; text: string }> = [];
    for (const [index, prefix] of [`interaction-answer-${digest([oldEndpoint, 'storage'])}-`, `interaction-answer-${oldEndpoint}-${digest('storage')}-`].entries()) {
      const row = unconfirmedAnswer('storage', { ...item, id: item.id + index }, `original before scoped identity ${index}`);
      const file = path.join(directory, prefix + digest(row.interactionId) + '.json'), text = JSON.stringify(row, null, 2); fs.writeFileSync(file, text, { mode: 0o600 }); files.push({ file, text });
    }
    assert.deepEqual(new InteractionAnswerDrafts(directory, 'authenticated identity').list('storage'), []);
    assert.deepEqual(new InteractionAnswerDrafts(directory, 'other identity', ['http://127.0.0.1:18902']).list('storage'), []);
    const migrated = new InteractionAnswerDrafts(directory, 'authenticated identity', [url]);
    assert.deepEqual(migrated.list('other-storage'), []);
    assert.equal(migrated.list('storage').length, 2);
    for (const { file, text } of files) assert.equal(fs.readFileSync(file, 'utf8'), text);
    for (const row of migrated.list('storage')) migrated.remove('storage', row.interactionId, [row.localId!]);
    assert.deepEqual(new InteractionAnswerDrafts(directory, 'authenticated identity', [url]).list('storage'), []);
    for (const { file, text } of files) assert.equal(fs.readFileSync(file, 'utf8'), text);
  } finally { await removeTemp(directory); }
});
