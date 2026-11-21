import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'shittimchest-packages'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let stage;
const rootPackages = new Map();
const copied = new Set();
const esbuildPackages = new Map();
const nativePackages = new Map();
let inputs;
const lockedPackages = parseYaml(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')).packages;
const patchedDependencies = parseYaml(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).patchedDependencies ?? {};
for (const specifier of Object.keys(patchedDependencies)) {
  const separator = specifier.lastIndexOf('@'), name = specifier.slice(0, separator), version = specifier.slice(separator + 1);
  if (manifest.dependencies?.[name] && (manifest.dependencies[name] !== version || !manifest.bundleDependencies?.includes(name))) throw new Error(`Patched runtime dependency must be bundled at its exact version: ${specifier}`);
}
const targets = ['darwin', 'linux', 'win32'].flatMap(platform => ['x64', 'arm64'].map(arch => ({platform, arch})));
const binary = path.dirname(process.execPath);
const npm = [process.env.npm_execpath, path.join(binary, 'node_modules/npm/bin/npm-cli.js'),
  path.resolve(binary, '../lib/node_modules/npm/bin/npm-cli.js')]
  .find(candidate => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate));
if (!npm) throw new Error('npm is required to create a portable package');
const npmRequire = createRequire(npm);
const tar = npmRequire('tar');
const cacache = npmRequire('cacache');
const packageInputs = new Map();
let npmCache;

function lockedIntegrity(name, version) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error(`Expected an exact dependency version: ${name}`);
  const entry = lockedPackages?.[`${name}@${version}`];
  const integrity = entry?.resolution?.integrity;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error(`Missing locked SHA512: ${name}@${version}`);
  const digest = integrity.slice('sha512-'.length);
  if (Buffer.from(digest, 'base64').length !== 64 || Buffer.from(digest, 'base64').toString('base64') !== digest) throw new Error(`Invalid locked SHA512: ${name}@${version}`);
  return {integrity, entry};
}

function verifyArchive(file, integrity) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid dependency archive');
  const actual = `sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
  if (actual !== integrity) throw new Error('Dependency archive does not match the lockfile');
}

function unpackArchive(file, destination) {
  const seen = new Set(); let size = 0; let entries = 0;
  tar.t({file, sync: true, strict: true, onentry(entry) {
    const name = entry.path.replace(/\/$/, ''); const segments = name.split('/');
    if (++entries > 256 || !['File', 'Directory'].includes(entry.type) || (entry.mode & 0o6000) !== 0 ||
      name.length > 4096 || name.includes('\\') || name.includes('\0') || segments[0] !== 'package' || segments.some(part => part === '..' || part === '.' || !part || part.includes(':')) ||
      seen.has(name) || entry.size < 0 || entry.size > 64 * 1024 * 1024 || (size += entry.size) > 96 * 1024 * 1024) throw new Error('Unsafe dependency archive entry');
    seen.add(name);
  }});
  fs.mkdirSync(destination, {recursive: true});
  tar.x({file, cwd: destination, sync: true, strip: 1, strict: true, preservePaths: false, noMtime: true});
}

async function lockedPackage(name, version) {
  const key = `${name}@${version}`;
  if (packageInputs.has(key)) return packageInputs.get(key);
  const {integrity} = lockedIntegrity(name, version);
  const directory = fs.mkdtempSync(path.join(inputs, 'package-'));
  const archive = path.join(directory, 'source.tgz');
  if (npmCache === undefined) {
    const value = execFileSync(process.execPath, [npm, 'config', 'get', 'cache'], {cwd: root, encoding: 'utf8'}).trim();
    if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Invalid npm cache location');
    npmCache = value;
  }
  let cached = false; let bytes = 0;
  try {
    await pipeline(cacache.get.stream.byDigest(path.join(npmCache, '_cacache'), integrity),
      new Transform({transform(chunk, _encoding, done) {
        bytes += chunk.byteLength;done(bytes > 64 * 1024 * 1024 ? new Error('Dependency archive exceeds the size limit') : null, chunk);
      }}), fs.createWriteStream(archive, {flags: 'wx'}));
    cached = true;
  } catch (error) {
    fs.rmSync(archive, {force: true});if (!['ENOENT', 'ENOTCACHED'].includes(error.code)) throw error;
  }
  if (!cached) {
    const base = name.split('/').at(-1);
    const url = `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
    const result = JSON.parse(execFileSync(process.execPath,
      [npm, 'pack', url, '--ignore-scripts', '--json', '--pack-destination', directory,
        '--cache', path.join(inputs, 'npm-cache'), '--prefer-offline', '--registry=https://registry.npmjs.org',
        '--replace-registry-host=never', '--fetch-retries=1', '--fetch-timeout=30000', '--update-notifier=false'],
      {cwd: directory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 90000}));
    if (result.length !== 1 || typeof result[0].filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(result[0].filename) || path.basename(result[0].filename) !== result[0].filename) throw new Error('Invalid packed dependency filename');
    fs.renameSync(path.join(directory, result[0].filename), archive);
  }
  verifyArchive(archive, integrity);
  const extracted = path.join(directory, 'extracted');unpackArchive(archive, extracted);
  const metadata = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
  if (metadata.name !== name || metadata.version !== version) throw new Error(`Unexpected locked package metadata: ${key}`);
  const value = {source: extracted, metadata};packageInputs.set(key, value);
  console.error(`Verified ${key} ${integrity} (${cached ? 'cache' : 'registry'})`);
  return value;
}

