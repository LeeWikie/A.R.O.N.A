import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { AppError } from '../src/domain.js';
import type { Editor, Terminal } from '@earendil-works/pi-tui';
import { TerminalApp } from '../src/tui/index.js';
import { InteractionAnswerDelivery, InteractionAnswerDrafts, answerDeliveryLabel, unconfirmedAnswer } from '../src/tui/interaction-answers.js';
import type { InteractionAnswerReceipt } from '../src/interactions.js';
import { finished, removeTemp, until } from './helpers.js';

async function fixture(payload: { question: string; options?: Array<{ label: string }>; selectionMode?: 'multi_select' } = { question: 'Which synthetic format?' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-ui-'));
  const prompts: string[] = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    prompts.push(JSON.stringify(request.prompt)); const answered = request.prompt.some(message => message.role === 'tool');
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (!answered) controller.enqueue({ type: 'tool-call', toolCallId: 'synthetic-choice', toolName: 'ask_user', input: JSON.stringify(payload) });
      else { controller.enqueue({ type: 'text-start', id: 'result' }); controller.enqueue({ type: 'text-delta', id: 'result', delta: 'Format received' }); controller.enqueue({ type: 'text-end', id: 'result' }); }
      controller.enqueue({ type: 'finish', finishReason: answered ? 'stop' : 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: path.join(directory, 'core'), model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const cache = new InteractionAnswerDrafts(path.join(directory, 'client'), client.localStateScope);
  const request = <T>(route: string, body?: unknown) => client.request<T>(route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'X-ShittimChest-Storage-Id': core.storageId }, body: JSON.stringify(body) });
  const submitted = await core.submitMessage({ contextId: 'main', content: 'Prepare a synthetic file' });
  const question = (await until(() => core.interactions(), rows => rows.some(row => row.status === 'pending'))).find(row => row.status === 'pending')!;
  return { directory, core, cache, client, request, question, prompts, submitted, async close() {
    if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
  } };
}

test('lost HTTP save acknowledgement survives a client restart and delivers the exact answer once to the original native gate', { timeout: 30000 }, async () => {
  const f = await fixture(); let lose = true; let writes = 0;
  const answer = '第一行 synthetic\n second line  \n';
  try {
    const first = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => {
      const result = await f.request<T>(route, body);
      if (route.endsWith('/answer-outbox')) { writes++; if (lose) { lose = false; throw new Error('synthetic response lost'); } }
      return result;
    }, f.cache);
    await assert.rejects(first.stage(f.question, answer), /response lost/);
    assert.equal(f.cache.list(f.core.storageId)[0]?.answer, answer);
    assert.match(answerDeliveryLabel(first.entries()[0]!), /本机/);
    const restarted = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => {
      if (route.endsWith('/answer-outbox')) writes++;
      return f.request<T>(route, body);
    }, f.cache);
    await restarted.refresh(f.core.interactions());
    assert.equal((await finished(f.core, f.submitted.runId!))!.status, 'succeeded');
    await restarted.refresh(f.core.interactions());
    assert.equal(writes, 2); assert.equal(f.prompts.length, 2); assert.match(f.prompts[1]!, /第一行 synthetic/);
    const receipts = f.core.interactionAnswers(); assert.equal(receipts.length, 1); assert.equal(receipts[0]!.status, 'delivered'); assert.equal(receipts[0]!.attempts, 1);
    assert.equal(receipts[0]!.runId, f.submitted.runId); assert.deepEqual(f.cache.list(f.core.storageId), []);
  } finally { await f.close(); }
});

