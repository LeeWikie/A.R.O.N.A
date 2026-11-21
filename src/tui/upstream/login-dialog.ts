// Pi coding-agent 1.5.1, modes/interactive/components/login-dialog.ts.
// Copyright (c) 2025 Mario Zechner; MIT license in LICENSE.
// Adaptation: injected host services/theme, masked credential input, HTTP prompt replacement,
// and an in-place selector. The editor remains owned by the host and is restored on exit.
import type { AuthInfoLink, OAuthDeviceCodeInfo } from '@earendil-works/pi-ai';
import { Container, type Focusable, Input, Key, matchesKey, CURSOR_MARKER, SelectList, Spacer, Text, TruncatedText, truncateToWidth } from '@earendil-works/pi-tui';
import { safeTerminalText } from '../../terminal-format.js';
import { AuthUrlComponent, displayUrl, webLink, webUrl, type AuthServices } from './auth-url.js';

class CredentialInput extends Input {
  override render(width: number): string[] {
    const count = Math.min(Array.from(this.getValue()).length, Math.max(0, width - 3));
    return [truncateToWidth(`› ${'•'.repeat(count)}`, Math.max(0, width - 1), '') + (this.focused ? CURSOR_MARKER : '')];
  }
}

export class LoginDialogComponent extends Container implements Focusable {
  private readonly contentContainer = new Container();
  private input: Input = new CredentialInput();
  private authUrl?: AuthUrlComponent;
  private abortController = new AbortController();
  private inputResolver?: (value: string | undefined) => void;
  private promptContainer?: Container;
  private selector?: SelectList;
  private deviceCodeAction?: { info: OAuthDeviceCodeInfo; hint: Container };
  private deviceCodeHint?: Container;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  constructor(private readonly services: AuthServices, providerName: string, private readonly onComplete: () => void) {
    super();
    const border = { invalidate() {}, render: (width: number) => [services.theme.fg('border', '─'.repeat(Math.max(1, width)))] };
    this.addChild(border);
    this.addChild(new Text(services.theme.fg('accent', services.theme.bold(`登录 ${safeTerminalText(providerName)}`)), 1, 0));
    this.addChild(this.contentContainer);
    this.addChild(new Text('Esc / Ctrl+C 取消登录', 1, 0));
    this.addChild(border);
  }
  get signal(): AbortSignal { return this.abortController.signal; }
  cancel(): void {
    if (this.signal.aborted) return;
    this.clearDeviceCodeAction(); this.abortController.abort(); this.dismissPrompt(); this.onComplete();
  }
  /** Expired prompt answers must never be sent to a later provider prompt. */
  dismissPrompt(): void {
    if (this.promptContainer && this.inputResolver) this.contentContainer.removeChild(this.promptContainer);
    this.promptContainer = undefined; this.selector = undefined; this.input.setValue('');
    const resolve = this.inputResolver; this.inputResolver = undefined; resolve?.(undefined);
    this.services.requestRender();
  }
  private clearDeviceCodeAction(): void {
    if (this.deviceCodeHint) this.contentContainer.removeChild(this.deviceCodeHint);
    this.deviceCodeHint = undefined; this.deviceCodeAction = undefined;
  }
  private clearContent(): void {
    this.contentContainer.clear(); this.contentContainer.addChild(new Spacer(1));
  }
  private restorePrompt(): void { if (this.promptContainer) this.contentContainer.addChild(this.promptContainer); }
  showAuth(url: string, instructions?: string, open = true): void {
    this.clearDeviceCodeAction(); this.clearContent();
    this.authUrl = new AuthUrlComponent(this.services, url); this.contentContainer.addChild(this.authUrl);
    if (instructions) { this.contentContainer.addChild(new Spacer(1)); this.contentContainer.addChild(new Text(this.services.theme.fg('warning', safeTerminalText(instructions)), 1, 0)); }
    this.restorePrompt();
    if (open && webUrl(url)) void this.authUrl.open();
    this.services.requestRender();
  }
  showDeviceCode(info: OAuthDeviceCodeInfo): void {
    this.authUrl = undefined; this.clearDeviceCodeAction(); this.clearContent();
    info = { ...info, openBrowserOnConfirm: info.openBrowserOnConfirm ?? true, copyCodeOnConfirm: info.copyCodeOnConfirm ?? true };
    const shownUrl = displayUrl(info.verificationUri);
    this.contentContainer.addChild(new Text(this.services.theme.fg('accent', webLink(shownUrl, shownUrl)), 1, 0));
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(new Text(this.services.theme.fg('warning', `输入验证码：${safeTerminalText(info.userCode)}`), 1, 0));
    if (!this.signal.aborted && (info.openBrowserOnConfirm || info.copyCodeOnConfirm)) {
      const hint = new Container();
      hint.addChild(new TruncatedText(`Enter ${info.openBrowserOnConfirm ? '打开浏览器' : ''}${info.openBrowserOnConfirm && info.copyCodeOnConfirm ? '并' : ''}${info.copyCodeOnConfirm ? '复制验证码' : ''}`, 1, 0));
      this.contentContainer.addChild(hint); this.deviceCodeHint = hint; this.deviceCodeAction = { info, hint };
    }
    this.restorePrompt(); this.services.requestRender();
  }
  private setDeviceCodeStatus(hint: Container, message: string): void {
    if (this.signal.aborted || !this.focused || !this.contentContainer.children.includes(hint)) return;
    hint.children = [new TruncatedText(this.services.theme.fg('dim', message), 1, 0)]; this.services.requestRender();
  }
  private activateDeviceCode(info: OAuthDeviceCodeInfo, hint: Container): void {
    this.setDeviceCodeStatus(hint, '正在准备授权页面…');
    if (info.copyCodeOnConfirm) void this.services.copy(info.userCode).then(() => this.setDeviceCodeStatus(hint, '验证码已复制')).catch(() => this.setDeviceCodeStatus(hint, '请手动复制验证码'));
    const target = webUrl(info.verificationUri);
    if (info.openBrowserOnConfirm && target) void this.services.openBrowser(target).catch(() => this.setDeviceCodeStatus(hint, '无法打开浏览器，请手动打开授权链接'));
  }
  showManualInput(prompt: string): Promise<string | undefined> { return this.showPrompt(prompt, undefined, true); }
  showPrompt(message: string, placeholder?: string, secret = false): Promise<string | undefined> {
    this.dismissPrompt(); this.clearDeviceCodeAction();
    const box = new Container(); box.addChild(new Spacer(1)); box.addChild(new Text(this.services.theme.fg('text', safeTerminalText(message)), 1, 0));
    if (placeholder) box.addChild(new Text(this.services.theme.fg('dim', safeTerminalText(placeholder)), 1, 0));
    this.input = secret ? new CredentialInput() : new Input(); this.input.focused = this.focused;
    box.addChild(this.input); box.addChild(new Text('Enter 提交 · Esc 取消', 1, 0));
    this.promptContainer = box; this.contentContainer.addChild(box);
    this.input.onSubmit = value => {
      const resolve = this.inputResolver; this.inputResolver = undefined;
      this.input.setValue('');
      box.children = [new Text(safeTerminalText(message), 1, 0), new Text(secret ? '已提交，等待供应商…' : `> ${safeTerminalText(value)}`, 1, 0)]; this.services.requestRender(); resolve?.(value);
    };
    this.input.onEscape = () => this.cancel(); this.services.requestRender();
    return new Promise(resolve => { this.inputResolver = resolve; });
  }
  showSelection(message: string, options: Array<{ id: string; label: string; description?: string }>): Promise<string | undefined> {
    this.dismissPrompt(); this.clearDeviceCodeAction();
    const box = new Container(); box.addChild(new Spacer(1)); box.addChild(new Text(safeTerminalText(message), 1, 0));
    const list = new SelectList(options.map(option => ({ value: option.id, label: safeTerminalText(option.label), description: option.description ? safeTerminalText(option.description) : undefined })), 6, this.services.theme.selectList());
    this.selector = list; this.promptContainer = box; box.addChild(list); this.contentContainer.addChild(box);
    list.onSelect = item => { const resolve = this.inputResolver; this.inputResolver = undefined; box.children = [new Text(`${safeTerminalText(message)}\n> ${item.label}`, 1, 0)]; this.services.requestRender(); resolve?.(item.value); };
    list.onCancel = () => this.cancel(); this.services.requestRender();
    return new Promise(resolve => { this.inputResolver = resolve; });
  }
  showDetails(lines: string[]): void {
    this.authUrl = undefined; this.clearDeviceCodeAction(); this.clearContent();
    for (const line of lines) this.contentContainer.addChild(new Text(safeTerminalText(line), 1, 0));
    this.restorePrompt(); this.services.requestRender();
  }
  showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
    this.contentContainer.addChild(new Spacer(1)); this.contentContainer.addChild(new Text(this.services.theme.fg('text', safeTerminalText(message)), 1, 0));
    for (const link of links) { const url = displayUrl(link.url); const text = link.label ? `${safeTerminalText(link.label)}: ${url}` : url; this.contentContainer.addChild(new Text(this.services.theme.fg('accent', webLink(text, url)), 1, 0)); }
    if (showCloseHint) this.contentContainer.addChild(new Text('Esc 关闭', 1, 0));
    this.services.requestRender();
  }
  showWaiting(message: string): void { this.contentContainer.addChild(new Spacer(1)); this.contentContainer.addChild(new Text(this.services.theme.fg('dim', safeTerminalText(message)), 1, 0)); this.services.requestRender(); }
  showProgress(message: string): void { this.contentContainer.addChild(new Text(this.services.theme.fg('dim', safeTerminalText(message)), 1, 0)); this.services.requestRender(); }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) { this.cancel(); return; }
    if (this.authUrl && matchesKey(data, Key.ctrl('x'))) { void this.authUrl.copy(); return; }
    if (this.authUrl && matchesKey(data, Key.ctrl('o'))) { void this.authUrl.open(); return; }
    if (this.deviceCodeAction && !this.inputResolver && !this.signal.aborted && this.focused && matchesKey(data, Key.enter)) {
      const action = this.deviceCodeAction; this.deviceCodeAction = undefined; this.activateDeviceCode(action.info, action.hint); this.services.requestRender(); return;
    }
    if (this.signal.aborted || !this.inputResolver) return;
    if (this.selector) this.selector.handleInput(data); else this.input.handleInput(data);
  }
}
