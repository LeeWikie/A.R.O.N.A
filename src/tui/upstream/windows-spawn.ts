// Command escaping adapted from cross-spawn lib/util/escape.js, MIT license.
// Copyright (c) 2018 Made With MOXY Lda. See LICENSE.cross-spawn.
import fs from 'node:fs';
import path from 'node:path';

const metaChars = /([()\][%!^"`<>&|;, *?])/g;
function escapeArgument(value: string, doubleEscape: boolean) {
  let argument = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  argument = `"${argument}"`.replace(metaChars, '^$1');
  return doubleEscape ? argument.replace(metaChars, '^$1') : argument;
}
const envValue = (env: NodeJS.ProcessEnv, key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];

/** Resolve editor shims through PATHEXT, then protect every argument from cmd expansion. */
export function editorSpawn(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') return { command, args, windowsVerbatimArguments: false };
  let resolved = command;
  if (!path.win32.extname(command)) {
    const directories = /[\\/]/.test(command) ? [''] : (envValue(env, 'PATH') ?? '').split(';').filter(directory => path.win32.isAbsolute(directory));
    const extensions = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';');
    outer: for (const directory of directories) for (const extension of ['', ...extensions]) {
      const candidate = directory ? path.win32.join(directory, `${command}${extension}`) : `${command}${extension}`;
      try { if (fs.statSync(candidate).isFile()) { resolved = candidate; break outer; } } catch { /* Next candidate. */ }
    }
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, windowsVerbatimArguments: false };
  const doubleEscape = /node_modules[\\/].bin[\\/]/i.test(resolved);
  const line = [resolved.replace(metaChars, '^$1'), ...args.map(argument => escapeArgument(argument, doubleEscape))].join(' ');
  return { command: envValue(env, 'ComSpec') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}
