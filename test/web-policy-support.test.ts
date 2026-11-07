// Test adapter for the upstream Vitest assertions exercised by the policy suite.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { format } from 'node:util';

const run = Object.assign((name: string, fn: () => void) => test(name, fn), {
  each: (rows: readonly unknown[]) => (name: string, fn: (...args: never[]) => void) => {
    for (const row of rows) {
      const args = Array.isArray(row) ? row : [row];
      test(format(name, ...args), () => fn(...args as never[]));
    }
  },
});
const expectValue = (value: unknown, message?: string) => ({
  toBe: (expected: unknown) => assert.strictEqual(value, expected, message),
  toBeUndefined: () => assert.strictEqual(value, undefined, message),
  toContain: (expected: string) => assert.ok(typeof value === 'string' && value.includes(expected), message),
  not: { toContain: (expected: string) => assert.ok(typeof value === 'string' && !value.includes(expected), message) },
});
export const it = run as unknown as typeof import('vitest').it;
export const expect = expectValue as unknown as typeof import('vitest').expect;
export { describe };
