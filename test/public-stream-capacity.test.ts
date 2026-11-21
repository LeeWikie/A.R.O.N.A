import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';
import { redactPublicText, terminalTextChunk, terminalTextDelta } from '../src/public-text.js';

function fixture(secrets: string[] = []) {
  const db = new DatabaseSync(':memory:'), runtime = new RuntimeStore(db); runtime.configurePublicThinkingSecrets(() => secrets);
  const base = { draftId: 'draft', signalId: 'signal' }; runtime.event({ contextId: 'main', runId: 'run', kind: 'reply.start', data: base });
  const delta = (value: string, key?: string) => runtime.event({ contextId: 'main', runId: 'run', kind: 'reply.delta', data: { ...base, delta: value }, ...(key ? { key } : {}) });
  const view = () => {
    let text = '';
    for (const row of db.prepare('SELECT kind,data FROM public_reply_events ORDER BY seq').iterate()) {
      const data = JSON.parse(String(row.data)); if (row.kind === 'reply.delta') text += data.delta; else if (row.kind === 'reply.replace') text = data.text;
    }
    return text;
  };
  return { db, runtime, delta, view };
}

test('multi-megabyte replies keep publishing incremental text before commit without duplicating old output', () => {
  const f = fixture(['fixture-private-token']);
  try {
    const chunk = '中文 ordinary visible text\n'.repeat(3000); let expected = '';
    for (let index = 0; index < 50; index++) { expected += chunk; f.delta(chunk); assert.equal(f.view(), expected); }
    assert.ok(expected.length > 3 * 1024 * 1024);
    assert.equal(f.db.prepare('SELECT status FROM public_reply_streams').get()!.status, 'open');
    const bytes = Number(f.db.prepare('SELECT SUM(length(CAST(data AS BLOB))) AS bytes FROM public_reply_events').get()!.bytes);
    assert.ok(bytes < Buffer.byteLength(expected) * 1.2 + 20000);
  } finally { f.db.close(); }
});

test('large unspaced Chinese reasoning remains incremental and unresolved ASCII words spill privately until their delimiter', () => {
  const f = fixture(['private-secret']);
  const thinking = (text: string) => f.runtime.event({ contextId: 'main', runId: 'thinking-run', kind: 'message_update', data: { id: 'message', event: { type: 'reasoning-delta', delta: text } } });
  const shown = () => f.db.prepare('SELECT delta FROM public_thinking_events ORDER BY seq').all().map(row => row.delta).join('');
  try {
    const text = '这是持续显示的中文思考。'.repeat(60000); thinking(text); assert.equal(shown(), text);
    const word = 'a'.repeat(300000); for (let index = 0; index < word.length; index += 10000) thinking(word.slice(index, index + 10000));
    assert.equal(shown(), text); assert.ok(Number(f.db.prepare("SELECT SUM(length(body)) AS size FROM projection_text_parts WHERE namespace='thinking'").get()!.size) >= word.length);
    thinking(' 完成'); assert.equal(shown(), text + word + ' 完成');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM projection_text_parts WHERE namespace='thinking'").get()!.count, 0);
  } finally { f.db.close(); }
});

