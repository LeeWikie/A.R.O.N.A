import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { fauxProvider, fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { setCapabilities, resetCapabilitiesCache, type Component, type Terminal } from '@earendil-works/pi-tui';
import { Client } from '../src/client.js';
import { Core } from '../src/core.js';
import { AppError } from '../src/domain.js';
import { createApp } from '../src/http.js';
import { TerminalApp } from '../src/tui/index.js';
import { finished, removeTemp, until } from './helpers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64');
class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false; output = ''; input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; } stop() {} async drainInput() {} write(data: string) { this.output += data; } moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('UI previews, confirms, retries and delivers exact image bytes to a Pi provider', { timeout: 35_000 }, async () => {
  const a = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), b = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true }); Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-asset-')); const file = path.join(directory, 'fixture.png'); fs.writeFileSync(file, png);
  const core = await Core.open({ dataDir: directory, memoryEnabled: false }); let seen: TranscriptContext | undefined;
  const fake = fauxProvider({ provider: 'image-fixture', models: [{ id: 'vision', input: ['text', 'image'] }] }); fake.setResponses([context => { seen = context; return fauxAssistantMessage('image received'); }, context => { seen = context; return fauxAssistantMessage('image only received'); }]); core.providerRegistry.setProvider(fake.provider);
  core.models.save({ id: 'default', name: 'Vision', providerId: 'image-fixture', modelId: 'vision' });
  const server = serve({ fetch: createApp(core).fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
  const client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, core.controlToken), terminal = new FakeTerminal();
  let clipboardReads = 0; const app = new TerminalApp(client, 'main', terminal, { clipboard: { async getText() { return null; }, async getImage() { clipboardReads++; return png; }, async getFilePaths() { return null; } } });
  const target = app as unknown as { currentRunId?: string; choose: (title: string, items: unknown[], filter?: unknown, preview?: Component) => Promise<string | undefined>; readLocalAttachment: (file: string) => Promise<unknown>; stageAttachment: (attachment: unknown) => Promise<void>; clipboardPaste: () => Promise<void>; submit: (text: string) => Promise<void>; write: (route: string, body: unknown, method?: string) => Promise<unknown>; pendingAttachments: Map<string, Array<{ id: string }>>; editor: { getText: () => string } };
  let choices: string[] = [], previewSeen = false, latestTitle = '';
  target.choose = async (title, _items, _filter, preview) => { latestTitle = title; if (preview) { previewSeen = true; assert.ok(preview.render(80).some(line => line.includes('\x1b_G'))); } return choices.shift(); };
  try {
    const running = app.run(); await until(() => terminal.output, text => text.includes('已连接'));
    const privateDir = path.join(directory, '.private'); fs.mkdirSync(privateDir); const privateFile = path.join(privateDir, 'private.png'); fs.writeFileSync(privateFile, png);
    await assert.rejects(target.readLocalAttachment(privateFile), /attachment_private_path/);
    const inspected = await target.readLocalAttachment(file);
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    choices = ['no']; await target.stageAttachment(inspected); assert.equal(previewSeen, false); assert.match(latestTitle, /不支持图像预览/);
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
    choices = ['no']; await target.stageAttachment(inspected); assert.equal(core.store.db.prepare('SELECT COUNT(*) AS n FROM asset_records').get()?.n, 0);
    choices = ['yes']; await target.stageAttachment(inspected); assert.equal(previewSeen, true);
    const id = target.pendingAttachments.get('main')?.[0]?.id; assert.ok(id); assert.deepEqual((await core.assets.read(id)).bytes, png);
    choices = ['no']; terminal.input('\x16'); await until(() => clipboardReads, count => count === 1); await until(() => choices.length, count => count === 0); assert.equal(target.pendingAttachments.get('main')?.length, 1);
    const originalWrite = target.write.bind(app); const ids: string[] = []; let fail = true;
    target.write = async (route, body, method) => { if (route === '/messages') { ids.push((body as { id: string }).id); if (fail) { fail = false; throw new AppError('connection_failed', 502); } } return originalWrite(route, body, method); };
    choices = ['yes']; await target.submit('check image'); assert.equal(target.editor.getText(), 'check image'); assert.equal(target.pendingAttachments.get('main')?.length, 1);
    choices = ['yes']; await target.submit('check image'); assert.equal(ids[0], ids[1]); assert.equal(target.pendingAttachments.get('main')?.length, 0);
    const signal = core.store.getSignal(ids[1]!)!; await finished(core, signal.runId!); assert.equal(core.store.outputsForSignal(signal.id)[0]?.content, 'image received');
    const images = seen?.messages.flatMap(message => message.role === 'user' && Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : []) ?? [];
    assert.ok(images.some(image => image.type === 'image' && image.data === png.toString('base64')));
    await until(() => target.currentRunId, value => value === undefined);
    choices = ['yes']; await target.stageAttachment(inspected); const onlyId = target.pendingAttachments.get('main')?.[0]?.id; assert.ok(onlyId);
    choices = ['yes']; await target.submit(''); const imageOnlySignal = core.store.getSignal(ids.at(-1)!)!;
    assert.equal(imageOnlySignal.content, ''); assert.deepEqual(imageOnlySignal.attachments, [onlyId]); await finished(core, imageOnlySignal.runId!);
    assert.equal(core.store.outputsForSignal(imageOnlySignal.id)[0]?.content, 'image only received');
    await app.stop(); await running;
  } finally {
    resetCapabilitiesCache(); await app.stop(); (server as Server).closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await core.close(); await removeTemp(directory);
    if (a) Object.defineProperty(process.stdin, 'isTTY', a); else delete (process.stdin as { isTTY?: boolean }).isTTY; if (b) Object.defineProperty(process.stdout, 'isTTY', b); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
