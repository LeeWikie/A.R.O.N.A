import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { AgentControllerEvent, Session } from '@mastra/core/agent-controller';
import { Core } from '../src/core.js';
import { conversationPage, publicEventPage, snapshot } from '../src/event-stream.js';
import { findCutPoint, estimateMessageTokens, type NativeMessage } from '../src/compaction.js';
import { finished, removeTemp } from './helpers.js';

const big = 'fixture detail '.repeat(1600);
// Ordinary-prose assertions use a token whose prefix cannot collide with their tails.
const controlToken = 'Z-synthetic-control-token-0123456789';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(withTools = false,reasoning?:string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-history-contracts-'));
  let call = 0;
  const prompts: string[] = []; let onSummary: (() => Promise<void>) | undefined; let failNext = false;
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const prompt = JSON.stringify(request.prompt); prompts.push(prompt);
    if (failNext) { failNext = false; throw Error('fixture_model_failed'); }
    const summarizing = prompt.includes('context checkpoint summary');
    if (summarizing) await onSummary?.();
    const text = summarizing ? '## Constraints & Preferences\n- EARLY-CONSTRAINT-MARKER' : 'fixture answer';
    const tool = withTools && !summarizing && request.prompt.at(-1)?.role !== 'tool';
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      if(reasoning){c.enqueue({type:'reasoning-start',id:'synthetic-thinking'});for(const delta of reasoning)c.enqueue({type:'reasoning-delta',id:'synthetic-thinking',delta});c.enqueue({type:'reasoning-end',id:'synthetic-thinking'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();return;}
      if (tool) { c.enqueue({ type: 'tool-call', toolCallId: `fixture-call-${++call}`, toolName: 'context_list', input: '{}' }); c.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close(); return; }
      c.enqueue({ type: 'text-start', id: 't' });
      c.enqueue({ type: 'text-delta', id: 't', delta: text }); c.enqueue({ type: 'text-end', id: 't' });
      c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }) };
  } });
  let core = await Core.open({ dataDir: directory, model, memoryEnabled: false, controlToken });
  const send = async (content: string, contextId = 'main') => { const receipt = await core.submitMessage({ contextId, content }); assert.equal((await finished(core, receipt.runId!))?.status, 'succeeded'); return receipt.runId!; };
  return { get core() { return core; }, directory, prompts, send,
    setSummaryHook(hook: () => Promise<void>) { onSummary = hook; },
    failNext() { failNext = true; },
    async reopen() { await core.close(); core = await Core.open({ dataDir: directory, model, memoryEnabled: false, controlToken }); },
    async close() { await core.close(); await removeTemp(directory); },
  };
}
function instructions(core: Core, id: string) { return (core as unknown as { instructions(role: 'main', id: string): string }).instructions('main', id); }
async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  await f.send(`EARLY-CONSTRAINT-MARKER ${big}`); await f.send(`middle ${big}`); return f.send('retained tail');
}

test('token budget counts full results, arguments, reasoning and non-text media, not summary truncation', () => {
  const first: NativeMessage = { id: 'u1', role: 'user', content: { parts: [{ type: 'text', text: 'old' }] } };
  const tail: NativeMessage = { id: 'u2', role: 'user', content: { parts: [{ type: 'text', text: 'recent' }] } };
  for (const part of [
    { type: 'tool-invocation', toolInvocation: { toolName: 'read', state: 'result', result: 'data '.repeat(30000) } },
    { type: 'tool-invocation', toolInvocation: { toolName: 'write', state: 'result', args: { text: 'argument '.repeat(30000) }, result: 'ok' } },
    { type: 'reasoning', text: 'reason '.repeat(30000) },
    { type: 'image', image: 'https://example.invalid/fixture.png' },
  ]) {
    const answer = { id: 'a2', role: 'assistant', content: { parts: [part] } } as NativeMessage;
    assert.equal(findCutPoint([first, tail, answer], 3000), 1, `complete ${part.type} must count towards the recent budget`);
  }
});

