// Adapted from Pi coding-agent external-editor.ts, commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in LICENSE.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorSpawn } from './windows-spawn.js';

export async function editExternally(options: { command: string; args: string[]; content: string; signal: AbortSignal }): Promise<{ status: 'complete'; content: string } | { status: 'failed'; message: string }> {
  options.signal.throwIfAborted();
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shittim-editor-'));
  const file = path.join(directory, 'prompt.txt');
  try {
    await fs.promises.writeFile(file, options.content, { encoding: 'utf8', mode: 0o600, flag: 'wx', signal: options.signal });
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; failed: boolean }>(resolve => {
      let failed = false;
      const invocation = editorSpawn(options.command, [...options.args, file]);
      const child = spawn(invocation.command, invocation.args, { stdio: 'inherit', shell: false, ...(process.platform === 'win32' ? {} : { signal: options.signal }), windowsHide: false, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
      const abort = () => {
        if (!child.pid) return;
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); });
      };
      if (process.platform === 'win32') {
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      }
      child.once('error', () => { failed = true; });
      child.once('close', (code, signal) => { options.signal.removeEventListener('abort', abort); resolve({ code, signal, failed }); });
    });
    options.signal.throwIfAborted();
    if (outcome.failed || outcome.code !== 0) return { status: 'failed', message: '外部编辑器未成功退出，原输入未改变。' };
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); const visible = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1 || visible.isSymbolicLink() || stat.ino !== visible.ino || stat.dev !== visible.dev || stat.size > 1024 * 1024) return { status: 'failed', message: '外部编辑器结果不可读取或过大。' };
      const bytes = await handle.readFile({ signal: options.signal }); const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return { status: 'failed', message: '外部编辑器结果读取时发生变化。' };
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { status: 'failed', message: '外部编辑器结果不是有效 UTF-8。' }; }
      return { status: 'complete', content: content.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n$/, '') };
    } finally { await handle.close(); }
  } finally { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
