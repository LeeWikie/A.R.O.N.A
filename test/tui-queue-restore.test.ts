import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { AppError } from '../src/domain.js';
import { TerminalApp } from '../src/tui/index.js';
import type { AssetInfo } from '../src/assets.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
const asset = (index: number): AssetInfo => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `${index}.txt`, bytes: 1, mediaType: 'text/plain', sha256: 'synthetic', createdAt: '2026-01-01T00:00:00Z' });
const message = (index: number, attachments: string[] = []) => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, contextId: 'main', type: 'message', content: `raw ${index}`, attachments, status: 'queued', revision: 1 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture(complete = true) {
  const rows = [message(1, [asset(1).id]), message(2, [asset(2).id])];
  const calls: Array<{ route: string; method?: string; body: any }> = [], notes: string[] = [];
  const receipt = () => ({ operationId: 'operation', contextId: 'main', entries: rows.map(row => ({ id: row.id, revision: row.revision })), withdrawn: rows.map(row => ({ ...row, status: 'cancelled', revision: 2 })), skipped: [] });
  const client = { async request(route: string, init?: RequestInit): Promise<any> {
    calls.push({ route, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (route.endsWith('/message-queue/withdrawals')) return { operations: [] };
    if (route.endsWith('/message-queue')) return rows;
    if (route.endsWith('/message-queue/withdraw')) return receipt();
    if (route.endsWith('/metadata')) return asset(Number(route.split('/')[2]!.slice(-12)));
    if (route.startsWith('/messages/') && init?.method === 'DELETE') return { ...rows.find(row => route.endsWith(row.id)), status: 'cancelled' };
    if (route === '/messages') return { status: 'accepted' };
    throw new Error(route);
  } } as unknown as Client;
  const app = new TerminalApp(client, 'main', terminal), state = app as any;
  Object.assign(state, { storageId: 'old', instanceId: 'instance', contextRole: 'main', contextReady: true, isMainContext: true });
  state.capabilities = new Set(['message-queue', 'message-source-text', ...(complete ? ['message-queue-withdraw'] : [])]); state.note = (text: string) => notes.push(text); state.refreshQueue = async () => {};
  return { app, state, client, rows, calls, notes, receipt };
}

test('legacy queue withdrawal also restores attachments in source order without submitting a message', async () => {
  const f = fixture(false);
  try {
    f.state.editor.setText('current'); f.state.pendingAttachments.set('main', [asset(3)]); await f.state.restoreQueue();
    assert.equal(f.state.editor.getText(), 'raw 1\n\nraw 2\n\ncurrent'); assert.deepEqual(f.state.pendingAttachments.get('main').map((item: any) => item.id), [asset(1).id, asset(2).id, asset(3).id]);
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 2); assert.equal(f.calls.some(call => call.route === '/messages'), false);
  } finally { await f.app.stop(); }
});

test('an oversized combined draft leaves the complete queue and existing input untouched', async () => {
  const f = fixture(); f.rows[0]!.attachments = Array.from({ length: 9 }, (_, index) => asset(index + 1).id);
  try {
    f.state.editor.setText('keep'); await f.state.restoreQueue();
    assert.equal(f.state.editor.getText(), 'keep'); assert.equal(f.calls.some(call => call.method === 'POST' || call.method === 'DELETE'), false); assert.ok(f.notes.some(text => text.includes('限制'))); assert.equal(f.notes.some(text => text.includes('已撤回')), false);
  } finally { await f.app.stop(); }
});

test('a late withdrawal receipt retains the original full draft and never overwrites another context', async () => {
  const f = fixture(), reply = deferred<any>(), request = f.client.request.bind(f.client);
  f.client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => route.endsWith('/message-queue/withdraw') ? reply.promise : request<T>(route, init);
  try {
    f.state.editor.setText('old current'); f.state.pendingAttachments.set('main', [asset(3)]);
    const pending = f.state.restoreQueue(); await tick(); const source = f.state.editor;
    f.state.contextId = 'other'; f.state.editor = f.state.createEditor(); f.state.editor.setText('new current'); f.state.pendingAttachments.set('other', [asset(4)]);
    reply.resolve(f.receipt()); await pending;
    assert.equal(f.state.editor.getText(), 'new current'); assert.deepEqual(f.state.pendingAttachments.get('other'), [asset(4)]); assert.equal(source.getText(), 'old current');
    const saved = [...f.state.recoverableDrafts.values()].find((draft: any) => draft.context === 'main') as any;
    assert.equal(saved.text, 'raw 1\n\nraw 2\n\nold current'); assert.deepEqual(saved.attachments.map((item: any) => item.id), [asset(1).id, asset(2).id, asset(3).id]); assert.deepEqual(saved.restoredFromSignalIds, f.rows.map(row => row.id));
  } finally { reply.resolve(f.receipt()); await f.app.stop(); }
});

test('storage replacement during asset preflight prevents cancellation against the new storage', async () => {
  const f = fixture(), description = deferred<any>(), request = f.client.request.bind(f.client);
  f.client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => route.includes(asset(1).id) ? description.promise : request<T>(route, init);
  try {
    const pending = f.state.restoreQueue(); await tick(); f.state.storageId = 'new'; f.state.storageGeneration++; f.state.editor = f.state.createEditor(); f.state.editor.setText('new storage draft');
    description.resolve(asset(1)); await pending;
    assert.equal(f.calls.some(call => call.method === 'POST' || call.method === 'DELETE'), false); assert.equal(f.state.editor.getText(), 'new storage draft'); assert.equal(f.state.recoverableDrafts.size, 0);
  } finally { description.resolve(asset(1)); await f.app.stop(); }
});

test('repeated dequeue input owns one operation and combines only the latest visible draft', async () => {
  const f = fixture(), reply = deferred<any>(), request = f.client.request.bind(f.client); let writes = 0;
  f.client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => { if (route.endsWith('/message-queue/withdraw')) { writes++; return reply.promise; } return request<T>(route, init); };
  try {
    f.state.editor.setText('old'); const pending = f.state.restoreQueue(); await tick(); await f.state.restoreQueue(); assert.equal(writes, 1);
    f.state.editor.setText('typed during withdrawal'); reply.resolve(f.receipt()); await pending;
    assert.equal(f.state.editor.getText(), 'raw 1\n\nraw 2\n\ntyped during withdrawal');
  } finally { reply.resolve(f.receipt()); await f.app.stop(); }
});

test('edited withdrawn input keeps its provenance and an unknown submission retries the same envelope', async () => {
  const f = fixture(), request = f.client.request.bind(f.client), submissions: any[] = [];
  f.client.request = async <T>(route: string, init?: Parameters<Client['request']>[1]): Promise<T> => {
    if (route === '/messages') { submissions.push(JSON.parse(String(init?.body))); if (submissions.length === 1) throw new AppError('offline', 502); return { status: 'accepted' } as T; }
    return request<T>(route, init);
  };
  try {
    await f.state.restoreQueue(); f.state.choose = async () => 'yes';
    const edited = f.state.editor.getText() + '\nedited'; f.state.editor.setText(''); await f.state.submit(edited);
    assert.equal(f.state.editor.getText(), edited); f.state.editor.setText(''); await f.state.submit(edited);
    assert.equal(submissions.length, 2); assert.deepEqual(submissions[0], submissions[1]); assert.deepEqual(submissions[0].restoredFromSignalIds, f.rows.map(row => row.id));
  } finally { await f.app.stop(); }
});
