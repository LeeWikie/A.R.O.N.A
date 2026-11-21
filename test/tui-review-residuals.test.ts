import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TerminalApp } from '../src/tui/index.js';
import { Client } from '../src/client.js';
import { AppError } from '../src/domain.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { toolActivity } from '../src/tool-activity.js';
import { publicEventPage } from '../src/event-stream.js';

class FakeTerminal {
  columns = 120; rows = 36; kittyProtocolActive = false; writes: string[] = [];
  start() {} stop() {} async drainInput() {} write(text: string) { this.writes.push(text); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(request: (route: string, init?: any) => Promise<unknown> = async () => ({})) {
  const terminal = new FakeTerminal();
  const app = new TerminalApp({ request } as any, 'main', terminal);
  const state = app as any;
  state.contextRole = 'main'; state.contextReady = true; state.isMainContext = true; state.storageId = 'old';
  return { app, state, terminal };
}
function stubReload(state: any, storageId = 'new') {
  state.client.snapshot = async () => ({ protocolVersion: 1, storageId, instanceId: storageId + '-instance', selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], conversation: { messages: [], hasMore: false } });
  for (const name of ['refreshModel', 'refreshUsage', 'refreshTasks', 'refreshQueue', 'connectStream']) state[name] = async () => {};
}
const attachment = { id: '00000000-0000-4000-8000-000000000001', name: 'A.txt', mediaType: 'text/plain', bytes: 1 };

test('control: AltEnter cannot clear B while A awaits an accepted or rejected receipt', async t => {
  for (const outcome of ['accepted', 'rejected', 'uncertain']) await t.test(outcome, async () => {
    const response = deferred<unknown>(); let posts = 0;
    const { app, state } = fixture(async () => { posts++; return response.promise; });
    try {
      state.editor.setText('A'); const pending = state.followUp(); state.editor.setText('B');
      await state.followUp(); assert.equal(state.editor.getExpandedText(), 'B'); assert.equal(posts, 1);
      if (outcome === 'accepted') response.resolve({ status: 'accepted' });
      else response.reject(outcome === 'rejected' ? new AppError('message_rejected', 400) : new Error('offline'));
      await pending; assert.equal(state.editor.getExpandedText(), 'B');
      if (outcome !== 'accepted') assert.ok([...state.recoverableDrafts.values()].some((d: any) => d.text === 'A'));
    } finally { response.resolve({ status: 'accepted' }); await app.stop(); }
  });
});

test('preflight-unavailable: original A remains recoverable when B is typed during model refresh', async () => {
  const refresh = deferred<void>(); let messages = 0;
  const { app, state } = fixture(async route => { if (route === '/messages') messages++; return { status: 'accepted' }; });
  try {
    state.model = { unavailable: 'not-ready' }; state.refreshModel = () => refresh.promise;
    state.pendingAttachments.set('main', [attachment]); state.editor.setText('A');
    const pending = state.followUp(); state.editor.setText('B'); refresh.resolve(); await pending;
    assert.equal(state.editor.getExpandedText(), 'B'); assert.equal(messages, 0);
    assert.ok([...state.recoverableDrafts.values()].some((d: any) => d.text === 'A' && d.attachments[0]?.id === attachment.id), 'A was cleared but is absent from recoverableDrafts');
  } finally { refresh.resolve(); await app.stop(); }
});

test('preflight-replacement: A remains recoverable when B exists on the detached source', async () => {
  const refresh = deferred<void>(); const { app, state } = fixture();
  try {
    state.model = { unavailable: 'not-ready' }; state.refreshModel = () => refresh.promise; state.editor.setText('A');
    const source = state.editor; const pending = state.followUp(); source.setText('B');
    state.editor = state.createEditor(); state.editor.setText('C'); state.model = undefined;
    refresh.resolve(); await pending;
    assert.equal(state.editor.getExpandedText(), 'C'); assert.equal(source.getExpandedText(), 'B');
    assert.ok([...state.recoverableDrafts.values()].some((d: any) => d.text === 'A'), 'A is neither in the source editor nor in recoverableDrafts');
  } finally { refresh.resolve(); await app.stop(); }
});

for (const command of ['/menu', '/attach']) test(`recovery-entry: staged attachment does not turn ${command} into a model message`, async () => {
  const bodies: any[] = []; const menus: string[][] = [];
  const { app, state } = fixture(async (route, init) => {
    if (route === '/messages') { bodies.push(JSON.parse(String(init?.body))); return { status: 'accepted' }; }
    return {};
  });
  try {
    state.capabilities.add('attachments');
    state.rememberDraft({ text: 'failed A', context: 'main', storageId: 'old', attachments: [], shell: [] });
    state.pendingAttachments.set('main', [attachment]);
    state.choose = async (_title: string, items: any[]) => { menus.push(items.map(item => item.value)); return items.some(item => item.value === 'yes') ? 'yes' : undefined; };
    state.editor.setText(command); await state.followUp();
    assert.equal(bodies.length, 0, JSON.stringify({ bodies, menus }));
  } finally { await app.stop(); }
});

test('plain-recovery: successfully sent recovered B is removed from the recovery list', async () => {
  const { app, state } = fixture(async () => ({ status: 'accepted' }));
  try {
    const saved = state.rememberDraft({ text: 'B preserved during A recovery', context: 'main', storageId: 'old', attachments: [], shell: [] });
    state.choose = async () => saved.key;
    await state.recoverDraft(); assert.equal(state.editor.getExpandedText(), saved.text);
    await state.followUp();
    assert.equal(state.recoverableDrafts.has(saved.key), false, 'the already accepted plain draft remains recoverable');
  } finally { await app.stop(); }
});

test('storage-replacement: a real folded paste retains its expanded content in the visible editor', async () => {
  const bodies: any[] = [];
  const { app, state } = fixture(async (route, init) => { if (route === '/messages') bodies.push(JSON.parse(String(init?.body))); return { status: 'accepted' }; });
  try {
    const content = 'B '.repeat(800); state.editor.handleInput('\x1b[200~' + content + '\x1b[201~');
    assert.equal(state.editor.getExpandedText(), content); assert.match(state.editor.getText(), /^\[paste #1/);
    stubReload(state); await state.loadContext(state.generation);
    const visible = state.editor.getExpandedText();
    await state.followUp();
    assert.equal(bodies[0]?.content, content.trim(), JSON.stringify({ visible, submitted: bodies[0]?.content, archived: [...state.recoverableDrafts.values()].map((d: any) => ({ textLength: d.text.length, storageId: d.storageId })) }));
  } finally { await app.stop(); }
});

const osc = '\x1b]52;c;c3ludGhldGlj\x07';
for (const kind of ['context-rename', 'queue-edit']) test(`modal-render: ${kind} does not emit server-supplied OSC52`, async () => {
  const hostile = 'safe-prefix ' + osc + ' safe-suffix';
  const { app, state } = fixture(async route => route === '/contexts' ? { contexts: [{ id: 'main', name: hostile, role: 'main' }] } : [{ id: 'queued', content: hostile, revision: 1 }]);
  const opened: any[] = [];
  state.overlays.openOverlay = (component: any) => { opened.push(component); return {}; };
  state.overlays.closeOverlay = () => {};
  let choices = kind === 'context-rename' ? ['main', 'rename'] : ['queued', 'edit'];
  state.choose = async () => choices.shift();
  const operation = kind === 'context-rename' ? state.contexts() : state.messageQueue();
  try {
    await tick(); assert.equal(opened.length, 1);
    const rendered = opened[0].render(120).join('\n');
    assert.equal(rendered.includes(osc), false, 'an intact OSC52 sequence reaches the rendered modal');
  } finally { state.pendingModal?.(); await operation; await app.stop(); }
});

test('modal-storage: confirmation selected in old storage cannot delete a same-named new-storage credential', async () => {
  const calls: any[] = []; let state: any;
  const f = fixture(async (route, init) => { calls.push({ route, method: init?.method, storageId: state.storageId }); return route === '/credentials' ? { credentials: [{ name: 'SYNTHETIC_REVIEW_ONLY' }] } : {}; });
  state = f.state; const { app } = f;
  const opened: any[] = []; const choose = state.choose.bind(state); let choices = ['existing:SYNTHETIC_REVIEW_ONLY', 'remove'];
  state.choose = (...args: any[]) => choices.length ? Promise.resolve(choices.shift()) : choose(...args);
  const open = state.overlays.openOverlay.bind(state.overlays);
  state.overlays.openOverlay = (component: any, options: any) => { opened.push(component); return open(component, options); };
  const operation = state.withModalFlow(() => state.credentials());
  try {
    await tick(); assert.equal(opened.length, 1); assert.equal(typeof state.pendingModal, 'function');
    stubReload(state); await state.loadContext(state.generation);
    // Simulate the user confirming the still-visible old confirmation. This is an in-memory fake client only.
    if (state.pendingModal) { opened[0].handleInput('\x1b[B'); opened[0].handleInput('\r'); }
    await operation;
    assert.equal(calls.some(call => call.method === 'DELETE'), false, JSON.stringify(calls));
  } finally { state.pendingModal?.(); await operation; await app.stop(); }
});

function legacy() {
  const db = new DatabaseSync(':memory:'); const runtime = new RuntimeStore(db);
  const core = { store: { db }, runtime, redactionValues: () => [] } as any;
  const emit = (kind: string, data: unknown) => runtime.event({ kind, data, contextId: 'main', runId: 'run' });
  return { db, core, runtime, emit };
}
const start = { toolCallId: 'call', toolName: 'fixture' };
for (const malformed of [{ exitCode: 'bad', success: false }, { exitCode: 7 }]) test(`legacy-malformed-first: valid subsequent exit survives final tool_end (${JSON.stringify(malformed)})`, () => {
  const { db, core, emit } = legacy();
  try {
    emit('tool_start', start); emit('command_exit', { toolCallId: 'call', ...malformed });
    emit('command_exit', { toolCallId: 'call', exitCode: 7, success: false });
    emit('tool_end', { toolCallId: 'call', isError: false, result: 'not evidence' });
    const events = publicEventPage(core, 0, 'main').events; const current = toolActivity(core, 'main')[0];
    const states = events.map(event => ({ seq: event.seq, ...(event.data as any) }));
    assert.deepEqual({ state: (events.at(-1)?.data as any)?.state, exitCode: (events.at(-1)?.data as any)?.exitCode }, { state: current?.state, exitCode: current?.exitCode }, JSON.stringify(states));
  } finally { db.close(); }
});
for (const terminal of [{ denied: true }, { isError: true }]) test(`legacy-repeat: duplicate successful end cannot erase ${JSON.stringify(terminal)}`, () => {
  const { db, core, emit } = legacy();
  try {
    emit('tool_start', start); emit('tool_end', { toolCallId: 'call', ...terminal });
    emit('command_exit', { toolCallId: 'call', exitCode: 0, success: true });
    emit('tool_end', { toolCallId: 'call', isError: false });
    const events = publicEventPage(core, 0, 'main').events; const current = toolActivity(core, 'main')[0];
    assert.equal((events.at(-1)?.data as any)?.state, current?.state, JSON.stringify(events.map(event => event.data)));
  } finally { db.close(); }
});

test('control: TerminalApp compact override reaches real Client without the 30s default, and keeps cancellation', async t => {
  const oldFetch = globalThis.fetch; const oldTimeout = AbortSignal.timeout;
  const deadlines: number[] = []; let signal: AbortSignal | undefined; const started = deferred<void>();
  const response = deferred<Response>();
  try {
    AbortSignal.timeout = ((ms: number) => { deadlines.push(ms); return oldTimeout(ms); }) as any;
    globalThis.fetch = (async (_target: unknown, init: any) => { signal = init.signal; started.resolve(); return response.promise; }) as any;
    const { app, state } = fixture(); state.client = new Client('http://review.invalid', 'synthetic-review-token');
    state.refreshModel = async () => {};
    const compact = state.compact();
    try {
      await started.promise; assert.deepEqual(deadlines, [600_000]);
      state.compactController.abort(); assert.equal(signal?.aborted, true);
      response.reject(new Error('cancelled')); await compact;
    } finally { response.reject(new Error('cleanup')); await app.stop(); }
  } finally { globalThis.fetch = oldFetch; AbortSignal.timeout = oldTimeout; }
});

for (const kind of ['context-rename', 'queue-edit']) test(`full terminal rendering filters modal ${kind} controls and retains CJK`, async () => {
  const hostile = `正常中文\n第二行 ${osc} 后缀`;
  const { app, state, terminal } = fixture(async route => route === '/contexts' ? { contexts: [{ id: 'main', name: hostile, role: 'main' }] } : [{ id: 'queued', content: hostile, revision: 1 }]);
  const choices = kind === 'context-rename' ? ['main', 'rename'] : ['queued', 'edit'];
  state.choose = async () => choices.shift(); state.ui.start(); state.started = true;
  const operation = kind === 'context-rename' ? state.contexts() : state.messageQueue();
  try {
    await tick(); state.ui.doRender();
    assert.equal(terminal.writes.some(write => write.includes(osc)), false);
    assert.ok(terminal.writes.join('').includes('正常中文'));
    if (kind === 'queue-edit') assert.ok(terminal.writes.join('').includes('第二行'));
  } finally { state.pendingModal?.(); await operation; await app.stop(); }
});

test('real editor Enter followed by B preserves preflight A with its original resources', async () => {
  const refresh = deferred<void>(); const { app, state } = fixture();
  let submitted: Promise<void> | undefined; const submit = state.submit.bind(state);
  state.submit = (...args: unknown[]) => { submitted = submit(...args); return submitted; };
  try {
    state.model = { unavailable: 'not-ready' }; state.refreshModel = () => refresh.promise;
    state.pendingAttachments.set('main', [attachment]); state.sharedShell.set('main', ['shell A']);
    state.editor.setText('A'); state.editor.handleInput('\r'); assert.ok(submitted);
    state.editor.handleInput('B'); state.pendingAttachments.set('main', [{ ...attachment, id: 'B' }]); state.sharedShell.set('main', ['shell B']);
    refresh.resolve(); await submitted;
    assert.equal(state.editor.getExpandedText(), 'B'); assert.equal(state.editor.history.includes('A'), true);
    const saved = [...state.recoverableDrafts.values()].find((d: any) => d.text === 'A') as any;
    assert.deepEqual(saved.attachments, [attachment]); assert.deepEqual(saved.shell, ['shell A']);
    assert.equal(state.pendingAttachments.get('main')[0].id, 'B'); assert.deepEqual(state.sharedShell.get('main'), ['shell B']);
  } finally { refresh.resolve(); await app.stop(); }
});

for (const mode of ['cancel-attachment', 'cancel-mode', 'refresh-error']) test(`preflight ${mode} retains consumed A without combining B`, async () => {
  const gate = deferred<any>(); const { app, state } = fixture();
  try {
    state.sharedShell.set('main', ['shell A']);
    if (mode === 'cancel-attachment') state.pendingAttachments.set('main', [attachment]);
    if (mode === 'cancel-mode') { state.currentRunId = 'run'; state.capabilities.add('message-queue'); }
    if (mode === 'refresh-error') { state.model = { unavailable: 'not-ready' }; state.refreshModel = () => gate.promise; }
    else state.choose = () => gate.promise;
    state.editor.setText('A'); const pending = state.followUp();
    state.editor.setText('B'); state.sharedShell.set('main', ['shell B']);
    if (mode === 'refresh-error') gate.reject(new Error('synthetic preflight failure')); else gate.resolve('cancel');
    await pending;
    assert.equal(state.editor.getExpandedText(), 'B');
    const saved = [...state.recoverableDrafts.values()].find((d: any) => d.text === 'A') as any;
    assert.ok(saved); assert.deepEqual(saved.shell, ['shell A']); assert.equal(saved.attachments.length, mode === 'cancel-attachment' ? 1 : 0);
    assert.deepEqual(state.sharedShell.get('main'), ['shell B']);
  } finally { gate.resolve(undefined); await app.stop(); }
});

test('delayed old-storage management reads neither reopen a modal nor write after two storage replacements', async () => {
  const read = deferred<unknown>(); let calls = 0;
  const { app, state } = fixture(async () => { calls++; return read.promise; });
  let opened = 0; state.overlays.openOverlay = () => { opened++; return {}; };
  const operation = state.withModalFlow(() => state.credentials());
  const outcome = operation.then(() => undefined, (error: unknown) => error);
  try {
    stubReload(state); await state.loadContext(state.generation);
    stubReload(state, 'old'); await state.loadContext(state.generation);
    read.resolve({ credentials: [{ name: 'SYNTHETIC_ONLY' }] });
    const error = await outcome; assert.ok(error instanceof AppError); assert.equal(error.code, 'core_storage_changed');
    assert.equal(opened, 0); assert.equal(state.pendingModal, undefined); assert.equal(calls, 1);
  } finally { read.resolve({ credentials: [] }); await outcome; await app.stop(); }
});

test('actual write boundary rejects an old management continuation even if a chooser already resolved', async () => {
  const confirmation = deferred<string>(); const calls: any[] = [];
  const { app, state } = fixture(async (route, init) => { calls.push({ route, method: init?.method }); return { credentials: [{ name: 'SYNTHETIC_ONLY' }] }; });
  const choices = ['existing:SYNTHETIC_ONLY', 'remove']; state.choose = () => choices.length ? Promise.resolve(choices.shift()) : confirmation.promise;
  const operation = state.withModalFlow(() => state.credentials()); const outcome = operation.catch((error: unknown) => error);
  try {
    await tick(); stubReload(state); await state.loadContext(state.generation); confirmation.resolve('yes');
    const error = await outcome; assert.ok(error instanceof AppError); assert.equal(error.code, 'core_storage_changed');
    assert.equal(calls.some(call => call.method === 'DELETE'), false);
  } finally { confirmation.resolve('no'); await outcome; await app.stop(); }
});

for (const hasAttachment of [false, true]) test(`accepted plain recovery removes only its exact record, attachments=${hasAttachment}`, async () => {
  const receipt = deferred<unknown>(); const { app, state } = fixture(async () => receipt.promise);
  try {
    const A = state.rememberDraft({ text: hasAttachment ? '' : 'identical', context: 'main', storageId: 'old', attachments: hasAttachment ? [attachment] : [], shell: [] });
    const B = state.rememberDraft({ ...A });
    const unknown = state.rememberDraft({ text: A.text, context: 'main', storageId: 'old', attachments: A.attachments, shell: [], submission: { id: 'uncertain', outgoing: A.text, uncertain: true } });
    state.choose = async () => A.key; await state.recoverDraft(); state.choose = async () => 'yes';
    const pending = state.followUp(); await tick(); state.restoredDrafts.set(state.editor, B);
    receipt.resolve({ status: 'accepted' }); await pending;
    assert.equal(state.recoverableDrafts.has(A.key), false); assert.equal(state.recoverableDrafts.has(B.key), true); assert.equal(state.recoverableDrafts.has(unknown.key), true);
    assert.equal(state.restoredDrafts.get(state.editor).key, B.key);
  } finally { receipt.resolve({ status: 'accepted' }); await app.stop(); }
});

test('recovered editor values and history retain original controls while their rendered text cannot execute them', async () => {
  const { app, state } = fixture();
  try {
    const hostile = `中文\n第二行 ${osc} 末尾`;
    const saved = state.rememberDraft({ text: hostile, context: 'main', storageId: 'old', attachments: [], shell: [] });
    state.choose = async () => saved.key; await state.recoverDraft();
    assert.equal(state.editor.getExpandedText(), hostile);
    state.editor.addToHistory(hostile); assert.equal(state.editor.history[0], hostile);
    assert.equal(state.editor.render(120).join('\n').includes(osc), false);
  } finally { await app.stop(); }
});

for (const text of ['  中文正文\n', `中文\n第二行 ${osc} 末尾`]) test('successful normalized recovery cleans up its own raw draft record', async () => {
  const { app, state } = fixture(async () => ({ status: 'accepted' }));
  try {
    const saved = state.rememberDraft({ text, context: 'main', storageId: 'old', attachments: [], shell: [] });
    state.choose = async () => saved.key; await state.recoverDraft(); await state.followUp();
    assert.equal(state.recoverableDrafts.has(saved.key), false);
  } finally { await app.stop(); }
});

test('slash attachment management removes staged resources without submitting a message', async () => {
  let requests = 0; const { app, state } = fixture(async () => { requests++; return {}; });
  try {
    state.capabilities.add('attachments'); state.pendingAttachments.set('main', [attachment]);
    const choices = ['pending', attachment.id, 'yes']; state.choose = async () => choices.shift();
    state.editor.setText('/attach'); await state.followUp();
    assert.deepEqual(state.pendingAttachments.get('main'), []); assert.equal(requests, 0);
  } finally { await app.stop(); }
});

test('slash menu can swap recovered attachment A back to B without sending either', async () => {
  let requests = 0; const { app, state } = fixture(async () => { requests++; return {}; });
  try {
    state.pendingAttachments.set('main', [attachment]);
    const saved = state.rememberDraft({ text: 'B', context: 'main', storageId: 'old', attachments: [], shell: [] });
    const choices = ['recover-draft', saved.key, 'restore']; state.choose = async () => choices.shift();
    state.editor.setText('/menu'); await state.followUp();
    assert.equal(state.editor.getExpandedText(), 'B'); assert.deepEqual(state.pendingAttachments.get('main'), []);
    assert.ok([...state.recoverableDrafts.values()].some((d: any) => !d.text && d.attachments[0]?.id === attachment.id));
    assert.equal(requests, 0);
  } finally { await app.stop(); }
});

test('a context loader started by an old modal flow refreshes only the new storage outside that flow', async () => {
  const reads: string[] = []; const { app, state } = fixture(async route => {
    reads.push(route);
    if (route.endsWith('/model')) return { profileId: 'new-model', name: 'new-model', thinkingLevel: 'off' };
    return {};
  });
  state.client.snapshot = async () => ({ protocolVersion: 1, storageId: 'new', instanceId: 'new-instance', selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], conversation: { messages: [], hasMore: false } });
  for (const name of ['refreshUsage', 'refreshTasks', 'refreshQueue', 'connectStream']) state[name] = async () => {};
  try {
    await state.withModalFlow(() => state.loadContext(state.generation)); await tick();
    assert.equal(state.storageId, 'new'); assert.ok(reads.includes('/contexts/main/model'));
    assert.equal(state.model?.profileId, 'new-model');
  } finally { await app.stop(); }
});
