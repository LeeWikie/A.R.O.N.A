import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolResultContent, type ToolResultPart } from '../src/tui/tool-content.js';
import { plainTheme } from '../src/tui/upstream/theme.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=';
test('structured native tool text and images have visible folded/expanded output without printing base64 as text', () => {
  const parts: ToolResultPart[] = [{ type: 'text', text: 'native result\nwith controls\x1b]52;c;CANARY\x07' }, { type: 'image', mimeType: 'image/png', data: pixel }];
  for (const expanded of [false, true]) {
    const content = new ToolResultContent(parts, expanded, plainTheme, text => text), rendered = content.render(80).join('\n');
    assert.match(rendered, /native result/); assert.match(rendered, /工具图片/); assert.doesNotMatch(rendered, /\x1b\]52/); assert.equal(rendered.includes(pixel), false);
    assert.equal(content.children.length, expanded ? 3 : 2);
  }
  const duplicate = new ToolResultContent(parts, false, plainTheme, text => text, false).render(80).join('\n'); assert.doesNotMatch(duplicate, /native result/); assert.match(duplicate, /工具图片/);
});
