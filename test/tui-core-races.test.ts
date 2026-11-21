import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { approvalTarget, toolCallLine, TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const approval = { id: 'a', toolCallId: 'call', contextId: 'main', runId: 'run', toolName: 'fixture', args: {}, taskId: null, status: 'pending', createdAt: '' };
function fixture(request: (route: string, init?: RequestInit) => Promise<unknown> = async () => ({})) {
  const app = new TerminalApp({ request } as unknown as Client, 'main', new FakeTerminal());
  // Exercise async boundaries without a live server, model, filesystem state or terminal process.
  const state = app as any;
  state.contextRole = 'main'; state.contextReady = true; state.isMainContext = true;
  return { app, state };
}

test('array tool targets are sanitized before theme formatting', () => {
  const target = ['safe\x1b[2J\x1b]0;injected\x07‮path'];
  const line = toolCallLine('mastra_workspace_read_file', { paths: target });
  assert.doesNotMatch(line, /\x1b|\x07|‮/);
  assert.equal(approvalTarget({ paths: target }), 'safepath');
});

test('legal JSON with a shadowed toString survives labels, approvals and expanded tool replay', async () => {
  const { app, state } = fixture();
  const hostile = JSON.parse('{"toString":null}');
  try {
    assert.equal(approvalTarget({ paths: [hostile] }), '{"toString":null}');
    assert.equal(approvalTarget({ command: hostile }), '{"toString":null}');
    const modal = state.choose('fixture', [{ value: 'x', label: hostile }]); state.pendingModal(); await modal;
    const event = { kind: 'tool', contextId: 'main', runId: 'run', data: { toolCallId: 'call', toolName: 'fixture', state: 'finished', args: { paths: [hostile], truncated: { truncated: true, characters: hostile } } } };
    state.event(event); state.event(event);
    assert.equal(state.toolCards.size, 1);
    assert.doesNotThrow(() => [...state.toolCards.values()][0].toggle());
  } finally { await app.stop(); }
});

test('late message completion unlocks the captured editor, never its replacement', async () => {
  const response = deferred<unknown>(); const { app, state } = fixture(async () => response.promise);
  const original = state.editor;
  try {
    const submitting = state.submit('original message');
    assert.equal(original.disableSubmit, true);
    const replacement = state.createEditor(); state.editor = replacement; state.contextId = 'other'; replacement.disableSubmit = true; replacement.setText('new draft');
    response.reject(new Error('synthetic offline failure')); await submitting;
    assert.equal(original.disableSubmit, false);
    assert.equal(replacement.disableSubmit, true);
    assert.equal(replacement.getText(), 'new draft');
    assert.equal(original.getText(), 'original message', 'the original editor retains the failed input');
  } finally { await app.stop(); }
});

test('successful late submission records history on the original editor only', async () => {
  const response = deferred<unknown>(); const { app, state } = fixture(async () => response.promise);
  const original = state.editor; const history: string[] = [];
  original.addToHistory = (text: string) => history.push(text);
  try {
    const submitting = state.submit('accepted in main');
    const replacement = state.createEditor(); state.editor = replacement; state.contextId = 'other'; replacement.disableSubmit = true; replacement.setText('new draft');
    response.resolve({ status: 'accepted' }); await submitting;
    assert.equal(original.disableSubmit, false); assert.deepEqual(history, ['accepted in main']);
    assert.equal(replacement.disableSubmit, true); assert.equal(replacement.getText(), 'new draft');
    assert.equal(state.transcript.children.length, 0, 'old-context receipt does not render in the new context');
  } finally { await app.stop(); }
});

test('submission captures its context before model refresh awaits', async () => {
  const refresh = deferred<void>(); const writes: unknown[] = [];
  const { app, state } = fixture(async (_route, init) => { writes.push(JSON.parse(String(init?.body))); return { status: 'accepted' }; });
  try {
    state.model = { unavailable: 'not-ready' }; state.refreshModel = () => refresh.promise;
    const original = state.editor; const submitting = state.submit('original message');
    state.editor = state.createEditor(); state.contextId = 'other'; state.model = undefined;
    refresh.resolve(); await submitting;
    assert.equal(writes.length, 0, 'stale preflight must not submit to the newly selected context');
    assert.equal(original.getText(), 'original message');
  } finally { await app.stop(); }
});

test('automatic approval cannot take a management flow during a network gap', async () => {
  const models = deferred<unknown>(); const { app, state } = fixture(async () => models.promise);
  try {
    state.started = true;
    const managing = state.command('/model');
    state.pendingApprovals = [approval]; void state.presentApproval(); await tick();
    assert.equal(state.approvalOpen, undefined);
    assert.equal(state.pendingModal, undefined);
    models.resolve({ models: [{ id: 'm', name: 'Model', modelId: 'fixture' }] }); await tick();
    const cancel = state.pendingModal; assert.equal(typeof cancel, 'function');
    await state.presentApproval(); assert.equal(state.pendingModal, cancel);
    cancel(); await managing; await tick();
    assert.equal(state.approvalOpen, 'a', 'approval resumes after the complete management flow');
    state.pendingModal(); await tick();
    assert.equal(state.postponedApprovals.has('a'), true);
  } finally { models.resolve({ models: [] }); await app.stop(); }
});

test('management retains ownership between its first selection and the next network-backed dialog', async () => {
  const models = deferred<unknown>(); const { app, state } = fixture(async () => models.promise);
  const choose = state.choose.bind(state); let first = true;
  state.choose = (...args: unknown[]) => { if (first) { first = false; return Promise.resolve('models'); } return choose(...args); };
  try {
    state.started = true; const managing = state.manage(); await tick();
    state.pendingApprovals = [approval]; void state.presentApproval(); await tick();
    assert.equal(state.approvalOpen, undefined);
    models.resolve({ models: [] }); await tick();
    assert.equal(typeof state.pendingModal, 'function');
    await app.stop(); await managing;
    assert.equal(state.pendingModal, undefined); assert.equal(state.modalFlow, undefined);
  } finally { models.resolve({ models: [] }); await app.stop(); }
});

test('approval owns its task lookup and cannot overwrite a newly requested dialog', async () => {
  const task = deferred<unknown>(); const { app, state } = fixture(async () => task.promise);
  try {
    state.started = true; state.pendingApprovals = [{ ...approval, taskId: 'task' }];
    const deciding = state.presentApproval();
    void state.command('/name'); await tick();
    assert.equal(state.pendingModal, undefined, 'a second flow must not start while approval details load');
    task.resolve({ id: 'task', title: 'Task' }); await tick();
    state.pendingModal(); await deciding;
    assert.equal(state.postponedApprovals.has('a'), true);
  } finally { task.resolve({}); await app.stop(); }
});

test('draft typed during automatic approval lookup defers the prompt without discarding input', async () => {
  const task = deferred<unknown>(); const { app, state } = fixture(async () => task.promise);
  try {
    state.started = true; state.pendingApprovals = [{ ...approval, taskId: 'task' }];
    const deciding = state.presentApproval(); state.editor.setText('draft written while loading');
    task.resolve({ id: 'task', title: 'Task' }); await tick();
    assert.equal(state.pendingModal, undefined);
    await deciding; assert.equal(state.approvalDeferred, true);
    assert.equal(state.editor.getText(), 'draft written while loading');
    state.editor.setText(''); await tick();
    assert.equal(typeof state.pendingModal, 'function'); state.pendingModal(); await tick();
    assert.equal(state.postponedApprovals.has('a'), true);
  } finally { task.resolve({}); await app.stop(); }
});

test('stop during approval lookup releases flow without opening a modal', async () => {
  const task = deferred<unknown>(); const { app, state } = fixture(async () => task.promise);
  state.started = true; state.pendingApprovals = [{ ...approval, taskId: 'task' }];
  const deciding = state.presentApproval(); await app.stop(); task.resolve({}); await deciding;
  assert.equal(state.pendingModal, undefined); assert.equal(state.approvalOpen, undefined); assert.equal(state.modalFlow, undefined);
});

test('configuration state is global but other-context content stays isolated', async () => {
  const { app, state } = fixture(async () => ({ contexts: [] })); let refreshed = 0;
  try {
    state.refreshModel = async () => { refreshed++; };
    state.event({ kind: 'state', contextId: 'settings', data: { area: 'configuration' } });
    assert.equal(refreshed, 1);
    const children = state.transcript.children.length;
    for (const kind of ['conversation', 'thinking', 'tool']) state.event({ kind, contextId: 'other', runId: 'r', data: {} });
    assert.equal(state.transcript.children.length, children); assert.equal(state.toolCards.size, 0); assert.equal(state.thinkingBlocks.size, 0);
    state.event({ kind: 'state', contextId: 'other', data: { area: 'contexts' } }); assert.equal(refreshed, 1, 'context-local updates stay local');
  } finally { await app.stop(); }
});

test('compact explicitly requests ten-minute timeout and retains caller cancellation', async () => {
  let init: (RequestInit & { timeoutMs?: number }) | undefined;
  const response = deferred<unknown>(); const { app, state } = fixture(async (_route, options) => { init = options; return response.promise; });
  const compacting = state.compact();
  try {
    assert.equal(init?.timeoutMs, 600_000);
    state.compactController.abort(); assert.equal(init?.signal?.aborted, true);
    response.reject(new Error('cancelled')); await compacting;
  } finally { state.compactController?.abort(); response.reject(new Error('cleanup')); await compacting; await app.stop(); }
});

// Enter clears the editor before onSubmit; Alt+Enter must apply the same admission guard first.
test('follow-up while A is pending preserves B on the same editor on success and failure', async () => {
  for (const accepted of [true, false]) {
    const response = deferred<unknown>(); let writes = 0;
    const { app, state } = fixture(async () => { writes++; return response.promise; });
    const original = state.editor;
    try {
      const submitting = state.submit('A'); original.setText('B');
      await state.followUp();
      assert.equal(original.getText(), 'B', 'blocked Alt+Enter must not clear the next draft');
      assert.equal(writes, 1);
      if (accepted) response.resolve({ status: 'accepted' }); else response.reject(new Error('offline'));
      await submitting; assert.equal(original.getText(), 'B'); assert.equal(original.disableSubmit, false);
    } finally { response.resolve({ status: 'accepted' }); await app.stop(); }
  }
});

test('admitted follow-up queues and clears only its original editor', async () => {
  const response = deferred<unknown>(); let body: any;
  const { app, state } = fixture(async (_route, init) => { body = JSON.parse(String(init?.body)); return response.promise; });
  try {
    state.currentRunId = 'run'; state.capabilities.add('message-queue'); state.editor.setText('queued A');
    const original = state.editor; const submitting = state.followUp();
    assert.equal(original.getText(), ''); assert.equal(original.disableSubmit, true); assert.equal(body.mode, 'queue');
    state.editor = state.createEditor(); state.editor.setText('replacement B'); response.resolve({ status: 'queued' }); await submitting;
    assert.equal(state.editor.getText(), 'replacement B'); assert.equal(original.disableSubmit, false);
  } finally { response.resolve({ status: 'queued' }); await app.stop(); }
});

test('late definite rejection retains complete A, isolates B, and recovery swaps rather than overwrites drafts', async () => {
  const { AppError } = await import('../src/domain.js');
  const response = deferred<unknown>(); const bodies: any[] = [];
  const { app, state } = fixture(async (_route, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? response.promise : { status: 'accepted' }; });
  const attachment = { id: 'a', name: 'A.txt', mediaType: 'text/plain', bytes: 1 };
  try {
    state.storageId = 'store'; state.pendingAttachments.set('main', [attachment]); state.sharedShell.set('main', ['shell A']); state.choose = async () => 'yes';
    const submitting = state.submit('A'); await tick();
    state.editor.setText('B'); state.pendingAttachments.set('main', [{ ...attachment, id: 'b', name: 'B.txt' }]); state.sharedShell.set('main', ['shell B']);
    response.reject(new AppError('message_rejected', 400)); await submitting;
    assert.equal(state.editor.getText(), 'B');
    const saved = [...state.recoverableDrafts.values()] as any[];
    assert.equal(saved.length, 1); assert.equal(saved[0].text, 'A'); assert.equal(saved[0].submission.uncertain, false);
    assert.deepEqual(saved[0].attachments, [attachment]); assert.deepEqual(saved[0].shell, ['shell A']); assert.equal(saved[0].submission.outgoing, 'shell A\n\nA');
    // First chooser selects A; the second explicitly allows retaining B and restoring A.
    state.choose = async (_title: string, items: any[]) => items.some(item => item.value === 'restore') ? 'restore' : saved[0].key;
    await state.recoverDraft(); assert.equal(state.editor.getText(), 'A'); assert.deepEqual(state.pendingAttachments.get('main'), [attachment]); assert.deepEqual(state.sharedShell.get('main'), ['shell A']);
    assert.ok([...state.recoverableDrafts.values()].some((draft: any) => draft.text === 'B' && draft.attachments[0]?.id === 'b' && draft.shell[0] === 'shell B'));
    state.choose = async () => 'yes'; state.editor.setText(''); await state.submit('A');
    assert.equal(bodies.length, 2); assert.notEqual(bodies[0].id, bodies[1].id, 'definite rejection gets a new attempt id'); assert.equal(bodies[1].content, bodies[0].content);
  } finally { response.resolve({ status: 'accepted' }); await app.stop(); }
});

test('uncertain A retains its exact envelope and id after successful unrelated B', async () => {
  const response = deferred<unknown>(); const bodies: any[] = [];
  const { app, state } = fixture(async (_route, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? response.promise : { status: 'accepted' }; });
  try {
    state.storageId = 'store'; state.sharedShell.set('main', ['shell A']);
    const submitting = state.submit('A'); state.editor.setText('B'); response.reject(new Error('offline')); await submitting;
    state.editor.setText(''); await state.submit('B');
    assert.equal(bodies[1].content, 'B', 'B must not inherit A shell evidence');
    const saved = [...state.recoverableDrafts.values()].find((draft: any) => draft.text === 'A') as any;
    state.choose = async () => saved.key; await state.recoverDraft(); state.editor.setText(''); await state.submit('A');
    assert.equal(bodies[2].id, bodies[0].id); assert.equal(bodies[2].content, bodies[0].content);
  } finally { response.resolve({ status: 'accepted' }); await app.stop(); }
});

test('external completion after storage reload preserves result without mutating or focusing detached editor', async () => {
  const edited = deferred<{ status: 'complete'; content: string }>(); const { app, state } = fixture();
  const original = state.editor; const focused: unknown[] = [];
  try {
    state.storageId = 'old'; original.setText('original');
    state.prompt = async () => 'fixture-editor'; state.editStrings = async () => []; state.choose = async () => 'yes'; state.editExternal = () => edited.promise;
    state.ui.start = () => {}; state.ui.stop = () => {}; state.ui.setFocus = (editor: unknown) => focused.push(editor);
    state.client.snapshot = async () => ({ protocolVersion: 1, storageId: 'new', instanceId: 'new-instance', selectedContextId: 'main', watermark: 0, contexts: [{ id: 'main', role: 'main' }], runs: [], conversation: { messages: [], hasMore: false } });
    for (const name of ['refreshModel', 'refreshUsage', 'refreshTasks', 'refreshQueue', 'connectStream']) state[name] = async () => {};
    const editing = state.externalEditor(true); await tick(); await state.loadContext(state.generation);
    const replacement = state.editor; assert.notEqual(replacement, original); replacement.setText('new draft');
    edited.resolve({ status: 'complete', content: 'external result' }); await editing;
    assert.equal(original.getText(), 'original'); assert.equal(replacement.getText(), 'new draft'); assert.equal(focused.at(-1), replacement);
    const saved = [...state.recoverableDrafts.values()].find((draft: any) => draft.text === 'external result') as any;
    assert.ok(saved); assert.equal(saved.storageId, 'old');
    state.choose = async (_title: string, items: any[]) => items.some(item => item.value === 'restore') ? 'restore' : saved.key;
    await state.recoverDraft(); assert.equal(replacement.getText(), 'external result');
    assert.ok([...state.recoverableDrafts.values()].some((draft: any) => draft.text === 'new draft'));
  } finally { edited.resolve({ status: 'complete', content: 'external result' }); await app.stop(); }
});

test('external completion with unchanged ownership returns text and focus to the visible editor', async () => {
  const edited = deferred<{ status: 'complete'; content: string }>(); const { app, state } = fixture(); const original = state.editor;
  let focused: unknown;
  try {
    state.prompt = async () => 'fixture-editor'; state.editStrings = async () => []; state.choose = async () => 'yes'; state.editExternal = () => edited.promise;
    state.ui.start = () => {}; state.ui.stop = () => {}; state.ui.setFocus = (editor: unknown) => { focused = editor; };
    const editing = state.externalEditor(true); await tick(); edited.resolve({ status: 'complete', content: 'edited' }); await editing;
    assert.equal(original.getText(), 'edited'); assert.equal(focused, original);
  } finally { edited.resolve({ status: 'complete', content: 'edited' }); await app.stop(); }
});

test('follow-up blocked by modal ownership retains the visible editor draft', async () => {
  const { app, state } = fixture();
  try { state.editor.setText('B'); state.modalFlow = Symbol(); await state.followUp(); assert.equal(state.editor.getText(), 'B'); }
  finally { state.modalFlow = undefined; await app.stop(); }
});

test('failure does not combine A text with an attachment-only or shell-only newer draft', async () => {
  for (const kind of ['attachment', 'shell']) {
    const response = deferred<unknown>(); const { app, state } = fixture(async () => response.promise);
    try {
      const submitting = state.submit('A');
      if (kind === 'attachment') state.pendingAttachments.set('main', [{ id: 'b', name: 'B.txt', bytes: 1 }]); else state.sharedShell.set('main', ['shell B']);
      response.reject(new Error('offline')); await submitting;
      assert.equal(state.editor.getText(), ''); assert.equal(state.recoverableDrafts.size, 1);
    } finally { response.resolve({ status: 'accepted' }); await app.stop(); }
  }
});

test('uncertain recovered steer retries its original run envelope, not the newly active run', async () => {
  const bodies: any[] = []; const { app, state } = fixture(async (_route, init) => {
    bodies.push(JSON.parse(String(init?.body))); if (bodies.length === 1) throw new Error('offline'); return { status: 'accepted' };
  });
  try {
    state.currentRunId = 'old-run'; state.capabilities.add('message-queue');
    await state.submit('A', 'steer'); assert.equal(state.editor.getText(), 'A');
    state.currentRunId = 'new-run'; state.choose = async () => { throw new Error('retry must not change its envelope through a new mode dialog'); };
    state.editor.setText(''); await state.submit('A');
    assert.deepEqual(bodies[1], bodies[0]); assert.equal(bodies[1].expectedRunId, 'old-run');
  } finally { await app.stop(); }
});

test('cancelled and stale recovery selections do not change B or its associated resources', async () => {
  const response = deferred<unknown>(); const { app, state } = fixture(async () => response.promise);
  try {
    const submitting = state.submit('A'); state.editor.setText('B'); response.reject(new Error('offline')); await submitting;
    const saved = [...state.recoverableDrafts.values()][0] as any;
    state.choose = async (_title: string, items: any[]) => items.some(item => item.value === 'restore') ? 'cancel' : saved.key;
    await state.recoverDraft(); assert.equal(state.editor.getText(), 'B'); assert.equal(state.recoverableDrafts.size, 1);
    const selection = deferred<string>(); state.choose = () => selection.promise;
    const recovering = state.recoverDraft(); const replacement = state.createEditor(); state.editor = replacement; replacement.setText('C');
    selection.resolve(saved.key); await recovering; assert.equal(replacement.getText(), 'C');
  } finally { response.resolve({ status: 'accepted' }); await app.stop(); }
});

test('external completion detects editor, context and in-place draft changes independently', async () => {
  for (const change of ['editor', 'context', 'text']) {
    const edited = deferred<{ status: 'complete'; content: string }>(); const { app, state } = fixture(); const original = state.editor;
    let focused: unknown;
    try {
      original.setText('original'); state.prompt = async () => 'fixture-editor'; state.editStrings = async () => []; state.choose = async () => 'yes'; state.editExternal = () => edited.promise;
      state.ui.start = () => {}; state.ui.stop = () => {}; state.ui.setFocus = (editor: unknown) => { focused = editor; };
      const editing = state.externalEditor(true); await tick();
      if (change === 'editor') { state.editor = state.createEditor(); state.editor.setText('B'); }
      else if (change === 'context') state.contextId = 'other'; else original.setText('B');
      edited.resolve({ status: 'complete', content: 'external result' }); await editing;
      assert.equal(original.getText(), change === 'text' ? 'B' : 'original'); assert.equal(focused === state.editor, true);
      assert.equal(state.recoverableDrafts.size, 1);
    } finally { edited.resolve({ status: 'complete', content: 'external result' }); await app.stop(); }
  }
});

test('successful A consumes only its captured resources and leaves staged B intact', async () => {
  const response = deferred<unknown>(); const { app, state } = fixture(async () => response.promise);
  const attachmentA = { id: 'a', name: 'A.txt', mediaType: 'text/plain', bytes: 1 }; const attachmentB = { ...attachmentA, id: 'b' };
  try {
    state.pendingAttachments.set('main', [attachmentA]); state.sharedShell.set('main', ['shell A']); state.choose = async () => 'yes';
    const submitting = state.submit('A'); await tick(); state.editor.setText('B'); state.pendingAttachments.set('main', [attachmentB]); state.sharedShell.set('main', ['shell B']);
    response.resolve({ status: 'accepted' }); await submitting;
    assert.equal(state.editor.getText(), 'B'); assert.deepEqual(state.pendingAttachments.get('main'), [attachmentB]); assert.deepEqual(state.sharedShell.get('main'), ['shell B']);
  } finally { response.resolve({ status: 'accepted' }); await app.stop(); }
});

test('management exposes recovery as an explicit local action without sending B', async () => {
  let writes = 0; const { app, state } = fixture(async () => { writes++; return {}; }); let recovered = false;
  try {
    state.editor.setText('B'); state.choose = async (_title: string, items: any[]) => {
      assert.ok(items.some(item => item.value === 'recover-draft' && item.label === '恢复草稿')); return 'recover-draft';
    };
    state.recoverDraft = async () => { recovered = true; };
    await state.manage(); assert.equal(recovered, true); assert.equal(state.editor.getText(), 'B'); assert.equal(writes, 0);
  } finally { await app.stop(); }
});