test('lost cancellation acknowledgement persists cancellation before reconnect and never posts the retained answer', { timeout: 30000 }, async () => {
  const f = await fixture(); let answerWrites = 0;
  try {
    const draft = unconfirmedAnswer(f.core.storageId, f.question, 'Do not deliver this answer'); f.cache.save(draft);
    const first = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => {
      const result = await f.request<T>(route, body); if (route.endsWith('/cancel')) throw new Error('synthetic cancel response lost'); return result;
    }, f.cache);
    await assert.rejects(first.cancel(f.question.id, f.question.runId), /response lost/);
    assert.ok(f.cache.list(f.core.storageId)[0]?.cancelRequestedAt);
    const restarted = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => {
      if (route.endsWith('/answer-outbox')) answerWrites++; return f.request<T>(route, body);
    }, f.cache);
    await restarted.refresh(f.core.interactions());
    assert.equal(answerWrites, 0); assert.equal(f.core.interactions()[0]!.status, 'cancelled'); assert.equal(f.cache.list(f.core.storageId)[0]!.answer, draft.answer); assert.ok(f.cache.list(f.core.storageId)[0]!.cancelAcknowledgedAt); assert.equal(restarted.needsRefresh(), false); assert.equal(f.prompts.length, 1);
  } finally { await f.close(); }
});

test('another client answer wins canonically; a retained conflicting answer is kept for inspection and cannot overwrite or trigger a new run', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    f.cache.save(unconfirmedAnswer(f.core.storageId, f.question, 'conflicting synthetic answer'));
    await f.request(`/interactions/${f.question.id}/answer-outbox`, { expectedRunId: f.question.runId, answer: 'canonical synthetic answer' });
    await finished(f.core, f.submitted.runId!);
    const delivery = new InteractionAnswerDelivery(f.core.storageId, f.request, f.cache); await delivery.refresh(f.core.interactions());
    const retained = f.cache.list(f.core.storageId)[0]!;
    assert.equal(retained.blockedCode, 'interaction_already_answered'); assert.equal(retained.answer, 'conflicting synthetic answer');
    assert.match(answerDeliveryLabel(delivery.entries()[0]!), /本机回答未送达/);
    assert.equal(f.prompts.length, 2); assert.match(f.prompts[1]!, /canonical synthetic answer/); assert.doesNotMatch(f.prompts[1]!, /conflicting synthetic answer/);
    await delivery.refresh(f.core.interactions()); assert.equal(f.prompts.length, 2);
  } finally { await f.close(); }
});

test('a delivered foreign receipt cannot mark an unbound local answer delivered or retry the other client answer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-foreign-'));
  const item = { id: 'question', contextId: 'context', runId: 'run', toolCallId: 'call', kind: 'question' as const, payload: { question: 'Synthetic choice?' }, status: 'pending' };
  const receipt: InteractionAnswerReceipt = { id: 'foreign', interactionId: item.id, contextId: item.contextId, runId: item.runId, toolCallId: item.toolCallId, status: 'pending', savedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', attempts: 0 };
  let retries = 0;
  try {
    const cache = new InteractionAnswerDrafts(directory, 'synthetic'); cache.save(unconfirmedAnswer('storage', item, 'local answer'));
    const delivery = new InteractionAnswerDelivery('storage', async <T>(route: string) => {
      if (route.endsWith('/answer-outbox')) throw new AppError('interaction_already_answered', 409);
      if (route.endsWith('/retry')) retries++;
      return (route.startsWith('/interaction-answers?') ? { answers: receipt.status === 'pending' ? [receipt] : [], nextCursor: 1, hasMore: false } : { answer: receipt }) as T;
    }, cache);
    await delivery.refresh([item]); receipt.status = 'delivered'; await delivery.refresh([{ ...item, status: 'answered' }]);
    const entry = delivery.entries()[0]!; assert.equal(entry.receipt?.status, 'delivered'); assert.equal(entry.draft?.receiptId, undefined);
    assert.match(answerDeliveryLabel(entry), /本机回答未送达/); await delivery.retry(item.id); assert.equal(retries, 0); assert.equal(cache.list('storage')[0]!.answer, 'local answer');
  } finally { await removeTemp(directory); }
});