test('full descendants preserve checkpoints across generations, restart and repeated compaction', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await seed(f); const compacted = await f.core.compactContext('main', { id: 'history.compacted', keepRecentTokens: 500 });
    const run = await f.send(`new long turn ${big}`, compacted.context.id);
    const branch = await f.core.branchContext(compacted.context.id, run, 'branch', 'history.branch');
    assert.match(instructions(f.core, branch.id), /EARLY-CONSTRAINT-MARKER/);
    const next = await f.send('next generation tail', branch.id);
    const child = await f.core.branchContext(branch.id, next, 'child', 'history.child');
    await f.reopen(); assert.match(instructions(f.core, child.id), /EARLY-CONSTRAINT-MARKER/);
    await f.send('after restart', child.id);
    const again = await f.core.compactContext(child.id, { id: 'history.again', keepRecentTokens: 100 });
    const prompt = f.prompts.filter(p => p.includes('context checkpoint summary')).at(-1)!;
    assert.match(prompt, /EARLY-CONSTRAINT-MARKER/, 'previous summary reaches the update request');
    assert.match(instructions(f.core, again.context.id), /EARLY-CONSTRAINT-MARKER/);
    assert.ok(conversationPage(f.core, 'main').messages.some(m => m.content.startsWith('EARLY-CONSTRAINT-MARKER')));
  } finally { await f.close(); }
});

test('inherited native message map resolves a retained ancestor turn without forging runs or signals', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.send(`excluded ancestor ${big}`); const ancestor = await f.send('retained ancestor');
    const source = await f.core.branchContext('main', ancestor, 'source', 'history.mapped');
    const own = await f.send('own tail', source.id);
    const selected = await f.core.branchContext(source.id, own, 'selected', 'history.selected', ancestor);
    const visible = conversationPage(f.core, selected.id).messages;
    assert.ok(visible.some(m => m.content.startsWith('retained ancestor') && m.originContextId === 'main'));
    assert.ok(visible.some(m => m.content === 'own tail')); assert.ok(!visible.some(m => m.content.startsWith('excluded ancestor')));
    assert.equal(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE context_id=?').get(selected.id)?.n, 0);
    assert.equal(f.core.store.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE json_extract(body,'$.contextId')=?").get(selected.id)?.n, 0);
    await assert.rejects(f.core.branchContext(source.id, own, 'bad', 'history.bad', 'unrelated-run'), /working_set_boundary_unavailable/);
    const compacted = await f.core.compactContext(source.id, { id: 'history.mappedcompact', keepRecentTokens: 500 });
    assert.ok(conversationPage(f.core, compacted.context.id).messages.some(m => m.content.startsWith('retained ancestor')));
    await f.send('verify native history', selected.id);
    assert.match(f.prompts.at(-1)!, /retained ancestor/); assert.doesNotMatch(f.prompts.at(-1)!, /excluded ancestor/);
  } finally { await f.close(); }
});

test('selected ranges inherit legacy checkpoints only when retaining the source beginning', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const ancestor = await seed(f); const compacted = await f.core.compactContext('main', { id: 'history.legacy', keepRecentTokens: 500 });
    // The original sidecar schema intentionally has no version or native boundary field.
    f.core.runtime.setSetting(`context-compaction:${compacted.context.id}`, { sourceContextId: 'main', sourceRunId: compacted.context.parentRunId, summary: 'LEGACY-EARLY-MARKER', summarizedMessages: 2 });
    const own = await f.send('later local turn', compacted.context.id);
    const all = await f.core.branchContext(compacted.context.id, own, 'all', 'history.legacyall');
    assert.match(instructions(f.core, all.id), /LEGACY-EARLY-MARKER/);
    const beginning = await f.core.branchContext(compacted.context.id, own, 'beginning', 'history.legacybeginning', ancestor);
    assert.match(instructions(f.core, beginning.id), /LEGACY-EARLY-MARKER/);
    const later = await f.core.branchContext(compacted.context.id, own, 'later', 'history.legacylater', own);
    assert.doesNotMatch(instructions(f.core, later.id), /LEGACY-EARLY-MARKER/);
  } finally { await f.close(); }
});

