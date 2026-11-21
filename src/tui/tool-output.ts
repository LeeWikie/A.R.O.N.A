import { Text, type Component } from '@earendil-works/pi-tui';
import { safeTerminalText } from '../terminal-format.js';
import type { PublicToolText } from '../tool-output.js';
import type { Theme } from './upstream/theme.js';

export interface ToolOutputData { output?: PublicToolText; diff?: PublicToolText }

/** Tool text is folded by rendered rows, so narrow terminals keep a short preview. */
export class ToolOutput implements Component {
  private readonly body: Text;
  constructor(data: ToolOutputData, private readonly expanded: boolean, private readonly theme: Theme, private readonly paint: (text: string) => string = text => text) {
    const lines: string[] = [];
    for (const [kind, value] of [['output', data.output], ['diff', data.diff]] as const) {
      if (!value || typeof value.text !== 'string') continue;
      if (lines.length) lines.push('');
      const clean = safeTerminalText(value.text);
      for (const line of clean.split('\n')) {
        const token = kind === 'diff' ? line.startsWith('+') ? 'toolDiffAdded' : line.startsWith('-') ? 'toolDiffRemoved' : 'toolDiffContext' : 'toolOutput';
        lines.push(theme.fg(token, line));
      }
      if (value.truncated) lines.push(theme.fg('warning', `（输出已截断，原文 ${value.characters} 字符 · ${value.lines} 行）`));
    }
    this.body = new Text(lines.join('\n'), 2, 0);
    this.body.setCustomBgFn(paint);
  }
  invalidate() { this.body.invalidate(); }
  render(width: number): string[] {
    const lines = this.body.render(width);
    if (this.expanded || lines.length <= 10) return lines;
    const notice = new Text(this.theme.fg('muted', `… 还有 ${lines.length - 10} 行 · 点击或 Ctrl+O 展开`), 2, 0);
    notice.setCustomBgFn(this.paint);
    return [...lines.slice(0, 10), ...notice.render(width)];
  }
}
