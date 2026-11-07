import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import { fauxProvider } from '@earendil-works/pi-ai';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { colorEnabled, detectAppearance, plainTheme, Theme } from '../src/tui/upstream/theme.js';
import { TerminalApp } from '../src/tui/index.js';
import { removeTemp } from './helpers.js';

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

test('theme colours tokens, respects NO_COLOR and COLORFGBG', () => {
  const dark = new Theme('dark', 'truecolor');
  assert.match(dark.fg('accent', 'x'), /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[39m$/);
  assert.match(dark.bg('toolErrorBg', 'x'), /^\x1b\[48;2;/);
  assert.notEqual(new Theme('light', 'truecolor').fg('text', 'x'), dark.fg('text', 'x'));
  assert.match(new Theme('dark', '256color').fg('accent', 'x'), /^\x1b\[38;5;\d+m/);
  assert.equal(plainTheme.fg('accent', 'x'), 'x');
  assert.equal(plainTheme.bold('x'), 'x');
  assert.equal(colorEnabled({ NO_COLOR: '1' }), false);
  assert.equal(colorEnabled({ NO_COLOR: '' }), true);
  assert.equal(colorEnabled({}), true);
  assert.equal(detectAppearance({ COLORFGBG: '0;15' }), 'light');
  assert.equal(detectAppearance({ COLORFGBG: '15;0' }), 'dark');
  assert.equal(detectAppearance({}), 'dark');
});

test('code blocks are highlighted per line only for known languages', () => {
  const theme = new Theme('dark', 'truecolor');
  const lines = theme.highlightCode('const a = "x";\n// note\nreturn 1;', 'ts');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(strip), ['const a = "x";', '// note', 'return 1;']);
  assert.ok(lines[0]!.includes('\x1b[38;2;'), 'keyword is coloured');
  assert.notEqual(lines[0], theme.fg('mdCodeBlock', 'const a = "x";'));
  const multi = theme.highlightCode('/* a\nb */', 'js');
  assert.ok(multi[1]!.startsWith('\x1b[38;2;'), 'multi-line comment colour is reopened on the next line');
  assert.deepEqual(theme.highlightCode('plain words here', 'not-a-language'), [theme.fg('mdCodeBlock', 'plain words here')]);
  assert.deepEqual(plainTheme.highlightCode('<b>&amp;</b>', 'html'), ['<b>&amp;</b>']);
  assert.deepEqual(theme.highlightCode('a < b && c > d', 'js').map(strip), ['a < b && c > d'], 'entities are decoded');
  const rendered = new Markdown('```py\nprint("hi")\n```', 0, 0, theme.markdown()).render(40);
  assert.ok(rendered.some(line => strip(line).includes('print("hi")')));
  for (const line of rendered) assert.ok(visibleWidth(line) <= 40);
});

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('missing model is reported and a send is intercepted locally with guidance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-no-model-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  try {
    const state = await core.modelState('main');
    assert.equal(state.unavailable, 'model_profile_not_found'); assert.equal(state.configuredProfiles, 0);
    const sent: string[] = [];
    const client = { async request(route: string, init?: RequestInit) {
      if (route === '/contexts/main/model') return core.modelState('main');
      if (route === '/messages') { sent.push(String(init?.body)); return { status: 'accepted' }; }
      return {};
    } } as unknown as Client;
    const app = new TerminalApp(client, 'main', new FakeTerminal());
    const target = app as unknown as { isMainContext: boolean; contextRole: string; contextReady: boolean; refreshModel(): Promise<void>; submit(text: string): Promise<void>; editor: { getText(): string }; transcript: { children: Array<{ text?: string }> } };
    try {
      target.isMainContext = true; target.contextRole = 'main'; target.contextReady = true;
      await target.refreshModel();
      const text = () => target.transcript.children.map(child => child.text ?? '').join('\n');
      assert.match(text(), /还没有可用的模型/); assert.match(text(), /\/login/);
      await target.submit('hello');
      assert.deepEqual(sent, [], 'nothing is sent while no model can run');
      assert.equal(target.editor.getText(), 'hello', 'the message stays in the editor');
    } finally { await app.stop(); }
  } finally { await core.close(); await removeTemp(directory); }
});