test('large private URL tails and their spill transactions never become public text, including a failed publication and retry', () => {
  const f = fixture();
  try {
    f.delta('ordinary '); const url = 'https://example.invalid/?token=' + 'private-value-'.repeat(20000);
    for (let index = 0; index < url.length; index += 2000) f.delta(url.slice(index, index + 2000));
    assert.equal(f.view(), 'ordinary '); assert.ok(Number(f.db.prepare('SELECT SUM(length(body)) AS size FROM projection_text_parts').get()!.size) >= url.length);
    const before = f.runtime.eventHead(), parts = f.db.prepare('SELECT * FROM projection_text_parts ORDER BY part').all();
    f.db.exec("CREATE TRIGGER fail_visible_tail BEFORE INSERT ON public_reply_events WHEN NEW.kind IN ('reply.delta','reply.replace') BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END");
    assert.throws(() => f.delta(' done ', 'tail-complete'), /synthetic projection failure/); assert.equal(f.runtime.eventHead(), before); assert.deepEqual(f.db.prepare('SELECT * FROM projection_text_parts ORDER BY part').all(), parts);
    f.db.exec('DROP TRIGGER fail_visible_tail'); f.delta(' done ', 'tail-complete'); f.delta(' done ', 'tail-complete');
    assert.equal(f.view(), redactPublicText('ordinary ' + url + ' done ', [])); assert.doesNotMatch(f.view(), /private-value/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM projection_text_parts').get()!.count, 0);
  } finally { f.db.close(); }
});

test('terminal-control parser state stays constant through large OSC/DCS payloads and preserves CRLF and Unicode boundaries', () => {
  for (const [open, close] of [['\x1b]0;', '\x07'], ['\x1bP', '\x1b\\'], ['\x9d0;', '\x9c']]) {
    let result = terminalTextDelta('visible\r' + open), text = result.text;
    for (let index = 0; index < 100; index++) {
      result = terminalTextDelta('private payload '.repeat(10000), result.state); text += result.text;
      assert.ok(JSON.stringify(result.state).length < 128);
    }
    result = terminalTextDelta(close + '\n\ud83d', result.state); text += result.text;
    result = terminalTextDelta('\ude00 complete', result.state); text += result.text;
    result = terminalTextDelta('', result.state, true); text += result.text;
    assert.equal(text, 'visible\n😀 complete');
  }
});

test('every chunk boundary preserves original redaction for credentials, URL syntax, Bearer/JWT and ordinary words that resemble tokens', () => {
  const samples = [
    'plain prefix Bearer unknown-private-token suffix ',
    'prefix eyJabcdefgh.ijklmnopq.rstuvwxyz suffix ',
    'aeyJabcdefgh.ijklmnopq.rstuvwxyz ordinary ',
    'https://user:unknown-private-password@example.invalid/?token=unknown-private-value tail ',
    'https%3A%2F%2Fuser%3Aunknown-private-password%40example.invalid%2F%3Ftoken%3Dunknown-private-value tail ',
    '中文Bearer unknown-private-token 中文 ',
    '中文普通文本和 legitimate-value words ',
    'visible known-private-key done ',
    'known-\x1b]ignored text\x07private-key done ',
  ];
  for (const input of samples) for (const size of [1, 2, 7, 31, input.length]) {
    const f = fixture(['known-private-key']);
    try {
      for (let index = 0; index < input.length; index += size) {
        f.delta(input.slice(index, index + size)); assert.doesNotMatch(f.view(), /unknown-private|known-private-key/);
      }
      assert.equal(f.view(), redactPublicText(input, ['known-private-key']), `${JSON.stringify(input)}/${size}`);
    } finally { f.db.close(); }
  }
  const raw = 'first\r\nsecond\x1b[31m中文\x1b[0m 😀 end';
  for (let split = 0; split <= raw.length; split++) {
    const a = terminalTextDelta(raw.slice(0, split)), b = terminalTextDelta(raw.slice(split), a.state), c = terminalTextDelta('', b.state, true);
    assert.equal(a.text + b.text + c.text, terminalTextChunk(raw).text);
  }
});

test('streamed URL and credential grammar prefixes do not cause quadratic public replacement records', () => {
  const f = fixture(); let raw = '';
  try {
    for (let index = 0; index < 150; index++) {
      const line = `Source ${index}: https://example.invalid/${index}?token=private-value-${index}\n`;
      raw += line; for (const char of line) f.delta(char);
    }
    assert.equal(f.view(), redactPublicText(raw, []));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM public_reply_events WHERE kind='reply.replace'").get()!.count, 0);
    const replaced = Number(f.db.prepare("SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM public_reply_events WHERE kind='reply.replace'").get()!.bytes);
    assert.ok(replaced < Buffer.byteLength(raw) * 3 + 20000);
  } finally { f.db.close(); }
});

test('known secrets cannot split a JWT or Bearer credential into publicly visible suffixes', () => {
  const cases = [
    { raw: '隐秘ABCeyJabcdef.ghijkl.mnopqr done ', secrets: ['隐秘ABC'], expected: '[hidden] done ' },
    { raw: 'eyJabcdef.ghijkl.mnopqr done ', secrets: ['abc'], expected: '[hidden] done ' },
    { raw: 'Bearer abc-private-suffix done ', secrets: ['abc'], expected: 'Bearer [hidden] done ' },
    { raw: '隐秘ABCtwo word key done ', secrets: ['隐秘ABC', 'two word key'], expected: '[hidden] done ' },
    { raw: '[hidden]隐秘ABC done ', secrets: ['隐秘ABC'], expected: '[hidden][hidden] done ' },
    { raw: 'aeyJabcdef.ghijkl.mnopqr done ', secrets: [], expected: 'aeyJabcdef.ghijkl.mnopqr done ' },
  ];
  for (const { raw, secrets, expected } of cases) for (let size = 1; size <= raw.length; size++) {
    const f = fixture(secrets);
    try {
      for (let index = 0; index < raw.length; index += size) {
        const delta = raw.slice(index, index + size);
        f.delta(delta);
        f.runtime.event({ contextId: 'main', runId: 'thinking-run', kind: 'message_update', data: { id: 'message', event: { type: 'reasoning-delta', delta } } });
        if (!raw.startsWith('aeyJ')) {
          assert.doesNotMatch(f.view(), /ghijkl|mnopqr|private-suffix|隐秘ABC|two word key/);
          const thought = f.db.prepare('SELECT delta FROM public_thinking_events ORDER BY seq').all().map(row => row.delta).join('');
          assert.doesNotMatch(thought, /ghijkl|mnopqr|private-suffix|隐秘ABC|two word key/);
        }
      }
      f.runtime.event({ contextId: 'main', runId: 'thinking-run', kind: 'message_end', data: { id: 'message' } });
      assert.equal(redactPublicText(raw, secrets), expected);
      assert.equal(f.view(), expected, `${JSON.stringify(raw)}/${size}`);
      assert.equal(f.db.prepare('SELECT delta FROM public_thinking_events ORDER BY seq').all().map(row => row.delta).join(''), expected);
    } finally { f.db.close(); }
  }
});