test('a read-only exact receipt lookup resolves a lost save acknowledgement after late cancellation without submitting the answer again', { timeout: 30000 }, async () => {
  const f = await fixture(); let posts = 0;
  try {
    const first = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => {
      const result = await f.request<T>(route, body); if (route.endsWith('/answer-outbox')) { posts++; throw new Error('synthetic acknowledgement lost'); } return result;
    }, f.cache);
    await assert.rejects(first.stage(f.question, 'exact synthetic answer'), /acknowledgement lost/);
    await finished(f.core, f.submitted.runId!);
    await assert.rejects(first.cancel(f.question.id, f.question.runId), error => error instanceof AppError && error.code === 'interaction_not_active');
    assert.ok(f.cache.list(f.core.storageId)[0]!.cancelRequestedAt);
    const restarted = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => {
      if (route.endsWith('/answer-outbox')) posts++; return f.request<T>(route, body);
    }, f.cache, { receiptLookup: true });
    await restarted.refresh(f.core.interactions());
    assert.equal(posts, 1); assert.equal(f.prompts.length, 2); assert.deepEqual(f.cache.list(f.core.storageId), []); assert.equal(f.core.interactionAnswers()[0]!.status, 'delivered');
  } finally { await f.close(); }
});

test('local drafts isolate storage and endpoint, refuse redirected files, and do not resend a question whose payload changed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-draft-'));
  const item = { id: 'question', contextId: 'context', runId: 'run', toolCallId: 'call', kind: 'question' as const, payload: { question: 'Synthetic choice?' } };
  try {
    const cache = new InteractionAnswerDrafts(directory, 'http://127.0.0.1:1000'); cache.save(unconfirmedAnswer('first', item, ['α', 'β']));
    assert.deepEqual(cache.list('second'), []); assert.deepEqual(new InteractionAnswerDrafts(directory, 'http://127.0.0.1:1001').list('first'), []);
    let writes = 0;
    const delivery = new InteractionAnswerDelivery('first', async <T>(_route: string, body?: unknown) => { if (body) writes++; return { answers: [], nextCursor: 0, hasMore: false } as T; }, cache);
    await delivery.refresh([{ ...item, payload: { question: 'A different question' }, status: 'pending' }]);
    assert.equal(writes, 0); assert.equal(cache.list('first')[0]?.blockedCode, 'interaction_question_changed');
    const file = path.join(directory, fs.readdirSync(directory)[0]!);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const link = `${file}.link`; fs.linkSync(file, link); assert.throws(() => cache.list('first'), /answer_draft_redirected/); fs.unlinkSync(link);
    fs.writeFileSync(file, '{broken'); assert.throws(() => cache.list('first')); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { await removeTemp(directory); }
});

test('authenticated draft identity survives a new port while changed credentials and storage remain isolated', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-address-'));
  const token = 'synthetic-control-identity-for-test-only';
  const first = new Client('http://127.0.0.1:10101', token), moved = new Client('http://127.0.0.1:20202', token), other = new Client('http://127.0.0.1:20202', 'other-synthetic-test-identity');
  const question = { id: 'question', contextId: 'context', runId: 'run', toolCallId: 'call', kind: 'question' as const, payload: { question: 'Synthetic question?' } };
  try {
    assert.equal(first.localStateScope, moved.localStateScope); assert.notEqual(first.localStateScope, other.localStateScope);
    const original = new InteractionAnswerDrafts(directory, first.localStateScope); original.save(unconfirmedAnswer('storage', question, 'original answer'));
    const recovered = new InteractionAnswerDrafts(directory, moved.localStateScope); assert.equal(recovered.list('storage')[0]!.answer, 'original answer'); assert.deepEqual(recovered.list('other-storage'), []);
    assert.deepEqual(new InteractionAnswerDrafts(directory, other.localStateScope).list('storage'), []);
    for (const name of fs.readdirSync(directory)) { assert.ok(!name.includes(token)); assert.ok(!fs.readFileSync(path.join(directory, name), 'utf8').includes(token)); }
    assert.notEqual(new Client('https://first.invalid', '').localStateScope, new Client('https://second.invalid', '').localStateScope);
  } finally { await removeTemp(directory); }
});

