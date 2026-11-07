import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('attachment limits and storage change reject uploads before transfer', async () => {
  let requests = 0, clipboardReads = 0;
  const client = { async request() { requests++; return {}; } } as unknown as Client;
  const app = new TerminalApp(client, 'main', new FakeTerminal(), { clipboard: { async getText() { clipboardReads++; return null; }, async getImage() { clipboardReads++; return null; } } });
  const target = app as unknown as { storageId: string; choose: () => Promise<string | undefined>; inspectAttachment: (name: string, bytes: Buffer) => Promise<unknown>; stageAttachment: (attachment: unknown) => Promise<void>; pendingAttachments: Map<string, Array<{ id: string; bytes: number }>> };
  target.storageId = 'old-storage';
  try {
    assert.equal(clipboardReads, 0);
    await assert.rejects(target.inspectAttachment('large.txt', Buffer.alloc(16 * 1024 * 1024 + 1, 65)), /asset_too_large/);
    await assert.rejects(target.inspectAttachment('bad.bin', Buffer.from([0, 255, 128])), /asset_type_not_supported/);
    const small = await target.inspectAttachment('note.txt', Buffer.from('fixture'));
    target.pendingAttachments.set('main', Array.from({ length: 8 }, (_, index) => ({ id: String(index), bytes: 1 })));
    await assert.rejects(target.stageAttachment(small), /too_many_attachments/);
    target.pendingAttachments.set('main', [{ id: 'one', bytes: 16 * 1024 * 1024 }, { id: 'two', bytes: 16 * 1024 * 1024 }]);
    await assert.rejects(target.stageAttachment(small), /message_attachments_too_large/);
    target.pendingAttachments.set('main', []); target.choose = async () => { target.storageId = 'new-storage'; return 'yes'; };
    await assert.rejects(target.stageAttachment(small), /core_storage_changed/); assert.equal(requests, 0);
  } finally { await app.stop(); }
});
