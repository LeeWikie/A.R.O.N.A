import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findInstalledFd } from '../src/tools/fd.js';

test('finds installed fd in absolute PATH entries without running it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-fd-discovery-'));
  try {
    const name = process.platform === 'win32' ? 'fd.exe' : 'fd';
    const file = path.join(directory, name); fs.writeFileSync(file, 'not an executable fixture', { mode: 0o755 });
    assert.equal(findInstalledFd({ PATH: directory }), file);
    assert.equal(findInstalledFd({ PATH: '' }), undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
