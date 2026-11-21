import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OAuthCredential } from '@earendil-works/pi-ai';
import { ProviderCredentialStore } from '../src/providers/credential-store.js';
import { createProviderCatalog } from '../src/providers/catalog.js';
import { classifyOAuthFailure } from '../src/providers/auth-failures.js';
import { until } from './helpers.js';

const key = 'synthetic-authorization-integrity-key-000000';
const scopes = ['chatgpt.tokens.use.direct', 'resource.invoke'];
function credential(account = 'synthetic-account', revision = 1): OAuthCredential {
  const claims = { iss: 'https://synthetic.invalid', sub: account, aud: 'synthetic-api', scope: scopes.join(' '), 'https://api.openai.com/auth': { chatgpt_account_id: account } };
  return { type: 'oauth', access: `aaa.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature${revision}`, refresh: `synthetic-refresh-${revision}`, expires: Date.now() - 1000, accountId: account };
}
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arona-authorization-'));
const context = { env: async () => undefined, fileExists: async () => false };

test('the native OAuth refresh and store lock preserve one authorization across concurrent requests and reopening', async () => {
  const dir = directory(), originalFetch = globalThis.fetch;
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const next = credential('synthetic-account', 2);
  const store = new ProviderCredentialStore(dir, key);
  const registry = createProviderCatalog({ credentials: store, authContext: context });
  let pending: Array<Promise<unknown>> = [];
  try {
    await store.modify('openai-codex', async () => credential());
    const before = await store.authorizationIdentity('openai-codex');
    assert.ok(before);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://auth.openai.com/oauth/token');
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'synthetic-refresh-1');
      calls++; await gate;
      return Response.json({ access_token: next.access, refresh_token: next.refresh, expires_in: 3600, scope: scopes.join(' ') });
    };
    pending = Array.from({ length: 3 }, () => registry.getAuth('openai-codex'));
    const settled = Promise.allSettled(pending);
    await until(() => calls, value => value === 1); release();
    await settled;
    const resolved = await Promise.all(pending) as Array<{ auth: { apiKey?: string } } | undefined>;
    assert.equal(calls, 1);
    assert.ok(resolved.every(value => value?.auth.apiKey === next.access));
    assert.deepEqual(await store.authorizationIdentity('openai-codex'), before);
    assert.deepEqual(await new ProviderCredentialStore(dir, key).authorizationIdentity('openai-codex'), before);
    const saved = await store.read('openai-codex'); assert.equal(saved?.type, 'oauth');
    assert.equal(saved && '__shittimchest_authorization' in saved, false, 'the native SDK receives its original credential shape');
    assert.ok(!JSON.stringify(before).includes(next.access)); assert.ok(!JSON.stringify(before).includes('synthetic-account'));
  } finally { release(); await Promise.allSettled(pending); globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed native refresh preserves the exact credential file and authorization for retry', async () => {
  const dir = directory(), originalFetch = globalThis.fetch;
  const store = new ProviderCredentialStore(dir, key);
  const registry = createProviderCatalog({ credentials: store, authContext: context });
  try {
    await store.modify('openai-codex', async () => credential());
    const identity = await store.authorizationIdentity('openai-codex');
    const file = path.join(dir, 'provider-credentials.json'), original = fs.readFileSync(file);
    globalThis.fetch = async () => new Response('synthetic invalid_grant', { status: 400 });
    await assert.rejects(registry.getAuth('openai-codex'));
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(await store.authorizationIdentity('openai-codex'), identity);
    for (const [status, code] of [[503, 'oauth_temporarily_unavailable'], [400, 'oauth_authentication_required']] as const) {
      globalThis.fetch = async () => new Response('synthetic invalid_grant', { status });
      await assert.rejects(registry.getAuth('openai-codex'), error => classifyOAuthFailure(error).code === code);
      assert.deepEqual(fs.readFileSync(file), original);
    }
  } finally { globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only a matching successful refresh preserves authorization; account, grants and unproven replacement revoke it', async () => {
  for (const variation of ['replacement', 'account', 'scope', 'wrong-provider', 'different-result', 'logout'] as const) {
    const dir = directory();
    const store = new ProviderCredentialStore(dir, key);
    try {
      await store.modify('openai-codex', async () => credential());
      const before = await store.authorizationIdentity('openai-codex');
      if (variation === 'logout') await store.delete('openai-codex');
      else await store.modify('openai-codex', async current => {
        assert.equal(current?.type, 'oauth');
        const next = credential(variation === 'account' ? 'another-account' : 'synthetic-account', 2);
        if (variation === 'scope') next.scopes = [...scopes, 'another-grant'];
        if (variation === 'replacement') return next;
        const result = await store.confirmOAuthRefresh(variation === 'wrong-provider' ? 'another-provider' : 'openai-codex', current as OAuthCredential, async () => next);
        return variation === 'different-result' ? { ...result, refresh: 'different-result' } : result;
      });
      assert.notDeepEqual(await store.authorizationIdentity('openai-codex'), before, variation);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('legacy credentials gain a bound identity without changing native data, and file edits cannot inherit it', async () => {
  const dir = directory(), file = path.join(dir, 'provider-credentials.json');
  const original = credential();
  fs.writeFileSync(file, JSON.stringify({ 'openai-codex': original }), { mode: 0o600 });
  const store = new ProviderCredentialStore(dir, key);
  try {
    const before = await store.authorizationIdentity('openai-codex');
    assert.deepEqual(await store.read('openai-codex'), original);
    await store.modify('openai-codex', async current => current);
    assert.deepEqual(await store.authorizationIdentity('openai-codex'), before, 'a no-op credential mutation keeps its existing authority');
    const changed = JSON.parse(fs.readFileSync(file, 'utf8'));
    changed['openai-codex'].access = credential('synthetic-account', 3).access;
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.notDeepEqual(await store.authorizationIdentity('openai-codex'), before);
    assert.equal((await store.read('openai-codex') as OAuthCredential).access, changed['openai-codex'].access);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling a caller after native refresh starts does not discard a rotated credential', async () => {
  const dir = directory(), originalFetch = globalThis.fetch;
  const store = new ProviderCredentialStore(dir, key), controller = new AbortController();
  const registry = createProviderCatalog({ credentials: store, authContext: context });
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<unknown> | undefined;
  try {
    await store.modify('openai-codex', async () => credential());
    const before = await store.authorizationIdentity('openai-codex'), next = credential('synthetic-account', 2);
    globalThis.fetch = async () => { calls++; await gate; return Response.json({ access_token: next.access, refresh_token: next.refresh, expires_in: 3600 }); };
    pending = registry.getAuth('openai-codex', { signal: controller.signal });
    const settled = Promise.allSettled([pending]);
    await until(() => calls, value => value === 1); controller.abort(); release(); await settled;
    await until(() => store.read('openai-codex'), value => value?.type === 'oauth' && value.refresh === next.refresh);
    assert.equal((await store.read('openai-codex') as OAuthCredential).refresh, next.refresh);
    assert.deepEqual(await store.authorizationIdentity('openai-codex'), before);
    assert.equal((await registry.getAuth('openai-codex'))?.auth.apiKey, next.access);
    assert.equal(calls, 1);
  } finally { release(); if (pending) await Promise.allSettled([pending]); globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ['hardlink', 'symlink'] as const) {
  test(`a ${kind} authorization signing key cannot create a trusted credential binding`, async t => {
    const dir = directory(), target = path.join(dir, 'target'), original = 'a'.repeat(64);
    fs.writeFileSync(target, original, { mode: 0o600 });
    try {
      const link = path.join(dir, 'provider-identity-key');
      if (kind === 'hardlink') fs.linkSync(target, link);
      else {
        try { fs.symlinkSync(target, link); }
        catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Symbolic link creation is unavailable'); return; } throw error; }
      }
      const store = new ProviderCredentialStore(dir);
      await assert.rejects(store.modify('openai-codex', async () => credential()), /invalid_provider_identity_key|ELOOP/);
      assert.equal(fs.readFileSync(target, 'utf8'), original);
      assert.equal(fs.existsSync(path.join(dir, 'provider-credentials.json')), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
