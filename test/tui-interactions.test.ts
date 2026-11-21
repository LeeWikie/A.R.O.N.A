import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
const request = { id: 'question.fixture', contextId: 'work.fixture', runId: 'run.original', toolCallId: 'tool.fixture', toolName: 'ask_user', kind: 'question', payload: { question: 'Which synthetic output?' }, status: 'pending', createdAt: '2026-01-01T00:00:00Z' };
type UI = { capabilities: Set<string>; command(text: string): Promise<void>; pendingInteractions: unknown[]; postponedInteractions: Set<string>; answerInteraction(item: unknown): Promise<void>; choose(title: string, items: unknown[]): Promise<string | undefined>; promptLong(title: string): Promise<string | undefined>; approvalPrompt(title: string, body: string[], options: string[], labels?: unknown): Promise<string | undefined>; note(text: string): void; storageId: string; storageGeneration: number };
function fixture() {
  const writes: Array<{ route: string; body: unknown }> = [], notes: string[] = [];
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    if (init?.method === 'POST') { writes.push({ route, body: JSON.parse(String(init.body)) }); return { status: 'answered' }; }
    if (route === '/interactions') return { interactions: [request] };
    throw new Error('unexpected route ' + route);
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as UI; ui.capabilities = new Set(['interactive-tools']); ui.note = text => { notes.push(text); };
  return { app, ui, writes, notes };
}

test('free text answers target the exact suspended run and Escape defers without sending or cancelling', async () => {
  const { app, ui, writes, notes } = fixture();
  try {
    ui.pendingInteractions = [request]; ui.promptLong = async () => undefined;
    await ui.answerInteraction(request); assert.equal(writes.length, 0); assert.equal(ui.postponedInteractions.has(request.id), true); assert.match(notes.at(-1)!, /暂缓/);
    ui.promptLong = async () => 'first line\nsecond line'; await ui.answerInteraction(request);
    assert.deepEqual(writes, [{ route: '/interactions/question.fixture/answer', body: { expectedRunId: 'run.original', answer: 'first line\nsecond line' } }]);
    assert.equal(ui.pendingInteractions.length, 0); assert.equal(ui.postponedInteractions.has(request.id), false);
  } finally { await app.stop(); }
});

test('single, multiple, and free-form option answers preserve actual option values', async () => {
  const { app, ui, writes } = fixture();
  const item = { ...request, payload: { question: 'Pick', options: [{ label: 'Alpha' }, { label: 'Beta' }], selectionMode: 'single_select' } };
  try {
    ui.choose = async () => '1'; await ui.answerInteraction(item); assert.deepEqual(writes.at(-1)?.body, { expectedRunId: request.runId, answer: 'Beta' });
    item.payload.selectionMode = 'multi_select'; const choices = ['1', '0', '1', 'done']; ui.choose = async () => choices.shift(); await ui.answerInteraction(item); assert.deepEqual(writes.at(-1)?.body, { expectedRunId: request.runId, answer: ['Alpha'] });
    ui.choose = async () => 'text'; ui.promptLong = async () => 'Gamma'; await ui.answerInteraction(item); assert.deepEqual(writes.at(-1)?.body, { expectedRunId: request.runId, answer: ['Gamma'] });
  } finally { await app.stop(); }
});

test('plan confirmation uses the paged body and sends only the explicit approval or rejection', async () => {
  const { app, ui, writes } = fixture(); const plan = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}`).join('\n');
  const item = { ...request, toolName: 'submit_plan', kind: 'plan', payload: { title: 'Synthetic plan', plan } };
  try {
    ui.approvalPrompt = async (_title, body, options) => { assert.ok(body.includes('Step 40')); assert.deepEqual(options, ['once', 'decline', 'later']); return 'later'; };
    await ui.answerInteraction(item); assert.equal(writes.length, 0);
    ui.approvalPrompt = async () => 'once'; await ui.answerInteraction(item); assert.deepEqual(writes.at(-1)?.body, { expectedRunId: request.runId, answer: { action: 'approved' } });
    ui.approvalPrompt = async () => 'decline'; ui.promptLong = async () => 'Use a smaller scope'; await ui.answerInteraction(item); assert.deepEqual(writes.at(-1)?.body, { expectedRunId: request.runId, answer: { action: 'rejected', feedback: 'Use a smaller scope' } });
  } finally { await app.stop(); }
});

test('/questions cancellation is explicit and tied to the question run; changed storage cannot receive old answers', async () => {
  const { app, ui, writes } = fixture();
  try {
    const choices = ['cancel', 'yes']; ui.choose = async () => choices.shift(); await ui.command('/questions');
    assert.deepEqual(writes, [{ route: '/interactions/question.fixture/cancel', body: { expectedRunId: request.runId } }]);
    ui.storageId = 'first'; ui.choose = async () => 'answer'; ui.promptLong = async () => { ui.storageId = 'other'; ui.storageGeneration++; return 'late answer'; };
    await ui.command('/questions'); assert.equal(writes.length, 1);
  } finally { await app.stop(); }
});
