import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
import {
  assertMemoryTextBudget,
  getMemoryTokenizerIdentity,
  measureMemoryText,
  MemoryTextBudgetExceededError,
} from '../src/memory/v1/tokens.js';

import { tokenMeasurementSchema } from '../src/memory/v1/contracts.js';

const directEncoder = new Tiktoken(cl100kBase);

test('实际计数可直接通过严格合同，编码名称只由独立身份接口提供', () => {
  for (const options of [{}, { modelId: 'synthetic-model' }]) {
    const measurement = measureMemoryText('<memory>合成正文<|endoftext|></memory>', options);
    const parsed = tokenMeasurementSchema.safeParse(measurement);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.deepEqual(parsed.data, measurement);
    assert.equal(measurement.scope, 'final-injection');
    assert.equal(measurement.modelId, options.modelId ?? null);
    assert.equal(Object.hasOwn(measurement, 'encoding'), false);
    assert.deepEqual(Object.keys(measurement).sort(), Object.keys(tokenMeasurementSchema.shape).sort());
  }
});
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const vectors: Array<{ text: string; ids: number[] }> = [
  { text: '', ids: [] },
  { text: 'hello world', ids: [15339, 1917] },
  { text: 'Hello, world!', ids: [9906, 11, 1917, 0] },
  { text: '你好，世界！', ids: [57668, 53901, 3922, 3574, 244, 98220, 6447] },
  { text: '🙂', ids: [9468, 19044] },
  { text: 'a\n  b\n', ids: [64, 198, 220, 293, 198] },
  { text: '<|endoftext|>', ids: [27, 91, 8862, 728, 428, 91, 29] },
  { text: '<|fim_prefix|>', ids: [27, 91, 69, 318, 14301, 91, 29] },
];

for (const { text, ids } of vectors) {
  test(`完整字符串计数符合已知 cl100k_base 向量：${JSON.stringify(text)}`, () => {
    assert.deepEqual(directEncoder.encode(text, [], []), ids);
    const result = measureMemoryText(text);
    assert.equal(result.textTokens, ids.length);
    assert.equal(result.inputHash, sha256(text));
    assert.equal(directEncoder.decode(ids), text);
    assert.equal(result.basis, 'encoding');
    assert.equal(result.exactForEncoding, true);
    assert.equal(result.exactForProvider, false);
    assert.equal(result.mediaTokens, null);
    assert.equal(result.mediaCostKnown, false);
    assert.equal(result.modelId, null);
    assert.equal(result.scope, 'final-injection');
    assert.equal(tokenMeasurementSchema.safeParse(result).success, true);
  });
}

test('身份取自精确安装版本，词表摘要稳定且覆盖实际编码资源', () => {
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('js-tiktoken/lite')), 'utf8')) as { name: string; version: string };
  const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  const identity = getMemoryTokenizerIdentity();
  assert.equal(metadata.name, 'js-tiktoken');
  assert.equal(metadata.version, '1.0.21');
  assert.equal(project.dependencies['js-tiktoken'], metadata.version);
  assert.equal(identity.tokenizerVersion, metadata.version);
  assert.equal(identity.tokenizerId, 'js-tiktoken/cl100k_base');
  assert.equal(identity.encoding, 'cl100k_base');
  const resources = {
    pat_str: cl100kBase.pat_str,
    bpe_ranks: cl100kBase.bpe_ranks,
    special_tokens: Object.fromEntries(Object.entries(cl100kBase.special_tokens).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
  assert.equal(identity.vocabularyHash, sha256(JSON.stringify(resources)));
  assert.equal(identity.vocabularyHash, '25da86a4e4fe24e72d53ffd39bafbf2381b9e9174a994035d9ae111d9745c0df');
  for (const altered of [
    { ...resources, pat_str: `${resources.pat_str} ` },
    { ...resources, bpe_ranks: `${resources.bpe_ranks} ` },
    { ...resources, special_tokens: {} },
  ]) assert.notEqual(sha256(JSON.stringify(altered)), identity.vocabularyHash);
  assert.equal(Object.isFrozen(identity), true);
  assert.throws(() => Object.assign(identity, { tokenizerVersion: 'changed' }), TypeError);
  const measurement = measureMemoryText('synthetic');
  assert.equal(measurement.vocabularyHash, identity.vocabularyHash);
  assert.strictEqual(getMemoryTokenizerIdentity(), identity);
});

