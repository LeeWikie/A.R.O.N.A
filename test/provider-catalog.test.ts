import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { builtinModels, getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import { createProviderCatalog, providerCatalogGeneratedAt } from '../src/providers/catalog.js';

const options = () => ({
  credentials: new InMemoryCredentialStore(),
  authContext: { env: async (_name: string) => undefined, fileExists: async (_path: string) => false },
});

test('catalog matches upstream provider and all model metadata without ambient credentials', async () => {
  const actual = createProviderCatalog(options());
  const upstream = builtinModels(options());
  assert.deepEqual(actual.getProviders().map(p => p.id), upstream.getProviders().map(p => p.id));
  assert.deepEqual(actual.getAllModels(), upstream.getAllModels());
  assert.equal(providerCatalogGeneratedAt(), getBuiltinModelDataGeneratedAt());
  assert.ok(actual.getModels('openai-codex').length > 0);
  assert.equal(await actual.checkAuth('openai-codex'), undefined);
  assert.deepEqual(actual.getAllModels('not-a-provider'), []);
});
