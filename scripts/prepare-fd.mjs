import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import yauzl from 'yauzl';
import { FD_ASSET, verifiedFile } from '../src/tools/fd.ts';

const MAX_ARCHIVE = 64 * 1024 * 1024;
const destinationNames = { 'fd.exe': 'fd.exe', 'LICENSE-MIT': 'LICENSE-MIT.fd', 'LICENSE-APACHE': 'LICENSE-APACHE.fd' };
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function cached(destination) {
  return Object.entries(FD_ASSET.entries).every(([name, entry]) => verifiedFile(path.join(destination, destinationNames[name]), entry.sha256, entry.maxBytes));
}
function meter(maxBytes, expected) {
  const hash = createHash('sha256'); let count = 0;
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    count += chunk.length;
    if (count > maxBytes) { callback(new Error('fd_asset_too_large')); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  return { stream, verify() { if (hash.digest('hex') !== expected) throw new Error('fd_asset_digest_mismatch'); } };
}
async function acquire(directory, signal) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    signal.throwIfAborted();
    try { return await lockfile.lock(directory, { stale: 30_000, update: 10_000, retries: 0 }); }
    catch (error) {
      if (error?.code !== 'ELOCKED' || Date.now() >= deadline) throw error;
      await delay(200, undefined, { signal });
    }
  }
}
async function archiveToFile(destination, archivePath, signal) {
  let input;
  if (archivePath) {
    const stat = fs.lstatSync(archivePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE) throw new Error('invalid_fd_archive');
    input = fs.createReadStream(archivePath);
  } else {
    const response = await fetch(FD_ASSET.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'follow' });
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') { await response.body?.cancel().catch(() => {}); throw new Error('fd_download_failed'); }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_ARCHIVE) { await response.body.cancel(); throw new Error('fd_asset_too_large'); }
    input = Readable.fromWeb(response.body);
  }
  const counted = meter(MAX_ARCHIVE, FD_ASSET.archiveSha256);
  await pipeline(input, counted.stream, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  counted.verify();
}
function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error('invalid_fd_archive')) : resolve(zip)));
}
function entryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('invalid_fd_archive')) : resolve(stream)));
}
async function extractExpected(archive, destination, signal) {
  const zip = await openZip(archive);
  const entries = Object.entries(FD_ASSET.entries);
  const byName = new Map(entries.map(([name, entry]) => [entry.archivePath, { name, ...entry }]));
  const seen = new Set();
  await new Promise((resolve, reject) => {
    let finished = false; let active = false;
    const fail = error => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); zip.close(); reject(error); };
    const abort = () => { if (!active) fail(signal.reason ?? new Error('aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    zip.once('error', fail);
    zip.once('end', () => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); resolve(); });
    zip.on('entry', entry => {
      active = true;
      void (async () => {
        signal.throwIfAborted();
        const config = byName.get(entry.fileName);
        if (config) {
          if (seen.has(config.name) || (entry.generalPurposeBitFlag & 1) || entry.uncompressedSize > config.maxBytes) throw new Error('invalid_fd_archive_entry');
          seen.add(config.name);
          const counted = meter(config.maxBytes, config.sha256);
          const input = await entryStream(zip, entry);
          await pipeline(input, counted.stream, fs.createWriteStream(path.join(destination, destinationNames[config.name]), { flags: 'wx', mode: 0o600 }), { signal });
          counted.verify();
        }
        signal.throwIfAborted(); active = false;
        if (!finished) zip.readEntry();
      })().catch(error => { active = false; fail(error); });
    });
    if (signal.aborted) abort(); else zip.readEntry();
  });
  if (seen.size !== entries.length) throw new Error('fd_archive_entries_missing');
}
async function prepare({ destination, archivePath, signal }) {
  fs.mkdirSync(destination, { recursive: true });
  const stat = fs.lstatSync(destination); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_fd_destination');
  const release = await acquire(destination, signal); let temporary;
  try {
    if (cached(destination)) return 'cached';
    temporary = fs.mkdtempSync(path.join(destination, '.fd-prepare-'));
    const archive = path.join(temporary, 'archive.zip');
    await archiveToFile(archive, archivePath, signal);
    await extractExpected(archive, temporary, signal);
    // Install licenses first. Runtime requires both valid licenses and the binary.
    for (const name of ['LICENSE-MIT', 'LICENSE-APACHE', 'fd.exe']) {
      signal.throwIfAborted();
      const entry = FD_ASSET.entries[name]; const target = path.join(destination, destinationNames[name]);
      if (verifiedFile(target, entry.sha256, entry.maxBytes)) continue;
      fs.rmSync(target, { force: true }); fs.renameSync(path.join(temporary, destinationNames[name]), target);
    }
    if (!cached(destination)) throw new Error('fd_install_verification_failed');
    return 'installed';
  } finally {
    try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    finally { await release(); }
  }
}

const args = process.argv.slice(2); let archivePath; let destination = path.join(root, 'dist', 'tools');
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--archive' && args[index + 1]) archivePath = path.resolve(args[++index]);
  else if (args[index] === '--destination' && args[index + 1]) destination = path.resolve(args[++index]);
  else throw new Error('invalid_fd_prepare_argument');
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('Bundled fd is not available for this platform; an installed fd may be used.');
} else {
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try { console.log(`fd ${await prepare({ destination, archivePath, signal: controller.signal })}`); }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
