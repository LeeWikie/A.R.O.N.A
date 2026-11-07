// Palette, token names and component theme mapping from Pi coding-agent
// modes/interactive/theme/{dark,light}.json and theme.ts, commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in LICENSE.
// Adapted: no theme files, watcher or custom themes; highlight.js is used directly.
import {
  backgroundAnsi, foregroundAnsi, getTerminalColorMode, parseColor,
  type EditorTheme, type MarkdownTheme, type SelectListTheme, type TerminalColorMode,
} from '@earendil-works/pi-tui';
import hljs from 'highlight.js';

const palettes = {
  dark: {
    vars: { text: 'okhsl(234 3% 89%)', muted: 'okhsl(229 6% 67%)', violet: 'okhsl(295 50% 67%)', blue: 'okhsl(232 54% 67%)', green: 'okhsl(159 59% 67%)', red: 'okhsl(20 72% 67%)', yellow: 'okhsl(83 88% 67%)', blueBg: 'okhsl(233 41% 24%)' },
    colors: {
      accent: 'violet', border: 'okhsl(231 57% 65%)', borderAccent: 'okhsl(295 53% 64%)', borderMuted: 'okhsl(229 8% 53%)', success: 'green', error: 'red', warning: 'yellow',
      muted: 'muted', dim: 'okhsl(229 8% 56%)', text: 'text', thinkingText: 'okhsl(226 7% 65%)', selectedBg: 'blueBg', userMessageBg: 'blueBg', userMessageText: 'text',
      customMessageBg: 'okhsl(295 42% 24%)', customMessageText: 'muted', customMessageLabel: 'violet',
      toolPendingBg: 'okhsl(229 5% 24%)', toolSuccessBg: 'okhsl(158 46% 25%)', toolErrorBg: 'okhsl(19 54% 25%)', toolTitle: 'text', toolOutput: 'muted',
      mdHeading: 'yellow', mdLink: 'blue', mdLinkUrl: 'muted', mdCode: 'violet', mdCodeBlock: 'green', mdCodeBlockBorder: 'muted', mdQuote: 'muted', mdQuoteBorder: 'muted', mdHr: 'muted', mdListBullet: 'violet',
      toolDiffAdded: 'green', toolDiffRemoved: 'red', toolDiffContext: 'muted',
      syntaxComment: 'muted', syntaxKeyword: 'blue', syntaxFunction: 'yellow', syntaxVariable: 'okhsl(202 58% 67%)', syntaxString: 'okhsl(52 67% 67%)', syntaxNumber: 'green', syntaxType: 'violet', syntaxOperator: 'muted', syntaxPunctuation: 'muted',
      thinkingOff: 'okhsl(229 8% 49%)', thinkingMinimal: 'okhsl(232 20% 52%)', thinkingLow: 'okhsl(232 45% 54%)', thinkingMedium: 'okhsl(263 59% 56%)', thinkingHigh: 'okhsl(295 73% 59%)', thinkingXhigh: 'okhsl(337 81% 61%)', thinkingMax: 'okhsl(20 99% 63%)',
    },
  },
  light: {
    vars: { text: 'okhsl(225 5% 27%)', muted: 'okhsl(229 8% 47%)', violet: 'okhsl(295 60% 46%)', blue: 'okhsl(231 68% 47%)', green: 'okhsl(159 75% 46%)', red: 'okhsl(20 91% 47%)', yellow: 'okhsl(83 99% 47%)', blueBg: 'okhsl(235 19% 91%)' },
    colors: {
      accent: 'violet', border: 'okhsl(231 67% 55%)', borderAccent: 'okhsl(295 59% 55%)', borderMuted: 'okhsl(235 7% 66%)', success: 'green', error: 'red', warning: 'yellow',
      muted: 'muted', dim: 'okhsl(229 7% 59%)', text: 'text', thinkingText: 'okhsl(234 8% 55%)', selectedBg: 'blueBg', userMessageBg: 'blueBg', userMessageText: 'text',
      customMessageBg: 'okhsl(295 25% 91%)', customMessageText: 'muted', customMessageLabel: 'violet',
      toolPendingBg: 'okhsl(248 3% 91%)', toolSuccessBg: 'okhsl(156 21% 91%)', toolErrorBg: 'okhsl(24 23% 91%)', toolTitle: 'text', toolOutput: 'muted',
      mdHeading: 'yellow', mdLink: 'blue', mdLinkUrl: 'muted', mdCode: 'violet', mdCodeBlock: 'green', mdCodeBlockBorder: 'muted', mdQuote: 'muted', mdQuoteBorder: 'muted', mdHr: 'muted', mdListBullet: 'violet',
      toolDiffAdded: 'green', toolDiffRemoved: 'red', toolDiffContext: 'muted',
      syntaxComment: 'muted', syntaxKeyword: 'blue', syntaxFunction: 'yellow', syntaxVariable: 'okhsl(203 73% 46%)', syntaxString: 'okhsl(52 84% 46%)', syntaxNumber: 'green', syntaxType: 'violet', syntaxOperator: 'muted', syntaxPunctuation: 'muted',
      thinkingOff: 'okhsl(223 5% 80%)', thinkingMinimal: 'okhsl(229 14% 78%)', thinkingLow: 'okhsl(232 33% 76%)', thinkingMedium: 'okhsl(264 48% 74%)', thinkingHigh: 'okhsl(295 62% 72%)', thinkingXhigh: 'okhsl(337 74% 70%)', thinkingMax: 'okhsl(20 98% 68%)',
    },
  },
} as const;