for (const failure of ['checkpoint', 'context', 'cancel-copy', 'copy', 'source-change', 'snapshot-change', 'native-change', 'native-copy-change', 'map'] as const) test(`compaction publishes no incomplete derived context on ${failure}`, { timeout: 30000 }, async () => {
  const f = await fixture(); const id = `history.failure.${failure}`; const controller = new AbortController();
  try {
    await seed(f);
    const set = f.core.runtime.setSetting.bind(f.core.runtime);
    const create = f.core.runtime.createContext.bind(f.core.runtime);
    const copy = f.core.memory.copyThread.bind(f.core.memory);
    if (failure === 'checkpoint') f.core.runtime.setSetting = ((key: string, value: unknown) => { if (key === `context-compaction:${id}`) throw Error('fixture_checkpoint_failed'); return set(key, value); }) as typeof f.core.runtime.setSetting;
    if (failure === 'context') f.core.runtime.createContext = input => { if (input.id === id) throw Error('fixture_context_failed'); return create(input); };
    if (failure === 'cancel-copy' || failure === 'copy') f.core.memory.copyThread = async (...args) => { const result = await copy(...args); if (failure === 'cancel-copy') controller.abort(Error('fixture_cancelled')); else throw Error('fixture_copy_failed'); return result; };
    if (failure === 'map') f.core.memory.copyThread = async (...args) => { const result = await copy(...args); return { ...result, messageIdMap: {} }; };
    if (failure === 'snapshot-change') f.setSummaryHook(async () => { const row = f.core.store.db.prepare("SELECT id FROM runs WHERE context_id='main' ORDER BY rowid DESC LIMIT 1").get()!; const snapshot = f.core.projectMemory.snapshot(String(row.id)); f.core.projectMemory.archive({ ...snapshot, sequence: snapshot.sequence + 1 }); });
    if (failure === 'native-change') f.setSummaryHook(async () => { const remembered = await f.core.history('main', 0, 100); const message = remembered.messages[0]!; await f.core.memory.saveMessages({ messages: [{ ...message, content: { ...message.content, parts: [{ type: 'text', text: 'changed during summary' }] } }] }); });
    if (failure === 'native-copy-change') f.core.memory.copyThread = async (...args) => { const result = await copy(...args); const remembered = await f.core.history('main', 0, 100); const message = remembered.messages[0]!; await f.core.memory.saveMessages({ messages: [{ ...message, content: { ...message.content, parts: [{ type: 'text', text: 'changed during copy' }] } }] }); return result; };
    if (failure === 'source-change') f.setSummaryHook(async () => { f.core.runtime.updateContext('main', { purpose: 'changed while summarizing' }); });
    try { await assert.rejects(f.core.compactContext('main', { id, keepRecentTokens: 500 }, controller.signal), /fixture_|context_changed|branch_history_unavailable/); }
    finally { f.core.runtime.setSetting = set; f.core.runtime.createContext = create; f.core.memory.copyThread = copy; }
    assert.equal(f.core.runtime.context(id), undefined, 'no published working set');
    assert.equal(f.core.runtime.setting(`context-compaction:${id}`, null), null);
    assert.equal(await f.core.memory.getThreadById({ threadId: id }), null, 'native clone rolled back');
    const receipt = await f.send('source remains available'); assert.ok(receipt);
  } finally { await f.close(); }
});

test('compaction owns the source across summary awaits and honours cancellation', { timeout: 30000 }, async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred(); const controller = new AbortController();
  try {
    const last = await seed(f); f.setSummaryHook(async () => { entered.resolve(); await release.promise; });
    const result = f.core.compactContext('main', { id: 'history.cancelled', keepRecentTokens: 500 }, controller.signal);
    // Attach rejection handler before aborting to avoid unhandled-rejection races.
    const rejected = assert.rejects(result, /fixture_cancelled|abort/i);
    await entered.promise;
    try {
      await assert.rejects(f.core.submitMessage({ content: 'must not enter during summary' }), /context_busy/);
      await assert.rejects(f.core.branchContext('main', last, 'concurrent', 'history.concurrent'), /context_busy/);
    } finally { controller.abort(Error('fixture_cancelled')); release.resolve(); await rejected; }
    assert.equal(f.core.runtime.context('history.cancelled'), undefined);
    await f.send('source unlocked');
  } finally { release.resolve(); await f.close(); }
});

