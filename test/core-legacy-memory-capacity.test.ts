import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { APICallError } from '@ai-sdk/provider';
import { getEncoding } from 'js-tiktoken';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { finished, removeTemp } from './helpers.js';

test('a large retained memory archive cannot prevent a fresh ordinary conversation', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-legacy-memory-capacity-'));
  const archive = path.join(directory, 'memory/versions/initial/archive/2025-experiences.md');
  const content = 'SYNTHETIC_ORIGINAL_ARCHIVE\n' + '过去的完整经历与原始条件。\n'.repeat(20000) + 'SYNTHETIC_ARCHIVE_END';
  fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 }); fs.writeFileSync(archive, content, { mode: 0o600 });
  const digest = () => createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const before = digest(); let calls = 0;
  const encoding = getEncoding('o200k_base');
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    calls++;
    const inputTokens = encoding.encode(JSON.stringify(request.prompt)).length;
    if (inputTokens > 40000) throw new APICallError({ message: 'maximum context length exceeded', url: 'https://fixture.invalid/v1', requestBodyValues: { inputTokens, contextWindow: 40000 }, statusCode: 400, responseBody: '{"error":{"code":"context_length_exceeded"}}', isRetryable: false });
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: '你好' }); controller.enqueue({ type: 'text-end', id: 'reply' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: directory, model, memoryEnabled: false, modelConfig: { protocol: 'responses', baseURL: 'https://fixture.invalid/v1', modelId: 'synthetic', apiKey: 'synthetic-only', authHeader: 'bearer', contextWindow: 40000, maxTokens: 1024 } });
  try {
    const receipt = await core.submitMessage({ content: '你好，这次只需要打个招呼。' });
    const run = await finished(core, receipt.runId!);
    assert.equal(run!.status, 'succeeded', run!.errorCode ?? undefined);
    assert.ok(calls > 0); assert.equal(digest(), before);
    assert.equal(core.projectMemory.version().id, 'initial');
  } finally { await core.close(); await removeTemp(directory); }
});

test('Main can naturally search and read the end of its frozen legacy archive without workspace or write permission', {timeout: 30000}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-legacy-memory-recall-'));
  const file = path.join(directory, 'memory/versions/initial/archive/facts.md');
  const original = '原始归档与事实条件。🙂\n'.repeat(24000) + '\nSYNTHETIC_ARCHIVE_END: 用户已更正为红色。';
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, original);
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex'), encoding = getEncoding('o200k_base');
  let phase = 0;
  function find(value: unknown): {path: string; matchOffset: number} | undefined {
    if (typeof value === 'string') {try {return find(JSON.parse(value));} catch {return;}}
    if (!value || typeof value !== 'object') return;
    if ('matchOffset' in value && 'path' in value && typeof value.matchOffset === 'number' && typeof value.path === 'string') return value as {path: string; matchOffset: number};
    for (const child of Object.values(value)) {const found = find(child); if (found) return found;}
  }
  const model = new MastraLanguageModelV2Mock({doStream: async request => {
    assert.ok(encoding.encode(JSON.stringify(request.prompt)).length < 40000);
    const names = request.tools?.map(tool => tool.name) ?? []; assert.ok(names.includes('memory_read')); assert.ok(!names.includes('memory_write'));
    let action: {toolName: string; toolCallId: string; input: string} | undefined;
    if (phase++ === 0) action = {toolName: 'memory_search', toolCallId: 'natural-search', input: JSON.stringify({query: 'SYNTHETIC_ARCHIVE_END'})};
    else if (phase === 2) {
      const match = find(request.prompt); assert.ok(match); assert.equal(match.path, 'archive/facts.md');
      action = {toolName: 'memory_read', toolCallId: 'natural-recall', input: JSON.stringify({path: match.path, offset: match.matchOffset})};
    } else assert.match(JSON.stringify(request.prompt), /SYNTHETIC_ARCHIVE_END: 用户已更正为红色/);
    return {stream: new ReadableStream({start(controller) {
      controller.enqueue({type: 'stream-start', warnings: []});
      if (action) controller.enqueue({type: 'tool-call', ...action});
      else {controller.enqueue({type: 'text-start', id: 'answer'}); controller.enqueue({type: 'text-delta', id: 'answer', delta: '记忆原文中的更正是红色。'}); controller.enqueue({type: 'text-end', id: 'answer'});}
      controller.enqueue({type: 'finish', finishReason: action ? 'tool-calls' : 'stop', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2}}); controller.close();
    }})};
  }});
  const core = await Core.open({dataDir: directory, model, memoryEnabled: false, modelConfig: {protocol: 'responses', baseURL: 'https://fixture.invalid/v1', modelId: 'synthetic', apiKey: 'synthetic-only', authHeader: 'bearer', contextWindow: 40000, maxTokens: 1024}});
  try {
    const receipt = await core.submitMessage({content: '查一下旧记忆末尾的 SYNTHETIC_ARCHIVE_END，更正是什么？'}), run = await finished(core, receipt.runId!);
    assert.equal(run!.status, 'succeeded', run!.errorCode ?? undefined); assert.equal(phase, 3);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
    assert.ok(core.projectMemory.resident({runId: receipt.runId!}).legacyViewId);
  } finally {await core.close(); await removeTemp(directory);}
});
