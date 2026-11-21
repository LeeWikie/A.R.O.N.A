import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveMemoryContextPolicy } from '../src/memory/v1/binding.js';
import { tokenMeasurementSchema } from '../src/memory/v1/contracts.js';
import { createDefaultMemoryContextPolicy, memoryContextPolicySchema } from '../src/memory/v1/policy.js';
import { getMemoryTokenizerIdentity, measureMemoryText } from '../src/memory/v1/tokens.js';

test('纯配置保持 pending，宿主必须显式绑定实际已安装编码器', () => {
  const policy = createDefaultMemoryContextPolicy();
  const identity = getMemoryTokenizerIdentity();
  assert.equal(policy.tokenizer.readiness, 'pending-dependency');
  assert.equal(policy.tokenizer.version, null);
  assert.equal(policy.tokenizer.vocabularyHash, null);
  assert.equal(identity.tokenizerVersion, '1.0.21');
  const prepared = resolveMemoryContextPolicy(policy);
  assert.equal(prepared.tokenizer.readiness, 'ready');
  assert.equal(prepared.tokenizer.version, identity.tokenizerVersion);
  assert.equal(prepared.tokenizer.vocabularyHash, identity.vocabularyHash);
  assert.equal(policy.tokenizer.readiness, 'pending-dependency');
});

test('ready 声明必须具有完整身份，但 schema 通过不代替实际资源校验', () => {
  const base = createDefaultMemoryContextPolicy();
  const identity = getMemoryTokenizerIdentity();
  const ready = {
    ...base,
    tokenizer: { ...base.tokenizer, readiness: 'ready', version: identity.tokenizerVersion, vocabularyHash: identity.vocabularyHash },
  };
  assert.equal(memoryContextPolicySchema.safeParse(ready).success, true);
  assert.deepEqual(resolveMemoryContextPolicy(ready), ready);
  for (const mismatch of [
    { version: 'synthetic-version' },
    { vocabularyHash: '0'.repeat(64) },
    { version: 'synthetic-version', vocabularyHash: 'f'.repeat(64) },
  ]) {
    const changed = { ...ready, tokenizer: { ...ready.tokenizer, ...mismatch } };
    const before = structuredClone(changed);
    assert.equal(memoryContextPolicySchema.safeParse(changed).success, true);
    assert.throws(() => resolveMemoryContextPolicy(changed), /^Error: memory_tokenizer_identity_mismatch$/);
    assert.deepEqual(changed, before);
  }
  for (const invalid of [
    { ...base.tokenizer, readiness: 'ready' },
    { ...ready.tokenizer, version: '' },
    { ...ready.tokenizer, vocabularyHash: 'invalid' },
    { ...ready.tokenizer, vocabularyHash: null },
    { ...base.tokenizer, version: identity.tokenizerVersion },
    { ...base.tokenizer, vocabularyHash: identity.vocabularyHash },
    { ...ready.tokenizer, encoding: 'other' },
    { ...ready.tokenizer, implementation: 'caller-provided' },
    { ...ready.tokenizer, exactForProvider: true },
    { ...ready.tokenizer, modelId: 'claimed-model' },
    { ...ready.tokenizer, tokenizerId: 'claimed-tokenizer' },
  ]) {
    const changed = { ...base, tokenizer: invalid };
    assert.equal(memoryContextPolicySchema.safeParse(changed).success, false);
    assert.throws(() => resolveMemoryContextPolicy(changed));
  }
});

test('绑定保留可调配置且不修改输入，每次返回深冻结独立快照', () => {
  const configuration = createDefaultMemoryContextPolicy();
  configuration.revision = 2;
  configuration.recent.days = 3;
  configuration.recent.textTokens = 2048;
  configuration.recent.maxImages = 0;
  configuration.resident.textTokens = 6144;
  configuration.organization.softTriggerRatio = 0.6;
  configuration.organization.maxCapacityCorrections = 2;
  const before = structuredClone(configuration);
  const prepared = resolveMemoryContextPolicy(configuration);
  const another = resolveMemoryContextPolicy(configuration);
  assert.deepEqual(configuration, before);
  assert.equal(Object.isFrozen(configuration), false);
  assert.equal(Object.isFrozen(configuration.recent), false);
  assert.equal(prepared.revision, 2);
  for (const key of ['recent', 'resident', 'organization'] as const) {
    assert.deepEqual(prepared[key], configuration[key]);
    assert.notStrictEqual(prepared[key], configuration[key]);
    assert.notStrictEqual(prepared[key], another[key]);
    assert.equal(Object.isFrozen(prepared[key]), true);
    assert.throws(() => Object.assign(prepared[key], { extra: true }), TypeError);
  }
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.tokenizer), true);
  assert.notStrictEqual(prepared, another);
  assert.notStrictEqual(prepared.tokenizer, another.tokenizer);
  assert.throws(() => Object.assign(prepared, { revision: 9 }), TypeError);
  assert.throws(() => Object.assign(prepared.tokenizer, { version: 'changed' }), TypeError);
  configuration.recent.days = 1;
  configuration.resident.textTokens = 1024;
  assert.equal(prepared.recent.days, 3);
  assert.equal(prepared.resident.textTokens, 6144);
  assert.equal(createDefaultMemoryContextPolicy().recent.days, 7);
  assert.deepEqual(resolveMemoryContextPolicy(), resolveMemoryContextPolicy(createDefaultMemoryContextPolicy()));
  assert.deepEqual(resolveMemoryContextPolicy(prepared), prepared);
  assert.notStrictEqual(resolveMemoryContextPolicy(prepared), prepared);
});

test('宿主身份与实际计量一致，不采纳调用方伪造的范围、身份或精度', () => {
  const prepared = resolveMemoryContextPolicy();
  const options = Object.freeze({
    modelId: 'claimed-model', scope: 'request', basis: 'provider-usage',
    tokenizerId: 'claimed-tokenizer', tokenizerVersion: 'claimed-version', vocabularyHash: '0'.repeat(64),
    exactForProvider: true, mediaTokens: 123, mediaCostKnown: true,
  });
  const measurement = measureMemoryText('合成图像说明<|endoftext|>', options);
  assert.equal(tokenMeasurementSchema.safeParse(measurement).success, true);
  assert.equal(measurement.tokenizerVersion, prepared.tokenizer.version);
  assert.equal(measurement.vocabularyHash, prepared.tokenizer.vocabularyHash);
  assert.equal(measurement.tokenizerId, getMemoryTokenizerIdentity().tokenizerId);
  assert.equal(measurement.scope, 'final-injection');
  assert.equal(measurement.basis, 'encoding');
  assert.equal(measurement.exactForEncoding, true);
  assert.equal(measurement.exactForProvider, false);
  assert.equal(prepared.tokenizer.exactForProvider, false);
  assert.equal(measurement.mediaCostKnown, false);
  assert.equal(measurement.mediaTokens, null);
});

test('纯配置模块不加载编码资源', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-v1-policy-pure-'));
  const moduleUrl = new URL('../src/memory/v1/policy.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (/js-tiktoken|(?:^|\\/)tokens\\.[jt]s$/.test(specifier)) throw new Error('encoder_import_forbidden');
      return nextResolve(specifier, context);
    } });
    const { createDefaultMemoryContextPolicy, memoryContextPolicySchema } = await import(${JSON.stringify(moduleUrl)});
    const policy = createDefaultMemoryContextPolicy();
    assert.equal(policy.tokenizer.readiness, 'pending-dependency');
    assert.equal(memoryContextPolicySchema.safeParse(policy).success, true);
  `;
  try {
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
      cwd: directory, env: { TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
