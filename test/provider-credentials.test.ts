import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { Credentials } from '../src/credentials.js';
import { AuthService } from '../src/auth.js';
import { ProviderCredentialStore } from '../src/providers/credential-store.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-'));

test('provider vault persists, lists only metadata, and migrates explicit legacy credentials without replacement', async () => {
  const dir = temp(); try {
    const credentials = new Credentials(dir);
    credentials.set('LEGACY_KEY', 'legacy-secret');
    await credentials.migrateProviderKey('example-provider', 'LEGACY_KEY');
    const store = new ProviderCredentialStore(dir);
    assert.deepEqual(await store.read('example-provider'), { type: 'api_key', key: 'legacy-secret' });
    assert.deepEqual(await store.list(), [{ providerId: 'example-provider', type: 'api_key' }]);
    credentials.set('OTHER_KEY', 'other-secret');
    await credentials.migrateProviderKey('example-provider', 'OTHER_KEY');
    assert.deepEqual(await store.read('example-provider'), { type: 'api_key', key: 'legacy-secret' });
    assert.equal(credentials.get('LEGACY_KEY'), 'legacy-secret');
    await store.delete('example-provider');
    assert.equal(await store.read('example-provider'), undefined);
    await assert.rejects(credentials.migrateProviderKey('example-provider', 'UNKNOWN'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider mutations serialize across processes and survive reopening', async () => {
  const dir = temp(); try {
    const url = pathToFileURL(path.resolve('src/providers/credential-store.ts')).href;
    const program = `import { ProviderCredentialStore } from ${JSON.stringify(url)};
const store = new ProviderCredentialStore(process.argv[1]);
for (let n = 0; n < 8; n++) await store.modify('fake', async c => {
 const value = c && c.type === 'api_key' ? Number(c.key) : 0;
 await new Promise(r => setTimeout(r, 2)); return { type: 'api_key', key: String(value + 1) };
});`;
    await Promise.all(Array.from({ length: 3 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, dir], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child ${code}: ${errors}`)));
    })));
    assert.deepEqual(await new ProviderCredentialStore(dir).read('fake'), { type: 'api_key', key: '24' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('aborted modification cannot persist and invalid files are rejected', async () => {
  const dir = temp(); try {
    const store = new ProviderCredentialStore(dir);
    const controller = new AbortController();
    await assert.rejects(store.modify('fake', async () => { controller.abort(); return { type: 'api_key', key: 'secret' }; }, { signal: controller.signal }));
    assert.equal(await store.read('fake'), undefined);
    fs.writeFileSync(path.join(dir, 'provider-credentials.json'), '{"fake":{"type":"oauth","access":"x"}}');
    await assert.rejects(store.read('fake'));
    await assert.rejects(store.modify('__proto__', async () => ({ type: 'api_key', key: 'x' })));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('Pi refresh shares a persisted rotated credential across registry instances', async () => {
  const dir = temp(); try {
    const store = new ProviderCredentialStore(dir);
    await store.modify('fake', async () => ({ type: 'oauth', access: 'old', refresh: 'old-refresh', expires: Date.now() - 10000 }));
    let refreshes = 0;
    const faux = fauxProvider({ provider: 'fake' }).provider;
    const provider = { ...faux, auth: { oauth: {
      name: 'Fake', login: async () => { throw new Error('unused'); },
      refresh: async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 20)); return { type: 'oauth' as const, access: 'new', refresh: 'new-refresh', expires: Date.now() + 3600000 }; },
      toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
    } } };
    const registry = () => { const models = createModels({ credentials: new ProviderCredentialStore(dir), authContext: { env: async () => undefined, fileExists: async () => false } }); models.setProvider(provider); return models; };
    const [first, second] = await Promise.all([registry().getAuth('fake'), registry().getAuth('fake')]);
    assert.equal(refreshes, 1);
    assert.equal(first?.auth.apiKey, 'new');
    assert.equal(second?.auth.apiKey, 'new');
    assert.equal((await store.read('fake'))?.type, 'oauth');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('provider-owned login persists through the Credentials vault and restart', async () => {
  const dir = temp(); try {
    const faux = fauxProvider({ provider: 'fake' }).provider;
    const provider = { ...faux, auth: { oauth: {
      name: 'Fake', login: async () => ({ type: 'oauth' as const, access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000 }),
      refresh: async (credential: { type: 'oauth'; access: string; refresh: string; expires: number }) => credential,
      toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
    } } };
    const registry = createModels({ credentials: new Credentials(dir).providerStore, authContext: { env: async () => undefined, fileExists: async () => false } });
    registry.setProvider(provider);
    const auth = new AuthService(registry);
    const job = auth.start('fake', 'oauth');
    for (let i = 0; i < 100 && auth.get(job.id).state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(auth.get(job.id).state, 'completed');
    assert.equal(JSON.stringify(auth.get(job.id)).includes('synthetic-access'), false);
    const reopened = createModels({ credentials: new Credentials(dir).providerStore, authContext: { env: async () => undefined, fileExists: async () => false } });
    reopened.setProvider(provider);
    assert.equal((await reopened.getAuth('fake'))?.auth.apiKey, 'synthetic-access');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('lock compromise during refresh prevents persistence', async () => {
  const dir = temp();
  const original = lockfile.lock;
  let compromise: ((error: Error) => void) | undefined;
  try {
    lockfile.lock = (async (_file: string, options?: { onCompromised?: (error: Error) => void }) => {
      compromise = options?.onCompromised; return async () => {};
    }) as typeof lockfile.lock;
    const store = new ProviderCredentialStore(dir);
    await assert.rejects(store.modify('fake', async () => {
      compromise?.(new Error('simulated lock compromise'));
      return { type: 'api_key', key: 'must-not-persist' };
    }), /simulated lock compromise/);
    assert.equal(await store.read('fake'), undefined);
  } finally { lockfile.lock = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider vault rejects hard-linked storage files', async () => {
  const dir = temp(); try {
    const target = path.join(dir, 'other.json');
    fs.writeFileSync(target, '{}');
    fs.linkSync(target, path.join(dir, 'provider-credentials.json'));
    const store = new ProviderCredentialStore(dir);
    await assert.rejects(store.read('fake'), /credential_store_redirected/);
    await assert.rejects(store.modify('fake', async () => ({ type: 'api_key', key: 'secret' })), /credential_store_redirected/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
