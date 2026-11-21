import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import type { Core } from '../src/core.js';
import type { ConversationMessage } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { ReplyStream } from '../src/reply-stream.js';
import { activeDrafts, contextThinking, conversationPage, publicEventPage } from '../src/event-stream.js';
import { safeTerminalText } from '../src/terminal-format.js';

function fixture(file = ':memory:', initial: string[] = ['synthetic-token']) {
  const store = new Store(file), runtime = new RuntimeStore(store.db); let secrets = initial;
  runtime.configurePublicThinkingSecrets(() => secrets);
  if (!runtime.context('main')) runtime.createContext({ id: 'main', role: 'main', name: 'Main' });
  const core = {
    store, runtime, redactionValues: () => secrets,
    sessionGraph: { head: () => undefined },
    sessionConversationMessages: (_contextId: string, messages: ConversationMessage[]) => messages,
    sessionLogicalMessages: (_contextId: string, messages: ConversationMessage[]) => messages,
    sessionRunIds: () => undefined,
    sessionMessageIds: () => undefined,
    projectSessionTools: (_contextId: string, rows: Record<string, unknown>[]) => rows,
  } as unknown as Core;
  return { store, runtime, core, rotate: (values: string[]) => { secrets = values; }, events: () => publicEventPage(core, 0, undefined, 1000).events };
}
function reply(f: ReturnType<typeof fixture>, userText = 'Synthetic user input') {
  const id = randomUUID(), runId = randomUUID();
  f.store.receive({ id, contextId: 'main', type: 'user-message', source: 'tui-message', content: userText, output: { kind: 'message', contextId: 'main' } });
  f.store.accept(id, id, runId, 'wake', 'main');
  const stream = new ReplyStream(id, 'main', f.store, f.runtime); stream.accept(runId);
  stream.observe({ type: 'message_start', message: { id: 'draft', role: 'assistant', content: { parts: [] } } } as unknown as AgentControllerEvent);
  return { id, runId, stream, delta: (delta: string) => stream.observe({ type: 'message_update', id: 'draft', event: { type: 'text-delta', delta } } as AgentControllerEvent) };
}
const controls = ['\x1b[31m', '\x9b31m', '\x1b]0;title\x07', '\x1b]8;;https://example.invalid\x1b\\', '\x1bPpayload\x1b\\', '\u202e', '\0'];

test('thinking removes terminal controls before redaction across every terminal-sequence boundary', () => {
  for (const control of controls) {
    const f = fixture(); const input = `ordinary synthet${control}ic-token done`;
    try {
      for (const delta of input) {
        f.runtime.event({ contextId: 'main', runId: 'r', kind: 'message_update', data: { id: 'm', event: { type: 'reasoning-delta', index: 0, delta } } });
        assert.doesNotMatch(safeTerminalText(contextThinking(f.core, 'main')[0]?.text ?? ''), /synthetic-token/);
      }
      f.runtime.event({ contextId: 'main', runId: 'r', kind: 'agent_end', data: { reason: 'complete' } });
      assert.equal(contextThinking(f.core, 'main')[0]?.text, 'ordinary [hidden] done');
    } finally { f.store.close(); }
  }
});

test('authorized reply deltas, active drafts and commits use the same sanitized view while originals remain intact', () => {
  for (const control of controls) {
    const f = fixture(); const raw = `ordinary synthet${control}ic-token done`; const user = `user original synthet${control}ic-token`;
    try {
      const r = reply(f, user);
      for (const delta of raw) {
        r.delta(delta);
        for (const event of f.events().filter(event => event.kind.startsWith('reply.'))) assert.doesNotMatch(safeTerminalText(JSON.stringify(event.data)), /synthetic-token/);
        for (const draft of activeDrafts(f.core, 'main')) assert.doesNotMatch(safeTerminalText(draft.text), /synthetic-token/);
      }
      r.stream.finish(true);
      const output = f.store.outputsForSignal(r.id)[0]!; assert.equal(output.content, raw); assert.equal(f.store.getSignal(r.id)?.content, user);
      const messages = conversationPage(f.core, 'main').messages;
      assert.equal(messages.find(message => message.role === 'assistant')?.content, 'ordinary [hidden] done');
      assert.equal(messages.find(message => message.role === 'user')?.content, user);
      assert.deepEqual(activeDrafts(f.core, 'main'), []);
      const commit = f.events().find(event => event.kind === 'reply.commit')!.data as { output: { content: string } };
      assert.equal(commit.output.content, 'ordinary [hidden] done');
    } finally { f.store.close(); }
  }
});

