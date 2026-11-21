import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Core } from '../src/core.js';
import { contextThinking, projectEvent, publicEventPage, serveEventStream } from '../src/event-stream.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { Hono } from 'hono';

type Configurable = RuntimeStore & { configurePublicThinkingSecrets?: (values: () => readonly string[]) => void };
function fixture(file = ':memory:', initial: string[] = []) {
  const db = new DatabaseSync(file); const runtime: Configurable = new RuntimeStore(db);
  let secrets = initial;
  runtime.configurePublicThinkingSecrets?.(() => secrets);
  const core = { runtime, store: { db }, redactionValues: () => secrets, storageId: 'test', instanceId: 'test' } as unknown as Core;
  const delta = (text: string, messageId = 'm', index = 0, runId = 'r', contextId = 'main', key?: string) => runtime.event({ contextId, runId, kind: 'message_update', data: { id: messageId, event: { type: 'reasoning-delta', index, delta: text } }, key });
  const end = (reason = 'complete', runId = 'r', contextId = 'main') => runtime.event({ contextId, runId, kind: 'agent_end', data: { reason } });
  const events = () => publicEventPage(core, 0, undefined, 1000).events.filter(x => x.kind === 'thinking');
  const text = () => events().map(x => (x.data as { delta: string }).delta).join('');
  return { db, runtime, core, delta, end, events, text, rotate: (values: string[]) => { secrets = values; } };
}

test('known credentials never escape across any delta boundary, including short and whitespace secrets', () => {
  for (const secret of ['old-private-token', 'two word key', 'xy']) for (let split = 1; split < secret.length; split++) {
    const f = fixture(':memory:', [secret]);
    try {
      f.delta('ordinary text ' + secret.slice(0, split));
      assert.equal(f.text(), 'ordinary text ', `prefix escaped: ${secret}/${split}`);
      f.delta(secret.slice(split) + ' done'); f.end();
      assert.equal(f.text(), 'ordinary text [hidden] done');
      assert.equal(contextThinking(f.core, 'main')[0]?.text, f.text());
    } finally { f.db.close(); }
  }
});

test('Bearer, JWT and URL credentials remain safe even when split one character at a time', () => {
  const f = fixture();
  try {
    const input = 'normal Bearer unknown-token-value then eyJabcdefgh.ijklmnopq.rstuvwxyz and https://host.invalid/?token=private-url-value done';
    for (const char of input) {
      f.delta(char);
      assert.doesNotMatch(f.text(), /unknown-token|eyJabcdefgh|private-url/);
    }
    f.end(); assert.match(f.text(), /normal Bearer \[hidden\] then \[hidden\] and/); assert.ok(f.text().endsWith(' done'));
  } finally { f.db.close(); }
});

test('ordinary text streams before completion and terminal events flush tails for every end reason', () => {
  for (const reason of ['complete', 'aborted', 'error', 'suspended']) {
    const f = fixture();
    try {
      f.delta('first words final'); assert.match(f.text(), /first words/);
      f.end(reason); assert.equal(f.text(), 'first words final');
      const before = f.text(); f.end(reason); assert.equal(f.text(), before);
    } finally { f.db.close(); }
  }
});

test('empty span-opening deltas preserve live publication without reviving legacy private text', () => {
  const f = fixture(':memory:', ['synthetic-private-token']);
  try {
    f.delta('', 'm', 0); f.delta('', 'm', 1); f.delta('', 'm', 1);
    f.delta('visible words synthetic-private-', 'm', 1);
    assert.equal(f.text(), 'visible words ');
    f.delta('token done', 'm', 1); f.end();
    assert.equal(f.text(), 'visible words [hidden] done');
    f.db.prepare('INSERT INTO runtime_events(context_id,run_id,kind,data,created_at) VALUES(?,?,?,?,?)').run('main','legacy','message_update',JSON.stringify({id:'m',event:{type:'reasoning-delta',delta:'unprojected private prefix'}}),new Date().toISOString());
    f.delta('', 'm', 0, 'legacy'); f.delta('new visible suffix ', 'm', 0, 'legacy'); f.end('complete', 'legacy');
    assert.equal(f.text(), 'visible words [hidden] done');
  } finally { f.db.close(); }
});

