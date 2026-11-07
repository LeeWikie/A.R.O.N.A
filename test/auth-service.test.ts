import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { AuthService } from '../src/auth.js';

function fixture() {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = fauxProvider({ provider: 'fake' }).provider;
  models.setProvider({ ...provider, auth: { oauth: {
    name: 'Fake OAuth',
    login: async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://example.invalid/auth' });
      const code = await interaction.prompt({ type: 'manual_code', message: 'Enter code' });
      return { type: 'oauth', access: code, refresh: 'fake-refresh', expires: Date.now() + 3600000 };
    },
    refresh: async credential => credential,
    toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  return { auth: new AuthService(models), credentials };
}

test('provider login uses upstream orchestration, hides responses and persists fake credential', async () => {
  const { auth, credentials } = fixture();
  const started = auth.start('fake', 'oauth');
  assert.equal(auth.get(started.id).prompt?.type, 'manual_code');
  assert.equal(auth.get(started.id).event?.type, 'auth_url');
  assert.equal(JSON.stringify(auth.respond(started.id, 'fake-secret', started.promptId!)).includes('fake-secret'), false);
  for (let i = 0; i < 20 && auth.get(started.id).state === 'running'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(auth.get(started.id).state, 'completed');
  assert.equal(JSON.stringify(auth.get(started.id)).includes('fake-secret'), false);
  assert.equal((await credentials.read('fake'))?.type, 'oauth');
  assert.equal((await auth.status('fake')).configured, true);
});

test('cancellation clears a pending prompt and persists nothing', async () => {
  const { auth, credentials } = fixture();
  const started = auth.start('fake', 'oauth');
  const cancelled = auth.cancel(started.id);
  assert.equal(cancelled.state, 'cancelling');
  assert.equal(cancelled.prompt, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(auth.get(started.id).state, 'cancelled');
  assert.equal(await credentials.read('fake'), undefined);
});

test('cancellation during an already-started credential write reports its actual result', async () => {
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const credentials = new InMemoryCredentialStore();
  const store = {
    read: credentials.read.bind(credentials), list: credentials.list.bind(credentials), delete: credentials.delete.bind(credentials),
    modify: credentials.modify.bind(credentials),
  };
  const modify = store.modify;
  store.modify = (providerId, fn, options) => modify(providerId, async current => {
    const next = await fn(current); started(); await gate; return next;
  }, options);
  const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = fauxProvider({ provider: 'fake' }).provider;
  models.setProvider({ ...provider, auth: { oauth: {
    name: 'Fake OAuth', login: async () => ({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 }),
    refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  const auth = new AuthService(models);
  const job = auth.start('fake', 'oauth');
  await writing;
  assert.equal(auth.cancel(job.id).state, 'cancelling');
  release();
  for (let i = 0; i < 20 && auth.get(job.id).state === 'cancelling'; i++) await new Promise(resolve => setImmediate(resolve));
  // Pi's in-memory store observes abort before committing; another store may instead finish its write.
  assert.equal(auth.get(job.id).state, 'cancelled');
  assert.equal(await credentials.read('fake'), undefined);
});

test('ordered events retain authorization information until cancellation and strip extra fields', async () => {
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = fauxProvider({ provider: 'fake' }).provider;
  models.setProvider({ ...provider, auth: { oauth: {
    name: 'Fake OAuth', login: async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://example.invalid/auth', credential: 'not-visible' } as never);
      interaction.notify({ type: 'device_code', userCode: 'ABC', verificationUri: 'https://example.invalid/device' });
      interaction.notify({ type: 'progress', message: 'Waiting' });
      await interaction.prompt({ type: 'manual_code', message: 'Code' });
      return { type: 'oauth', access: 'private', refresh: 'private', expires: Date.now() + 3600000 };
    }, refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  const auth = new AuthService(models); const started = auth.start('fake', 'oauth');
  assert.equal(started.event?.type, 'progress');
  assert.deepEqual(started.events.map(item => [item.sequence, item.event.type]), [[1, 'auth_url'], [2, 'device_code'], [3, 'progress']]);
  assert.equal(started.eventCursor, 3);
  assert.equal(JSON.stringify(started).includes('not-visible'), false);
  started.events.length = 0;
  assert.equal(auth.get(started.id).events.length, 3);
  const cancelled = auth.cancel(started.id);
  assert.deepEqual(cancelled.events, []); assert.equal(cancelled.event, undefined);
  await auth.close();
  assert.equal(auth.get(started.id).state, 'cancelled');
});

test('only one response can settle a pending prompt and completed jobs clear events', async () => {
  const { auth } = fixture(); const job = auth.start('fake', 'oauth');
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => auth.respond(job.id, 'first-secret', job.promptId!)),
    Promise.resolve().then(() => auth.respond(job.id, 'second-secret', job.promptId!)),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  await auth.close();
  const view = auth.get(job.id);
  assert.ok(view.state === 'completed' || view.state === 'cancelled');
  assert.deepEqual(view.events, []); assert.equal(view.prompt, undefined); assert.equal(view.event, undefined);
  assert.equal(JSON.stringify(view).includes('secret'), false);
});

test('per-prompt abort expires a prompt and close awaits Pi cancellation', async () => {
  let abortPrompt!: () => void; let release!: () => void; let entered!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const finishGate = new Promise<void>(resolve => { release = resolve; });
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = fauxProvider({ provider: 'fake' }).provider;
  models.setProvider({ ...provider, auth: { oauth: {
    name: 'Fake OAuth', login: async interaction => {
      const signal = new AbortController(); abortPrompt = () => signal.abort();
      try { await interaction.prompt({ type: 'manual_code', message: 'Code', signal: signal.signal }); } catch { entered(); }
      await finishGate;
      throw new Error('end');
    }, refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  const auth = new AuthService(models); const job = auth.start('fake', 'oauth');
  abortPrompt(); await enteredGate;
  assert.equal(auth.get(job.id).prompt, undefined);
  assert.throws(() => auth.respond(job.id, 'too-late', job.promptId!), /auth_prompt_not_pending/);
  let closed = false; const closing = auth.close().then(() => { closed = true; });
  await closing; assert.equal(closed, true);
  assert.throws(() => auth.start('fake', 'oauth'), /auth_service_closed/);
  release();
  assert.equal(auth.get(job.id).state, 'cancelled');
});


test('close waits for a credential mutation that already started', async () => {
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  const credentials = new InMemoryCredentialStore();
  const store = { read: credentials.read.bind(credentials), list: credentials.list.bind(credentials), delete: credentials.delete.bind(credentials),
    modify: credentials.modify.bind(credentials) };
  store.modify = async (_id, fn) => { const value = await fn(undefined); started(); await gate; return value; }; 
  const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = fauxProvider({ provider: 'fake' }).provider;
  models.setProvider({ ...provider, auth: { oauth: { name: 'Fake',
    login: async () => ({ type: 'oauth', access: 'private', refresh: 'private', expires: Date.now() + 3600000 }),
    refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  const auth = new AuthService(models); const job = auth.start('fake', 'oauth'); await writing;
  let closed = false; const closing = auth.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await closing; assert.equal(auth.get(job.id).state, 'completed');
});

test('stale prompt IDs cannot answer an identical subsequent prompt', async () => {
  let firstResponse = ''; let secondResponse = '';
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = fauxProvider({ provider: 'fake' }).provider;
  models.setProvider({ ...provider, auth: { oauth: {
    name: 'Fake', login: async interaction => {
      firstResponse = await interaction.prompt({ type: 'manual_code', message: 'Code' });
      secondResponse = await interaction.prompt({ type: 'manual_code', message: 'Code' });
      return { type: 'oauth', access: 'private', refresh: 'private', expires: Date.now() + 3600000 };
    }, refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  const auth = new AuthService(models); const first = auth.start('fake', 'oauth');
  assert.ok(first.promptId);
  assert.throws(() => auth.respond(first.id, 'missing', undefined as never), /auth_prompt_not_pending/);
  auth.respond(first.id, 'one', first.promptId);
  await new Promise(resolve => setImmediate(resolve));
  const second = auth.get(first.id); assert.deepEqual(second.prompt, first.prompt); assert.ok(second.promptId); assert.notEqual(second.promptId, first.promptId);
  assert.throws(() => auth.respond(first.id, 'late', first.promptId!), /auth_prompt_not_pending/);
  assert.equal(auth.get(first.id).promptId, second.promptId);
  auth.respond(first.id, 'two', second.promptId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstResponse, 'one'); assert.equal(secondResponse, 'two');
  assert.equal(auth.get(first.id).promptId, undefined);
  assert.throws(() => auth.respond(first.id, 'late', second.promptId!), /auth_prompt_not_pending/);
  await auth.close();
});
