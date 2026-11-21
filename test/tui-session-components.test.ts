// Behavioral cases adapted from Pi coding-agent 1.5.1 tree/session-selector tests.
// Copyright (c) 2025 Mario Zechner; MIT license in ../src/tui/upstream/LICENSE.
import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import type { SessionTreeNode, SessionTreeEntry } from '../src/protocol.js';
import { TreeSelectorComponent } from '../src/tui/upstream/tree-selector.js';
import { SessionSelectorComponent } from '../src/tui/upstream/session-selector.js';
import type { SessionInfo } from '../src/tui/upstream/session-types.js';
import { terminalSessionView } from '../src/tui/session-view.js';
const stamp = '2026-01-01T00:00:00Z';
const user = (id: string, parentId: string | null, text: string): SessionTreeEntry => ({ id, parentId, timestamp: stamp, type: 'message', message: { role: 'user', content: text, timestamp: 0 } });
function graph(): SessionTreeNode[] {
  return [{ entry: { id: 'model', parentId: null, timestamp: stamp, type: 'model_change', provider: 'fixture', modelId: 'synthetic-model' }, children: [
    { entry: { id: 'think', parentId: 'model', timestamp: stamp, type: 'thinking_level_change', thinkingLevel: 'high' }, children: [
      { entry: user('root', 'think', 'root message'), label: 'start', labelTimestamp: stamp, children: [
        { entry: user('left', 'root', 'left branch'), label: 'work', labelTimestamp: stamp, children: [
          { entry: { id: 'compact', parentId: 'left', timestamp: stamp, type: 'compaction', summary: 'retained summary', tokensBefore: 32000, firstKeptEntryId: 'left' }, children: [
            { entry: { id: 'summary', parentId: 'compact', timestamp: stamp, type: 'branch_summary', fromId: 'right', summary: 'branch summary text' }, children: [{ entry: user('leaf', 'summary', 'current leaf'), children: [] }] },
          ] },
        ] },
        { entry: user('right', 'root', 'branch needle'), children: [] },
      ] },
    ] },
  ] }];
}
const text = (component: { render(width: number): string[] }, width = 120) => stripVTControlCharacters(component.render(width).join('\n'));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('tree search, filters, labels, timestamps and current-path selection retain native behavior', () => {
  let cancelled = false;
  const selector = new TreeSelectorComponent(graph(), 'leaf', 50, () => {}, () => { cancelled = true; }); selector.focused = true;
  selector.handleInput('branch needle'); assert.equal(selector.getTreeList().getSelectedNode()?.entry.id, 'right');
  selector.handleInput('\x1b'); assert.equal(cancelled, false); assert.equal(selector.getTreeList().getSearchQuery(), '');
  selector.handleInput('\x0c'); assert.equal(selector.getTreeList().getFilterMode(), 'labeled-only'); assert.match(text(selector), /\[start\]|\[work\]/);
  selector.handleInput('T'); assert.match(text(selector), /1\/1/);
  selector.handleInput('\x01'); assert.equal(selector.getTreeList().getFilterMode(), 'all'); assert.match(text(selector), /synthetic-model/); assert.match(text(selector), /thinking: high/); assert.match(text(selector), /compaction: 32k/); assert.match(text(selector), /branch summary text/);
  selector.handleInput('\x15'); assert.equal(selector.getTreeList().getFilterMode(), 'user-only'); assert.doesNotMatch(text(selector), /synthetic-model|compaction: 32k/);
  selector.handleInput('\x1b'); assert.equal(cancelled, true); selector.dispose();
});

test('tree folding, paging, selected-message copy and cancellation preserve actual entry identities', () => {
  const selected: string[] = [], copied: Array<string | undefined> = [];
  const selector = new TreeSelectorComponent(graph(), 'leaf', 50, id => selected.push(id), () => {}, undefined, 'root'); selector.onCopy = value => copied.push(value);
  selector.handleInput('\x18'); assert.deepEqual(copied, ['root message']);
  selector.handleInput('\x1b[1;5D'); assert.doesNotMatch(text(selector), /left branch|branch needle/);
  selector.handleInput('\r'); assert.deepEqual(selected, ['root']);
  selector.handleInput('\x1b[1;5C'); assert.match(text(selector), /left branch/);
  selector.handleInput('\x1b[6~'); assert.equal(selector.getTreeList().getSelectedNode()?.entry.id, 'right'); selector.dispose();
});

test('label edits wait for the Core acknowledgement and apply its actual label and timestamp', async () => {
  const tree = graph(), root = tree[0]!.children[0]!.children[0]!, save = deferred<{ label: string; labelTimestamp: string }>(), calls: unknown[] = [];
  const selector = new TreeSelectorComponent(tree, 'leaf', 40, () => {}, () => {}, (id, label) => { calls.push([id, label]); return save.promise; }, 'root'); selector.focused = true;
  selector.handleInput('L'); selector.handleInput('\x01'); selector.handleInput('\x0b'); selector.handleInput('requested label'); selector.handleInput('\r'); selector.handleInput('\r');
  assert.deepEqual(calls, [['root', 'requested label']]); assert.equal(root.label, 'start');
  save.resolve({ label: 'Core acknowledged label', labelTimestamp: '2026-01-02T00:00:00Z' }); await tick();
  assert.equal(root.label, 'Core acknowledged label'); assert.equal(root.labelTimestamp, '2026-01-02T00:00:00Z'); selector.dispose();
});