for (const [prefix, input, expected] of [
  ['Z', 'ordinary prose safe ending', 'ordinary prose safe ending'],
  ['ng', 'ordinary prose safe ending', 'ordinary prose safe endi[hidden]'],
  ['Z', 'consider safely', 'consider safely'],
  ['ly', 'consider safely', 'consider safe[hidden]'],
] as const) test(`terminal credential prefix ${prefix} against ${JSON.stringify(input)} is deterministic`, () => {
  for (const reason of ['complete', 'aborted', 'error', 'suspended', 'message_end']) {
    for (const chunks of [[input], [...input]]) {
      const secret = `${prefix}-synthetic-control-token-0123456789`;
      const f = fixture(':memory:', [secret]);
      try {
        for (const chunk of chunks) f.delta(chunk);
        // A suffix matching a credential prefix stays private even before termination.
        if (prefix !== 'Z') assert.equal(f.text(), input.slice(0, input.lastIndexOf(' ') + 1));
        if (reason === 'message_end') f.runtime.event({ contextId: 'main', runId: 'r', kind: 'message_end', data: { id: 'm' } });
        else f.end(reason);
        assert.equal(f.text(), expected, `${reason}/${chunks.length} chunks`);
        assert.equal(contextThinking(f.core, 'main')[0]?.text, expected);
        const published = f.events(); f.end(reason); assert.deepEqual(f.events(), published);
      } finally { f.db.close(); }
    }
  }
});

test('message, block index, run and context delimit independent streams without mixing pending text', () => {
  const f = fixture(':memory:', ['abcXYZ']);
  try {
    f.delta('abc', 'a', 0); f.delta('XYZ ', 'b', 0); f.delta('XYZ ', 'a', 1);
    f.delta('XYZ ', 'a', 0, 'other'); f.delta('XYZ ', 'a', 0, 'r', 'work');
    f.delta('XYZ ', 'a', 0); f.end(); f.end('complete', 'other'); f.end('complete', 'r', 'work');
    assert.equal(f.events().filter(x => x.runId === 'r' && x.contextId === 'main' && (x.data as {messageId:string;index:number}).messageId === 'a' && (x.data as {index:number}).index === 0).map(x => (x.data as {delta:string}).delta).join(''), '[hidden] ');
    assert.equal((f.text().match(/XYZ/g) ?? []).length, 4);
  } finally { f.db.close(); }
});

test('message_end flushes only its message, and opaque provider metadata is never projected', () => {
  const f = fixture();
  try {
    f.delta('visible', 'one'); f.delta('other', 'two');
    f.runtime.event({contextId:'main',runId:'r',kind:'message_end',data:{id:'one',message:{reasoning:'opaque-private',signature:'signed-private'}}});
    assert.equal(f.text(), 'visible'); f.end(); assert.equal(f.text(), 'visibleother');
    assert.doesNotMatch(JSON.stringify(f.events()), /opaque-private|signed-private/);
  } finally { f.db.close(); }
});

test('projection is stable after rotation, repeated source events, pagination and restart', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'public-thinking-')); const file = path.join(directory, 'runtime.sqlite');
  let f = fixture(file, ['old-private-token']);
  try {
    f.delta('before old-private-', 'm', 0, 'r', 'main', 'delta-1'); f.rotate(['new-private-token']);
    f.delta('token after', 'm', 0, 'r', 'main', 'delta-2'); f.delta('token after', 'm', 0, 'r', 'main', 'delta-2'); f.end();
    const original = f.events(); assert.equal(f.text(), 'before [hidden] after');
    f.rotate([]); assert.deepEqual(f.events(), original);
    const pages = []; let cursor = 0;
    do { const page = publicEventPage(f.core, cursor, undefined, 1); pages.push(...page.events.filter(x=>x.kind==='thinking')); if (page.nextCursor === cursor) break; cursor = page.nextCursor; } while (true);
    assert.deepEqual(pages, original);
    const publicRows = f.db.prepare("SELECT data FROM runtime_events WHERE kind='public_thinking'").all(); assert.doesNotMatch(JSON.stringify(publicRows), /old-private-token/);
    f.db.close(); f = fixture(file, ['unrelated']); assert.deepEqual(f.events(), original);
    assert.equal(contextThinking(f.core, 'main')[0]?.text, 'before [hidden] after');
  } finally { f.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy reasoning without an ingest-time projection fails closed', () => {
  const f = fixture(':memory:', ['current']);
  try {
    f.db.prepare('INSERT INTO runtime_events(context_id,run_id,kind,data,created_at) VALUES(?,?,?,?,?)').run('main','legacy','message_update',JSON.stringify({id:'m',event:{type:'reasoning-delta',delta:'retired-private-token'}}),new Date().toISOString());
    const raw = f.runtime.events()[0]!; assert.equal(projectEvent(f.core, raw), undefined);
    assert.equal(f.text(), ''); assert.deepEqual(contextThinking(f.core, 'main'), []);
  } finally { f.db.close(); }
});

