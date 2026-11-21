import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import type { PublicEvent } from '../src/protocol.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('tool card previews actual output, expands by the existing selector, and renders edit diff', async () => {
  const app = new TerminalApp({} as Client, 'main', new FakeTerminal());
  const target = app as unknown as {
    event(event: PublicEvent): void;
    toolCards: Map<string, { region: { render(width: number): string[] }; data: { output?: { text: string } } }>;
    choose(): Promise<string | undefined>;
    toolActivity(): Promise<void>;
  };
  const text = Array.from({ length: 16 }, (_, i) => `command-output-row-${i}`).join('\n');
  const send = (seq: number, data: unknown) => target.event({ seq, contextId: 'main', runId: 'run', kind: 'tool', createdAt: '', data });
  try {
    send(1, { toolCallId: 'call', toolName: 'mastra_workspace_execute_command', state: 'running', output: { text, characters: text.length, lines: 16 } });
    const [key, card] = [...target.toolCards.entries()][0]!;
    const render = () => card.region.render(100).map(stripTerminalSequences).join('\n');
    assert.match(render(), /command-output-row-9/); assert.doesNotMatch(render(), /command-output-row-10/);
    target.choose = async () => key; await target.toolActivity();
    assert.match(render(), /command-output-row-15/);
    send(2, { toolCallId: 'call', toolName: 'mastra_workspace_execute_command', state: 'finished', summary: { bytes: 42 } });
    assert.equal(card.data.output!.text, text);
    assert.match(render(), /command-output-row-15/);
    await target.toolActivity();
    assert.doesNotMatch(render(), /command-output-row-10/);
    send(3, { toolCallId: 'edit', toolName: 'mastra_workspace_edit_file', state: 'finished', diff: { text: '--- fixture.ts\n+++ fixture.ts\n@@ replacement @@\n-old\n+new', characters: 65, lines: 5 } });
    const edit = [...target.toolCards.values()][1]!;
    const diff = edit.region.render(100).map(stripTerminalSequences).join('\n');
    assert.match(diff, /-old/); assert.match(diff, /\+new/);
  } finally { await app.stop(); }
});
