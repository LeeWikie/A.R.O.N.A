// System fd discovery is adapted from Pi coding-agent utils/tools-manager.ts,
// commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in ../tui/upstream/LICENSE.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface FdAsset {
  version: string; url: string; format: 'zip' | 'tar.gz'; binaryName: 'fd' | 'fd.exe'; archiveSha256: string; binarySha256: string;
  entries: Record<string, { archivePath: string; sha256: string; maxBytes: number }>;
}
function asset(target: string, archiveSha256: string, binarySha256: string): FdAsset {
  const windows = target.includes('windows'); const binaryName = windows ? 'fd.exe' : 'fd'; const format = windows ? 'zip' : 'tar.gz';
  const base = `fd-v10.5.0-${target}`;
  return { version: '10.5.0', url: `https://github.com/sharkdp/fd/releases/download/v10.5.0/${base}.${format}`, format, binaryName, archiveSha256, binarySha256,
    entries: {
      [binaryName]: { archivePath: `${base}/${binaryName}`, sha256: binarySha256, maxBytes: 16 * 1024 * 1024 },
      'LICENSE-MIT': { archivePath: `${base}/LICENSE-MIT`, sha256: windows ? '7255d831d8873121ca5bcf278d8d5485d1221612b02742529703432e8134e87b' : '322cfc7aa0c774d0eca3b2610f1d414de3ddbd7d8dd4b9dea941a13a6eb07455', maxBytes: 64 * 1024 },
      'LICENSE-APACHE': { archivePath: `${base}/LICENSE-APACHE`, sha256: windows ? '5406ff8da3fb52d20c70938295dc6d8178de6fc4ff1ae163bd4990eacc2c1451' : '73c83c60d817e7df1943cb3f0af81e4939a8352c9a96c2fd00451b1116fa635c', maxBytes: 64 * 1024 },
    } };
}
export const FD_ASSETS: Readonly<Record<string, FdAsset>> = {
  'darwin-arm64': asset('aarch64-apple-darwin', 'b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12', 'cf3bde435da174f41cf9589a2efeaf03804df7c250fc15e8b8a1e9bfc66ebc9a'),
  'darwin-x64': asset('x86_64-apple-darwin', '7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590', '7ca13c0959482c381a4de9b85fe8bef4233ab7e5232761e958ed0df3583baa89'),
  'linux-arm64': asset('aarch64-unknown-linux-musl', 'd76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4', '90dab774d92889926d75a85b47c4b2dc4c9adfa792cd3a6ccfcb98b0eabc9b94'),
  'linux-x64': asset('x86_64-unknown-linux-musl', '761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7', 'e79642a479d2816c887047476bbe6ad229465f30de031033574dee2a095e0037'),
  'win32-arm64': asset('aarch64-pc-windows-msvc', 'a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6', 'a88cc8920168968eff917f387062ebd8cdb230d8717fb5058eae5e365c759b14'),
  'win32-x64': asset('x86_64-pc-windows-msvc', 'a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7', 'd67d27a8e375ed7e9bca2b506a9dd5082bc24547aeba908b863f6f8b8ab0c3b9'),
};
export const FD_ASSET = FD_ASSETS['win32-x64']! as FdAsset & { entries: Record<'fd.exe' | 'LICENSE-MIT' | 'LICENSE-APACHE', FdAsset['entries'][string]> };
export function fdAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): FdAsset | undefined { return FD_ASSETS[`${platform}-${arch}`]; }

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
  const selected = fdAsset(platform, arch);
  if (selected) {
    const candidates = options.bundledPath ? [options.bundledPath] : [fileURLToPath(new URL(`./bin/${platform}-${arch}/${selected.binaryName}`, import.meta.url)), fileURLToPath(new URL(`../../dist/tools/bin/${platform}-${arch}/${selected.binaryName}`, import.meta.url)), fileURLToPath(new URL(`./${selected.binaryName}`, import.meta.url)), fileURLToPath(new URL(`../../dist/tools/${selected.binaryName}`, import.meta.url))];
    for (const candidate of candidates) {
      const directory = path.dirname(candidate);
      if (verifiedFile(candidate, selected.binarySha256, selected.entries[selected.binaryName]!.maxBytes) &&
        verifiedFile(path.join(directory, 'LICENSE-MIT.fd'), selected.entries['LICENSE-MIT']!.sha256, selected.entries['LICENSE-MIT']!.maxBytes) &&
        verifiedFile(path.join(directory, 'LICENSE-APACHE.fd'), selected.entries['LICENSE-APACHE']!.sha256, selected.entries['LICENSE-APACHE']!.maxBytes)) {
        try { fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return candidate; } catch { /* Try the next candidate. */ }
      }
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
