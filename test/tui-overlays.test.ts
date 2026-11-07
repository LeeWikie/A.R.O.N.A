// Adapted from OpenClaw src/tui/tui-overlays.test.ts, commit 24a860c9e7d9b2ebba60e3ca2cbb0b3ce3abfb19.
// Copyright (c) 2026 OpenClaw Foundation; MIT license in ../src/tui/upstream/LICENSE.openclaw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Component, OverlayHandle } from '@earendil-works/pi-tui';
import { createOverlayHandlers } from '../src/tui/upstream/tui-overlays.js';

const component = (): Component => ({ render: () => ['dummy'], invalidate() {} });
const handle = (hide: () => void): OverlayHandle => ({ hide, setHidden() {}, isHidden: () => false, focus() {}, unfocus() {}, isFocused: () => false, getBounds: () => undefined });

test('overlay opens through host and does not steal focus while a stack remains', () => {
  let shown: Component | undefined;
  let focused: Component | undefined;
  let hidden = 0;
  const overlay = component();
  const h = handle(() => { hidden++; });
  const host = { showOverlay: (c: Component) => { shown = c; return h; }, hasOverlay: () => true, setFocus: (c: Component | null) => { focused = c ?? undefined; } };
  const { openOverlay, closeOverlay } = createOverlayHandlers(host, component());
  assert.equal(openOverlay(overlay), h); assert.equal(shown, overlay);
  closeOverlay(h); assert.equal(hidden, 1); assert.equal(focused, undefined);
});

test('focus is restored only after the last handled overlay closes', () => {
  let count = 2;
  const focus: Array<Component | null> = [];
  const fallback = component();
  const host = { showOverlay: () => handle(() => {}), hasOverlay: () => count > 0, setFocus: (c: Component | null) => { focus.push(c); } };
  const { closeOverlay } = createOverlayHandlers(host, fallback);
  closeOverlay(handle(() => { count--; })); assert.deepEqual(focus, []);
  closeOverlay(handle(() => { count--; })); assert.deepEqual(focus, [fallback]);
});
