import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai';
import { openProviderSession, providerTurn, socketFixture } from './provider-session-fixture.js';
import { removeTemp, until } from './helpers.js';

test('provider sockets belong to independent Core sessions and close without affecting another Core', { timeout: 30000 }, async () => {
  const fixture = await socketFixture();
  const firstDir = await mkdtemp(join(tmpdir(), 'arona-provider-first-'));
  const secondDir = await mkdtemp(join(tmpdir(), 'arona-provider-second-'));
  const first = await openProviderSession(firstDir, fixture.baseUrl);
  const second = await openProviderSession(secondDir, fixture.baseUrl);
  try {
    await providerTurn(first); await providerTurn(second);
    assert.equal(fixture.connections, 2, 'matching account and context names must not share a socket across stores');
    assert.equal(fixture.clients, 2);
    await first.close();
    await until(() => fixture.clients, count => count === 1);
    await providerTurn(second);
    assert.equal(fixture.connections, 2, 'the other Core keeps its own reusable connection');
    assert.equal(fixture.requests, 3);
    await second.close();
    await until(() => fixture.clients, count => count === 0);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    await fixture.close();
    await removeTemp(firstDir); await removeTemp(secondDir);
  }
});

test('provider logout and session archival release their actual cached resources', { timeout: 30000 }, async () => {
  const fixture = await socketFixture();
  const directory = await mkdtemp(join(tmpdir(), 'arona-provider-logout-'));
  const core = await openProviderSession(directory, fixture.baseUrl);
  try {
    await providerTurn(core);
    assert.equal(fixture.clients, 1);
    await core.createConversationContext({ id: 'archive-target', name: 'Archive target', modelProfile: 'socket-fixture' });
    await core.switchModel('archive-target', 'socket-fixture', 'max');
    await providerTurn(core, 'archive-target');
    assert.equal(fixture.clients, 2);
    core.archiveContext('archive-target', true);
    await until(() => fixture.clients, count => count === 1);
    await providerTurn(core);
    assert.equal(fixture.connections, 2, 'archiving another session preserves the main connection');
    await core.providerRegistry.logout('openai-codex');
    await until(() => fixture.clients, count => count === 0);
    assert.equal(await core.providerRegistry.checkAuth('openai-codex'), undefined);
    await assert.rejects(Promise.resolve(core.models.resolve('socket-fixture').doGenerate({ prompt: [] })));
    await core.close();
    assert.throws(() => core.models.options('socket-fixture', 'max', 'main'), /model_runtime_closed/);
  } finally { await core.close(); await fixture.close(); await removeTemp(directory); }
});

test('all owned session cleanup hooks run even when one resource fails, and storage is unlocked', { timeout: 15000 }, async () => {
  const fixture = await socketFixture();
  const directory = await mkdtemp(join(tmpdir(), 'arona-provider-cleanup-error-'));
  const core = await openProviderSession(directory, fixture.baseUrl);
  const ids = ['main', 'other'].map(id => String(core.models.options('socket-fixture', 'max', id).providerOptions?.pi?.sessionId));
  const seen: string[] = [];
  const unregister = registerSessionResourceCleanup(id => { if (id && ids.includes(id)) { seen.push(id); if (id === ids[0]) throw new Error('Synthetic cleanup failure'); } });
  try {
    await assert.rejects(core.close(), /provider_session_cleanup_failed/);
    assert.deepEqual(seen.sort(), ids.sort());
    unregister();
    const reopened = await openProviderSession(directory, fixture.baseUrl);
    await reopened.close();
  } finally { unregister(); await core.close().catch(() => {}); await fixture.close(); await removeTemp(directory); }
});

test('a Core that used a real cached provider socket exits naturally after close', { timeout: 20000 }, async () => {
  const fixture = await socketFixture();
  const directory = await mkdtemp(join(tmpdir(), 'arona-provider-natural-exit-'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./provider-session-fixture.ts', import.meta.url)), directory, fixture.baseUrl], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostics = '', ready = false, closed = false;
  child.stdout!.setEncoding('utf8').on('data', data => { diagnostics += data; });
  child.stderr!.setEncoding('utf8').on('data', data => { diagnostics += data; });
  child.on('message', message => { if (message && typeof message === 'object' && 'type' in message) { if (message.type === 'ready') ready = true; if (message.type === 'closed') closed = true; } });
  try {
    await until(() => ready || child.exitCode !== null, value => value, 10000);
    assert.ok(ready, diagnostics);
    assert.equal(fixture.clients, 1, 'the real socket is cached before shutdown');
    const exit = once(child, 'exit', { signal: AbortSignal.timeout(7000) });
    child.send({ type: 'close' });
    const [code, signal] = await exit;
    assert.equal(closed, true, diagnostics);
    assert.equal(code, 0, diagnostics); assert.equal(signal, null, diagnostics);
    await until(() => fixture.clients, count => count === 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await fixture.close(); await removeTemp(directory);
  }
});