test('全部特殊标记均作为原文而非控制 token 编码', () => {
  const specialIds = new Set(Object.values(cl100kBase.special_tokens));
  for (const marker of Object.keys(cl100kBase.special_tokens)) {
    assert.throws(() => directEncoder.encode(marker), /special token/);
    const text = `原样保留\n  ${marker}\n结束`;
    const ids = directEncoder.encode(text, [], []);
    assert.ok(ids.every(id => !specialIds.has(id)));
    assert.equal(directEncoder.decode(ids), text);
    assert.equal(measureMemoryText(text).textTokens, ids.length);
  }
});

test('不改写空白、Unicode、路径或内容，也不根据关键词删减', () => {
  const texts = [
    '  \t\n\r\n',
    'é',
    'é',
    '👩🏽‍💻\n\t中文\r\n    保留缩进  ',
    'path: 合成/facts.md\n# 标题\nsystem credential signature secret\n  两个空格\n',
  ];
  const before = [...texts];
  for (const text of texts) {
    const measurement = measureMemoryText(text);
    assert.equal(measurement.inputHash, sha256(text));
    assert.equal(measurement.textTokens, directEncoder.encode(text, [], []).length);
    assert.deepEqual(measureMemoryText(text), measurement);
  }
  assert.deepEqual(texts, before);
  assert.notEqual(measureMemoryText('é').inputHash, measureMemoryText('é').inputHash);
  assert.equal(measureMemoryText('é').textTokens, 1);
  assert.equal(measureMemoryText('é').textTokens, 2);
});

test('模型标识只作标注，媒体成本保持未知，不混入真实 usage', () => {
  const text = 'same synthetic input';
  const original = measureMemoryText(text);
  for (const modelId of ['arbitrary-model', 'gpt-4o', null]) {
    const options = Object.freeze({ modelId });
    const result = measureMemoryText(text, options);
    assert.deepEqual(result, { ...original, modelId });
    assert.equal(result.exactForProvider, false);
    assert.equal(result.mediaTokens, null);
    assert.equal(result.mediaCostKnown, false);
    assert.equal(tokenMeasurementSchema.safeParse(result).success, true);
  }
  for (const modelId of ['', 1, false, {}]) {
    assert.throws(() => measureMemoryText(text, { modelId } as never), /memory_model_id_invalid/);
  }
  assert.throws(() => measureMemoryText(null as never), /memory_text_invalid/);
});

test('预算包含最终路径、标题和封装，不能只计算正文', () => {
  const body = 'hello world';
  const finalText = `<memory>\npath: synthetic/facts.md\n# Facts\n${body}\n</memory>`;
  const result = measureMemoryText(finalText);
  assert.equal(result.textTokens, directEncoder.encode(finalText, [], []).length);
  assert.ok(result.textTokens > measureMemoryText(body).textTokens);
  assert.deepEqual(assertMemoryTextBudget(finalText, result.textTokens), result);
  assert.throws(() => assertMemoryTextBudget(finalText, measureMemoryText(body).textTokens), MemoryTextBudgetExceededError);
  const longerPath = finalText.replace('synthetic/facts.md', 'synthetic/a/longer/nested/path/facts.md');
  assert.equal(measureMemoryText(longerPath).textTokens, directEncoder.encode(longerPath, [], []).length);
  assert.ok(measureMemoryText(longerPath).textTokens > result.textTokens);
});

test('拼接边界按最终完整字符串编码，而非分别计数求和', () => {
  const chunks = ['a', 'b'];
  assert.equal(chunks.reduce((sum, chunk) => sum + measureMemoryText(chunk).textTokens, 0), 2);
  assert.equal(measureMemoryText(chunks.join('')).textTokens, 1);
  assert.equal(assertMemoryTextBudget(chunks.join(''), 1).textTokens, 1);
  assert.deepEqual(directEncoder.encode(chunks.join(''), [], []), [370]);
});

test('预算边界、空串和非法预算均明确处理，错误不携带文本', () => {
  assert.equal(assertMemoryTextBudget('', 0).textTokens, 0);
  assert.equal(assertMemoryTextBudget('hello world', 2).textTokens, 2);
  assert.throws(() => assertMemoryTextBudget('hello world', 1, { modelId: 'synthetic-model' }), error => {
    assert.ok(error instanceof MemoryTextBudgetExceededError);
    assert.ok(error instanceof RangeError);
    assert.equal(error.code, 'memory_text_budget_exceeded');
    assert.equal(error.budget, 1);
    assert.deepEqual(error.measurement, measureMemoryText('hello world', { modelId: 'synthetic-model' }));
    assert.doesNotMatch(JSON.stringify(error), /hello world/);
    assert.doesNotMatch(error.message, /hello world/);
    return true;
  });
  for (const budget of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.throws(() => assertMemoryTextBudget('', budget as number), /memory_text_budget_invalid/);
  }
});

