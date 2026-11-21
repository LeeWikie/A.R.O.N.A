import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Terminal } from '@earendil-works/pi-tui';
import { TerminalApp } from '../src/tui/index.js';
import { Core } from '../src/core.js';
import type { Client } from '../src/client.js';
import type { AssetInfo } from '../src/assets.js';
import { authenticatedApp, removeTemp } from './helpers.js';
import { documentFixture, pdfFixture, workbookFixture } from './document-fixture.js';

test('terminal document upload agrees with the actual HTTP asset classification and retains exact original bytes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-tui-documents-'));
  const core = await Core.open({ dataDir: directory, memoryEnabled: false });
  const http = authenticatedApp(core);
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;
  const app = new TerminalApp({ async request(route: string, init?: RequestInit) {
    const response = await http.request(route, init); assert.equal(response.status, 201); return response.json();
  } } as unknown as Client, 'main', terminal);
  const ui = app as unknown as { storageId: string; choose(): Promise<string>; readLocalAttachment(file: string): Promise<unknown>; stageAttachment(attachment: unknown): Promise<void>; pendingAttachments: Map<string, AssetInfo[]> };
  ui.storageId = core.storageId; ui.choose = async () => 'yes';
  try {
    const fixtures = [
      ['synthetic.docx', documentFixture(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['synthetic.xlsx', await workbookFixture(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['synthetic.pdf', pdfFixture(), 'application/pdf'],
    ] as const;
    for (const [name, bytes, mediaType] of fixtures) {
      const file = path.join(directory, name); fs.writeFileSync(file, bytes);
      const inspected = await ui.readLocalAttachment(file); await ui.stageAttachment(inspected);
      const metadata = ui.pendingAttachments.get('main')!.at(-1)!;
      assert.equal(metadata.name, name); assert.equal(metadata.mediaType, mediaType);
      assert.deepEqual((await core.assets.read(metadata.id)).bytes, bytes);
    }
    assert.equal(ui.pendingAttachments.get('main')?.length, 3);
  } finally { await app.stop(); await core.close(); await removeTemp(directory); }
});
