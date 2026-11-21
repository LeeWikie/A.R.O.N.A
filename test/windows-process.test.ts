import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { editorSpawn } from '../src/tui/upstream/windows-spawn.js';
import { shellCommand } from '../src/tui/shell.js';

test('Windows command invocation preserves command text and safely selects editor shims', () => {
  const text = '"C:\\Program Files\\tool.exe" "hello world" && echo done';
  assert.deepEqual(shellCommand(text, { ComSpec: 'cmd.exe' }, 'win32').args, ['/d', '/s', '/c', `"${text}"`]);
  const native = editorSpawn('editor.exe', ['a&b', 'space value'], {}, 'win32');
  assert.deepEqual(native, { command: 'editor.exe', args: ['a&b', 'space value'], windowsVerbatimArguments: false });
  const shim = editorSpawn('C:\\Program Files\\Editor\\code.cmd', ['--wait', 'a&b', '%PATH%'], { ComSpec: 'cmd.exe' }, 'win32');
  assert.equal(shim.command, 'cmd.exe'); assert.equal(shim.windowsVerbatimArguments, true);
  assert.match(shim.args[3]!, /a\^&b/); assert.match(shim.args[3]!, /\^%PATH\^%/);
  assert.deepEqual(editorSpawn('editor', ['space value'], {}, 'darwin'), { command: 'editor', args: ['space value'], windowsVerbatimArguments: false });
});

test('Windows editor shims receive arguments literally, including spaces and shell metacharacters', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-cmd 中文 空格-'));
  try {
    const wrapper = path.join(directory, 'editor.cmd'); const capture = path.join(directory, 'capture.mjs');
    fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    // Keep batch source ASCII; Unicode paths travel through the environment and %~dp0.
    fs.writeFileSync(wrapper, '@"%SC_EDITOR_NODE%" "%~dp0capture.mjs" %*\r\n');
    const args = ['space value', 'a&b', '%PATH%', 'a"b', 'tail\\']; const invocation = editorSpawn(wrapper, args);
    const child = spawn(invocation.command, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SC_EDITOR_NODE: process.execPath }, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    let output = ''; let errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, errors); assert.deepEqual(JSON.parse(output), args);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
