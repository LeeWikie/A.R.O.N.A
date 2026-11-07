import * as pty from '@lydell/node-pty';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url); const writer = fileURLToPath(new URL('./tui-external-writer.mjs', import.meta.url));
const child = pty.spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(new URL('./tui-external-child.ts', import.meta.url))], { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color', VISUAL: process.execPath, SHITTIMCHEST_EDITOR_EXPECT: 'unsent original' } });
let output = '', started = false, entered = false, sent = false;
const timeout = setTimeout(() => { child.kill(); console.error('EDITOR_TIMEOUT'); process.exitCode = 1; }, 12_000);
child.onData(data => {
  output += data;
  if (!started && output.includes('已连接')) {
    started = true; setTimeout(() => child.write('unsent original'), 100); setTimeout(() => child.write('\x07'), 300);
    setTimeout(() => child.write('\r'), 600); setTimeout(() => child.write('add\r'), 850); setTimeout(() => child.write(`${writer}\r`), 1100);
    setTimeout(() => child.write('\r'), 1350); setTimeout(() => child.write('yes\r'), 1600);
  }
  if (!entered && output.includes('first edited line')) { entered = true; setTimeout(() => child.write('\r'), 200); setTimeout(() => child.write('/quit\r'), 600); }
  if (entered && output.includes('second edited line')) sent = true;
});
child.onExit(({ exitCode }) => {
  clearTimeout(timeout); child.kill();
  if (exitCode !== 0 || !started || !entered || !sent) { console.error(`EDITOR_FAILURE exit=${exitCode} started=${started} entered=${entered} sent=${sent} output=${JSON.stringify(output.slice(-5000))}`); process.exitCode = 1; }
  else console.log('EDITOR_PTY_PASSED');
});
