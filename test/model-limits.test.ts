import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Models } from '../src/models.js';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';

test('custom context metadata survives profile storage without inferring limits from names', () => {
  const store = new Store(':memory:');
  try {
    const models = new Models(new RuntimeStore(store.db));
    const profile = { id: 'custom', name: 'Custom', protocol: 'responses', baseURL: 'http://127.0.0.1:8000/v1', modelId: 'huge-context-model', apiKeyEnv: 'SYNTHETIC_KEY' };
    models.save(profile);
    assert.deepEqual(models.limits('custom'), { contextWindow: null, maxTokens: null, source: 'unknown' });
    models.save({ ...profile, contextWindow: 32000, maxTokens: 4000 });
    assert.deepEqual(models.limits('custom'), { contextWindow: 32000, maxTokens: 4000, source: 'profile' });
    assert.equal((models.list()[0] as { contextWindow: number }).contextWindow, 32000);
    for (const value of [0, -1, 3.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => models.save({ ...profile, contextWindow: value }), /invalid_model_profile/);
  } finally { store.close(); }
});

test('startup context limits can be configured and carried into a saved profile', () => {
  const env = { SHITTIMCHEST_MODEL_PROTOCOL: 'responses', SHITTIMCHEST_MODEL_BASE_URL: 'http://127.0.0.1:8000/v1', SHITTIMCHEST_MODEL_ID: 'synthetic', SHITTIMCHEST_MODEL_API_KEY: 'synthetic-only', SHITTIMCHEST_MODEL_CONTEXT_WINDOW: '64000', SHITTIMCHEST_MODEL_MAX_OUTPUT_TOKENS: '8000' };
  const config = readConfig(env);
  const store = new Store(':memory:');
  try {
    const models = new Models(new RuntimeStore(store.db), config.model);
    assert.deepEqual(models.limits('default'), { contextWindow: 64000, maxTokens: 8000, source: 'profile' });
    assert.throws(() => readConfig({ ...env, SHITTIMCHEST_MODEL_CONTEXT_WINDOW: 'not-a-number' }), /invalid_model_configuration/);
  } finally { store.close(); }
});
