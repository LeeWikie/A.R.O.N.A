import * as pty from '@lydell/node-pty';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const child = pty.spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(new URL('./tui-abort-child.ts', import.meta.url))], { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' } });
let output = ''; const timeout = setTimeout(() => { child.kill(); console.error('ABORT_TIMEOUT'); process.exitCode = 1; }, 10_000);
child.onData(data => { output += data; });
child.onExit(({ exitCode }) => {
  clearTimeout(timeout); child.kill();
  if (exitCode !== 0 || !output.includes('ShittimChest') || !output.includes('\x1b[?1049h') || !output.includes('\x1b[?1049l')) { console.error(`ABORT_FAILURE exit=${exitCode} output=${JSON.stringify(output.slice(-2000))}`); process.exitCode = 1; }
  else console.log('ABORT_TERMINAL_RESTORED');
});