test('unfinished pre-restart streams cannot revive raw buffered secrets with a new credential set', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'public-thinking-open-')); const file = path.join(directory, 'runtime.sqlite');
  let f = fixture(file, ['old-private-token']);
  try {
    f.delta('safe words old-private-'); const previous = f.text();
    f.db.close(); f = fixture(file); f.delta('token'); f.end();
    assert.equal(f.text(), previous); assert.doesNotMatch(f.text(), /old-private-|token/);
  } finally { f.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SSE consumes only persisted safe projection and checkpoints preserve source sequencing', async () => {
  const f = fixture(':memory:', ['old-private-token']);
  try {
    f.delta('value old-private-'); f.delta('token done'); f.end(); f.rotate([]);
    const app = new Hono(); app.get('/events', c => serveEventStream(c, f.core, 0));
    const abort = new AbortController(); const response = await app.request('/events', {signal:abort.signal}); const reader = response.body!.getReader();
    let text = ''; const decoder = new TextDecoder();
    try { while (!text.includes('event: checkpoint')) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); } }
    finally { abort.abort(); await reader.cancel(); }
    assert.doesNotMatch(text, /old-private-token/); assert.match(text, /\[hidden\]/); assert.match(text, new RegExp('id: ' + f.runtime.eventHead()));
  } finally { f.db.close(); }
});

test('overlapping credentials and terminal partial prefixes are fully hidden', () => {
  for (const chunks of [['abcde '], ['abc', 'de '], ['abcde']]) {
    const f = fixture(':memory:', ['abcd', 'bcde', 'de-longer-credential']);
    try {
      for (const chunk of chunks) f.delta(chunk);
      f.end('aborted');
      assert.doesNotMatch(f.text(), /abc|bcde|de$/);
      assert.match(f.text(), /\[hidden\]/);
    } finally { f.db.close(); }
  }
});

test('raw source and safe projection roll back together and retry exactly once', () => {
  const f = fixture(':memory:', ['secret-value']);
  try {
    f.db.exec("CREATE TRIGGER reject_thinking BEFORE INSERT ON public_thinking_events BEGIN SELECT RAISE(ABORT,'projection_write_failed'); END");
    assert.throws(() => f.delta('normal secret-value tail', 'm', 0, 'r', 'main', 'retry-source'), /projection_write_failed/);
    assert.equal(f.runtime.eventHead(), 0); assert.equal(f.text(), '');
    f.db.exec('DROP TRIGGER reject_thinking');
    f.delta('normal secret-value tail', 'm', 0, 'r', 'main', 'retry-source');
    f.delta('normal secret-value tail', 'm', 0, 'r', 'main', 'retry-source'); f.end();
    assert.equal(f.text(), 'normal [hidden] tail');
  } finally { f.db.close(); }
});

test('missing or failed credential lookup never falls back to raw text', () => {
  const db = new DatabaseSync(':memory:'); const runtime = new RuntimeStore(db);
  try {
    runtime.event({contextId:'main',runId:'r',kind:'message_update',data:{id:'m',event:{type:'reasoning-delta',delta:'private raw text '}}});
    runtime.configurePublicThinkingSecrets(() => { throw Error('lookup-failed'); });
    runtime.event({contextId:'main',runId:'other',kind:'message_update',data:{id:'m',event:{type:'reasoning-delta',delta:'more private text '}}});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM public_thinking_events').get()!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get()!.n, 2);
  } finally { db.close(); }
});
