import * as pty from '@lydell/node-pty';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const child = pty.spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(new URL('./tui-pty-child.ts', import.meta.url))], { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string> });
let output = ''; let sent = false; let secretSent = false; let quitting = false; let fdMatch = false; let continuing = false;
function continueTest() {
  if (continuing) return; continuing = true;
  child.write('\x1b');
  setTimeout(() => child.write('\x15'), 100);
  setTimeout(() => { child.resize(60, 20); child.write('\x1b[200~hello中文粘贴\n第二行\x1b[201~'); }, 450);
  setTimeout(() => child.write('\r'), 650);
  setTimeout(() => { child.resize(100, 30); child.write('/menu\r'); }, 900);
  setTimeout(() => child.write('credentials\r'), 1150);
  setTimeout(() => child.write('\r'), 1400);
  setTimeout(() => child.write('FIXTURE_KEY\r'), 1650);
}
const timeout = setTimeout(() => { child.kill(); console.error('PTY_TIMEOUT'); process.exitCode = 1; }, 10_000);
child.onData(data => {
  output += data;
  if (!sent && output.includes('ShittimChest')) {
    sent = true;
    if ((process.env.SHITTIMCHEST_TEST_FD || process.env.SHITTIMCHEST_TEST_BUNDLED_FD)) { setTimeout(() => child.write('@needle'), 100); setTimeout(() => child.write('\t'), 400); }
    else continueTest();
  }
  if (sent && !fdMatch && (process.env.SHITTIMCHEST_TEST_FD || process.env.SHITTIMCHEST_TEST_BUNDLED_FD) && output.includes('needle-item.txt')) { fdMatch = true; continueTest(); }
  if (!secretSent && output.includes('输入密钥')) { secretSent = true; setTimeout(() => child.write('conpty-fixture-secret\r'), 150); }
  if (!quitting && output.includes('凭据已保存')) { quitting = true; setTimeout(() => child.write('/quit\r'), 1000); }
});
child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  child.kill();
  if (!sent || !secretSent || !quitting || ((process.env.SHITTIMCHEST_TEST_FD || process.env.SHITTIMCHEST_TEST_BUNDLED_FD) && !fdMatch) || exitCode !== 0 || !output.includes('hello中文粘贴') || !output.includes('第二行') || output.includes('conpty-fixture-secret') || output.includes('needle-private.txt') || output.includes('alias/')) { console.error(`PTY_FAILURE sent=${sent} secretSent=${secretSent} quitting=${quitting} exit=${exitCode} output=${JSON.stringify(output.replaceAll('conpty-fixture-secret', '[redacted]').slice(-4000))}`); process.exitCode = 1; }
  else console.log('PTY_CHILD_EXITED');
});
