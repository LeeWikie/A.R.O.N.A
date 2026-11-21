import assert from 'node:assert/strict';
import test from 'node:test';
import { isBase64String } from '../src/base64.js';

test('large media validates without exhausting the regexp stack and rejects a corrupt tail', () => {
  const data = Buffer.alloc(9 * 1024 * 1024 + 5, 127).toString('base64');
  assert.equal(isBase64String(data), true);
  assert.equal(isBase64String(data.slice(0, -4) + 'AA!A'), false);
  assert.equal(isBase64String(data.slice(0, -4) + 'A=AA'), false);
});

test('base64 validation preserves standard alphabet and padding syntax', () => {
  for (const value of ['', 'AAAA', 'AA==', 'AAA=', '+/8=', 'AB==']) assert.equal(isBase64String(value), true, value);
  for (const value of [undefined, 123, 'A', 'AA', 'AAA', '=AAA', 'A===', '====', 'AA==AAAA', 'AAA\n', 'AA-=', 'AA_=', '中文AA']) assert.equal(isBase64String(value), false, String(value));
});
