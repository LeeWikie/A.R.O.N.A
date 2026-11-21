import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { serve } from '@hono/node-server';
import type { Terminal } from '@earendil-works/pi-tui';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { Client } from '../src/client.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { InteractionAnswerDrafts, answerReviewId, unconfirmedAnswer } from '../src/tui/interaction-answers.js';
import { QueueLocalEdits } from '../src/tui/queue-local-edits.js';
import { QueueEditorComponent } from '../src/tui/queue-editor.js';
import { finished, removeTemp, until } from './helpers.js';

class TerminalFixture implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; input: (text: string) => void = () => {};
  start(input: (text: string) => void) { this.input = input; } stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('an undelivered Worker answer is reviewed as a new input in its original Main, preserving the current Worker draft across restart and leaving the canonical gate unchanged', { timeout: 30000 }, async () => {
  const descriptors = [Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')];
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-answer-review-'));
  const prompts: Array<{ worker: boolean; text: string }> = [];
  const model = new MastraLanguageModelV2Mock({ doStream: async request => {
    const text = request.prompt.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
    const worker = request.tools?.some(tool => tool.type === 'function' && tool.name === 'task_report') ?? false;
    prompts.push({ worker, text });
    const hasAnswer = request.prompt.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('ask_user'));
    const reported = request.prompt.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('task_report'));
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (worker && !hasAnswer) controller.enqueue({ type: 'tool-call', toolCallId: 'original-worker-question', toolName: 'ask_user', input: JSON.stringify({ question: 'Synthetic original Worker question?' }) });
      else if (worker && !reported) {
        const id = /"taskId":"([a-f0-9-]{36})"/.exec(text)?.[1]; assert.ok(id, text);
        controller.enqueue({ type: 'tool-call', toolCallId: 'worker-report', toolName: 'task_report', input: JSON.stringify({ id, report: { outcome: 'succeeded', summary: 'Canonical answer received', checks: [{ description: 'Original answer received', passed: true }], deliveries: [{ kind: 'text', title: 'Result', value: 'Canonical B' }], unresolved: [] } }) });
      } else {
        controller.enqueue({ type: 'text-start', id: 'reply' }); controller.enqueue({ type: 'text-delta', id: 'reply', delta: worker ? 'Worker complete' : 'Main received new input' }); controller.enqueue({ type: 'text-end', id: 'reply' });
      }
      controller.enqueue({ type: 'finish', finishReason: worker && (!hasAnswer || !reported) ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); controller.close();
    } }) };
  } });
  const core = await Core.open({ dataDir: path.join(directory, 'core'), model, memoryEnabled: false });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken);
  const answerDirectory = path.join(directory, 'answers'), queueDirectory = path.join(directory, 'drafts');
  const answers = new InteractionAnswerDrafts(answerDirectory, client.localStateScope), queue = new QueueLocalEdits(queueDirectory, client.localStateScope);
  let app: TerminalApp | undefined, running: Promise<void> | undefined;
  try {
    const target = core.createConversationContext({ name: 'Original dispatch conversation' });
    const task = await core.submitTask({ title: 'Original Worker', content: 'Ask the original question', returnContextId: target.id }, 'answer-review-original');
    const question = (await until(() => core.interactions(task.contextId), rows => rows.some(row => row.status === 'pending'))).find(row => row.status === 'pending')!;
    const raw = 'Recovered original A\n' + '中文😀'.repeat(12000) + '\n  keep trailing spaces  ';
    const local = answers.save(unconfirmedAnswer(core.storageId, question, raw));
    await client.request(`/interactions/${question.id}/answer-outbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRunId: question.runId, answer: 'Canonical B' }) });
    await finished(core, question.runId); await until(() => core.runtime.task(task.id).status, status => status === 'succeeded');
    await until(() => core.runtime.pendingNotifications().length, count => count === 0);
    const canonical = core.interactionAnswers()[0]!, original = core.interactions().find(row => row.id === question.id)!;
    const terminal = new TerminalFixture(); app = new TerminalApp(client, task.contextId, terminal, { answerDrafts: answers, queueEdits: queue }); const ui = app as any;
    running = app.run(); await until(() => ui.contextReady, Boolean);
    const asset = await core.assets.put(new Response('CURRENT_WORKER_ASSET').body, 'worker.txt');
    ui.editor.setText('CURRENT_WORKER_COMPOSER'); ui.sharedShell.set(task.contextId, ['CURRENT_WORKER_OBSERVATION']); ui.pendingAttachments.set(task.contextId, [asset]);
    ui.pick = async () => question.id; const choose = ui.choose.bind(ui); ui.choose = async (title: string, ...args: unknown[]) => title.startsWith('整份草稿包含') ? 'yes' : title.includes('本机') || title.includes('回答') ? 'view' : choose(title, ...args);
    ui.approvalPrompt = async (_title: string, body: string[]) => { assert.equal(body.join('\n'), raw); return 'once'; };
    const before = prompts.length, questionFlow = ui.questions();
    await until(() => ui.contextId === target.id && ui.sessionSelector instanceof QueueEditorComponent, Boolean);
    assert.equal(prompts.length, before, 'opening the review does not send an input');
    assert.deepEqual(core.interactions().find(row => row.id === question.id), original); assert.deepEqual(core.interactionAnswers()[0], canonical);
    const workerDraft = queue.captures(core.storageId, task.contextId).find(row => row.localOnly)!;
    assert.equal(workerDraft.content, 'CURRENT_WORKER_COMPOSER'); assert.deepEqual(workerDraft.attachments, [asset.id]); assert.equal(workerDraft.localContext, 'CURRENT_WORKER_OBSERVATION');
    const draft = core.queueEditor().list(target.id)[0]!, entry = core.queueEditor().page(target.id, draft.id).entries[0]!;
    assert.equal(entry.content, raw);
    terminal.input('\r'); await questionFlow;
    const submitted = core.queueEditor().page(target.id, draft.id).draft.submission!, signal = await until(() => core.store.getSignal(submitted.leaderSignalId!)!, row => row.status === 'accepted'); await finished(core, signal.runId!);
    assert.equal(core.store.getSignal(submitted.leaderSignalId!)!.contextId, target.id);
    const mainPrompt = prompts.filter(row => !row.worker).at(-1)!.text; assert.ok(mainPrompt.includes(raw)); assert.ok(mainPrompt.includes(question.id));
    assert.deepEqual(core.interactionAnswers()[0], canonical); assert.deepEqual(core.interactions().find(row => row.id === question.id), original);
    await app.reviewLocalInput({ id: answerReviewId({ ...local, localId: undefined, updatedAt: new Date(0).toISOString(), blockedCode: 'changed metadata' }), contextId: target.id, content: raw, localContext: JSON.stringify({ kind: 'prior-interaction-reference', interaction: original, taskIds: [task.id] }) });
    assert.equal(prompts.length, before + 1, 'reopening the same semantic version after metadata changes cannot create another input');
    await app.stop(); await running;
    const secondTerminal = new TerminalFixture(); app = new TerminalApp(client, task.contextId, secondTerminal, { answerDrafts: new InteractionAnswerDrafts(answerDirectory, client.localStateScope), queueEdits: new QueueLocalEdits(queueDirectory, client.localStateScope) }); const second = app as any;
    running = app.run(); await until(() => second.contextReady, Boolean);
    second.choose = async (title: string, rows: Array<{ value: string }>) => title.includes('保留当前') ? 'restore' : rows[0]!.value;
    await second.recoverDraft(); assert.equal(second.editor.getExpandedText(), 'CURRENT_WORKER_COMPOSER'); assert.deepEqual(second.pendingAttachments.get(task.contextId).map((row: { id: string }) => row.id), [asset.id]); assert.deepEqual(second.sharedShell.get(task.contextId), ['CURRENT_WORKER_OBSERVATION']);
  } finally {
    await app?.stop(); await running; if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    for (const [index, stream] of [process.stdin, process.stdout].entries()) { const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else delete (stream as { isTTY?: boolean }).isTTY; }
  }
});