test('Core command_exit emits the same structured state to public events and snapshots', async () => {
  const f = await fixture();
  try {
    const session=await f.core.sessions.get(f.core.runtime.context('main')!);session.run.setRunId({runId:'fixture-run'});
    const emit = (event: unknown) => (f.core as unknown as { onEvent(record: unknown, session: Session, event: AgentControllerEvent): void }).onEvent(f.core.runtime.context('main')!, session, event as AgentControllerEvent);
    emit({ type: 'tool_start', toolCallId: 'fixture-call', toolName: 'execute', args: { command: 'fixture' } });
    emit({ type: 'tool_end', toolCallId: 'fixture-call', result: 'not evidence', isError: false });
    const watermark = f.core.runtime.eventHead();
    emit({ type: 'command_exit', toolCallId: 'fixture-call', exitCode: 17, success: false });
    const updates = publicEventPage(f.core, watermark).events.filter(e => e.kind === 'tool');
    assert.equal(updates.length, 1); assert.equal((updates[0]!.data as { exitCode: number }).exitCode, 17);
    assert.equal((updates[0]!.data as { state: string }).state, 'failed');
    assert.equal((snapshot(f.core).toolActivity?.[0] as { exitCode?: number })?.exitCode, 17);
  } finally { await f.close(); }
});

test('Core ingest-time secret snapshots include short local and provider credentials and remain immutable', async () => {
  const f = await fixture(false,['thinking q','z and x','y done']);
  try {
    f.core.credentials.set('FIXTURE_SHORT', 'qz');
    await f.core.credentials.providerStore.modify('fixture-provider', async () => ({ type: 'api_key', key: 'xy' }));
    const receipt=await f.core.submitMessage({content:'Synthetic secret-stream fixture'});assert.equal((await finished(f.core,receipt.runId!))?.status,'succeeded');
    const before = snapshot(f.core).thinking;
    assert.equal(before?.[0]?.text, 'thinking [hidden] and [hidden] done');
    const source=f.core.store.db.prepare("SELECT seq FROM runtime_events WHERE context_id='main' AND kind='public_thinking' ORDER BY seq LIMIT 1").get()!;const messageId=f.core.runtime.publicThinking(Number(source.seq))!.messageId;assert.ok(f.core.sessionGraph.records('main').some(row=>row.source?.messageId===messageId));
    f.core.credentials.remove('FIXTURE_SHORT'); await f.core.credentials.providerStore.delete('fixture-provider');
    assert.deepEqual(snapshot(f.core).thinking, before);
    await f.reopen(); assert.deepEqual(snapshot(f.core).thinking, before);
    assert.doesNotMatch(JSON.stringify(publicEventPage(f.core, 0)), /qz|xy/);
  } finally { await f.close(); }
});

