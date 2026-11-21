import fs from 'node:fs/promises';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export interface ApplicationDriver { name: string; command: string; args?: string[]; cwd?: string }
export interface BehaviorCase { id: string; input: unknown; expected: unknown }
export interface Comparison { applications: ApplicationDriver[]; cases: BehaviorCase[]; repetitions?: number; timeoutMs?: number; evidenceDirectory?: string }
interface Capture { bytes: number; sha256: string }
interface Evidence { directory: string; stdout: Capture; stderr: Capture; exitCode: number | null; signal: NodeJS.Signals | null; complete: boolean }
interface Observation { observation?: unknown; failure?: string; evidence: Evidence }

async function observe(driver: ApplicationDriver, test: BehaviorCase, repetition: number, timeoutMs: number, directory: string): Promise<Observation> {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'input.json'), JSON.stringify({ id: test.id, input: test.input, repetition }) + '\n', { mode: 0o600, flag: 'wx' });
  return new Promise<Observation>(resolve => {
    const output = ['stdout', 'stderr'].map(name => ({ fd: openSync(path.join(directory, `${name}.bin`), 'wx', 0o600), bytes: 0, hash: createHash('sha256') }));
    const child = spawn(driver.command, driver.args ?? [], { cwd: driver.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let failure: string | undefined, complete = true, settled = false, drainTimer: NodeJS.Timeout | undefined;
    const fail = (reason: string) => { failure ??= reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail('timeout'), timeoutMs);
    [child.stdout, child.stderr].forEach((stream, index) => stream.on('data', (chunk: Buffer) => {
      const capture = output[index]!;
      try {
        // Preserve the original bytes, including invalid UTF-8 and diagnostic escape sequences.
        let offset = 0; while (offset < chunk.length) offset += writeSync(capture.fd, chunk, offset);
        capture.hash.update(chunk); capture.bytes += chunk.length;
        if (index === 0 && capture.bytes <= 1024 * 1024) chunks.push(Buffer.from(chunk));
        if (capture.bytes > (index === 0 ? 1024 * 1024 : 16 * 1024 * 1024)) fail('output_limit');
      } catch { complete = false; fail('evidence_write_failed'); }
    }));
    child.stdin.on('error', () => {});
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      for (const capture of output) {
        try { fsyncSync(capture.fd); } catch { complete = false; failure ??= 'evidence_write_failed'; }
        try { closeSync(capture.fd); } catch { complete = false; failure ??= 'evidence_write_failed'; }
      }
      const captures = output.map(({ bytes, hash }) => ({ bytes, sha256: hash.digest('hex') }));
      const evidence: Evidence = { directory, stdout: captures[0]!, stderr: captures[1]!, exitCode: code, signal, complete };
      let observation: unknown;
      if (code !== 0 || signal) failure ??= 'nonzero_exit';
      if (output[1]!.bytes) failure ??= 'diagnostic_output';
      try {
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!result || typeof result !== 'object' || result.id !== test.id || result.repetition !== repetition || !Object.hasOwn(result, 'observation')) throw new Error();
        observation = result.observation;
      } catch { failure ??= 'invalid_observation'; }
      resolve({ observation, failure, evidence });
    };
    child.on('error', () => { failure ??= 'launch_failed'; });
    child.on('exit', (code, signal) => {
      // A descendant retaining the pipes is an incomplete run, never a successful observation.
      drainTimer = setTimeout(() => {
        complete = false; failure ??= 'stdio_drain_timeout'; child.stdout.destroy(); child.stderr.destroy(); finish(code, signal);
      }, 1000);
    });
    child.on('close', finish);
    child.stdin.end(JSON.stringify({ id: test.id, input: test.input, repetition }) + '\n');
  }).then(async result => {
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return result;
  });
}

export async function compareBehavior(config: Comparison) {
  const repetitions = config.repetitions ?? 5, timeoutMs = config.timeoutMs ?? 120_000;
  if (!Number.isInteger(repetitions) || repetitions < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Array.isArray(config.applications) || config.applications.length < 2 || !config.cases?.length
    || new Set(config.applications.map(app => app.name)).size !== config.applications.length
    || new Set(config.cases.map(test => test.id)).size !== config.cases.length
    || config.applications.some(app => !app.name?.trim() || !app.command?.trim())
    || config.cases.some(test => !test.id?.trim() || !Object.hasOwn(test, 'expected'))) throw new Error('invalid_comparison');
  const inputsSha256 = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const evidenceDirectory = config.evidenceDirectory ? path.resolve(config.evidenceDirectory) : await fs.mkdtemp(path.join(os.tmpdir(), 'arona-behavior-'));
  if (config.evidenceDirectory) await fs.mkdir(evidenceDirectory, { mode: 0o700 });
  await fs.chmod(evidenceDirectory, 0o700);
  await fs.writeFile(path.join(evidenceDirectory, 'manifest.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const runs = [];
  for (const test of config.cases) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      // Rotate order so a consistently warm service or cache does not always favor one app.
      const apps = [...config.applications.slice(repetition % config.applications.length), ...config.applications.slice(0, repetition % config.applications.length)];
      for (const app of apps) {
        const result = await observe(app, test, repetition, timeoutMs, path.join(evidenceDirectory, String(runs.length + 1).padStart(6, '0')));
        runs.push({ application: app.name, case: test.id, repetition, ...result,
          passed: result.failure === undefined && isDeepStrictEqual(result.observation, test.expected) });
      }
    }
  }
  const result = { inputsSha256, repetitions, evidenceDirectory, passed: runs.every(run => run.passed), runs };
  await fs.writeFile(path.join(evidenceDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [manifest, output] = process.argv.slice(2);
  if (!manifest || !output) throw new Error('Usage: compare-behavior MANIFEST.json RESULT.json');
  const config = JSON.parse(await fs.readFile(manifest, 'utf8')) as Comparison;
  const result = await compareBehavior(config);
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ passed: result.passed, runs: result.runs.length, inputsSha256: result.inputsSha256 }));
  if (!result.passed) process.exitCode = 1;
}
