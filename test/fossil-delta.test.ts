// Adapted from dchest/fossil-delta-js@fbf59f556fa75d934609ee43ef1b08cad9a9a673.
// Original test vectors and BSD notice: fixtures/fossil-delta/LICENSE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createDelta, applyDelta, getDeltaTargetSize, createStringDelta, applyStringDelta, getStringDeltaTargetSize } from 'fossil-delta';

function vector(index: number, name: string) { return fs.readFileSync(new URL(`./fixtures/fossil-delta/data/${index}/${name}`, import.meta.url)); }

test('Fossil original binary and array vectors retain their complete bytes and target sizes', () => {
  for (let index = 1; index <= 5; index++) {
    const source = vector(index, 'origin'), target = vector(index, 'target'), expected = vector(index, 'delta');
    const delta = createDelta(source, target);
    assert.deepEqual([...delta], [...expected]); assert.deepEqual([...applyDelta(source, delta)], [...target]); assert.equal(getDeltaTargetSize(delta), target.length);
    const plain = createDelta([...source], [...target]);
    assert.deepEqual(plain, [...expected]); assert.deepEqual(applyDelta([...source], plain), [...target]); assert.equal(getDeltaTargetSize(plain), target.length);
  }
});
test('Fossil original string vector retains its exact delta and decoded target', () => {
  const source = vector(1, 'origin').toString(), target = vector(1, 'target').toString(), expected = vector(1, 'delta').toString();
  const delta = createStringDelta(source, target); assert.equal(typeof delta, 'string'); assert.equal(delta, expected);
  const applied = applyStringDelta(source, delta); assert.equal(typeof applied, 'string'); assert.equal(applied, target); assert.equal(getStringDeltaTargetSize(delta), vector(1, 'target').length);
});
test('Fossil original byte-array type contract is preserved', () => {
  const delta = createDelta(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4])); assert.ok(delta instanceof Uint8Array); assert.ok(applyDelta(new Uint8Array([1, 2, 3]), delta) instanceof Uint8Array);
  const plain = createDelta([1, 2, 3], [1, 2, 3, 4]); assert.ok(Array.isArray(plain)); assert.ok(Array.isArray(applyDelta([1, 2, 3], plain)));
});
test('Fossil original truncated delta is rejected', () => {
  const source = vector(1, 'origin'), delta = vector(1, 'delta'); assert.throws(() => applyDelta(source, delta.subarray(0, -1)));
});