test('actual Pi Anthropic parser and Core preserve opaque metadata privately without public or summary leakage', { timeout: 30000 }, async () => {
  const { stream: anthropicStream } = await import('@earendil-works/pi-ai/api/anthropic-messages');
  const { normalizeContext } = await import('@earendil-works/pi-ai/utils/transcript');
  const { createPiLanguageModel } = await import('../src/providers/bridge.js');
  const { serializeConversation } = await import('../src/compaction.js');
  type Model = import('@earendil-works/pi-ai').Model<'anthropic-messages'>;
  type Context = import('@earendil-works/pi-ai').Context;
  type Models = import('@earendil-works/pi-ai').Models;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-history-parser-'));
  const opaque = 'OPAQUE-FIXTURE-DO-NOT-DISPLAY'; const secret = 'fixture credential with spaces'; const signature = 'SIGNED-FIXTURE-DO-NOT-DISPLAY';
  const target: Model = { id: 'synthetic-model', name: 'fixture', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const fetch: typeof globalThis.fetch = async () => {
    const frames = [
      { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: target.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      ...['consider fixture cred', 'ential with spaces safely'].map(thinking => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })),
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: opaque } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'valid answer' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
    ];
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const registry = { streamSimple(model: Model, context: Context) { return anthropicStream(model, normalizeContext(context), { apiKey: 'synthetic-not-real', fetch, env: {}, cacheRetention: 'none', maxRetries: 0 }); } } as Pick<Models, 'streamSimple'>;
  const model = createPiLanguageModel(registry, target); let core = await Core.open({ dataDir: directory, model, memoryEnabled: false, controlToken });
  try {
    core.credentials.set('FIXTURE_PARSER_SECRET', secret);
    const receipt = await core.submitMessage({ content: 'fixture question' }); const completed = await finished(core, receipt.runId!);
    assert.equal(completed?.status, 'succeeded', `fixture run errorCode: ${completed?.errorCode}`);
    const native = core.projectMemory.snapshot(receipt.runId!).nativeMessages as { messages: NativeMessage[] };
    assert.match(JSON.stringify(native), new RegExp(opaque)); assert.match(JSON.stringify(native), new RegExp(signature));
    assert.doesNotMatch(serializeConversation(native.messages), new RegExp(`${opaque}|${signature}`));
    const visible = snapshot(core); assert.equal(visible.thinking?.[0]?.text, 'consider [hidden] safely');
    assert.doesNotMatch(JSON.stringify(visible), new RegExp(`${opaque}|${signature}|${secret}`));
    assert.doesNotMatch(JSON.stringify(publicEventPage(core, 0)), new RegExp(`${opaque}|${signature}|${secret}`));
    await core.close(); core = await Core.open({ dataDir: directory, model, memoryEnabled: false, controlToken });
    assert.deepEqual(snapshot(core).thinking, visible.thinking);
  } finally { await core.close(); await removeTemp(directory); }
});

test('failed native clone cleanup preserves both errors and is recovered before the next session starts', { timeout: 30000 }, async () => {
  const f = await fixture(); const id = 'history.recover';
  try {
    await seed(f); const set = f.core.runtime.setSetting.bind(f.core.runtime); const remove = f.core.memory.deleteThread.bind(f.core.memory);
    f.core.runtime.setSetting = ((key: string, value: unknown) => { if (key === `context-compaction:${id}`) throw Error('fixture_checkpoint_failed'); return set(key, value); }) as typeof f.core.runtime.setSetting;
    f.core.memory.deleteThread = async () => { throw Error('fixture_cleanup_failed'); };
    try {
      await assert.rejects(f.core.compactContext('main', { id, keepRecentTokens: 500 }), error => error instanceof AggregateError && error.errors.some(e => e.message === 'fixture_checkpoint_failed') && error.errors.some(e => e.message === 'fixture_cleanup_failed'));
    } finally { f.core.runtime.setSetting = set; f.core.memory.deleteThread = remove; }
    assert.equal(f.core.runtime.context(id), undefined);
    assert.ok(await f.core.memory.getThreadById({ threadId: id }), 'fixture models a recoverable orphan, not a published working set');
    assert.throws(() => f.core.createConversationContext({ id, name: 'must not reuse pending clone' }), /context_exists/);
    await f.reopen();
    assert.equal(await f.core.memory.getThreadById({ threadId: id }), null);
    assert.equal(f.core.runtime.context(id), undefined);
    await f.send('recovered source still usable');
  } finally { await f.close(); }
});

