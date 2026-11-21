// Regression scenarios from Pi 1.5.1 login-dialog-device-code.test.ts and auth-url-copy.test.ts.
// Copyright (c) 2025 Mario Zechner; MIT license in ../src/tui/upstream/LICENSE.
import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { LoginDialogComponent } from '../src/tui/upstream/login-dialog.js';
import { plainTheme } from '../src/tui/upstream/theme.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const device = { userCode: 'ABCD-EFGH', verificationUri: 'https://example.invalid/device' };
function fixture() {
  const opened: string[] = [], copied: string[] = []; let cancelled = 0;
  const services = { theme: plainTheme, requestRender() {}, openBrowser: async (url: string) => { opened.push(url); }, copy: async (text: string) => { copied.push(text); } };
  const dialog = new LoginDialogComponent(services, 'Fixture', () => { cancelled++; }); dialog.focused = true;
  return { dialog, opened, copied, services, get cancelled() { return cancelled; }, shown: (width = 100) => stripVTControlCharacters(dialog.render(width).join('\n')) };
}
test('device actions require explicit confirmation, preserve provider overrides and consume Enter once', async () => {
  for (const [browser, clipboard] of [[true, true], [false, false], [true, false], [false, true]]) {
    const f = fixture(); const domain = f.dialog.showPrompt('Domain'); f.dialog.handleInput('\r'); assert.equal(await domain, '');
    f.dialog.showDeviceCode({ ...device, openBrowserOnConfirm: browser, copyCodeOnConfirm: clipboard }); f.dialog.showWaiting('Waiting');
    assert.deepEqual(f.opened, []); assert.deepEqual(f.copied, []);
    f.dialog.handleInput('\r'); await tick(); f.dialog.handleInput('\r');
    assert.deepEqual(f.opened, browser ? [device.verificationUri] : []); assert.deepEqual(f.copied, clipboard ? [device.userCode] : []);
    assert.match(f.shown(), /ABCD-EFGH[\s\S]*Waiting/); assert.equal(f.dialog.signal.aborted, false);
  }
});
test('device, browser and detail state transitions clear stale actions', async () => {
  const f = fixture(); f.dialog.showAuth('https://example.invalid/authorize'); f.opened.length = 0;
  f.dialog.showDeviceCode(device); f.dialog.handleInput('\x18'); assert.deepEqual(f.copied, []);
  f.dialog.showAuth('https://example.invalid/other'); f.opened.length = 0; f.dialog.handleInput('\r'); assert.deepEqual(f.copied, []); assert.deepEqual(f.opened, []);
  f.dialog.handleInput('\x18'); await tick(); assert.deepEqual(f.copied, ['https://example.invalid/other']);
  f.copied.length = 0; f.dialog.showDetails(['Choose method']); f.dialog.handleInput('\x18');
  f.dialog.showDeviceCode(device); f.dialog.showDetails(['Choose method']); f.dialog.handleInput('\r'); assert.deepEqual(f.copied, []); assert.deepEqual(f.opened, []);
});
test('cancel clears pending input and device actions without exposing submitted credentials', async () => {
  const f = fixture(); const answer = f.dialog.showManualInput('Code'); f.dialog.handleInput('private-code');
  assert.doesNotMatch(f.shown(), /private-code/); f.dialog.handleInput('\r'); assert.equal(await answer, 'private-code'); assert.doesNotMatch(f.shown(), /private-code/);
  const next = f.dialog.showPrompt('Again'); f.dialog.handleInput('discard-me'); f.dialog.cancel(); assert.equal(await next, undefined);
  f.dialog.showDeviceCode(device); f.dialog.handleInput('\r'); assert.equal(f.cancelled, 1); assert.deepEqual(f.opened, []); assert.deepEqual(f.copied, []);
});
test('full wrapped URL copy and browser retry coexist with a masked manual-code draft', async () => {
  const f = fixture(), url = `https://example.invalid/authorize?state=${'a'.repeat(310)}&redirect_uri=http%3A%2F%2Flocalhost%3A1455`;
  f.dialog.showAuth(url); const code = f.dialog.showManualInput('Redirect URL or code'); f.dialog.handleInput('partial-');
  f.dialog.handleInput('\x18'); f.dialog.handleInput('\x0f'); await tick();
  assert.deepEqual(f.copied, [url]); assert.deepEqual(f.opened, [url, url]);
  const rows = f.dialog.render(35); assert.ok(rows.length > 12); assert.ok(rows.join('\n').includes(`\x1b]8;;${url}`));
  f.dialog.handleInput('secret'); f.dialog.handleInput('\r'); assert.equal(await code, 'partial-secret'); assert.doesNotMatch(f.shown(), /partial-secret/);
});
test('URL update preserves the current manual input rather than rebuilding the prompt', async () => {
  const f = fixture(); f.dialog.showAuth('https://example.invalid/first'); const answer = f.dialog.showManualInput('Code'); f.dialog.handleInput('draft');
  f.dialog.showAuth('https://example.invalid/next', 'Updated URL', false); f.dialog.handleInput('-kept'); f.dialog.handleInput('\r'); assert.equal(await answer, 'draft-kept');
  assert.deepEqual(f.opened, ['https://example.invalid/first']); assert.match(f.shown(), /Updated URL/);
});
test('unsafe URLs never launch or emit hostile OSC sequences; valid URLs encode control characters', async () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.invalid/', 'not a URL\x1b]52;c;CANARY\x07']) {
    const f = fixture(); f.dialog.showAuth(value); await tick(); assert.deepEqual(f.opened, []); assert.doesNotMatch(f.dialog.render(100).join('\n'), /\x1b\]52/);
    assert.equal(f.dialog.render(100).join('\n').includes('\x1b]8;;'), false);
  }
  const f = fixture(); f.dialog.showAuth('https://example.invalid/#x\x07\x1b]52;c;CANARY\x07'); await tick();
  assert.equal(f.opened.length, 1); assert.match(f.opened[0]!, /%07%1B/); assert.doesNotMatch(f.dialog.render(100).join('\n'), /\x1b\]52/);
});
test('browser and clipboard failures remain visible without cancelling login or losing input', async () => {
  const f = fixture(); f.services.openBrowser = async () => { throw new Error('private launcher diagnostics'); }; f.services.copy = async () => { throw new Error('private clipboard diagnostics'); };
  f.dialog.showAuth('https://example.invalid/authorize'); const answer = f.dialog.showManualInput('Code'); f.dialog.handleInput('kept'); await tick();
  assert.match(f.shown(), /无法打开浏览器/); assert.doesNotMatch(f.shown(), /private launcher/);
  f.dialog.handleInput('\x18'); await tick(); assert.match(f.shown(), /无法访问剪贴板/); f.dialog.handleInput('\r'); assert.equal(await answer, 'kept'); assert.equal(f.dialog.signal.aborted, false);
  f.dialog.showDeviceCode(device); f.dialog.handleInput('\r'); await tick(); assert.match(f.shown(), /请手动|无法打开浏览器/); assert.equal(f.cancelled, 0);
});
test('select, text, stale prompts and cancellation share the same component lifecycle', async () => {
  const f = fixture(); const expired = f.dialog.showPrompt('Expired'); f.dialog.handleInput('stale'); f.dialog.dismissPrompt(); assert.equal(await expired, undefined);
  const selection = f.dialog.showSelection('Choose', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]); f.dialog.handleInput('\x1b[B'); f.dialog.handleInput('\r'); assert.equal(await selection, 'b');
  const text = f.dialog.showPrompt('Name'); f.dialog.handleInput('visible'); assert.match(f.shown(), /visible/); f.dialog.handleInput('\r'); assert.equal(await text, 'visible');
});
