import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { editExternally } from '../src/tui/upstream/external-editor.js';
const writer = fileURLToPath(new URL('./tui-external-writer.mjs', import.meta.url));

test('external editor reads a private temporary input and removes it on success', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-editor-test-')); const marker = path.join(directory, 'marker');
  const old = process.env.SHITTIMCHEST_EDITOR_TEST_MARKER; process.env.SHITTIMCHEST_EDITOR_TEST_MARKER = marker;
  try {
    const result = await editExternally({ command: process.execPath, args: [writer], content: 'unsent original', signal: new AbortController().signal });
    assert.deepEqual(result, { status: 'complete', content: 'first edited line\nsecond edited line' });
    const temporary = fs.readFileSync(marker, 'utf8'); assert.equal(fs.existsSync(temporary), false);
  } finally { if (old === undefined) delete process.env.SHITTIMCHEST_EDITOR_TEST_MARKER; else process.env.SHITTIMCHEST_EDITOR_TEST_MARKER = old; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('external editor termination does not return a modified draft', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 200);
  try { await assert.rejects(editExternally({ command: process.execPath, args: [writer, '--hold'], content: 'original', signal: controller.signal })); }
  finally { clearTimeout(timer); }
});
