import { Container, Image, Text } from '@earendil-works/pi-tui';
import { safeTerminalText } from '../terminal-format.js';
import type { Theme } from './upstream/theme.js';
import { ToolOutput } from './tool-output.js';

export type ToolResultPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Tool images stay structured; the terminal renderer chooses graphics or a visible fallback. */
export class ToolResultContent extends Container {
  constructor(parts: ToolResultPart[], expanded: boolean, theme: Theme, paint: (text: string) => string, includeText = true) {
    super();
    if (includeText) {
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (text) this.addChild(new ToolOutput({ output: { text, characters: text.length, lines: text.split('\n').length } }, expanded, theme, paint));
    }
    for (const part of parts) if (part.type === 'image') {
      const label = new Text(theme.fg('muted', `工具图片 · ${safeTerminalText(part.mimeType)}${expanded ? '' : ' · Ctrl+O 展开'}`), 2, 0); label.setCustomBgFn(paint); this.addChild(label);
      if (expanded) this.addChild(new Image(part.data, part.mimeType, { fallbackColor: text => theme.fg('toolOutput', text) }, { maxWidthCells: 60, maxHeightCells: 20, filename: 'tool-image' }));
    }
  }
}
