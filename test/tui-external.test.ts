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

test('Ctrl+G opens $VISUAL directly without prompts, as Pi does', async () => {
  const { TerminalApp } = await import('../src/tui/index.js');
  const writer = fileURLToPath(new URL('./tui-external-writer.mjs', import.meta.url));
  const before = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
  process.env.VISUAL = `${process.execPath} ${writer}`; delete process.env.EDITOR;
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const app = new TerminalApp({} as never, 'main', terminal as never);
  const target = app as unknown as { prompt: () => Promise<string | undefined>; externalEditor: () => Promise<void>; editor: { getText(): string; setText(text: string): void } };
  let prompted = false; target.prompt = async () => { prompted = true; return undefined; };
  try {
    target.editor.setText('unsent original');
    await target.externalEditor();
    assert.equal(prompted, false);
    assert.match(target.editor.getText(), /edited line/);
  } finally {
    await app.stop();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('editor commands split like Pi but keep quoted paths', async () => {
  const { splitCommand } = await import('../src/tui/index.js');
  assert.deepEqual(splitCommand('code --wait'), ['code', '--wait']);
  assert.deepEqual(splitCommand('"C:\\Program Files\\Editor\\edit.exe" -w'), ['C:\\Program Files\\Editor\\edit.exe', '-w']);
});