export type ThemeColor = keyof typeof palettes.dark.colors;
export type ThemeBg = 'selectedBg' | 'userMessageBg' | 'customMessageBg' | 'toolPendingBg' | 'toolSuccessBg' | 'toolErrorBg';
export type Appearance = keyof typeof palettes;
const backgrounds = new Set<string>(['selectedBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);

/** Dark or light from COLORFGBG (same classification as Pi), defaulting to dark. */
export function detectAppearance(env: NodeJS.ProcessEnv = process.env): Appearance {
  const bg = env.COLORFGBG?.split(';').at(-1)?.trim();
  if (!bg || !/^\d{1,2}$/.test(bg)) return 'dark';
  const index = Number(bg);
  if (index > 15) return 'dark';
  return index <= 6 || index === 8 ? 'dark' : 'light';
}
/** Honour the NO_COLOR convention (https://no-color.org) and non-truecolor terminals. */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env) { return !('NO_COLOR' in env && env.NO_COLOR !== ''); }

export class Theme {
  private readonly fgAnsi = new Map<string, string>();
  private readonly bgAnsi = new Map<string, string>();
  constructor(readonly appearance: Appearance = 'dark', readonly mode: TerminalColorMode = getTerminalColorMode(), readonly enabled = true) {
    const palette = palettes[appearance];
    for (const [token, raw] of Object.entries(palette.colors)) {
      const value = (palette.vars as Record<string, string>)[raw] ?? raw;
      const color = parseColor(value);
      this.fgAnsi.set(token, foregroundAnsi(color, mode));
      if (backgrounds.has(token)) this.bgAnsi.set(token, backgroundAnsi(color, mode));
    }
  }
  fg(color: ThemeColor, text: string) { return this.enabled ? `${this.fgAnsi.get(color)}${text}\x1b[39m` : text; }
  bg(color: ThemeBg, text: string) { return this.enabled ? `${this.bgAnsi.get(color)}${text}\x1b[49m` : text; }
  bold(text: string) { return this.enabled ? `\x1b[1m${text}\x1b[22m` : text; }
  italic(text: string) { return this.enabled ? `\x1b[3m${text}\x1b[23m` : text; }
  underline(text: string) { return this.enabled ? `\x1b[4m${text}\x1b[24m` : text; }
  strikethrough(text: string) { return this.enabled ? `\x1b[9m${text}\x1b[29m` : text; }
  thinking(level: string | undefined, text: string) {
    const token = ({ off: 'thinkingOff', minimal: 'thinkingMinimal', low: 'thinkingLow', medium: 'thinkingMedium', high: 'thinkingHigh', xhigh: 'thinkingXhigh', max: 'thinkingMax' } as Record<string, ThemeColor>)[level ?? 'off'] ?? 'thinkingOff';
    return this.fg(token, text);
  }

  /** Same scope-to-token mapping as Pi's cli-highlight theme. */
  private readonly scopes: Record<string, ThemeColor> = {
    keyword: 'syntaxKeyword', built_in: 'syntaxType', literal: 'syntaxNumber', number: 'syntaxNumber', regexp: 'syntaxString', string: 'syntaxString',
    comment: 'syntaxComment', doctag: 'syntaxComment', meta: 'muted', function: 'syntaxFunction', title: 'syntaxFunction', class: 'syntaxType', type: 'syntaxType',
    tag: 'syntaxPunctuation', name: 'syntaxKeyword', attr: 'syntaxVariable', variable: 'syntaxVariable', params: 'syntaxVariable', operator: 'syntaxOperator',
    punctuation: 'syntaxPunctuation', addition: 'toolDiffAdded', deletion: 'toolDiffRemoved', subst: 'text',
  };
  /** Highlight only when the fence names a known language; auto-detection misreads prose (as Pi notes). */
  highlightCode = (code: string, lang?: string): string[] => {
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;
    if (!this.enabled || !language) return code.split('\n').map(line => this.fg('mdCodeBlock', line));
    try {
      const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      return this.renderHtml(html).split('\n');
    } catch { return code.split('\n').map(line => this.fg('mdCodeBlock', line)); }
  };
  private renderHtml(html: string) {
    const stack: string[] = []; let out = '';
    const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    // Re-open the active colour after each newline so per-line rendering keeps it.
    const color = (text: string) => {
      const scope = stack.at(-1); const token = scope ? this.scopes[scope] : undefined;
      return token ? text.split('\n').map(part => part ? this.fg(token, part) : part).join('\n') : text;
    };
    for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
      const open = /^<span class="([^"]*)">$/.exec(part);
      if (open) { stack.push(open[1]!.split(/\s+/).map(name => name.replace(/^hljs-/, '').replace(/_$/, '')).find(name => name in this.scopes) ?? stack.at(-1) ?? ''); continue; }
      if (part === '</span>') { stack.pop(); continue; }
      if (part) out += color(decode(part));
    }
    return out;
  }

  markdown(): MarkdownTheme {
    return {
      heading: text => this.fg('mdHeading', text), link: text => this.fg('mdLink', text), linkUrl: text => this.fg('mdLinkUrl', text),
      code: text => this.fg('mdCode', text), codeBlock: text => this.fg('mdCodeBlock', text), codeBlockBorder: text => this.fg('mdCodeBlockBorder', text),
      quote: text => this.fg('mdQuote', text), quoteBorder: text => this.fg('mdQuoteBorder', text), hr: text => this.fg('mdHr', text), listBullet: text => this.fg('mdListBullet', text),
      bold: text => this.bold(text), italic: text => this.italic(text), underline: text => this.underline(text), strikethrough: text => this.strikethrough(text),
      highlightCode: this.highlightCode,
    };
  }
  selectList(): SelectListTheme {
    return { selectedPrefix: text => this.fg('accent', text), selectedText: text => this.fg('accent', text), description: text => this.fg('muted', text), scrollInfo: text => this.fg('muted', text), noMatch: text => this.fg('muted', text) };
  }
  editor(): EditorTheme { return { borderColor: text => this.fg('borderMuted', text), selectList: this.selectList() }; }
}

export const plainTheme = new Theme('dark', 'truecolor', false);
