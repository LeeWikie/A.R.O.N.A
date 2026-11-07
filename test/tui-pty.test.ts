import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('ConPTY client and driver both exit naturally', { skip: process.platform !== 'win32' || process.env.SHITTIMCHEST_CONPTY_TEST !== '1', timeout: 20_000 }, async () => {
  const completionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-fd-'));
  fs.writeFileSync(path.join(completionDir, 'needle-item.txt'), 'fixture');
  fs.mkdirSync(path.join(completionDir, '.private')); fs.writeFileSync(path.join(completionDir, '.private', 'needle-private.txt'), 'fixture');
  fs.symlinkSync(path.join(completionDir, '.private'), path.join(completionDir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const driver = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./tui-pty-driver.ts', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHITTIMCHEST_COMPLETION_DIR: completionDir } });
  let output = '';
  driver.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  driver.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const result = await new Promise<{ code: number | null; timedOut: boolean }>(resolve => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; driver.kill(); }, 14_000);
    driver.on('exit', code => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
  fs.rmSync(completionDir, { recursive: true, force: true });
  assert.equal(result.timedOut, false, output);
  assert.equal(result.code, 0, output);
  assert.match(output, /PTY_CHILD_EXITED/);
});