test('a cancelled label response cannot repaint a disposed selector or pretend that it was saved', async () => {
  const tree = graph(), root = tree[0]!.children[0]!.children[0]!, save = deferred<{ label: string }>(); let refreshes = 0;
  const selector = new TreeSelectorComponent(tree, 'leaf', 30, () => {}, () => {}, () => save.promise, 'root');
  selector.onLabelError = () => { refreshes++; selector.dispose(); };
  selector.handleInput('L'); selector.handleInput('\r'); selector.handleInput('\x1b'); save.resolve({ label: 'late value' }); await tick();
  assert.equal(refreshes, 1); assert.equal(root.label, 'start');
});

test('live tree resize bounds the visible rows and retains selected identity and the search cursor', () => {
  const selector = new TreeSelectorComponent(graph(), 'leaf', 50, () => {}, () => {}); let height = 14;
  selector.focused = true; selector.setViewportProvider(() => height);
  const narrow = selector.render(14); assert.ok(narrow.length <= 14); assert.ok(narrow.every(line => visibleWidth(line) <= 14)); assert.ok(narrow.some(line => line.includes(CURSOR_MARKER)));
  const selected = selector.getTreeList().getSelectedNode()?.entry.id; height = 50; const wide = selector.render(100);
  assert.ok(wide.length > narrow.length); assert.equal(selector.getTreeList().getSelectedNode()?.entry.id, selected); selector.dispose();
});

test('the terminal tree projection preserves Core identities and rejects malformed topology while neutralizing controls', () => {
  const original = { tree: graph(), leafId: 'leaf', currentContextId: 'main', rootContextId: 'main', revision: 3 };
  const root = original.tree[0]!.children[0]!.children[0]!; root.label = 'label\x1b]52;c;CANARY\x07';
  const projected = terminalSessionView(original);
  assert.equal(projected.revision, 3); assert.equal(projected.leafId, 'leaf'); assert.notEqual(projected.tree, original.tree);
  const selector = new TreeSelectorComponent(projected.tree, projected.leafId, 40, () => {}, () => {});
  assert.doesNotMatch(selector.render(120).join('\n'), /\x1b\]52/); assert.match(root.label, /\x1b\]52/); selector.dispose();
  assert.throws(() => terminalSessionView({ ...original, tree: [{ ...root, entry: { ...root.entry, parentId: 'loop' } }] }), /invalid_session_tree/);
  assert.throws(() => terminalSessionView({ ...original, leafId: 'missing' }), /invalid_session_tree/);
});

const session = (id: string, name: string | undefined, allMessagesText: string, parentSessionPath?: string): SessionInfo => ({ id, path: id, cwd: '/synthetic/workspace', name, created: new Date(0), modified: new Date('2026-01-01'), messageCount: 2, firstMessage: 'first visible message', allMessagesText, ...(parentSessionPath ? { parentSessionPath } : {}) });

test('session browsing searches full message text and keeps current/all workspace loaders separate', async () => {
  const current = deferred<SessionInfo[]>(), all = deferred<SessionInfo[]>(); let currentCalls = 0, allCalls = 0;
  const selector = new SessionSelectorComponent(async () => { currentCalls++; return current.promise; }, async () => { allCalls++; return all.promise; }, () => {}, () => {}, () => {}, () => {});
  try {
    selector.handleInput('\t'); all.resolve([session('other', 'Other', 'historical hidden phrase')]); await tick();
    current.resolve([session('current', 'Current', 'different source')]); await tick();
    selector.handleInput('"hidden phrase"'); assert.equal(selector.getSessionList().getSelectedSessionPath(), 'other');
    assert.equal(currentCalls, 1); assert.equal(allCalls, 1); selector.handleInput('\t'); assert.equal(selector.getSessionList().getSelectedSessionPath(), undefined);
  } finally { selector.dispose(); }
});

test('session removal uses the injected Core operation and refuses to remove the active session', async () => {
  const removed: string[] = []; let rows = [session('active', 'Active', 'one'), session('other', 'Other', 'two')];
  const selector = new SessionSelectorComponent(async () => rows, async () => rows, () => {}, () => {}, () => {}, () => {}, { removeSession: async id => { removed.push(id); rows = rows.filter(row => row.id !== id); return { ok: true }; } }, 'active');
  try {
    await tick(); selector.handleInput('\x04'); assert.deepEqual(removed, []); assert.match(text(selector), /currently active/);
    selector.handleInput('\x1b[B'); selector.handleInput('\x04'); assert.match(text(selector), /Archive session/); selector.handleInput('\r'); await tick();
    assert.deepEqual(removed, ['other']); assert.equal(selector.getSessionList().getSelectedSessionPath(), 'active'); assert.match(text(selector), /Session archived|Active/);
  } finally { selector.dispose(); }
});

test('a failed rename keeps its input available and can be retried without an unhandled promise', async () => {
  let attempts = 0, name = 'Original';
  const selector = new SessionSelectorComponent(async () => [session('target', name, 'one')], async () => [], () => {}, () => {}, () => {}, () => {}, { renameSession: async (_id, value) => { if (++attempts === 1) throw new Error('synthetic failure'); name = value!; } });
  try {
    await tick(); selector.handleInput('\x12'); selector.handleInput('\x01'); selector.handleInput('\x0b'); selector.handleInput('Renamed'); selector.handleInput('\r'); await tick();
    assert.match(text(selector), /Rename was not confirmed/); assert.match(text(selector), /Renamed/);
    selector.handleInput('\r'); await tick(); assert.equal(attempts, 2); assert.equal(name, 'Renamed'); assert.equal(selector.getSessionList().getSelectedSessionPath(), 'target');
  } finally { selector.dispose(); }
});
