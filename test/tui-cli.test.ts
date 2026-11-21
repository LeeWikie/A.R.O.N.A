import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('CLI connects to a real core in ConPTY and both processes exit naturally', { skip: process.platform !== 'win32' || process.env.SHITTIMCHEST_CONPTY_TEST !== '1', timeout: 25_000 }, async () => {
  const bootstrap = `data:text/javascript,${encodeURIComponent('process.stderr.write("CLI_PTY_STAGE bootstrap\\n")')}`;
  const driver = spawn(process.execPath, ['--expose-gc', '--import', bootstrap, '--import', 'tsx', fileURLToPath(new URL('./tui-cli-driver.ts', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  driver.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; }); driver.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const result = await new Promise<{ code: number | null; timedOut: boolean }>(resolve => {
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; driver.kill(); }, 20_000);
    driver.on('exit', code => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
  assert.equal(result.timedOut, false, output); assert.equal(result.code, 0, output); assert.match(output, /CLI_PTY_PASSED/);
});
