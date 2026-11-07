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
    assert.equal(target.toolCards.size, 1); assert.equal(card.data.state, 'finished'); assert.ok(card.region.render(100).join('').includes('结果：')); assert.ok(card.region.render(100).join('').includes('bytes：42'));
    send('run-2', { toolCallId: 'call', toolName: 'fixture', state: 'running', args: { command: { truncated: true, characters: 20000 } } });
    assert.equal(target.toolCards.size, 2); const second = [...target.toolCards.values()][1]!;
    target.choose = async () => [...target.toolCards.keys()][1]; await target.toolActivity();
    assert.ok(second.region.render(100).join('').includes('已截断，20000 字符'));
    target.choose = async () => key; await target.toolActivity(); assert.ok(!card.region.render(100).join('').includes('漢'));
  } finally { await app.stop(); }
});

test('folded tool lines follow Pi call renderers', async () => {
  const { toolCallLine } = await import('../src/tui/index.js');
  const plain = (text: string) => stripTerminalSequences(text);
  assert.equal(plain(toolCallLine('mastra_workspace_execute_command', { command: 'ls  -la\nnext', timeout: 30 })), '$ ls -la next (timeout 30s)');
  assert.equal(plain(toolCallLine('mastra_workspace_grep', { pattern: 'TODO', path: 'src' })), 'grep /TODO/ in src');
  assert.equal(plain(toolCallLine('mastra_workspace_read_file', { path: 'README.md' })), 'read README.md');
  assert.equal(plain(toolCallLine('web_fetch', { url: 'https://example.com' })), 'fetch https://example.com');
  assert.equal(plain(toolCallLine('custom_tool', {})), 'custom_tool');
});

test('task reports read as text with checks, deliveries and unresolved items', async () => {
  const { formatReport } = await import('../src/tui/index.js');
  const text = formatReport({ outcome: 'blocked', summary: 'Needs a key.', checks: [{ description: 'read input', passed: true }, { description: 'call API', passed: false }], deliveries: [{ kind: 'file', title: 'Result', value: 'out.txt', sha256: 'a'.repeat(64) }], unresolved: ['API key missing'] });
  assert.match(text, /结果：受阻/); assert.match(text, /✓ read input/); assert.match(text, /✗ call API/);
  assert.match(text, /Result（file） out\.txt · SHA-256 aaaaaaaaaaaa…/); assert.match(text, /• API key missing/);
  assert.doesNotMatch(text, /[{}]/);
  assert.equal(formatReport(null), '暂无报告');
});
