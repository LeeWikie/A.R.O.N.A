// System fd discovery is adapted from Pi coding-agent utils/tools-manager.ts,
// commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in ../tui/upstream/LICENSE.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const FD_ASSET = {
  version: '10.5.0',
  url: 'https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-pc-windows-msvc.zip',
  archiveSha256: 'a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7',
  binarySha256: 'd67d27a8e375ed7e9bca2b506a9dd5082bc24547aeba908b863f6f8b8ab0c3b9',
  entries: {
    'fd.exe': { archivePath: 'fd-v10.5.0-x86_64-pc-windows-msvc/fd.exe', sha256: 'd67d27a8e375ed7e9bca2b506a9dd5082bc24547aeba908b863f6f8b8ab0c3b9', maxBytes: 16 * 1024 * 1024 },
    'LICENSE-MIT': { archivePath: 'fd-v10.5.0-x86_64-pc-windows-msvc/LICENSE-MIT', sha256: '7255d831d8873121ca5bcf278d8d5485d1221612b02742529703432e8134e87b', maxBytes: 64 * 1024 },
    'LICENSE-APACHE': { archivePath: 'fd-v10.5.0-x86_64-pc-windows-msvc/LICENSE-APACHE', sha256: '5406ff8da3fb52d20c70938295dc6d8178de6fc4ff1ae163bd4990eacc2c1451', maxBytes: 64 * 1024 },
  },
} as const;

/** Check a packaged binary or license against the project's pinned digest. */
export function verifiedFile(file: string, expectedSha256: string, maxBytes: number): boolean {
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) return false;
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    return after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && before.size === after.size && before.mtimeMs === after.mtimeMs && createHash('sha256').update(bytes).digest('hex') === expectedSha256;
  } catch { return false; }
}

/** Prefer the packaged, digest-checked fd on the supported host; otherwise use PATH. */
export function findFd(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; bundledPath?: string } = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform === 'win32' && arch === 'x64') {
    const candidates = options.bundledPath ? [options.bundledPath] : [fileURLToPath(new URL('./fd.exe', import.meta.url)), fileURLToPath(new URL('../../dist/tools/fd.exe', import.meta.url))];
    for (const candidate of candidates) {
      const directory = path.dirname(candidate);
      if (verifiedFile(candidate, FD_ASSET.binarySha256, FD_ASSET.entries['fd.exe'].maxBytes) &&
        verifiedFile(path.join(directory, 'LICENSE-MIT.fd'), FD_ASSET.entries['LICENSE-MIT'].sha256, FD_ASSET.entries['LICENSE-MIT'].maxBytes) &&
        verifiedFile(path.join(directory, 'LICENSE-APACHE.fd'), FD_ASSET.entries['LICENSE-APACHE'].sha256, FD_ASSET.entries['LICENSE-APACHE'].maxBytes)) return candidate;
    }
  }
  return findInstalledFd(options.env, platform);
}

/** Find an already-installed fd without downloading or running it. */
export function findInstalledFd(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const names = platform === 'win32' ? ['fd.exe', 'fdfind.exe'] : ['fd', 'fdfind'];
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const name of names) for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    // Empty and relative PATH components implicitly execute from the current directory.
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}