test('native copied turns retain tool pairs and provenance while excluded ancestor boundaries stay unavailable', { timeout: 30000 }, async () => {
  const f = await fixture(true);
  try {
    const excluded = await f.send('excluded native tool turn'); const retained = await f.send('retained native tool turn');
    const selected = await f.core.branchContext('main', retained, 'tools', 'history.toolturn', retained);
    const original = JSON.stringify((await f.core.history('main', 0, 100)).messages);
    const inherited = await f.core.history(selected.id, 0, 100);
    const calls = inherited.messages.flatMap(m => m.content.parts).filter(p => p.type === 'tool-invocation');
    assert.ok(calls.length > 0); assert.ok(calls.every(p => p.toolInvocation.state === 'result' && p.toolInvocation.toolName === 'context_list' && p.toolInvocation.result !== undefined));
    assert.doesNotMatch(JSON.stringify(inherited.messages), /excluded native tool turn/);
    const local = await f.send('follow up on copied tools', selected.id);
    await assert.rejects(f.core.branchContext(selected.id, local, 'excluded', 'history.excludedtool', excluded), /working_set_boundary_unavailable/);
    const second = await f.core.branchContext(selected.id, local, 'second generation', 'history.secondtool', retained);
    assert.ok(conversationPage(f.core, second.id).messages.some(m => m.content === 'retained native tool turn' && m.originContextId === 'main'));
    assert.ok((await f.core.history(second.id, 0, 100)).messages.some(m => m.content.parts.some(p => p.type === 'tool-invocation')));
    assert.equal(JSON.stringify((await f.core.history('main', 0, 100)).messages), original, 'branching never edits source native history');
    assert.equal(f.core.runtime.tasks({ contextId: second.id }).length, 0);
    assert.equal(f.core.runtime.approvals().filter(a => a.contextId === second.id).length, 0);
  } finally { await f.close(); }
});

test('accepted input from a failed run remains a valid selected and compacted boundary after later success', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.send(`early excluded ${big}`); f.failNext();
    const failed = await f.core.submitMessage({ content: `accepted failed input ${big}` });
    assert.equal((await finished(f.core, failed.runId!))?.status, 'failed');
    assert.equal(f.core.store.getSignal(failed.id)?.status, 'accepted');
    const last = await f.send('successful tail');
    const selected = await f.core.branchContext('main', last, 'selected', 'history.failedselected', failed.runId!);
    assert.match(JSON.stringify(await f.core.history(selected.id)), /accepted failed input/);
    assert.doesNotMatch(JSON.stringify(await f.core.history(selected.id)), /early excluded/);
    const native = (f.core.projectMemory.snapshot(last).nativeMessages as { messages: NativeMessage[] }).messages;
    const failedSignal = f.core.store.getSignal(failed.id)!;
    const boundary = native.findIndex(message => message.id === failedSignal.nativeSignalId);
    assert.ok(boundary > 0);
    const keepRecentTokens = native.slice(boundary).reduce((total, message) => total + estimateMessageTokens(message), 1);
    assert.equal(findCutPoint(native, keepRecentTokens), boundary);
    const compacted = await f.core.compactContext('main', { id: 'history.failedcompact', keepRecentTokens });
    assert.equal(compacted.context.workingSet?.kind, 'selected-turn-range');
    assert.equal(compacted.context.workingSet?.kind === 'selected-turn-range' && compacted.context.workingSet.fromRunId, failed.runId);
    const descendantRun = await f.send('descendant tail', selected.id);
    await f.core.branchContext(selected.id, descendantRun, 'failed inherited input', 'history.failedinherited', failed.runId!);
    assert.equal(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE context_id=?').get('history.failedinherited')?.n, 0);
    assert.equal(f.core.store.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE json_extract(body,'$.contextId')=?").get('history.failedinherited')?.n, 0);
    await assert.rejects(f.core.branchContext('main', failed.runId!, 'invalid end', 'history.failedend'), /branch_requires_complete_run/);
  } finally { await f.close(); }
});

for (const status of ['rejected', 'cancelled', 'interrupted'] as const) test(`unaccepted ${status} inputs cannot supply a history boundary`, { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.send('not an accepted boundary'); const last = await f.send('successful end');
    f.core.store.db.prepare('UPDATE signals SET status=? WHERE run_id=?').run(status, first);
    await assert.rejects(f.core.branchContext('main', last, 'invalid', `history.invalid.${status}`, first), /working_set_boundary_unavailable/);
  } finally { await f.close(); }
});

