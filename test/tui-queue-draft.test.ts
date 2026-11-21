import assert from 'node:assert/strict';
import test from 'node:test';
import { queueDraft } from '../src/tui/queue-draft.js';
import type { AssetInfo } from '../src/assets.js';

const asset = (id: string, bytes = 1): AssetInfo => ({ id, name: `${id}.txt`, mediaType: 'text/plain', bytes, sha256: 'synthetic', createdAt: '2026-01-01T00:00:00Z' });
test('withdrawing a complete input keeps raw text order, attachment-only messages and current draft references', () => {
  const a = asset('a'), b = asset('b'), c = asset('c');
  const result = queueDraft([{ id: 'first', content: '  first raw text  ', attachments: ['a'] }, { id: 'second', content: '', attachments: ['b', 'a'] }], 'current draft', [c], new Map([['a', a], ['b', b]]));
  assert.equal(result.text, '  first raw text  \n\ncurrent draft'); assert.deepEqual(result.attachments, [a, b, c]);
});
test('an unavailable or oversize complete input fails before cancelling any source', () => {
  assert.throws(() => queueDraft([{ id: 'first', content: 'text', attachments: ['missing'] }], '', [], new Map()), /queue_attachment_unavailable/);
  const items = Array.from({ length: 9 }, (_, index) => asset(String(index)));
  assert.throws(() => queueDraft([{ id: 'first', content: 'text', attachments: items.map(item => item.id) }], '', [], new Map(items.map(item => [item.id, item]))), /queue_draft_too_large/);
  assert.throws(() => queueDraft([{ id: 'first', content: 'a'.repeat(64000) }], 'new draft', [], new Map()), /queue_draft_too_large/);
  const large = asset('large', 32 * 1024 * 1024 + 1);
  assert.throws(() => queueDraft([{ id: 'first', content: '', attachments: [large.id] }], '', [], new Map([[large.id, large]])), /queue_draft_too_large/);
});
