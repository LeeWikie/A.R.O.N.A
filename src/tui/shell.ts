// Local `!command` execution, following Pi coding-agent core/tools/bash.ts (local shell operations,
// process-tree kill on abort) and core/messages.ts bashExecutionToText, commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in upstream/LICENSE.
// Runs in this terminal's own account and directory, like typing in a shell; it is not sandboxed.
import { spawn } from 'node:child_process';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

export const SHELL_MAX_BYTES = 50 * 1024;
export const SHELL_MAX_LINES = 2000;
export interface ShellResult { output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean }

/** Same shell selection idea as Pi: $SHELL (or bash/sh) with -c on POSIX, cmd.exe /d /s /c on Windows. */
export function shellCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return { shell: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { shell: env.SHELL || '/bin/sh', args: ['-c', command] };
}
/** Keep the tail, as Pi's truncateTail does for bash output. */
export function truncateTail(text: string, maxBytes = SHELL_MAX_BYTES, maxLines = SHELL_MAX_LINES) {
  let lines = text.split('\n'); let truncated = false;
  if (lines.length > maxLines) { lines = lines.slice(-maxLines); truncated = true; }
  let out = lines.join('\n');
  while (Buffer.byteLength(out) > maxBytes) { out = out.slice(Math.ceil(out.length / 10)); truncated = true; }
  return { content: out, truncated };
}

export function runShell(command: string, options: { cwd: string; signal: AbortSignal; onChunk: (text: string) => void }): Promise<ShellResult> {
  return new Promise(resolve => {
    const { shell, args } = shellCommand(command);
    let output = ''; let cancelled = false; let settled = false;
    const child = spawn(shell, args, { cwd: options.cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const kill = () => {
      cancelled = true;
      if (!child.pid) return;
      try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGTERM'); }
      catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    };
    const onData = (chunk: Buffer) => {
      // Binary or control output must not drive the terminal; keep text only.
      const text = stripTerminalSequences(chunk.toString('utf8')).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      output += text; if (output.length > SHELL_MAX_BYTES * 4) output = output.slice(-SHELL_MAX_BYTES * 2);
      options.onChunk(text);
    };
    child.stdout?.on('data', onData); child.stderr?.on('data', onData);
    if (options.signal.aborted) kill(); else options.signal.addEventListener('abort', kill, { once: true });
    const finish = (exitCode: number | undefined) => {
      if (settled) return; settled = true; options.signal.removeEventListener('abort', kill);
      const tail = truncateTail(output.replace(/\n$/, ''));
      resolve({ output: tail.content, exitCode: cancelled ? undefined : exitCode, cancelled, truncated: tail.truncated });
    };
    child.once('error', error => { output += `${error.message}\n`; finish(127); });
    child.once('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

/** Pi bashExecutionToText: what the model sees when a `!` result is shared. */
export function shellResultText(command: string, result: ShellResult) {
  let text = `Ran \`${command}\`\n`;
  text += result.output ? `\`\`\`\n${result.output}\n\`\`\`` : '(no output)';
  if (result.cancelled) text += '\n\n(command cancelled)';
  else if (result.exitCode !== undefined && result.exitCode !== 0) text += `\n\nCommand exited with code ${result.exitCode}`;
  if (result.truncated) text += '\n\n[Output truncated to the last lines]';
  return text;
}