test('the complete multi-select answer crosses HTTP, local persistence and the original native gate without truncating long Chinese choices or free text', { timeout: 30000 }, async () => {
  const options = Array.from({ length: 100 }, (_, index) => ({ label: `选项${String(index).padStart(3, '0')}:` + '字'.repeat(3990) }));
  const free = '补'.repeat(64000);
  const f = await fixture({ question: 'Select the synthetic choices', options, selectionMode: 'multi_select' });
  const app = new TerminalApp(f.client, 'main', new TestTerminal(), { answerDrafts: f.cache });
  const ui = app as unknown as { storageId: string; capabilities: Set<string>; choose(): Promise<string>; promptLong(): Promise<string>; note(text: string): void; answerInteraction(item: unknown): Promise<void> };
  try {
    const choices = [...options.map((_, index) => String(index)), 'text'];
    ui.storageId = f.core.storageId; ui.capabilities = new Set(['interactive-tools', 'interaction-answer-outbox', 'interaction-answer-receipt-lookup']);
    ui.choose = async () => choices.shift()!; ui.promptLong = async () => free; ui.note = () => {};
    assert.ok(Buffer.byteLength(JSON.stringify([...options.map(option => option.label), free])) > 512 * 1024);
    assert.ok('options' in f.question.payload); assert.equal(f.question.payload.options?.length, 100);
    await ui.answerInteraction(f.question);
    assert.equal((await finished(f.core, f.submitted.runId!))!.status, 'succeeded');
    assert.equal(f.core.interactionAnswers()[0]!.status, 'delivered'); assert.equal(f.core.interactionAnswers()[0]!.attempts, 1);
    assert.equal(f.prompts.length, 2);
    for (const item of [...options.map(option => option.label), free]) assert.ok(f.prompts[1]!.includes(item), 'native resumed prompt must contain the complete answer');
  } finally { await app.stop(); await f.close(); }
});