test('a provider profile without stored login is reported before sending', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-no-auth-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  try {
    const model = core.providerRegistry.getModels('openai-codex')[0]!;
    core.configure('model', { id: 'codex', name: 'Codex', providerId: 'openai-codex', modelId: model.id });
    await core.switchModel('main', 'codex');
    const state = await core.modelState('main');
    assert.equal(state.unavailable, 'model_credentials_unavailable');
    assert.equal(state.providerId, 'openai-codex');
  } finally { await core.close(); await removeTemp(directory); }
});

test('model state reports effective thinking and Shift+Tab cycles supported levels', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-model-state-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  try {
    const faux = fauxProvider({ provider: 'fake', models: [{ id: 'reasoner', reasoning: true }] });
    core.providerRegistry.setProvider(faux.provider);
    core.configure('model', { id: 'think', name: 'Thinker', providerId: 'fake', modelId: 'reasoner', defaultThinkingLevel: 'high' });
    await core.switchModel('main', 'think');
    assert.deepEqual(await core.modelState('main'), { contextId: 'main', profileId: 'think', name: 'Thinker', modelId: 'reasoner', thinkingLevel: 'high', source: 'profile', unavailable: null, configuredProfiles: 1, providerId: 'fake' });
    await core.switchModel('main', 'think', 'low');
    assert.equal((await core.modelState('main')).source, 'session');
    await core.switchModel('main', 'think', null);
    assert.equal((await core.modelState('main')).thinkingLevel, 'high');

    const writes: Array<{ route: string; body: unknown }> = [];
    const client = { async request(route: string, init?: RequestInit) {
      if (init?.body) writes.push({ route, body: JSON.parse(String(init.body)) as unknown });
      if (route === '/contexts/main/model' && !init?.method) return core.modelState('main');
      if (route === '/contexts/main/model') { const body = JSON.parse(String(init!.body)) as { profileId: string; thinkingLevel?: 'low' }; return core.switchModel('main', body.profileId, body.thinkingLevel); }
      if (route === '/models') return { models: core.models.list() };
      if (route.startsWith('/provider-models')) return { models: core.providerRegistry.getModels('fake').map(model => ({ modelId: model.id, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'] })) };
      return {};
    } } as unknown as Client;
    const app = new TerminalApp(client, 'main', new FakeTerminal());
    const target = app as unknown as { isMainContext: boolean; refreshModel(): Promise<void>; cycleThinking(): Promise<void>; model?: { thinkingLevel: string | null }; footer: { render(width: number): string[] } };
    try {
      target.isMainContext = true;
      await target.refreshModel();
      assert.equal(target.model?.thinkingLevel, 'high');
      assert.ok(target.footer.render(120).join('\n').includes('Thinker • high'));
      await target.cycleThinking();
      assert.deepEqual(writes.at(-1), { route: '/contexts/main/model', body: { profileId: 'think', thinkingLevel: 'off' } }, 'wraps after the last supported level, skipping levels we do not expose');
      assert.equal(target.model?.thinkingLevel, 'off');
      await target.cycleThinking();
      assert.equal((writes.at(-1)!.body as { thinkingLevel: string }).thinkingLevel, 'low');
    } finally { await app.stop(); }
  } finally { await core.close(); await removeTemp(directory); }
});

test('Markdown links become OSC 8 hyperlinks when the terminal supports them', async () => {
  const { setCapabilities, resetCapabilitiesCache } = await import('@earendil-works/pi-tui');
  setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  try {
    const lines = new Markdown('see [docs](https://example.com/a)', 0, 0, new Theme('dark', 'truecolor').markdown()).render(60).join('');
    assert.ok(lines.includes('\x1b]8;;https://example.com/a\x1b\\'));
  } finally { resetCapabilitiesCache(); }
});
