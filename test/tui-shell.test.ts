import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { contextThinking, projectEvent, snapshot } from '../src/event-stream.js';
import { runShell, shellCommand, shellResultText, truncateTail } from '../src/tui/shell.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp } from './helpers.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

test('shell runner streams output, reports exit codes, cancels the process tree and keeps the tail', { skip: process.platform === 'win32' }, async () => {
  const chunks: string[] = [];
  const ok = await runShell('echo one; echo two 1>&2', { cwd: os.tmpdir(), signal: new AbortController().signal, onChunk: text => chunks.push(text) });
  assert.equal(ok.exitCode, 0); assert.match(ok.output, /one/); assert.match(ok.output, /two/); assert.ok(chunks.length > 0);
  const failed = await runShell('exit 3', { cwd: os.tmpdir(), signal: new AbortController().signal, onChunk: () => {} });
  assert.equal(failed.exitCode, 3);
  const controller = new AbortController();
  const started = Date.now(); const pending = runShell('sleep 30', { cwd: os.tmpdir(), signal: controller.signal, onChunk: () => {} });
  setTimeout(() => controller.abort(), 100);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true); assert.ok(Date.now() - started < 5000);
  const colored = await runShell("printf '\\033[31mred\\033[0m\\n'", { cwd: os.tmpdir(), signal: new AbortController().signal, onChunk: () => {} });
  assert.equal(colored.output, 'red', 'terminal control sequences are stripped');
  const unicode = await runShell("printf '\\344'; sleep 0.02; printf '\\270\\255'", { cwd: os.tmpdir(), signal: new AbortController().signal, onChunk: () => {} });
  assert.equal(unicode.output, '中', 'UTF-8 split between process chunks remains intact');
  const tail = truncateTail(Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(tail.truncated, true); assert.ok(tail.content.endsWith('line 2999'));
  const unicodeTail = truncateTail('中文内容🙂'.repeat(100), 17);
  assert.equal(unicodeTail.truncated, true); assert.ok(Buffer.byteLength(unicodeTail.content) <= 17); assert.ok(!unicodeTail.content.includes('�'));
  assert.deepEqual(shellCommand('dir', { ComSpec: 'C:\\Windows\\cmd.exe' }, 'win32'), { shell: 'C:\\Windows\\cmd.exe', args: ['/d', '/s', '/c', '"dir"'] });
  assert.equal(shellResultText('false', { output: '', exitCode: 1, cancelled: false, truncated: false }), 'Ran `false`\n(no output)\n\nCommand exited with code 1');
});

test('shell cancellation ends processes that ignore SIGTERM', { skip: process.platform === 'win32', timeout: 6000 }, async () => {
  const controller = new AbortController();
  const running = runShell("trap '' TERM; echo ready; while :; do sleep 1; done", { cwd: os.tmpdir(), signal: controller.signal,
    onChunk: text => { if (text.includes('ready')) controller.abort(); } });
  const result = await running; assert.equal(result.cancelled, true); assert.equal(result.exitCode, undefined);
});

test('! shares the result with the next message, !! does not, and nothing reaches the model by itself', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-bang-'));
  const sent: Array<{ content: string }> = [];
  const client = { async request(route: string, init?: RequestInit) {
    if (route === '/messages') { sent.push(JSON.parse(String(init?.body))); return { status: 'accepted' }; }
    return {};
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal(), { completionBase: dir });
  const target = app as unknown as { submit(text: string): Promise<void>; contextRole: string; contextReady: boolean; isMainContext: boolean; transcript: { children: Array<{ children?: Array<{ text?: string }> }> }; sharedShell: Map<string, string[]> };
  try {
    target.contextRole = 'main'; target.contextReady = true; target.isMainContext = true;
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'x');
    await target.submit('!ls');
    await target.submit('!!echo private-only');
    assert.equal(sent.length, 0, 'running a command sends nothing to the core');
    const cards = target.transcript.children.flatMap(child => child.children ?? []).map(child => strip(child.text ?? '')).join('\n');
    assert.match(cards, /\$ ls/); assert.match(cards, /marker\.txt/); assert.match(cards, /\$ echo private-only/); assert.match(cards, /不带入对话/);
    assert.equal(target.sharedShell.get('main')?.length, 1);
    await target.submit('what files are there?');
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.content, /^Ran `ls`\n```\nmarker\.txt\n```\n\nwhat files are there\?$/);
    assert.doesNotMatch(sent[0]!.content, /private-only/);
    assert.equal(target.sharedShell.has('main'), false, 'shared results are consumed once');
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider reasoning is projected as thinking, redacted, and restored with history', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-thinking-'));
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'reasoning-start', id: 'r' }); c.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'weighing options with Bearer secret-token-value' }); c.enqueue({ type: 'reasoning-end', id: 'r' });
    c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'answer' }); c.enqueue({ type: 'text-end', id: 't' });
    c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
  } }) }) });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false });
  try {
    const signal = await core.submitMessage({ content: 'hi' }); await finished(core, signal.runId!);
    const events = core.runtime.events('main', 0, 500).map(event => projectEvent(core, event)).filter(event => event?.kind === 'thinking');
    assert.ok(events.length > 0);
    assert.match(events.map(event => (event!.data as { delta: string }).delta).join(''), /weighing options with Bearer \[hidden\]/);
    assert.deepEqual(contextThinking(core, 'main').map(row => row.runId), [signal.runId]);
    assert.ok(snapshot(core, 'main').thinking?.[0]?.text.includes('weighing options'));

    const app = new TerminalApp({} as Client, 'main', new FakeTerminal());
    const target = app as unknown as { event(event: unknown): void; toggleThinking(): void; transcript: { children: Array<{ children?: Array<{ text?: string; render?: (width: number) => string[] }> }> } };
    try {
      target.event({ ...events[0], contextId: 'main' });
      const render = () => target.transcript.children.map(child => (child as unknown as { render(width: number): string[] }).render(80).join('\n')).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
      assert.match(render(), /weighing options/);
      target.toggleThinking();
      assert.doesNotMatch(render(), /weighing options/); assert.match(render(), /Ctrl\+T 展开/);
    } finally { await app.stop(); }
  } finally { await core.close(); await removeTemp(directory); }
});
