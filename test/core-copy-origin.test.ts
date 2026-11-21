import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import type { ContextSnapshot } from '../src/memory/index.js';
import type { MemoryEvidence } from '../src/memory/evidence.js';
import { finished, until, removeTemp } from './helpers.js';

function fixture() {
  const prompts: unknown[] = []; const sourcePrompts: unknown[] = []; const commits = new Set<string>(); let reads: string[] = [];
  const model = new MastraLanguageModelV2Mock({
    doStream: async request => {
      sourcePrompts.push(request.prompt); const target = reads.shift();
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        if (target) c.enqueue({ type: 'tool-call', toolName: 'context_history', toolCallId: `read-${sourcePrompts.length}`, input: JSON.stringify({ id: target, page: 0 }) });
        else { c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: '合成回答' }); c.enqueue({ type: 'text-end', id: 't' }); }
        c.enqueue({ type: 'finish', finishReason: target ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
      } }) };
    },
    doGenerate: async request => {
      prompts.push(request.prompt);
      const runId = /来源运行是 ([0-9a-f-]{36})/.exec(JSON.stringify(request.prompt))?.[1]; assert.ok(runId);
      const commit = !commits.has(runId); commits.add(runId);
      return { content: commit ? [{ type: 'tool-call', toolName: 'memory_commit', toolCallId: `commit-${runId}`, input: JSON.stringify({ sourceRunId: runId, note: '合成证据' }) }] : [{ type: 'text', text: '完成' }], finishReason: commit ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
  });
  return { model, prompts, sourcePrompts, read: (...targets: string[]) => { reads = targets; } };
}
async function send(core: Core, contextId: string, content: string) {
  const row = await core.submitMessage({ contextId, content }); assert.equal((await finished(core, row.runId!))?.status, 'succeeded'); return row;
}
async function organize(core: Core, runId: string) {
  const job = await core.queueMemory(runId);
  const rows = await until(() => core.projectMemory.jobs(), jobs => jobs.some(row => row.id === job.id && ['succeeded', 'failed'].includes(row.status)));
  assert.equal(rows.find(row => row.id === job.id)?.status, 'succeeded');
}
function evidence(core: Core, snapshot: ContextSnapshot) {
  return (core as unknown as { memoryEvidence(value: ContextSnapshot): Promise<MemoryEvidence> }).memoryEvidence(snapshot);
}
function texts(prompt: unknown) {
  return (prompt as { content: { type: string; text?: string }[] }[]).flatMap(row => row.content).filter(part => part.type === 'text').map(part => part.text);
}