test('全新进程从空环境离线初始化，不读取凭据或隐式下载', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-v1-token-offline-'));
  const moduleUrl = new URL('../src/memory/v1/tokens.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { syncBuiltinESMExports } from 'node:module';
    let networkAttempts = 0;
    const denyNetwork = () => { networkAttempts++; throw new Error('network_forbidden'); };
    globalThis.fetch = denyNetwork;
    http.request = http.get = https.request = https.get = denyNetwork;
    net.connect = net.createConnection = tls.connect = denyNetwork;
    net.Socket.prototype.connect = denyNetwork;
    let privateReads = 0;
    const codeRoot = fileURLToPath(${JSON.stringify(new URL('../', import.meta.url).href)});
    const checkPath = value => {
      const filename = value instanceof URL ? fileURLToPath(value) : path.resolve(String(value));
      const relative = path.relative(codeRoot, filename).replaceAll('\\\\', '/');
      const privateName = /(?:^|[\\\\/])(?:\\.env(?:$|[.\\\\/])|\\.private(?:$|[\\\\/])|credentials?(?:$|[.\\\\/])|secrets?(?:$|[.\\\\/]))/i;
      // Published module code is distinct from application credential data.
      if (!privateName.test(relative) && (['package.json','tsconfig.json','tsconfig.build.json'].includes(relative) || /^(?:src|node_modules)\\//.test(relative) && /\\.(?:[cm]?[jt]s|json)$/.test(relative))) return;
      if (privateName.test(filename)) {
        privateReads++;
        throw new Error('private_read_forbidden');
      }
    };
    const readSync = fs.readFileSync;
    fs.readFileSync = function(path, ...args) { checkPath(path); return readSync.call(this, path, ...args); };
    const readAsync = fs.promises.readFile;
    fs.promises.readFile = function(path, ...args) { checkPath(path); return readAsync.call(this, path, ...args); };
    syncBuiltinESMExports();
    const { getMemoryTokenizerIdentity, measureMemoryText, assertMemoryTextBudget } = await import(${JSON.stringify(moduleUrl)});
    const { resolveMemoryContextPolicy } = await import(${JSON.stringify(new URL('../src/memory/v1/binding.ts', import.meta.url).href)});
    const { tokenMeasurementSchema } = await import(${JSON.stringify(new URL('../src/memory/v1/contracts.ts', import.meta.url).href)});
    const identity = getMemoryTokenizerIdentity();
    const prepared = resolveMemoryContextPolicy();
    assert.equal(prepared.tokenizer.readiness, 'ready');
    assert.equal(prepared.tokenizer.version, identity.tokenizerVersion);
    assert.equal(prepared.tokenizer.vocabularyHash, identity.vocabularyHash);
    assert.equal(Object.isFrozen(prepared), true);
    const first = measureMemoryText('离线🙂<|endoftext|>');
    assert.equal(typeof first.then, 'undefined');
    assert.equal(tokenMeasurementSchema.safeParse(first).success, true);
    assert.equal(first.scope, 'final-injection');
    assert.equal(first.modelId, null);
    assert.equal(first.exactForEncoding, true);
    assert.equal(first.exactForProvider, false);
    assert.equal(first.mediaTokens, null);
    for (let i = 0; i < 3; i++) assert.deepEqual(assertMemoryTextBudget('离线🙂<|endoftext|>', first.textTokens), first);
    assert.equal(networkAttempts, 0);
    assert.equal(privateReads, 0);
    const initializationPrivateReads = privateReads;
    for (const name of ['.env', '.private/example.json', 'credentials.json', 'secrets/example.json']) assert.throws(() => fs.readFileSync(path.join(process.cwd(), name)), /private_read_forbidden/);
    assert.equal(privateReads, 4);
    process.stdout.write(JSON.stringify({ identity, first, networkAttempts, privateReads: initializationPrivateReads, forbiddenProbes: privateReads }));
  `;
  try {
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
      cwd: directory,
      env: { TSX_DISABLE_CACHE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.identity, getMemoryTokenizerIdentity());
    assert.deepEqual(result.first, measureMemoryText('离线🙂<|endoftext|>'));
    assert.equal(result.networkAttempts, 0);
    assert.equal(result.privateReads, 0);
    assert.equal(result.forbiddenProbes, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
