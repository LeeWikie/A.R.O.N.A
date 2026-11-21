import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createModels, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Models } from '../src/models.js';
import { RuntimeStore } from '../src/runtime-store.js';

test('image policy follows the selected exact native descriptor and leaves unknown custom endpoints unknown', () => {
  const db = new DatabaseSync(':memory:');
  const provider = fauxProvider({ provider: 'synthetic-images', models: [{ id: 'vision', input: ['text', 'image'] }, { id: 'text', input: ['text'] }] });
  const descriptor = provider.getModel('vision')!;
  descriptor.inputLimits = { images: { resize: { maxWidth: 1000, maxHeight: 500, maxBytes: 4096 } } };
  const registry = createModels({ credentials: new InMemoryCredentialStore() }); registry.setProvider(provider.provider);
  const models = new Models(new RuntimeStore(db), undefined, () => undefined, registry);
  try {
    models.save({ id: 'vision-profile', name: 'Vision', providerId: 'synthetic-images', modelId: 'vision' });
    models.save({ id: 'text-profile', name: 'Text', providerId: 'synthetic-images', modelId: 'text' });
    const frozen = models.imageReadOptions('vision-profile'); assert.equal(frozen.supportsImages, true); assert.equal(frozen.resizeOptions?.maxWidth, 1000);
    descriptor.inputLimits.images!.resize!.maxWidth = 400;
    assert.equal(frozen.resizeOptions?.maxWidth, 1000); assert.equal(models.imageReadOptions('vision-profile').resizeOptions?.maxWidth, 400);
    assert.deepEqual(models.imageReadOptions('text-profile'), { supportsImages: false });
    models.save({ id: 'custom', name: 'Unknown proxy', protocol: 'chat-completions', baseURL: 'https://unknown.example.invalid/v1', modelId: 'vision', apiKeyEnv: 'SYNTHETIC_KEY' });
    assert.deepEqual(models.imageReadOptions('custom'), {}); assert.deepEqual(models.imageReadOptions('missing'), {});
    if (descriptor.api === 'openai-completions' && /^https?:/.test(descriptor.baseUrl)) {
      models.save({ id: 'exact', name: 'Exact native address', protocol: 'chat-completions', baseURL: descriptor.baseUrl, modelId: descriptor.id, apiKeyEnv: 'SYNTHETIC_KEY' });
      assert.equal(models.imageReadOptions('exact').supportsImages, true);
    }
  } finally { models.close(); db.close(); }
});
