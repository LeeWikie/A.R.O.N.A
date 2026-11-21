import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBehavior } from '../scripts/compare-behavior.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function app(name: string, code: string) { return { name, command: process.execPath, args: ['-e', code] }; }
const driver = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);console.log(JSON.stringify({id:r.id,repetition:r.repetition,observation:r.input}));});`;

test('comparison retains every repetition and checks an independent expected result', async () => {
  const result = await compareBehavior({ applications: [app('a', driver), app('b', driver)], cases: [{ id: 'unicode', input: { text: '中文\nsecond line', state: 'finished' }, expected: { text: '中文\nsecond line', state: 'finished' } }] });
  assert.equal(result.passed, true); assert.equal(result.runs.length, 10);
  assert.equal(new Set(result.runs.map(row => row.repetition)).size, 5);
  const wrong = await compareBehavior({ applications: [app('a', driver), app('b', driver)], repetitions: 1, cases: [{ id: 'wrong', input: 'same wrong output', expected: 'actual expected output' }] });
  assert.equal(wrong.passed, false); assert.ok(wrong.runs.every(run => !run.passed));
});

test('crashes, stale observations and timeouts cannot be treated as equal success', async () => {
  for (const code of [driver + `process.exitCode=1;`, `console.log('{}')`, 'setTimeout(()=>{},10000)']) {
    const result = await compareBehavior({ applications: [app('reference', driver), app('candidate', code)], repetitions: 1, timeoutMs: 500, cases: [{ id: 'case', input: 'ok', expected: 'ok' }] });
    assert.equal(result.passed, false);
    assert.ok(result.runs.some(run => run.application === 'candidate' && run.failure));
  }
});

test('diagnostics retain exact private evidence and cannot disappear behind a successful observation', async () => {
  const bytes = Buffer.from([0, 255, 27, 91, 51, 49, 109, ...Buffer.from('synthetic private diagnostic 中文')]);
  const result = await compareBehavior({ applications: [app('reference', driver), app('candidate', `process.stderr.write(Buffer.from('${bytes.toString('base64')}', 'base64'));` + driver)], repetitions: 1, cases: [{ id: 'diagnostics', input: 'ok', expected: 'ok' }] });
  try {
    assert.equal(result.passed, false);
    const run = result.runs.find(row => row.application === 'candidate')!;
    assert.equal(run.observation, 'ok'); assert.equal(run.failure, 'diagnostic_output'); assert.equal(run.passed, false);
    assert.deepEqual(await fs.readFile(path.join(run.evidence.directory, 'stderr.bin')), bytes);
    assert.equal(run.evidence.stderr.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(run.evidence.stderr.bytes, bytes.length); assert.equal(run.evidence.complete, true);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(result.evidenceDirectory)).mode & 0o777, 0o700);
      for (const name of ['stdout.bin', 'stderr.bin', 'input.json', 'result.json']) assert.equal((await fs.stat(path.join(run.evidence.directory, name))).mode & 0o777, 0o600);
    }
    await assert.rejects(compareBehavior({ applications: [app('a', driver), app('b', driver)], evidenceDirectory: result.evidenceDirectory, cases: [{ id: 'case', input: 'ok', expected: 'ok' }] }), /EEXIST/);
    assert.deepEqual(await fs.readFile(path.join(run.evidence.directory, 'stderr.bin')), bytes);
  } finally { await fs.rm(result.evidenceDirectory, { recursive: true, force: true }); }
});

test('invalid encoding and oversized observations fail while retaining captured bytes', async () => {
  for (const [code, failure] of [
    [`process.stdout.write(Buffer.from([255]));` + driver, 'invalid_observation'],
    [`process.stdout.write(Buffer.alloc(1100000, 120));`, 'output_limit'],
  ]) {
    const result = await compareBehavior({ applications: [app('reference', driver), app('candidate', code!)], repetitions: 1, cases: [{ id: 'bytes', input: 'ok', expected: 'ok' }] });
    try {
      const run = result.runs.find(row => row.application === 'candidate')!;
      assert.equal(run.passed, false); assert.equal(run.failure, failure);
      const captured = await fs.readFile(path.join(run.evidence.directory, 'stdout.bin'));
      assert.equal(run.evidence.stdout.bytes, captured.length);
      assert.equal(run.evidence.stdout.sha256, createHash('sha256').update(captured).digest('hex'));
      if (failure === 'invalid_observation') assert.equal(captured[0], 255); else assert.ok(captured.length > 1024 * 1024);
    } finally { await fs.rm(result.evidenceDirectory, { recursive: true, force: true }); }
  }
});