const originals = { plain: '普通对照事实', spaces: '末尾空格事实  ', newlines: '末尾多换行事实\n\n\n', crlf: 'CRLF事实\r\n第二行\r\n', indent: '  首行缩进\n    次行缩进  \n' };
for (const [label, original] of Object.entries(originals)) {
  test(`Core 完整复制与二代复制保留原始用户证据：${label}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-copy-origin-')); const f = fixture();
    const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
    try {
      const source = await send(core, 'main', original); const snapshot = core.projectMemory.snapshot(source.runId!);
      await organize(core, source.runId!); assert.ok(texts(f.prompts[0]).includes(original));
      const branch = await core.branchContext('main', source.runId!, '副本', 'chat.copy');
      const child = await send(core, branch.id, '副本新增事实'); const childSnapshot = core.projectMemory.snapshot(child.runId!);
      const before = await core.history(branch.id); const start = f.prompts.length;
      await organize(core, child.runId!);
      assert.ok(texts(f.prompts[start]).includes(original), '副本 organizer 必须收到原始完整用户内容');
      assert.doesNotMatch(JSON.stringify(f.prompts[start]), /unresolved-origin/);
      const grandchild = await core.branchContext(branch.id, child.runId!, '二代副本', 'chat.copy.two');
      const latest = await send(core, grandchild.id, '二代新增事实'); const next = f.prompts.length; await organize(core, latest.runId!);
      assert.ok(texts(f.prompts[next]).includes(original)); assert.doesNotMatch(JSON.stringify(f.prompts[next]), /unresolved-origin/);
      assert.deepEqual(core.projectMemory.snapshot(source.runId!), snapshot);
      assert.deepEqual(core.projectMemory.snapshot(child.runId!), childSnapshot);
      assert.deepEqual(await core.history(branch.id), before);
    } finally { await core.close(); await removeTemp(dir); }
  });
}

for (const [label, original] of Object.entries(originals)) test(`Core 选区及压缩继承只恢复选中原文：${label}`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-copy-origin-range-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    await send(core, 'main', '排除祖先事实'); const source = await send(core, 'main', original);
    const selected = await core.branchContext('main', source.runId!, '选区', 'chat.selected', source.runId!);
    const middleText = '  选区中间原文\r\n保留缩进  \n'; const middle = await send(core, selected.id, middleText);
    const selectedSnapshot = core.projectMemory.snapshot(middle.runId!); const before = await core.history(selected.id);
    const compacted = await core.compactContext(selected.id, { id: 'chat.compact', keepRecentTokens: 1 });
    const latest = await send(core, compacted.context.id, '压缩继承新增事实'); const start = f.prompts.length;
    await organize(core, latest.runId!);
    assert.ok(texts(f.prompts[start]).includes(original)); assert.ok(texts(f.prompts[start]).includes(middleText));
    assert.doesNotMatch(JSON.stringify(f.prompts[start]), /排除祖先事实|unresolved-origin|missing-checkpoint/);
    const copy = await core.branchContext(compacted.context.id, latest.runId!, '压缩副本', 'chat.compact.copy');
    const last = await send(core, copy.id, '压缩副本新增事实'); const next = f.prompts.length; await organize(core, last.runId!);
    assert.ok(texts(f.prompts[next]).includes(original)); assert.ok(texts(f.prompts[next]).includes(middleText));
    assert.doesNotMatch(JSON.stringify(f.prompts[next]), /排除祖先事实|unresolved-origin|missing-checkpoint/);
    assert.deepEqual(core.projectMemory.snapshot(middle.runId!), selectedSnapshot); assert.deepEqual(await core.history(selected.id), before);
  } finally { await core.close(); await removeTemp(dir); }
});

type Lineage = { sourceContextId: string; sourceRunId: string; messageIdMap: Record<string, string>; storageTextProofs?: Record<string, string> };
for (const mode of ['body', 'role', 'map', 'proof-missing', 'proof-forged', 'source-missing', 'source-unaccepted'] as const) test(`Core 拒绝不可信的复制来源并保留 gap：${mode}`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-copy-origin-negative-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  const originalText = '唯一原始用户事实  \n';
  try {
    const other = await send(core, 'main', '无关受理用户事实'); const source = await send(core, 'main', originalText);
    const sourceSnapshot = core.projectMemory.snapshot(source.runId!);
    const branch = await core.branchContext('main', source.runId!, '副本', 'chat.copy');
    const key = `context-lineage:${branch.id}`; const lineage = core.runtime.setting<Lineage>(key, null!);
    const stored = (await core.history(branch.id)).messages.find(row => row.id === lineage.messageIdMap[source.nativeSignalId!])!; assert.ok(stored);
    assert.ok(lineage.storageTextProofs?.[source.nativeSignalId!]);
    if (mode === 'body' || mode === 'proof-forged') {
      await core.memory.saveMessages({ messages: [{ ...stored, content: { ...stored.content, parts: [{ type: 'text', text: '伪造正文事实' }] } }] });
      if (mode === 'proof-forged') {
        const changed = (await core.history(branch.id)).messages.find(row => row.id === stored.id)!;
        const original = (sourceSnapshot.nativeMessages as { messages: typeof changed[] }).messages.find(row => row.id === source.nativeSignalId)!;
        // 即使重算格式正确的绑定摘要，也不能让未知正文变形通过存储投影校验。
        lineage.storageTextProofs![original.id] = createHash('sha256').update(JSON.stringify(['stored-user-text-v1', branch.id, lineage.sourceContextId, lineage.sourceRunId,
          Object.entries(lineage.messageIdMap).sort(([a], [b]) => a.localeCompare(b)), original.id, changed.id, original.role, original.content, changed.content])).digest('hex');
        core.runtime.setSetting(key, lineage);
      }
    }
    if (mode === 'role') await core.memory.saveMessages({ messages: [{ ...stored, role: stored.role === 'signal' ? 'user' : 'signal' }] });
    if (mode === 'map') {
      delete lineage.messageIdMap[source.nativeSignalId!]; lineage.messageIdMap[other.nativeSignalId!] = stored.id;
      core.runtime.setSetting(key, lineage);
    }
    if (mode === 'proof-missing') { delete lineage.storageTextProofs; core.runtime.setSetting(key, lineage); }
    if (mode === 'source-missing') core.store.db.prepare('DELETE FROM model_snapshots WHERE run_id=?').run(source.runId!);
    if (mode === 'source-unaccepted') core.store.db.prepare('UPDATE signals SET status=? WHERE id=?').run('rejected', source.id);
    const current = await send(core, branch.id, '验证副本隔离'); const index = f.prompts.length; await organize(core, current.runId!);
    assert.match(JSON.stringify(f.prompts[index]), /unresolved-origin/);
    assert.ok(!texts(f.prompts[index]).includes(originalText)); assert.ok(!texts(f.prompts[index]).includes('伪造正文事实'));
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core 不给复制前已篡改的源存储签发来源证明', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-copy-origin-source-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const source = await send(core, 'main', '受理源用户内容  \n'); const snapshot = core.projectMemory.snapshot(source.runId!);
    const stored = (await core.history('main')).messages.find(row => row.id === source.nativeSignalId)!;
    await core.memory.saveMessages({ messages: [{ ...stored, content: { ...stored.content, parts: [{ type: 'text', text: '复制前已变更正文' }] } }] });
    await assert.rejects(core.branchContext('main', source.runId!, '无效副本', 'chat.invalid'), /context_changed/);
    assert.equal(core.runtime.context('chat.invalid'), undefined); assert.equal(await core.memory.getThreadById({ threadId: 'chat.invalid' }), null);
    assert.equal(core.runtime.setting('context-lineage:chat.invalid', null), null); assert.equal(core.runtime.setting('context-copy-pending:chat.invalid', null), null);
    assert.deepEqual(core.projectMemory.snapshot(source.runId!), snapshot);
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core 旧 lineage 只保留严格相等的验证范围，复制证明重启后仍有效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-copy-origin-restart-')); const f = fixture();
  let core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const plain = await send(core, 'main', '旧 lineage 对照事实');
    const legacy = await core.branchContext('main', plain.runId!, '旧副本', 'chat.legacy');
    const lineage = core.runtime.setting<Lineage>(`context-lineage:${legacy.id}`, null!); delete lineage.storageTextProofs; core.runtime.setSetting(`context-lineage:${legacy.id}`, lineage);
    const legacyRun = await send(core, legacy.id, '旧副本新增');
    assert.ok(texts((await evidence(core, core.projectMemory.snapshot(legacyRun.runId!))).prompt).includes('旧 lineage 对照事实'));
    const original = '重启前原文  \r\n'; const source = await send(core, 'main', original);
    const branch = await core.branchContext('main', source.runId!, '重启副本', 'chat.persist');
    await core.close(); core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
    const current = await send(core, branch.id, '重启后继续'); const start = f.prompts.length; await organize(core, current.runId!);
    assert.ok(texts(f.prompts[start]).includes(original)); assert.doesNotMatch(JSON.stringify(f.prompts[start]), /unresolved-origin/);
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core 带复制证明的独立读取与父上下文读取顺序无关，证明不进入模型或上下文 DTO', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-copy-origin-independent-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  try {
    const original = '  独立复制原文\r\n保留末尾空白  \n'; const source = await send(core, 'main', original);
    const branch = await core.branchContext('main', source.runId!, '独立副本', 'chat.independent');
    const lineage = core.runtime.setting<Lineage>(`context-lineage:${branch.id}`, null!);
    const proof = lineage.storageTextProofs?.[source.nativeSignalId!]; assert.ok(proof);
    const before = await core.history(branch.id);
    await send(core, 'main', '父上下文后续事实');
    for (const [index, order] of [['main', branch.id], [branch.id, 'main']].entries()) {
      const reader = core.createConversationContext({ id: `chat.reader.${index}`, name: '读取者' }); f.read(...order);
      const current = await send(core, reader.id, '核对独立历史'); const start = f.prompts.length; await organize(core, current.runId!);
      const body = texts(f.prompts[start]); assert.equal(body.filter(text => text === original).length, 1);
      assert.equal(body.filter(text => text === '父上下文后续事实').length, 1);
      assert.doesNotMatch(JSON.stringify(f.prompts[start]), /unresolved-origin|unresolved-history|storageTextProofs/);
    }
    assert.ok(!JSON.stringify(f.sourcePrompts).includes(proof)); assert.ok(!JSON.stringify(f.prompts).includes(proof));
    assert.ok(!JSON.stringify(core.runtime.context(branch.id)).includes(proof)); assert.deepEqual(await core.history(branch.id), before);
  } finally { await core.close(); await removeTemp(dir); }
});

test('Core 来源证明与上下文在同一事务发布，失败不会留下证明或原生副本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-copy-origin-atomic-')); const f = fixture();
  const core = await Core.open({ dataDir: dir, model: f.model, memoryEnabled: false });
  const set = core.runtime.setSetting.bind(core.runtime);
  try {
    const source = await send(core, 'main', '事务内原文事实  \n'); let sawProof = false;
    core.runtime.setSetting = ((key: string, value: unknown) => {
      if (key === 'context-lineage:chat.failed') { sawProof = Boolean((value as Lineage).storageTextProofs?.[source.nativeSignalId!]); throw Error('synthetic_publication_failure'); }
      return set(key, value);
    }) as typeof core.runtime.setSetting;
    await assert.rejects(core.branchContext('main', source.runId!, '失败副本', 'chat.failed'), /synthetic_publication_failure/);
    assert.ok(sawProof); assert.equal(core.runtime.context('chat.failed'), undefined);
    assert.equal(core.runtime.setting('context-lineage:chat.failed', null), null); assert.equal(core.runtime.setting('context-copy-pending:chat.failed', null), null);
    assert.equal(await core.memory.getThreadById({ threadId: 'chat.failed' }), null);
  } finally { core.runtime.setSetting = set; await core.close(); await removeTemp(dir); }
});
