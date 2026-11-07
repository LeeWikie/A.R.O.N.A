import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import type { PublicEvent } from '../src/protocol.js';
import { TerminalApp } from '../src/tui/index.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

test('tool cards correlate run and call, preserve public arguments, and fold by keyboard', async () => {
  const app = new TerminalApp({} as Client, 'main', new FakeTerminal());
  const target = app as unknown as { event: (event: PublicEvent) => void; toolCards: Map<string, { region: { render: (width: number) => string[] }; data: { state: string } }>; choose: () => Promise<string | undefined>; toolActivity: () => Promise<void> };
  const command = '漢'.repeat(15990); let sequence = 0;
  const send = (runId: string, data: unknown) => target.event({ seq: ++sequence, contextId: 'main', runId, kind: 'tool', createdAt: '2026-01-01T00:00:00Z', data });
  try {
    send('run-1', { toolCallId: 'call', toolName: 'fixture', state: 'running', args: { command }, progress: { bytes: 12 } });
    assert.equal(target.toolCards.size, 1); const [key, card] = [...target.toolCards.entries()][0]!;
    assert.ok(!card.region.render(100).join('\n').includes('漢'));
    target.choose = async () => key; await target.toolActivity();
    const expanded = card.region.render(100).map(stripTerminalSequences).join('');
    assert.equal([...expanded].filter(char => char === '漢').length, command.length); assert.ok(expanded.includes('进度'));
    send('run-1', { toolCallId: 'call', toolName: 'fixture', state: 'finished', summary: { bytes: 42 } });
    assert.equal(target.toolCards.size, 1); assert.equal(card.data.state, 'finished'); assert.ok(card.region.render(100).join('').includes('结果统计'));
    send('run-2', { toolCallId: 'call', toolName: 'fixture', state: 'running', args: { command: { truncated: true, characters: 20000 } } });
    assert.equal(target.toolCards.size, 2); const second = [...target.toolCards.values()][1]!;
    target.choose = async () => [...target.toolCards.keys()][1]; await target.toolActivity();
    assert.ok(second.region.render(100).join('').includes('部分参数已截断'));
    target.choose = async () => key; await target.toolActivity(); assert.ok(!card.region.render(100).join('').includes('漢'));
  } finally { await app.stop(); }
});