test('pending, blocked and unknown receipts are saving/delivery states rather than completed answers', async () => {
  const receipt: InteractionAnswerReceipt = { id: 'answer', interactionId: 'question', contextId: 'context', runId: 'run', toolCallId: 'call', status: 'pending', savedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', attempts: 0 };
  const delivery = new InteractionAnswerDelivery('storage', async <T>() => ({ answers: [receipt], nextCursor: 1, hasMore: false }) as T);
  await delivery.refresh([]); assert.equal(delivery.hasAnswer('question'), true); assert.equal(delivery.needsRefresh(), true); assert.match(answerDeliveryLabel(delivery.entries()[0]!), /等待送达/);
  receipt.status = 'unknown'; await delivery.refresh([]); assert.match(answerDeliveryLabel(delivery.entries()[0]!), /未确认/);
  receipt.status = 'blocked'; receipt.retryable = false; await delivery.refresh([]); assert.match(answerDeliveryLabel(delivery.entries()[0]!), /需要处理/);
});

class TestTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input = (_data: string) => {};
  start(onInput: (data: string) => void) { this.input = onInput; } stop() {} async drainInput() {} write(text: string) { this.output += text; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
test('the running terminal preserves a lost answer acknowledgement and a fresh terminal reconciles it without another prompt or model run', { timeout: 30000 }, async () => {
  const f = await fixture(); const priorIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), priorOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  let offline = false;
  const transport = Object.create(f.client) as Client;
  transport.request = async <T>(route: string, init?: Parameters<Client['request']>[1]) => {
    if (offline) throw new Error('synthetic transport offline');
    const result = await f.client.request<T>(route, init);
    if (route.endsWith('/answer-outbox')) { offline = true; throw new Error('synthetic save acknowledgement lost'); }
    return result;
  };
  const firstTerminal = new TestTerminal(), secondTerminal = new TestTerminal();
  const first = new TerminalApp(transport, 'main', firstTerminal, { answerDrafts: f.cache });
  const second = new TerminalApp(f.client, 'main', secondTerminal, { answerDrafts: f.cache });
  const running = first.run(); let next: Promise<void> | undefined;
  const firstUI = first as unknown as { contextReady: boolean; pendingModal?: () => void; editor: Editor };
  const secondUI = second as unknown as { contextReady: boolean; pendingModal?: () => void };
  try {
    await until(() => firstUI.pendingModal, Boolean);
    firstTerminal.input('original synthetic answer'); firstTerminal.input('\r');
    await until(() => f.cache.list(f.core.storageId), rows => rows.length === 1);
    await until(() => firstTerminal.output, text => text.includes('保存尚未确认'));
    assert.doesNotMatch(firstTerminal.output, /已提交回答/); assert.equal(firstUI.pendingModal, undefined);
    await first.stop(); await running;
    await finished(f.core, f.submitted.runId!);
    next = second.run(); await until(() => secondUI.contextReady, Boolean);
    await until(() => f.cache.list(f.core.storageId), rows => rows.length === 0);
    assert.equal(secondUI.pendingModal, undefined); assert.equal(f.prompts.length, 2); assert.equal(f.core.interactionAnswers()[0]!.attempts, 1);
  } finally {
    await first.stop(); await second.stop(); await running; await next; await f.close();
    if (priorIn) Object.defineProperty(process.stdin, 'isTTY', priorIn); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (priorOut) Object.defineProperty(process.stdout, 'isTTY', priorOut); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test('two offline terminals preserve both confirmed answers; reopening requires a reviewed choice and delivers only that original version', { timeout: 30000 }, async () => {
  const f = await fixture();
  const cacheB = new InteractionAnswerDrafts(path.join(f.directory, 'client'), f.client.localStateScope);
  const offline = Object.create(f.client) as Client;
  offline.request = async <T>(route: string, init?: Parameters<Client['request']>[1]) => {
    if (route.endsWith('/answer-outbox') || route.endsWith('/answer-receipt')) throw new Error('synthetic offline');
    return f.client.request<T>(route, init);
  };
  const first = new TerminalApp(offline, 'main', new TestTerminal(), { answerDrafts: f.cache });
  const second = new TerminalApp(offline, 'main', new TestTerminal(), { answerDrafts: cacheB });
  const third = new TerminalApp(f.client, 'main', new TestTerminal(), { answerDrafts: new InteractionAnswerDrafts(path.join(f.directory, 'client'), f.client.localStateScope) });
  type UI = { storageId: string; capabilities: Set<string>; promptLong(): Promise<string>; note(text: string): void; answerInteraction(item: unknown): Promise<void>; questions(): Promise<void>; pick(): Promise<string>; choose(): Promise<string>; approvalPrompt(title: string, body: string[]): Promise<string> };
  const a = first as unknown as UI, b = second as unknown as UI, c = third as unknown as UI;
  const answerA = 'first offline original\n  preserve spaces  ', answerB = 'second offline original\n末尾继续';
  for (const ui of [a, b, c]) { ui.storageId = f.core.storageId; ui.capabilities = new Set(['interactive-tools', 'interaction-answer-outbox', 'interaction-answer-receipt-lookup']); ui.note = () => {}; }
  try {
    // Both question editors were opened before either client could save to Core.
    let releaseA!: () => void, releaseB!: () => void;
    a.promptLong = async () => { await new Promise<void>(resolve => { releaseA = resolve; }); return answerA; };
    b.promptLong = async () => { await new Promise<void>(resolve => { releaseB = resolve; }); return answerB; };
    const openA = a.answerInteraction(f.question), openB = b.answerInteraction(f.question);
    releaseA(); await openA; releaseB(); await openB;
    assert.deepEqual(f.cache.list(f.core.storageId).map(row => row.answer), [answerA, answerB]);
    assert.equal(f.core.interactionAnswers().length, 0); assert.equal(f.prompts.length, 1);
    await first.stop(); await second.stop();
    const reopened = new InteractionAnswerDelivery(f.core.storageId, f.request, f.cache, { receiptLookup: true });
    await reopened.refresh(f.core.interactions());
    assert.equal(reopened.entries()[0]!.selectionRequired, true); assert.equal(f.prompts.length, 1);
    const versionB = f.cache.list(f.core.storageId).find(row => row.answer === answerB)!;
    c.pick = async () => f.question.id;
    const choices = ['view', versionB.localId!]; c.choose = async () => choices.shift()!;
    c.approvalPrompt = async (_title, body) => { assert.equal(body.join('\n'), answerB); return 'once'; };
    await c.questions(); await finished(f.core, f.submitted.runId!);
    await reopened.refresh(f.core.interactions());
    assert.equal(f.prompts.length, 2); assert.ok(f.prompts[1]!.includes(answerB.replace('\n', '\\n'))); assert.ok(!f.prompts[1]!.includes('first offline original'));
    assert.deepEqual(f.cache.list(f.core.storageId).map(row => row.answer), [answerA]);
    assert.equal(f.cache.list(f.core.storageId)[0]!.blockedCode, 'interaction_already_answered');
    const anotherRestart = new InteractionAnswerDelivery(f.core.storageId, f.request, f.cache, { receiptLookup: true });
    await anotherRestart.refresh(f.core.interactions()); assert.equal(f.prompts.length, 2);
  } finally { await first.stop(); await second.stop(); await third.stop(); await f.close(); }
});

test('a confirmation from an already open editor survives another client winning the Core gate', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const local = new InteractionAnswerDelivery(f.core.storageId, f.request, f.cache, { receiptLookup: true });
    await f.request(`/interactions/${f.question.id}/answer-outbox`, { expectedRunId: f.question.runId, answer: 'already canonical' });
    await finished(f.core, f.submitted.runId!); await local.refresh(f.core.interactions());
    await assert.rejects(local.stage(f.question, 'confirmed in the other open editor'), error => error instanceof AppError && error.code === 'interaction_already_answered');
    assert.equal(f.cache.list(f.core.storageId)[0]!.answer, 'confirmed in the other open editor');
    assert.equal(f.prompts.length, 2); assert.match(answerDeliveryLabel(local.entries()[0]!), /本机回答未送达/);
  } finally { await f.close(); }
});

test('local version selection rejects a stale review and cancellation cannot be erased by a stale client write', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const a = f.cache.save(unconfirmedAnswer(f.core.storageId, f.question, 'version a'));
    const reviewed = [a.localId!];
    const cacheB = new InteractionAnswerDrafts(path.join(f.directory, 'client'), f.client.localStateScope);
    const b = cacheB.save(unconfirmedAnswer(f.core.storageId, f.question, 'version b'));
    assert.throws(() => f.cache.choose(f.core.storageId, f.question.id, a.localId!, reviewed), /answer_draft_versions_changed/);
    f.cache.requestCancel(f.core.storageId, f.question.id, new Date().toISOString());
    cacheB.save({ ...b, updatedAt: new Date().toISOString() });
    assert.ok(cacheB.list(f.core.storageId).every(row => row.cancelRequestedAt));
    let posts = 0;
    const delivery = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => { if (route.endsWith('/answer-outbox')) posts++; return f.request<T>(route, body); }, cacheB, { receiptLookup: true });
    await delivery.refresh(f.core.interactions());
    assert.equal(posts, 0); assert.equal(f.core.interactions()[0]!.status, 'cancelled'); assert.equal(f.prompts.length, 1);
  } finally { await f.close(); }
});

