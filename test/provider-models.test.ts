import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createModels, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Models } from '../src/models.js';
import { RuntimeStore } from '../src/runtime-store.js';

test('saved provider profiles resolve and execute through the shared Pi registry', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const registry = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const faux = fauxProvider({ provider: 'fake' }); faux.setResponses([fauxAssistantMessage('fixture response')]); registry.setProvider(faux.provider);
    const models = new Models(new RuntimeStore(db), undefined, () => undefined, registry);
    const profile = { id: 'local', name: 'Local', providerId: 'fake', modelId: faux.getModel().id };
    assert.deepEqual(models.save(profile), profile);
    assert.throws(() => models.save({ ...profile, modelId: 'missing' }), /model_not_found/);
    const model = models.resolve('local');
    const generated = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    assert.equal(generated.content.filter(content => content.type === 'text').map(content => content.text).join(''), 'fixture response');
    assert.equal(faux.state.callCount, 1);
    assert.throws(() => models.validateThinking('local', 'high'), /thinking_level_not_supported/);
    assert.deepEqual(models.options('local', 'off'), {});
  } finally { db.close(); }
});

test('provider reasoning levels use Pi capability metadata', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const registry = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const faux = fauxProvider({ provider: 'fake', models: [{ id: 'reasoner', reasoning: true }] }); registry.setProvider(faux.provider);
    const models = new Models(new RuntimeStore(db), undefined, () => undefined, registry);
    models.save({ id: 'think', name: 'Think', providerId: 'fake', modelId: 'reasoner' });
    assert.deepEqual(models.options('think', 'high'), { providerOptions: { pi: { reasoning: 'high' } } });
    assert.throws(() => models.validateThinking('think', 'max'), /thinking_level_not_supported/);
  } finally { db.close(); }
});

test('Mastra agent executes a tool round through a provider profile', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const { createTool } = await import('@mastra/core/tools');
  const { z } = await import('zod');
  const { fauxToolCall } = await import('@earendil-works/pi-ai');
  const db = new DatabaseSync(':memory:');
  try {
    const registry = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const faux = fauxProvider({ provider: 'fake' });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('fixture_tool', { value: 'hello' }, { id: 'tool-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('finished'),
    ]);
    registry.setProvider(faux.provider);
    const models = new Models(new RuntimeStore(db), undefined, () => undefined, registry);
    models.save({ id: 'fixture', name: 'Fixture', providerId: 'fake', modelId: faux.getModel().id });
    let called = 0;
    const agent = new Agent({ id: 'provider-fixture', name: 'Fixture', instructions: 'Use the tool.', model: models.resolve('fixture'),
      tools: { fixture_tool: createTool({ id: 'fixture_tool', description: 'A synthetic tool.', inputSchema: z.object({ value: z.string() }), execute: async input => { called++; return { value: input.value }; } }) },
    });
    const result = await agent.generate('hello', { maxSteps: 3 });
    assert.equal(called, 1);
    assert.equal(result.text, 'finished');
    assert.equal(faux.state.callCount, 2);
  } finally { db.close(); }
});

test('Mastra streams a response through a provider profile', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const db = new DatabaseSync(':memory:');
  try {
    const registry = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const faux = fauxProvider({ provider: 'fake' }); faux.setResponses([fauxAssistantMessage('streamed response')]); registry.setProvider(faux.provider);
    const models = new Models(new RuntimeStore(db), undefined, () => undefined, registry);
    models.save({ id: 'fixture', name: 'Fixture', providerId: 'fake', modelId: faux.getModel().id });
    const agent = new Agent({ id: 'stream-fixture', name: 'Fixture', instructions: 'Reply.', model: models.resolve('fixture') });
    const result = await agent.stream('hello');
    let text = '';
    for await (const chunk of result.textStream) text += chunk;
    assert.equal(text, 'streamed response');
  } finally { db.close(); }
});

test('provider default thinking is validated and explicit session levels override it', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const registry = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const faux = fauxProvider({ provider: 'fake', models: [{ id: 'reasoner', reasoning: true }] }); registry.setProvider(faux.provider);
    const models = new Models(new RuntimeStore(db), undefined, () => undefined, registry);
    const profile = { id: 'think', name: 'Think', providerId: 'fake', modelId: 'reasoner', defaultThinkingLevel: 'high' };
    assert.deepEqual(models.save(profile), profile);
    assert.deepEqual(models.options('think'), { providerOptions: { pi: { reasoning: 'high' } } });
    assert.deepEqual(models.options('think', 'low'), { providerOptions: { pi: { reasoning: 'low' } } });
    assert.deepEqual(models.options('think', 'off'), {});
    models.save({ ...profile, defaultThinkingLevel: 'max' });
    assert.equal(models.thinking('think').requestedThinkingLevel,'max');assert.equal(models.thinking('think').thinkingLevel,'high');
    assert.deepEqual(models.options('think'),{providerOptions:{pi:{reasoning:'high'}}});
    models.save({ ...profile, defaultThinkingLevel: 'minimal' });
    assert.deepEqual(models.options('think', 'minimal'),{providerOptions:{pi:{reasoning:'minimal'}}});
    assert.deepEqual(models.profile('think'), {...profile,defaultThinkingLevel:'minimal'});
    models.save({ ...profile, defaultThinkingLevel: 'off' });
    assert.deepEqual(models.options('think'), {});
    models.save({ id: 'think', name: 'Think', providerId: 'fake', modelId: 'reasoner' });
    assert.deepEqual(models.options('think'), {providerOptions:{pi:{reasoning:'medium'}}});
  } finally { db.close(); }
});

test('startup model can be edited through a secret-free profile without dropping its default thinking',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const models=new Models(new RuntimeStore(db),{protocol:'responses',baseURL:'https://example.invalid/v1',modelId:'fixture',apiKey:'synthetic-seed-secret',authHeader:'bearer',reasoningEffort:'high'},()=>undefined);
  const profile=models.configurationProfiles()[0]!;assert.ok('apiKeyEnv' in profile);
  assert.equal(profile.apiKeyEnv,'SHITTIMCHEST_STARTUP_MODEL_KEY');assert.equal(profile.defaultThinkingLevel,'high');assert.ok(!JSON.stringify(models.configurationProfiles()).includes('synthetic-seed-secret'));
  models.save({...profile,name:'Edited startup model'});assert.ok(models.resolve('default'));
  assert.deepEqual(models.options('default'),{providerOptions:{openai:{store:false,include:['reasoning.encrypted_content'],reasoningEffort:'high'}}});
  models.save({...profile,defaultThinkingLevel:'low'});
  assert.equal(models.thinking('default').requestedThinkingLevel,'low');assert.equal(models.thinking('default').thinkingLevel,'high');
  assert.equal(models.options('default').providerOptions?.openai?.reasoningEffort,'high');
 }finally{db.close();}
});
