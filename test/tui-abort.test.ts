import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('external AbortSignal restores the terminal and both processes exit', { skip: process.platform === 'win32' && process.env.SHITTIMCHEST_CONPTY_TEST !== '1', timeout: 20_000 }, async () => {
  const driver = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./tui-abort-driver.ts', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; driver.stdout.setEncoding('utf8').on('data', data => { output += data; }); driver.stderr.setEncoding('utf8').on('data', data => { output += data; });
  const result = await new Promise<{ code: number | null; timedOut: boolean }>(resolve => {
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; driver.kill(); }, 14_000);
    driver.once('exit', code => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
  assert.equal(result.timedOut, false, output); assert.equal(result.code, 0, output); assert.match(output, /ABORT_TERMINAL_RESTORED/);
});
