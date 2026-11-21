import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import yauzl from 'yauzl';
import { RG_ASSETS, rgAsset } from '../src/tools/rg-assets.ts';
import { verifiedFile } from '../src/tools/fd.ts';

const MAX_ARCHIVE = 64 * 1024 * 1024;
const destinationNames = { rg: 'rg', 'rg.exe': 'rg.exe', 'LICENSE-MIT': 'LICENSE-MIT.rg', 'UNLICENSE': 'UNLICENSE.rg' };
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function cached(destination) {
  return Object.entries(selectedAsset.entries).every(([name, entry]) => verifiedFile(path.join(destination, destinationNames[name]), entry.sha256, entry.maxBytes));
}
function meter(maxBytes, expected) {
  const hash = createHash('sha256'); let count = 0;
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    count += chunk.length;
    if (count > maxBytes) { callback(new Error('rg_asset_too_large')); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  return { stream, verify() { if (hash.digest('hex') !== expected) throw new Error('rg_asset_digest_mismatch'); } };
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE) throw new Error('invalid_rg_archive');
    input = fs.createReadStream(archivePath);
  } else {
    const response = await fetch(selectedAsset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'follow' });
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') { await response.body?.cancel().catch(() => {}); throw new Error('rg_download_failed'); }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_ARCHIVE) { await response.body.cancel(); throw new Error('rg_asset_too_large'); }
    input = Readable.fromWeb(response.body);
  }
  const counted = meter(MAX_ARCHIVE, selectedAsset.archiveSha256);
  await pipeline(input, counted.stream, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  counted.verify();
}
function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error('invalid_rg_archive')) : resolve(zip)));
}
function entryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('invalid_rg_archive')) : resolve(stream)));
}
async function extractExpected(archive, destination, signal) {
  const zip = await openZip(archive);
  const entries = Object.entries(selectedAsset.entries);
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
          if (seen.has(config.name) || (entry.generalPurposeBitFlag & 1) || entry.uncompressedSize > config.maxBytes) throw new Error('invalid_rg_archive_entry');
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
  if (seen.size !== entries.length) throw new Error('rg_archive_entries_missing');
}
async function extractTar(archive, destination, signal) {
  signal.throwIfAborted();
  const bytes = gunzipSync(fs.readFileSync(archive), { maxOutputLength: 128 * 1024 * 1024 });
  const expected = new Map(Object.entries(selectedAsset.entries).map(([name, entry]) => [entry.archivePath, { name, ...entry }]));
  const seen = new Set();
  const field = value => value.toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= bytes.length;) {
    signal.throwIfAborted();
    const header = bytes.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const sizeText = field(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('invalid_rg_archive_entry');
    const size = Number.parseInt(sizeText, 8); const end = offset + 512 + size;
    if (!Number.isSafeInteger(size) || end > bytes.length) throw new Error('invalid_rg_archive_entry');
    const checksum = Number.parseInt(field(header.subarray(148, 156)).trim(), 8);
    const actual = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error('invalid_rg_archive_entry');
    const prefix = field(header.subarray(345, 500)); const name = field(header.subarray(0, 100));
    const config = expected.get(prefix ? `${prefix}/${name}` : name);
    if (config) {
      if (seen.has(config.name) || ![0, 48].includes(header[156]) || size > config.maxBytes) throw new Error('invalid_rg_archive_entry');
      seen.add(config.name); const content = bytes.subarray(offset + 512, end);
      if (createHash('sha256').update(content).digest('hex') !== config.sha256) throw new Error('rg_asset_digest_mismatch');
      await fs.promises.writeFile(path.join(destination, destinationNames[config.name]), content, { flag: 'wx', mode: 0o600, signal });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (seen.size !== expected.size) throw new Error('rg_archive_entries_missing');
}
async function prepare({ destination, archivePath, signal }) {
  fs.mkdirSync(destination, { recursive: true });
  const stat = fs.lstatSync(destination); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_rg_destination');
  const release = await acquire(destination, signal); let temporary;
  try {
    if (cached(destination)) { if (selectedAsset.binaryName === 'rg') fs.chmodSync(path.join(destination, 'rg'), 0o755); return 'cached'; }
    temporary = fs.mkdtempSync(path.join(destination, '.rg-prepare-'));
    const archive = path.join(temporary, `archive.${selectedAsset.format}`);
    await archiveToFile(archive, archivePath, signal);
    if (selectedAsset.format === 'zip') await extractExpected(archive, temporary, signal);
    else await extractTar(archive, temporary, signal);
    if (selectedAsset.binaryName === 'rg') fs.chmodSync(path.join(temporary, 'rg'), 0o755);
    // Install licenses first. Runtime requires both valid licenses and the binary.
    for (const name of ['LICENSE-MIT', 'UNLICENSE', selectedAsset.binaryName]) {
      signal.throwIfAborted();
      const entry = selectedAsset.entries[name]; const target = path.join(destination, destinationNames[name]);
      if (verifiedFile(target, entry.sha256, entry.maxBytes)) { if (name === 'rg') fs.chmodSync(target, 0o755); continue; }
      fs.rmSync(target, { force: true }); fs.renameSync(path.join(temporary, destinationNames[name]), target);
    }
    if (!cached(destination)) throw new Error('rg_install_verification_failed');
    return 'installed';
  } finally {
    try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    finally { await release(); }
  }
}

const args = process.argv.slice(2); let archivePath; let destination = path.join(root, 'dist', 'tools'); let platform = process.platform; let arch = process.arch; let explicitDestination = false; let explicitTarget = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--archive' && args[index + 1]) archivePath = path.resolve(args[++index]);
  else if (args[index] === '--destination' && args[index + 1]) { destination = path.resolve(args[++index]); explicitDestination = true; }
  else if (args[index] === '--platform' && args[index + 1]) { platform = args[++index]; explicitTarget = true; }
  else if (args[index] === '--arch' && args[index + 1]) { arch = args[++index]; explicitTarget = true; }
  else throw new Error('invalid_rg_prepare_argument');
}
let selectedAsset = rgAsset(platform, arch);
if ((explicitTarget || explicitDestination || archivePath) && !selectedAsset) throw new Error(`unsupported_rg_platform: ${platform}-${arch}`);
const controller = new AbortController(); const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
try {
  const targets = explicitTarget || explicitDestination || archivePath ? [[`${platform}-${arch}`, selectedAsset]] : Object.entries(RG_ASSETS);
  for (const [target, config] of targets) {
    selectedAsset = config;
    const targetDirectory = explicitDestination ? destination : path.join(destination, 'bin', target);
    console.log(`rg ${target} ${await prepare({ destination: targetDirectory, archivePath, signal: controller.signal })}`);
  }
  if (!explicitDestination && !explicitTarget && !archivePath) {
    for (const name of ['rg', 'rg.exe', 'LICENSE-MIT.rg', 'UNLICENSE.rg']) {
      const legacy = path.join(destination, name);
      if (name === 'rg' && fs.existsSync(legacy) && fs.lstatSync(legacy).isDirectory()) continue;
      fs.rmSync(legacy, { force: true });
    }
  }
} finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
