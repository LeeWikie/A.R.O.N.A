// Adapted from Pi coding-agent user-message.test.ts, commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in ../src/tui/upstream/LICENSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chalk } from 'chalk';
import { stripTerminalSequences, type MarkdownTheme } from '@earendil-works/pi-tui';
import { UserMessageComponent } from '../src/tui/upstream/user-message.js';
const identity = (value: string) => value;
const theme: MarkdownTheme = { heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity, codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity, listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity };
const chalk = new Chalk({ level: 3 });

test('keeps message height and OSC zone marker positions', () => {
  const message = new UserMessageComponent('hello', theme, 1, [], undefined, undefined, { color: identity, bgColor: chalk.bgBlue });
  const lines = message.render(20);
  assert.equal(lines.length, 3); assert.ok(lines[0]?.includes('\x1b]133;A\x07')); assert.ok(lines[0]?.endsWith('\x1b[49m'));
  assert.ok(!lines[0]?.includes('\x1b]133;B\x07')); assert.ok(lines[1]?.includes('hello'));
  assert.ok(lines[2]?.startsWith('\x1b]133;B\x07\x1b]133;C\x07')); assert.ok(lines[2]?.endsWith('\x1b[49m'));
});
test('chains transformers with user context', () => {
  const calls: string[] = [];
  const message = new UserMessageComponent('The input is $x^2$.', theme, 1, [
    (text, context) => { calls.push('formula'); assert.deepEqual(context, { messageType: 'user', isStreaming: false, availableWidth: 78, messageId: undefined, timestamp: undefined }); return text.replace('$x^2$', 'x²'); },
    text => { calls.push('suffix'); return `${text} Done.`; },
  ]);
  assert.match(stripTerminalSequences(message.render(80).join('\n')), /The input is x²\. Done\./); assert.deepEqual(calls, ['formula', 'suffix']);
});
test('reapplies transformers after invalidation', () => {
  let suffix = 'before'; const message = new UserMessageComponent('Message', theme, 1, [text => `${text} ${suffix}`]);
  assert.match(message.render(80).join('\n'), /Message before/); suffix = 'after'; message.invalidate(); assert.match(message.render(80).join('\n'), /Message after/);
});
test('passes persisted identity only when supplied', () => {
  const captured: Array<{ messageId?: string; timestamp?: string }> = [];
  const capture = (text: string, context: { messageId?: string; timestamp?: string }) => { captured.push({ messageId: context.messageId, timestamp: context.timestamp }); return text; };
  new UserMessageComponent('restored', theme, 1, [capture], 'entry-abc', '2025-01-15T10:30:00.000Z').render(80);
  new UserMessageComponent('live', theme, 1, [capture]).render(80);
  assert.deepEqual(captured, [{ messageId: 'entry-abc', timestamp: '2025-01-15T10:30:00.000Z' }, { messageId: undefined, timestamp: undefined }]);
});
