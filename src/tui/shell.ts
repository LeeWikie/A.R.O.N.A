// Local `!command` execution, following Pi coding-agent core/tools/bash.ts (local shell operations,
// process-tree kill on abort) and core/messages.ts bashExecutionToText, commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in upstream/LICENSE.
// Runs in this terminal's own account and directory, like typing in a shell; it is not sandboxed.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { initialTerminalTextState, terminalTextDelta } from '../public-text.js';

export const SHELL_MAX_BYTES = 50 * 1024;
export const SHELL_MAX_LINES = 2000;
export interface ShellResult { output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; captureFailed?: boolean }

/** Same shell selection idea as Pi: $SHELL (or bash/sh) with -c on POSIX, cmd.exe /d /s /c on Windows. */
export function shellCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return { shell: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`] };
  return { shell: env.SHELL || '/bin/sh', args: ['-c', command] };
}
/** Keep the tail, as Pi's truncateTail does for bash output. */
export function truncateTail(text: string, maxBytes = SHELL_MAX_BYTES, maxLines = SHELL_MAX_LINES) {
  let lines = text.split('\n'); let truncated = false;
  if (lines.length > maxLines) { lines = lines.slice(-maxLines); truncated = true; }
  let out = lines.join('\n');
  const bytes = Buffer.from(out);
  if (bytes.length > maxBytes) {
    let start = bytes.length - maxBytes;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    out = bytes.subarray(start).toString('utf8'); truncated = true;
  }
  return { content: out, truncated };
}

export function runShell(command: string, options: { cwd: string; signal: AbortSignal; onChunk: (text: string) => void; onRaw?: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void }): Promise<ShellResult> {
  return new Promise(resolve => {
    const { shell, args } = shellCommand(command);
    let output = ''; let cancelled = false; let settled = false; let clipped = false; let captureFailed = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(shell, args, { cwd: options.cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
    const kill = () => {
      cancelled = true;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('error', () => { child.kill(); });
        else {
          process.kill(-child.pid, 'SIGTERM');
          killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ } }, 1000);
          killTimer.unref();
        }
      }
      catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    };
    const onData = (text: string) => {
      output += text; if (output.length > SHELL_MAX_BYTES * 4) { output = output.slice(-SHELL_MAX_BYTES * 2); clipped = true; }
      options.onChunk(text);
    };
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      const decoder = new StringDecoder('utf8');
      let terminal = initialTerminalTextState();
      const display = (value: string, final = false) => { const projected = terminalTextDelta(value, terminal, final); terminal = projected.state; onData(projected.text); };
      stream?.on('data', (chunk: Buffer) => {
        if (!captureFailed) try { options.onRaw?.(name, chunk); } catch { captureFailed = true; kill(); }
        display(decoder.write(chunk));
      });
      stream?.once('end', () => display(decoder.end(), true));
    }
    if (options.signal.aborted) kill(); else options.signal.addEventListener('abort', kill, { once: true });
    const finish = (exitCode: number | undefined) => {
      if (settled) return; settled = true; if (killTimer) clearTimeout(killTimer); options.signal.removeEventListener('abort', kill);
      const tail = truncateTail(output.replace(/\n$/, ''));
      resolve({ output: tail.content, exitCode: cancelled ? undefined : exitCode, cancelled, truncated: clipped || tail.truncated, ...(captureFailed ? { captureFailed: true } : {}) });
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
