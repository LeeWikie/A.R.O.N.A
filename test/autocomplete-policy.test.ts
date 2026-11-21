import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CombinedAutocompleteProvider, type FileCompletionPolicy } from '@earendil-works/pi-tui';
import { findFd } from '../src/tools/fd.js';

function temporary() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arona-path-policy-'))); }
function policy(root: string): FileCompletionPolicy {
  return { followSymlinks: false, fdExclude: ['secrets', 'secrets/**'], allowPath(file) {
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    for (const part of relative.split(path.sep)) if (part === 'secrets') return false;
    let current = root;
    try {
      for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part); const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) return false;
      }
      return true;
    } catch { return false; }
  } };
}
async function suggestions(provider: CombinedAutocompleteProvider, text: string, force = false, signal = new AbortController().signal) {
  return provider.getSuggestions([text], 0, text.length, { force, signal });
}

test('file prefix extraction retains native command, quote, wrapper and at-prefix rules without IO', () => {
  let inspected = 0;
  const provider = new CombinedAutocompleteProvider([], path.resolve('/unused'), null, { allowPath() { inspected++; throw new Error('No IO'); } });
  const contexts = [
    ['', false, null], ['', true, { prefix: '' }], ['/think', false, null],
    ['/task argument', false, null], ['/task @src/fi', false, { prefix: '@src/fi' }],
    ['use (./src/fi', false, { prefix: './src/fi' }], ['use @"src/my fi', false, { prefix: '@"src/my fi' }],
    ['read，', false, { prefix: '' }], ['read /absolute/path', false, { prefix: '/absolute/path' }],
    ['/absolute/path', true, { prefix: '/absolute/path' }],
  ] as const;
  for (const [text, force, expected] of contexts) assert.deepEqual(provider.getFileCompletionContext([text], 0, text.length, force), expected, text);
  const line = `${'中文'.repeat(1500000)} @src/fi`;
  assert.deepEqual(provider.getFileCompletionContext([line], 0, line.length), { prefix: '@src/fi' });
  assert.equal(inspected, 0);
});

test('file suggestions and native fd enforce the same root, sensitive-directory, link and hardlink policy', async () => {
  const root = temporary(), outside = temporary();
  try {
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'secrets'));
    fs.writeFileSync(path.join(root, 'src', 'visible.txt'), 'visible');
    fs.writeFileSync(path.join(root, 'secrets', 'hidden.txt'), 'hidden');
    fs.writeFileSync(path.join(outside, 'external.txt'), 'external');
    fs.linkSync(path.join(outside, 'external.txt'), path.join(root, 'hard.txt'));
    fs.symlinkSync(outside, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    const fd = findFd(); assert.ok(fd, 'The packaged fd must be available');
    const provider = new CombinedAutocompleteProvider([], root, fd, policy(root));
    const direct = await suggestions(provider, './', true);
    assert.ok(direct?.items.some(row => row.value === './src/'));
    assert.equal(direct?.items.some(row => /secrets|redirect|hard/.test(row.value)), false);
    const fuzzy = await suggestions(provider, '@visible'); assert.ok(fuzzy?.items.some(row => row.value === '@src/visible.txt'));
    assert.equal(await suggestions(provider, '@hidden'), null);
    assert.equal(await suggestions(provider, '@external'), null);
    assert.equal(await suggestions(provider, `@${outside}${path.sep}`), null);
    assert.equal(await suggestions(provider, `read ${outside}${path.sep}`, true), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('policy suggestions preserve native fd values, quoting and explicitly typed scoped prefixes', async () => {
  const root = temporary();
  try {
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'src', '中文 目录'));
    fs.writeFileSync(path.join(root, 'src', 'visible.txt'), 'visible'); fs.writeFileSync(path.join(root, 'src', '中文 目录', 'visible 文件.ts'), 'visible');
    const fd = findFd(); assert.ok(fd);
    const native = new CombinedAutocompleteProvider([], root, fd), restricted = new CombinedAutocompleteProvider([], root, fd, policy(root));
    for (const prefix of ['@visible', '@src/visible', '@./src/visible', '@"src/中文 目录/vis', '@src/', '@./src/']) {
      assert.deepEqual(await suggestions(restricted, prefix), await suggestions(native, prefix), prefix);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a rejected scoped root never launches fd or probes a fallback root', async () => {
  const root = temporary();
  try {
    const inspected: string[] = [];
    const provider = new CombinedAutocompleteProvider([], root, path.join(root, 'must-not-exist'), { allowPath(file) { inspected.push(file); return false; } });
    assert.equal(await suggestions(provider, '@/unavailable/child'), null);
    assert.deepEqual(inspected, [path.resolve('/unavailable/')]);
    assert.equal(await suggestions(provider, 'read /unavailable/', true), null);
    assert.deepEqual(inspected, [path.resolve('/unavailable/'), path.resolve('/unavailable/')]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fakeFd(root: string, script: string) {
  const file = path.join(root, 'fd-fixture');
  fs.writeFileSync(file, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  return file;
}
function dead(pid: number) { try { process.kill(pid, 0); return false; } catch { return true; } }
async function waitFor(file: string) { for (let attempt = 0; attempt < 200; attempt++) { if (fs.existsSync(file)) return; await delay(10); } throw new Error('fd fixture did not start'); }

test('fd counts admitted candidates after filtering and awaits process close on its result limit', { skip: process.platform === 'win32' }, async () => {
  const root = temporary();
  try {
    const pids = path.join(root, 'pids'), args = path.join(root, 'args');
    const fd = fakeFd(root, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');fs.appendFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2))+'\\n');for(let i=0;i<150;i++)process.stdout.write('deny-'+i+'\\0');for(let i=0;i<120;i++)process.stdout.write('accepted-'+i+'\\0');setInterval(()=>{},1000);`);
    const admitted = new Set<string>();
    const provider = new CombinedAutocompleteProvider([], root, fd, { followSymlinks: false, fdExclude: ['secrets/**'], allowPath(file) { const name = path.basename(file); if (name.startsWith('accepted-')) admitted.add(name); return !name.startsWith('deny-'); } });
    const result = await suggestions(provider, '@accepted');
    assert.ok(result && result.items.length > 0); assert.ok(result.items.every(row => row.value.startsWith('@accepted-')));
    assert.equal(admitted.size, 100);
    const processes = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number); assert.equal(processes.length, 2); assert.ok(processes.every(dead));
    for (const line of fs.readFileSync(args, 'utf8').trim().split('\n')) { const argv = JSON.parse(line) as string[]; assert.ok(argv.includes('--print0')); assert.ok(argv.includes('secrets/**')); assert.equal(argv.includes('--follow'), false); assert.equal(argv.includes('--max-results'), false); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fd cancellation awaits the actual child close and leaves no stale suggestions', { skip: process.platform === 'win32' }, async () => {
  const root = temporary();
  try {
    const pidFile = path.join(root, 'pid');
    const fd = fakeFd(root, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('partial\\0');setInterval(()=>{},1000);`);
    const controller = new AbortController(), provider = new CombinedAutocompleteProvider([], root, fd, { allowPath: () => true });
    const pending = suggestions(provider, '@partial', false, controller.signal); await waitFor(pidFile); controller.abort();
    assert.equal(await pending, null); assert.ok(dead(Number(fs.readFileSync(pidFile, 'utf8'))));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
