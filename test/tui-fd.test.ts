import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findFd, findInstalledFd } from '../src/tools/fd.js';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';

test('finds installed fd in absolute PATH entries without running it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-discovery-'));
  try {
    const name = process.platform === 'win32' ? 'fd.exe' : 'fd';
    const file = path.join(directory, name); fs.writeFileSync(file, 'not an executable fixture', { mode: 0o755 });
    assert.equal(findInstalledFd({ PATH: directory }), file);
    assert.equal(findInstalledFd({ PATH: '' }), undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('packaged fd completes Unicode and spaced paths, hidden files and gitignore rules', { skip: !findFd() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd 中文 空格-'));
  try {
    fs.mkdirSync(path.join(directory, '.git'));
    fs.mkdirSync(path.join(directory, '中文 目录')); fs.writeFileSync(path.join(directory, '中文 目录', 'needle 文件.txt'), 'fixture');
    fs.writeFileSync(path.join(directory, '.hidden-needle'), 'fixture');
    fs.writeFileSync(path.join(directory, '.gitignore'), 'needle-ignored.txt\n'); fs.writeFileSync(path.join(directory, 'needle-ignored.txt'), 'fixture');
    const provider = new CombinedAutocompleteProvider([], directory, findFd());
    const result = await provider.getSuggestions(['@needle'], 0, 7, { signal: new AbortController().signal });
    assert.ok(result);
    assert.ok(result.items.some(item => item.description === '中文 目录/needle 文件.txt'), JSON.stringify(result));
    assert.ok(result.items.some(item => item.description === '.hidden-needle'), JSON.stringify(result));
    assert.ok(!result.items.some(item => item.description === 'needle-ignored.txt'), JSON.stringify(result));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