async function completeEsbuildPackages() {
  for (const [destination, version] of esbuildPackages) {
    const original = await lockedPackage('esbuild', version);
    const shim = fs.readFileSync(path.join(original.source, 'bin/esbuild'), 'utf8');
    if (!shim.startsWith('#!/usr/bin/env node')) throw new Error('esbuild package does not contain its portable CLI');
    // postinstall can replace the installed CLI with a host binary; retain only the locked upstream body.
    for (const name of fs.readdirSync(destination)) if (name !== 'node_modules') fs.rmSync(path.join(destination, name), {recursive: true, force: true});
    fs.cpSync(original.source, destination, {recursive: true});
    for (const {platform, arch} of targets) {
      const name = `@esbuild/${platform}-${arch}`;
      const expectedVersion = original.metadata.optionalDependencies?.[name];
      const {entry} = lockedIntegrity(name, expectedVersion);
      if (expectedVersion !== version || entry.os?.length !== 1 || entry.os[0] !== platform || entry.cpu?.length !== 1 || entry.cpu[0] !== arch) throw new Error(`Unexpected locked esbuild target: ${name}`);
      const target = await lockedPackage(name, expectedVersion);
      if (target.metadata.os?.length !== 1 || target.metadata.os[0] !== platform || target.metadata.cpu?.length !== 1 || target.metadata.cpu[0] !== arch) throw new Error(`Unexpected esbuild target metadata: ${name}`);
      const relative = platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
      const executable = path.join(target.source, relative);
      const expectedHash = original.metadata['esbuild.binaryHashes']?.[`${name}/${relative}`];
      if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== expectedHash) throw new Error(`esbuild binary does not match its locked package: ${name}`);
      const local = path.join(destination, 'node_modules', name);
      fs.rmSync(local, {recursive: true, force: true});fs.cpSync(target.source, local, {recursive: true});
    }
  }
}

async function completeNativePackages() {
  for (const [destination, metadata] of nativePackages) {
    for (const [name, version] of Object.entries(metadata.optionalDependencies ?? {})) {
      const {entry} = lockedIntegrity(name, version);
      if (!Array.isArray(entry.os) || !Array.isArray(entry.cpu) || !targets.some(target => entry.os.includes(target.platform) && entry.cpu.includes(target.arch))) continue;
      const target = await lockedPackage(name, version);
      if (JSON.stringify(target.metadata.os) !== JSON.stringify(entry.os) || JSON.stringify(target.metadata.cpu) !== JSON.stringify(entry.cpu)) throw new Error(`Unexpected native target metadata: ${name}`);
      const local = path.join(destination, 'node_modules', name);
      fs.rmSync(local, {recursive: true, force: true});
      fs.cpSync(target.source, local, {recursive: true});
    }
  }
}

function resolvePackage(from, name) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (directory === path.dirname(directory)) throw new Error(`Dependency not installed: ${name}`);
  }
}

function copyDependency(from, name, parent, ancestors = new Set(), direct = false) {
  const source = resolvePackage(from, name);
  const reserved = rootPackages.get(name);
  let destination;
  if (!reserved) {
    destination = path.join(stage, 'node_modules', name);
    rootPackages.set(name, { source, destination });
  } else if (reserved.source === source) {
    destination = reserved.destination;
  } else {
    destination = path.join(parent, 'node_modules', name);
  }
  if (!direct && reserved?.source === source && manifest.bundleDependencies.includes(name)) return;
  if (copied.has(destination)) return;
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (ancestors.has(source)) return;
  copied.add(destination);
  if (metadata.name === 'esbuild') esbuildPackages.set(destination, metadata.version);
  if (metadata.name === 'libsql' || metadata.name === '@lydell/node-pty') nativePackages.set(destination, metadata);
  fs.cpSync(source, destination, { recursive: true, dereference: true,
    filter: entry => !['node_modules', '.git'].includes(path.basename(entry)) });
  const lineage = new Set([...ancestors, source]);
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    copyDependency(source, dependency, destination, lineage);
  }
  for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
    if (metadata.dependencies?.[dependency]) continue;
    try { resolvePackage(source, dependency); } catch { continue; }
    copyDependency(source, dependency, destination, lineage);
  }
}

try {
  stage = fs.mkdtempSync(path.join(os.tmpdir(), 'shittimchest-package-'));
  inputs = fs.mkdtempSync(path.join(os.tmpdir(), 'shittimchest-package-inputs-'));
  for (const name of ['dist', 'README.md', '.env.example']) {
    const source = path.join(root, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(stage, name), { recursive: true });
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Materialize the exact installed dependency graph in npm's portable layout.
  // Copying pnpm symlinks would lose patches or retain virtual-store paths.
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    rootPackages.set(name, { source: resolvePackage(root, name), destination: path.join(stage, 'node_modules', name) });
  }
  for (const name of manifest.bundleDependencies ?? []) {
    if (!manifest.dependencies?.[name]) throw new Error(`Bundled dependency must be direct: ${name}`);
    copyDependency(root, name, stage, new Set(), true);
  }
  await completeEsbuildPackages();
  await completeNativePackages();
  fs.mkdirSync(output, { recursive: true });
  const result = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
    { cwd: stage, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  for (const entry of result) {
    if (entry.files.some(file => path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..') || file.path.split(/[\\/]/).includes('.private'))) {
      fs.rmSync(path.join(output, entry.filename), { force: true });
      throw new Error('Package contains a non-portable path');
    }
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
  if (inputs) fs.rmSync(inputs, { recursive: true, force: true });
}