test('a local save failure retains confirmed text in the live window and recovery persists it before any network submission', { timeout: 30000 }, async () => {
  const f = await fixture(); const original = f.cache.save.bind(f.cache); let unavailable = true, posts = 0;
  f.cache.save = value => { if (unavailable) throw new Error('synthetic local storage unavailable'); return original(value); };
  try {
    const delivery = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => { if (route.endsWith('/answer-outbox')) posts++; return f.request<T>(route, body); }, f.cache, { receiptLookup: true });
    const answer = 'confirmed original while disk unavailable\n  ';
    await assert.rejects(delivery.stage(f.question, answer), /local storage unavailable/);
    assert.equal(delivery.hasAnswer(f.question.id), true); assert.equal(delivery.entries()[0]!.draft!.answer, answer); assert.equal(posts, 0);
    await delivery.refresh(f.core.interactions());
    assert.equal(delivery.entries()[0]!.draft!.answer, answer); assert.equal(posts, 0);
    unavailable = false; await delivery.refresh(f.core.interactions()); await finished(f.core, f.submitted.runId!); await delivery.refresh(f.core.interactions());
    assert.equal(posts, 1); assert.equal(f.prompts.length, 2); assert.deepEqual(f.cache.list(f.core.storageId), []);
    assert.ok(f.prompts[1]!.includes('confirmed original while disk unavailable'));
  } finally { await f.close(); }
});