test('lineage cannot assign an inherited message to an unrelated accepted input', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.send('original first'); const second = await f.send('original second');
    const branch = await f.core.branchContext('main', second, 'copied tail', 'history.falsemap', second);
    const last = await f.send('own tail', branch.id);
    const lineage = f.core.runtime.setting<{ sourceContextId: string; sourceRunId: string; messageIdMap: Record<string, string> }>(`context-lineage:${branch.id}`, null!);
    const firstNative = f.core.store.db.prepare('SELECT native_id FROM signals WHERE run_id=?').get(first)!;
    const copiedUser = (await f.core.history(branch.id)).messages.find(m => m.role === 'user' || m.role === 'signal')!;
    f.core.runtime.setSetting(`context-lineage:${branch.id}`, { ...lineage, messageIdMap: { [String(firstNative.native_id)]: copiedUser.id } });
    await assert.rejects(f.core.branchContext(branch.id, last, 'forged', 'history.falsemapchild', first), /working_set_boundary_unavailable/);
  } finally { await f.close(); }
});

test('close waits for an in-flight clone to roll back before closing storage and releasing its lock', { timeout: 15000 }, async () => {
  const f = await fixture(); const copied = deferred(); const release = deferred(); const id = 'history.closecopy';
  const copy = f.core.memory.copyThread.bind(f.core.memory);
  try {
    await seed(f); const before = await f.core.history('main', 0, 100);
    f.core.memory.copyThread = async (...args) => { const result = await copy(...args); copied.resolve(); await release.promise; return result; };
    const result = f.core.compactContext('main', { id, keepRecentTokens: 500 });
    const rejected = assert.rejects(result, /abort|core_stopping/i); await copied.promise;
    let closed = false; const close = f.core.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false, 'no force-close while clone still writes');
    release.resolve(); await rejected; await close;
    await f.reopen();
    assert.equal(f.core.runtime.context(id), undefined); assert.equal(await f.core.memory.getThreadById({ threadId: id }), null);
    assert.deepEqual((await f.core.history('main', 0, 100)).messages, before.messages);
    await f.send('source available after close rollback');
  } finally { release.resolve(); await f.close(); }
});

test('close surfaces clone cleanup failures and leaves a recoverable journal rather than swallowing them', { timeout: 15000 }, async () => {
  const f = await fixture(); const copied = deferred(); const release = deferred(); const id = 'history.closecleanuperror';
  const copy = f.core.memory.copyThread.bind(f.core.memory); const remove = f.core.memory.deleteThread.bind(f.core.memory);
  try {
    await seed(f);
    f.core.memory.copyThread = async (...args) => { const result = await copy(...args); copied.resolve(); await release.promise; return result; };
    f.core.memory.deleteThread = async () => { throw Error('fixture_close_cleanup_failed'); };
    const result = f.core.compactContext('main', { id, keepRecentTokens: 500 });
    const rejected = assert.rejects(result, error => error instanceof AggregateError && error.errors.some(e => e.message === 'fixture_close_cleanup_failed') && error.errors.some(e => e.name === 'AbortError'));
    await copied.promise;
    const close = assert.rejects(f.core.close(), /context_copy_shutdown_cleanup_failed/);
    release.resolve(); await rejected; await close;
    const recovered = await Core.open({ dataDir: f.directory, memoryEnabled: false, controlToken });
    try { assert.equal(await recovered.memory.getThreadById({ threadId: id }), null); assert.equal(recovered.runtime.context(id), undefined); }
    finally { await recovered.close(); }
  } finally {
    release.resolve(); f.core.memory.deleteThread = remove;
    // close() is idempotent, including its recorded failure; it has already released storage.
    await f.core.close().catch(error => { assert.match(error.message, /context_copy_shutdown_cleanup_failed/); });
    await removeTemp(f.directory);
  }
});
