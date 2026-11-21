import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { fdAsset, findFd, verifiedFile } from '../src/tools/fd.js';

const FD_ASSET = fdAsset()!;
const binaryName = FD_ASSET.binaryName;
const script = fileURLToPath(new URL('../scripts/prepare-fd.mjs', import.meta.url));
function prepare(archive: string, destination: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--archive', archive, '--destination', destination], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
  });
}

test('digest verification rejects tampering and links', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-hash-'));
  try {
    const file = path.join(directory, 'fixture'); fs.writeFileSync(file, 'fixture');
    const digest = createHash('sha256').update('fixture').digest('hex');
    assert.equal(verifiedFile(file, digest, 100), true);
    assert.equal(verifiedFile(file, '0'.repeat(64), 100), false);
    assert.equal(verifiedFile(file, digest, 1), false);
    const link = path.join(directory, 'link'); fs.linkSync(file, link); assert.equal(verifiedFile(file, digest, 100), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unverified archives never install a binary', { timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-invalid-'));
  try {
    const archive = path.join(directory, 'invalid.zip'), destination = path.join(directory, 'out'); fs.writeFileSync(archive, 'invalid archive');
    const result = await prepare(archive, destination); assert.notEqual(result.code, 0); assert.match(result.output, /fd_asset_digest_mismatch/);
    assert.equal(fs.existsSync(path.join(destination, binaryName)), false);
    assert.deepEqual(fs.readdirSync(destination), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('interruption while waiting on the build lock leaves no binary or temporary files', { timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-interrupt-'));
  const archive = path.join(directory, 'fixture.zip'); fs.writeFileSync(archive, 'fixture');
  const destination = path.join(directory, 'out'); fs.mkdirSync(destination);
  const release = await lockfile.lock(destination, { stale: 30_000 });
  try {
    const child = spawn(process.execPath, [script, '--archive', archive, '--destination', destination], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 400));
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve)); child.kill(); await exited;
    assert.deepEqual(fs.readdirSync(destination), []);
  } finally { await release(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('interrupted slow download removes temporary data and releases the lock', { skip: !process.env.SHITTIMCHEST_TEST_FD_ARCHIVE, timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-abort-'));
  const code = `
    import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
    const bytes = fs.readFileSync(process.env.TEST_ARCHIVE); let offset = 0; let timer;
    globalThis.fetch = async () => {
      const stream = new ReadableStream({ start(controller) { timer = setInterval(() => { if (offset >= bytes.length) { clearInterval(timer); controller.close(); return; } controller.enqueue(bytes.subarray(offset, offset += 8192)); }, 50); }, cancel() { clearInterval(timer); } });
      const response = new Response(stream, { status: 200 }); Object.defineProperty(response, 'url', { value: 'https://github.com/fixture' }); return response;
    };
    process.argv = [process.execPath, process.env.TEST_SCRIPT, '--destination', process.env.TEST_DESTINATION];
    setTimeout(() => process.emit('SIGTERM'), 350); await import(pathToFileURL(process.env.TEST_SCRIPT).href);
  `;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TEST_ARCHIVE: process.env.SHITTIMCHEST_TEST_FD_ARCHIVE!, TEST_SCRIPT: script, TEST_DESTINATION: directory, TEST_BINARY: binaryName }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8').on('data', data => { output += data; }); child.stderr.setEncoding('utf8').on('data', data => { output += data; });
    const codeResult = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.notEqual(codeResult, 0, output); assert.deepEqual(fs.readdirSync(directory), [], output);
    const release = await lockfile.lock(directory, { retries: 0 }); await release();
  } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('interruption while extracting the verified binary leaves no partial install', { skip: !process.env.SHITTIMCHEST_TEST_FD_ARCHIVE, timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-extract-abort-'));
  const code = `
    import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
    const original = fs.createWriteStream; let interrupted = false;
    fs.createWriteStream = function(file, ...args) {
      const stream = original.call(this, file, ...args);
      if (String(file).endsWith(process.env.TEST_BINARY)) {
        const write = stream._write.bind(stream);
        stream._write = (chunk, encoding, callback) => { write(chunk, encoding, error => { callback(error); if (!interrupted) { interrupted = true; setImmediate(() => process.emit('SIGTERM')); } }); };
      }
      return stream;
    };
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    fs.promises.writeFile = async function(file, ...args) {
      const result = await writeFile(file, ...args);
      if (String(file).endsWith(process.env.TEST_BINARY) && !interrupted) { interrupted = true; process.emit('SIGTERM'); }
      return result;
    };
    process.argv = [process.execPath, process.env.TEST_SCRIPT, '--archive', process.env.TEST_ARCHIVE, '--destination', process.env.TEST_DESTINATION];
    await import(pathToFileURL(process.env.TEST_SCRIPT).href);
  `;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TEST_ARCHIVE: process.env.SHITTIMCHEST_TEST_FD_ARCHIVE!, TEST_SCRIPT: script, TEST_DESTINATION: directory, TEST_BINARY: binaryName }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8').on('data', data => { output += data; }); child.stderr.setEncoding('utf8').on('data', data => { output += data; });
    const codeResult = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.notEqual(codeResult, 0, output); assert.deepEqual(fs.readdirSync(directory), [], output);
    const release = await lockfile.lock(directory, { retries: 0 }); await release();
  } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('pinned archive builds safely, serializes concurrent preparation, and repairs a corrupted cache', { skip: !process.env.SHITTIMCHEST_TEST_FD_ARCHIVE, timeout: 40_000 }, async () => {
  const archive = process.env.SHITTIMCHEST_TEST_FD_ARCHIVE!;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-build-'));
  try {
    const results = await Promise.all([prepare(archive, directory), prepare(archive, directory)]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    assert.ok(results.some(result => result.output.includes('installed'))); assert.ok(results.some(result => result.output.includes('cached')));
    const binary = path.join(directory, binaryName);
    assert.equal(findFd({ bundledPath: binary, env: { PATH: '' } }), binary);
    fs.writeFileSync(binary, 'tampered'); assert.equal(findFd({ bundledPath: binary, env: { PATH: '' } }), undefined);
    const repaired = await prepare(archive, directory); assert.equal(repaired.code, 0, repaired.output);
    assert.equal(verifiedFile(binary, FD_ASSET.binarySha256, FD_ASSET.entries[binaryName]!.maxBytes), true);
    fs.rmSync(path.join(directory, 'LICENSE-MIT.fd'));
    assert.equal(findFd({ bundledPath: binary, env: { PATH: '' } }), undefined);
    const repairedLicense = await prepare(archive, directory); assert.equal(repairedLicense.code, 0, repairedLicense.output);
    assert.equal(findFd({ bundledPath: binary, env: { PATH: '' } }), binary);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['LICENSE-APACHE.fd', 'LICENSE-MIT.fd', binaryName]);
  } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