test('ordinary reply suffixes remain live while Bearer, JWT and URL credential tails stay private', () => {
  const f = fixture(':memory:', []);
  try {
    const r = reply(f); r.delta('Visible partial');
    assert.equal(activeDrafts(f.core, 'main')[0]?.text, 'Visible partial');
    for (const delta of ' Bearer unknown-token then eyJabcdef.ghijkl.mnopqr and https://host.invalid/?token=unknown-url done') {
      r.delta(delta);
      const current = activeDrafts(f.core, 'main')[0]?.text ?? '';
      assert.doesNotMatch(current, /unknown-token|eyJabcdef|unknown-url/);
    }
    r.stream.finish(true);
    const text = conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant')!.content;
    assert.doesNotMatch(text, /unknown-token|eyJabcdef|unknown-url/); assert.ok(text.startsWith('Visible partial'));
  } finally { f.store.close(); }
});

test('safe reply views survive credential removal, rotation and restart without re-reading raw text', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-public-reply-')); const file = path.join(directory, 'records.sqlite');
  let f = fixture(file);
  try {
    const r = reply(f); r.delta('before synthet\x1b['); f.rotate(['next-token']); r.delta('31mic-token after'); r.stream.finish(true);
    const before = f.events().filter(event => event.kind.startsWith('reply.') || event.kind === 'conversation'); const message = conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant');
    assert.equal(message?.content, 'before [hidden] after'); f.rotate([]);
    assert.deepEqual(f.events().filter(event => event.kind.startsWith('reply.') || event.kind === 'conversation'), before);
    f.store.close(); f = fixture(file, []);
    assert.deepEqual(f.events().filter(event => event.kind.startsWith('reply.') || event.kind === 'conversation'), before);
    assert.equal(conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant')?.content, message.content);
  } finally { f.store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('legacy committed messages remain readable and receive a persistent first display projection', () => {
  const f = fixture();
  try {
    const r = reply(f); r.stream.finish(false);
    const output = f.store.publish({ kind: 'message', runId: r.runId, signalIds: [r.id], toolCallId: 'legacy', content: 'Older ordinary content synthet\x1b[31mic-token preserved' });
    const text = conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant')?.content;
    assert.equal(text, 'Older ordinary content [hidden] preserved');
    f.rotate([]); assert.equal(conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant')?.content, text);
    assert.equal(f.store.outputsForSignal(r.id).find(row => row.id === output.id)?.content, output.content);
    f.runtime.createContext({ id: 'branch', role: 'main', name: 'Branch' });
    f.runtime.setSetting('context-transcript:branch', [{ id: 'legacy-inherited', role: 'assistant', contextId: 'branch', content: 'Previously published imported text', createdAt: '2026-01-01T00:00:00Z', runId: null, status: 'committed', kind: 'message' }]);
    assert.equal(conversationPage(f.core, 'branch').messages[0]?.content, 'Previously published imported text');
  } finally { f.store.close(); }
});

test('reply projection transactions roll back with source events and retry once', () => {
  const f = fixture();
  try {
    const r = reply(f); r.delta('prefix ');
    f.store.db.exec("CREATE TRIGGER reject_public_reply BEFORE INSERT ON public_reply_events WHEN NEW.kind IN ('reply.delta','reply.replace') BEGIN SELECT RAISE(ABORT,'reply_projection_failed'); END");
    const event = { contextId: 'main', runId: r.runId, kind: 'reply.delta', data: { draftId: 'draft', signalId: r.id, delta: 'safe synthetic-token end' }, key: 'retry-delta' };
    assert.throws(() => f.runtime.event(event), /reply_projection_failed/);
    f.store.db.exec('DROP TRIGGER reject_public_reply'); f.runtime.event(event); f.runtime.event(event);
    assert.equal(activeDrafts(f.core, 'main')[0]?.text, 'prefix safe [hidden] end');
    assert.equal(f.events().filter(event => event.kind === 'reply.delta').length, 2);
  } finally { f.store.close(); }
});

test('unaccepted native text has no reply view and legacy raw deltas are never reconstructed', () => {
  const f = fixture();
  try {
    const id = randomUUID(); f.store.receive({ id, contextId: 'main', type: 'user-message', source: 'tui-message', content: 'Input', output: { kind: 'message', contextId: 'main' } });
    const stream = new ReplyStream(id, 'main', f.store, f.runtime);
    stream.observe({ type: 'message_start', message: { id: 'draft', role: 'assistant', content: { parts: [{ type: 'text', text: 'not authorized' }] } } } as unknown as AgentControllerEvent);
    assert.equal(f.events().filter(event => event.kind.startsWith('reply.')).length, 0); stream.finish(false);
    f.store.db.prepare('INSERT INTO runtime_events(context_id,run_id,kind,data,created_at) VALUES(?,?,?,?,?)').run('main', 'legacy', 'reply.delta', JSON.stringify({ draftId: 'legacy', signalId: id, delta: 'retired raw secret' }), new Date().toISOString());
    assert.equal(f.events().filter(event => event.kind.startsWith('reply.')).length, 0); assert.deepEqual(activeDrafts(f.core, 'main'), []);
  } finally { f.store.close(); }
});

test('a credential-prefix collision stays private only until the authorized reply is complete', () => {
  const f = fixture(':memory:', ['l-synthetic-control-token-0123456789']);
  try {
    const r = reply(f); r.delta('Visible partial');
    assert.equal(activeDrafts(f.core, 'main')[0]?.text, 'Visible partia');
    r.stream.finish(true);
    assert.equal(conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant')?.content, 'Visible partial');
  } finally { f.store.close(); }
});

test('an unfinished pre-restart reply cannot revive raw deltas with a new credential set', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-public-reply-open-')); const file = path.join(directory, 'records.sqlite');
  let f = fixture(file);
  try {
    const r = reply(f); r.delta('safe synthetic-');
    const previous = activeDrafts(f.core, 'main')[0]?.text;
    f.store.close(); f = fixture(file, []);
    f.runtime.event({ contextId: 'main', runId: r.runId, kind: 'reply.delta', data: { draftId: 'draft', signalId: r.id, delta: 'token' } });
    assert.equal(activeDrafts(f.core, 'main')[0]?.text, previous);
    assert.doesNotMatch(JSON.stringify(f.events().filter(event => event.kind.startsWith('reply.'))), /synthetic-token/);
  } finally { f.store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a failed safe output projection cannot commit an unprojected canonical reply', () => {
  const f = fixture();
  try {
    const r = reply(f); r.delta('ordinary synthetic-token done');
    f.store.db.exec("CREATE TRIGGER reject_public_output BEFORE INSERT ON public_output_text BEGIN SELECT RAISE(ABORT,'output_projection_failed'); END");
    assert.throws(() => r.stream.finish(true), /output_projection_failed/);
    assert.deepEqual(f.store.outputsForSignal(r.id), []);
    f.store.db.exec('DROP TRIGGER reject_public_output'); r.stream.finish(true);
    assert.equal(conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant')?.content, 'ordinary [hidden] done');
  } finally { f.store.close(); }
});

test('long replies persist bounded incremental public deltas and unchanged snapshots do not duplicate text', () => {
  const f = fixture(':memory:', ['Z-synthetic-token']);
  try {
    const r = reply(f); const chunk = 'ordinary words '; const count = 500;
    for (let i = 0; i < count; i++) r.delta(chunk);
    const rows = f.store.db.prepare('SELECT kind,data FROM public_reply_events ORDER BY seq').all();
    assert.equal(rows.filter(row => row.kind === 'reply.replace').length, 0);
    const deltas = rows.filter(row => row.kind === 'reply.delta').map(row => String((JSON.parse(String(row.data)) as { delta: string }).delta));
    assert.equal(deltas.join(''), chunk.repeat(count)); assert.equal(deltas.reduce((total, delta) => total + delta.length, 0), chunk.length * count);
    const before = rows.length;
    for (let i = 0; i < 10; i++) f.runtime.event({ contextId: 'main', runId: r.runId, kind: 'reply.replace', data: { draftId: 'draft', signalId: r.id, text: chunk.repeat(count) } });
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM public_reply_events').get()!.n, before);
    assert.equal(activeDrafts(f.core, 'main')[0]?.text, chunk.repeat(count));
    r.stream.finish(true);
    assert.equal(conversationPage(f.core, 'main').messages.find(message => message.role === 'assistant')?.content, chunk.repeat(count));
  } finally { f.store.close(); }
});
