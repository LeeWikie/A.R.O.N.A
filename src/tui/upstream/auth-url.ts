// Pi coding-agent 1.5.1, modes/interactive/components/auth-url.ts and utils/web-url.ts.
// Copyright (c) 2025 Mario Zechner; MIT license in LICENSE.
// Adaptation: injected client services, explicit retry, and no hyperlinks for non-web targets.
import { Container, hyperlink, replaceControlCharacters, Text } from '@earendil-works/pi-tui';
import type { Theme } from './theme.js';

export interface AuthServices {
  requestRender(): void;
  openBrowser(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  theme: Theme;
}

export function webUrl(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
}
export function displayUrl(value: string): string { return webUrl(value) ?? replaceControlCharacters(value); }
export function webLink(text: string, url: string): string { const target = webUrl(url); return target ? hyperlink(text, target) : text; }

/** Keeps the complete target available when a terminal wraps or cannot select a long URL. */
export class AuthUrlComponent extends Container {
  readonly url: string;
  private readonly hint = new Text('', 1, 0);
  constructor(private readonly services: AuthServices, url: string) {
    super();
    this.url = displayUrl(url);
    this.addChild(new Text(services.theme.fg('accent', webLink(this.url, this.url)), 1, 0));
    this.addChild(this.hint);
    this.setHint('Ctrl+O 打开浏览器 · Ctrl+X 复制完整链接');
  }
  private setHint(message: string) { this.hint.setText(this.services.theme.fg('dim', message)); this.services.requestRender(); }
  async copy(): Promise<void> {
    try { await this.services.copy(this.url); this.setHint('已复制完整链接 · Ctrl+O 打开浏览器'); }
    catch { this.setHint('无法访问剪贴板，请手动复制链接 · Ctrl+O 打开浏览器'); }
  }
  async open(): Promise<void> {
    const target = webUrl(this.url);
    if (!target) { this.setHint('授权地址不是有效的 HTTP(S) 链接'); return; }
    try { await this.services.openBrowser(target); this.setHint('已请求浏览器打开 · Ctrl+O 再次打开 · Ctrl+X 复制完整链接'); }
    catch { this.setHint('无法打开浏览器 · Ctrl+O 重试 · Ctrl+X 复制完整链接'); }
  }
}