test('a second editor confirming after another client cancels retains its new original without reviving or repeatedly cancelling the run', { timeout: 30000 }, async () => {
  const f = await fixture(); let posts = 0, cancellations = 0;
  const request = async <T>(route: string, body?: unknown) => { if (route.endsWith('/answer-outbox')) posts++; if (route.endsWith('/cancel')) cancellations++; return f.request<T>(route, body); };
  try {
    f.cache.save(unconfirmedAnswer(f.core.storageId, f.question, 'original before cancellation'));
    const first = new InteractionAnswerDelivery(f.core.storageId, request, f.cache, { receiptLookup: true });
    const other = new InteractionAnswerDelivery(f.core.storageId, request, new InteractionAnswerDrafts(path.join(f.directory, 'client'), f.client.localStateScope), { receiptLookup: true });
    await first.cancel(f.question.id, f.question.runId);
    await other.stage(f.question, 'new original from the already open second editor');
    await other.refresh(f.core.interactions()); await other.refresh(f.core.interactions());
    assert.equal(posts, 0); assert.equal(cancellations, 1); assert.equal(other.needsRefresh(), false); assert.equal(f.prompts.length, 1);
    assert.deepEqual(f.cache.list(f.core.storageId).map(row => row.answer), ['original before cancellation', 'new original from the already open second editor']);
    assert.ok(f.cache.list(f.core.storageId).every(row => row.cancelAcknowledgedAt));
    assert.match(answerDeliveryLabel(other.entries()[0]!), /停止请求已确认/);
  } finally { await f.close(); }
});

test('local cache failure cannot prevent stopping the original Core run and confirmed text remains available during recovery', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    f.cache.save(unconfirmedAnswer(f.core.storageId, f.question, 'preserve while stopping with a failed disk'));
    const delivery = new InteractionAnswerDelivery(f.core.storageId, f.request, f.cache, { receiptLookup: true });
    const original = { list: f.cache.list.bind(f.cache), save: f.cache.save.bind(f.cache), requestCancel: f.cache.requestCancel.bind(f.cache), acknowledgeCancel: f.cache.acknowledgeCancel.bind(f.cache) };
    const fail = () => { throw new Error('synthetic disk unavailable'); };
    f.cache.list = fail; f.cache.save = fail; f.cache.requestCancel = fail; f.cache.acknowledgeCancel = fail;
    await delivery.cancel(f.question.id, f.question.runId);
    assert.equal(f.core.interactions()[0]!.status, 'cancelled'); assert.equal(f.prompts.length, 1);
    assert.equal(delivery.entries()[0]!.draft!.answer, 'preserve while stopping with a failed disk');
    assert.match(answerDeliveryLabel(delivery.entries()[0]!), /停止请求已确认/);
    Object.assign(f.cache, original); await delivery.refresh(f.core.interactions());
    assert.equal(f.cache.list(f.core.storageId)[0]!.answer, 'preserve while stopping with a failed disk');
    assert.ok(f.cache.list(f.core.storageId)[0]!.cancelAcknowledgedAt); assert.equal(f.core.interactionAnswers().length, 0);
  } finally { await f.close(); }
});

test('another client may acknowledge an exact delivered version while this window has a failed local receipt write', { timeout: 30000 }, async () => {
  const f = await fixture(); const original = f.cache.save.bind(f.cache); let fail = false, posts = 0;
  f.cache.save = value => { if (fail) throw new Error('synthetic receipt write unavailable'); return original(value); };
  try {
    const first = new InteractionAnswerDelivery(f.core.storageId, async <T>(route: string, body?: unknown) => {
      const result = await f.request<T>(route, body); if (route.endsWith('/answer-outbox')) { posts++; fail = true; } return result;
    }, f.cache, { receiptLookup: true });
    await assert.rejects(first.stage(f.question, 'same exact original answer'), /receipt write unavailable/);
    await finished(f.core, f.submitted.runId!);
    const second = new InteractionAnswerDelivery(f.core.storageId, f.request, new InteractionAnswerDrafts(path.join(f.directory, 'client'), f.client.localStateScope), { receiptLookup: true });
    await second.refresh(f.core.interactions()); assert.deepEqual(new InteractionAnswerDrafts(path.join(f.directory, 'client'), f.client.localStateScope).list(f.core.storageId), []);
    fail = false; await first.refresh(f.core.interactions());
    assert.equal(first.entries().some(row => row.draft), false); assert.equal(posts, 1); assert.equal(f.prompts.length, 2);
    assert.deepEqual(f.cache.list(f.core.storageId), []);
  } finally { await f.close(); }
});

test('a fresh terminal with an unreadable local answer file can still inspect and stop the original Core request without changing that file', { timeout: 30000 }, async () => {
  const f = await fixture();
  const app = new TerminalApp(f.client, 'main', new TestTerminal(), { answerDrafts: f.cache });
  const ui = app as unknown as { storageId: string; capabilities: Set<string>; note(text: string): void; pick(): Promise<string>; choose(title: string, choices: Array<{ value: string }>): Promise<string>; questions(): Promise<void> };
  try {
    f.cache.save(unconfirmedAnswer(f.core.storageId, f.question, 'original local data'));
    const file = path.join(f.directory, 'client', fs.readdirSync(path.join(f.directory, 'client')).find(name => name.endsWith('.sqlite'))!);
    const corrupt = Buffer.from('synthetic damaged local storage'); fs.writeFileSync(file, corrupt);
    ui.storageId = f.core.storageId; ui.capabilities = new Set(['interactive-tools', 'interaction-answer-outbox', 'interaction-answer-receipt-lookup']); ui.note = () => {};
    ui.pick = async () => f.question.id;
    const actions = ['cancel', 'yes']; ui.choose = async (title, choices) => { if (title === '处理这项请求') { assert.ok(choices.some(row => row.value === 'view')); assert.ok(!choices.some(row => row.value === 'answer')); } return actions.shift()!; };
    await ui.questions();
    assert.equal(f.core.interactions()[0]!.status, 'cancelled'); assert.equal(f.core.interactionAnswers().length, 0); assert.equal(f.prompts.length, 1);
    assert.deepEqual(fs.readFileSync(file), corrupt);
  } finally { await app.stop(); await f.close(); }
});
