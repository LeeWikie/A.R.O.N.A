import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Box, Container, Editor, Loader, fuzzyFilter, Input, Markdown, ProcessTerminal, ScrollView, SelectList, Spacer, CombinedAutocompleteProvider, Image, MouseRegion, getCapabilities, getNativeClipboard,
  Text, TruncatedText, TuiAltScreen, VStack, wrapTextWithAnsi, stripTerminalSequences, matchesKey, Key, CURSOR_MARKER, truncateToWidth,
  type Component, type EditorTheme, type MarkdownTheme, type OverlayHandle, type SelectItem, type AutocompleteProvider, type AutocompleteItem,
  type SelectListTheme, type Terminal, type TuiMouseEvent, type NativeClipboard,
} from '@earendil-works/pi-tui';
import type { Client } from '../client.js';
import { AppError } from '../domain.js';
import type { OutputRecord, RunRecord, SignalRecord } from '../domain.js';
import type { AssetInfo } from '../assets.js';
import type { ContextCapacity } from '../context-policy.js';
import { fileTypeFromBuffer } from 'file-type';
import type { ConversationMessage, ConversationPage, PublicEvent, TuiSnapshot } from '../protocol.js';
import type { ApprovalRecord, ContextRecord, ContextRole, TaskRecord, TaskReport } from '../runtime-store.js';
import type { Occurrence } from '../schedules.js';
import { createOverlayHandlers } from './upstream/tui-overlays.js';
import { UserMessageComponent } from './upstream/user-message.js';
import { editExternally } from './upstream/external-editor.js';
import { filterAndSortSessions, type SessionInfo } from './upstream/session-selector-search.js';
import { protocolHandshakeSchema } from '../protocol.js';
import { findFd } from '../tools/fd.js';
import { colorEnabled, detectAppearance, plainTheme, Theme } from './upstream/theme.js';

const identity = (s: string) => s;
// Module-level theme so free functions and components share one palette; set per app instance.
let theme: Theme = plainTheme;
let selectTheme: SelectListTheme = theme.selectList();
let editorTheme: EditorTheme = theme.editor();
let markdownTheme: MarkdownTheme = theme.markdown();
function applyTheme(next: Theme) { theme = next; selectTheme = next.selectList(); editorTheme = next.editor(); markdownTheme = next.markdown(); }

/** Server-controlled text must never supply terminal controls or bidi overrides. */
export function safeTerminalText(value: string): string {
  return stripTerminalSequences(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '');
}
const label = (value: unknown) => safeTerminalText(String(value ?? '')).replace(/\s+/g, ' ').trim();
const routeId = (id: string) => encodeURIComponent(id);

/** Marks user input that did not (or not yet) reach a run; accepted input needs no annotation. */
function userMessageState(status: string) {
  if (status === 'queued') return '（排队中）';
  if (status === 'cancelled') return '（已撤回，未发送）';
  if (status === 'rejected') return '（未接收）';
  if (status === 'interrupted') return '（未执行：已中断）';
  return '';
}
const thinkingCommandLevels =['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
interface TuiCommand { name: string; description: string; usage?: string; aliases?: string[]; capability?: string; completions?: readonly string[] }
/** Local slash commands; each maps to an existing management flow so behaviour stays in one place. */
export const tuiCommands: readonly TuiCommand[] = [
  { name: 'help', description: '查看命令', aliases: ['commands'] },
  { name: 'menu', description: '打开管理菜单', aliases: ['settings'] },
  { name: 'new', description: '新建交流上下文', usage: '/new [名称]' },
  { name: 'sessions', description: '切换上下文', usage: '/sessions [ID或名称]', aliases: ['session', 'resume'] },
  { name: 'name', description: '重命名当前上下文', usage: '/name [名称]' },
  { name: 'fork', description: '从已完成的一轮分支出新对话', capability: 'context-branch' },
  { name: 'tree', description: '按来源浏览上下文树' },
  { name: 'model', description: '切换模型', usage: '/model [配置ID或名称]', aliases: ['models'] },
  { name: 'think', description: '设置思考等级', usage: '/think <等级|default>', aliases: ['thinking'], completions: [...thinkingCommandLevels, 'default'] },
  { name: 'stop', description: '停止当前运行', aliases: ['abort'], capability: 'foreground-interrupt' },
  { name: 'copy', description: '复制最近回复或选区' },
  { name: 'status', description: '当前连接与运行状态' },
  { name: 'usage', description: '当前上下文用量' },
  { name: 'context', description: '上下文容量估算', capability: 'context-capacity' },
  { name: 'tasks', description: '后台任务' },
  { name: 'task', description: '新建后台任务', usage: '/task [任务内容]' },
  { name: 'approvals', description: '待处理审批' },
  { name: 'queue', description: '查看、编辑或撤回排队消息', capability: 'message-queue' },
  { name: 'schedules', description: '定时任务' },
  { name: 'tools', description: '展开或折叠工具活动' },
  { name: 'attach', description: '附件', capability: 'attachments' },
  { name: 'login', description: '供应商登录', usage: '/login [供应商]', aliases: ['auth'], capability: 'provider-auth' },
  { name: 'mcp', description: 'MCP 连接' },
  { name: 'memory', description: '记忆' },
  { name: 'editor', description: '外部编辑器（Ctrl+G）' },
  { name: 'quit', description: '退出（核心继续运行）', aliases: ['exit'] },
];
function commandHelp() {
  return ['可用命令：', ...tuiCommands.map(command => `  ${command.usage ?? `/${command.name}`}  ${command.description}${command.aliases?.length ? `（别名 ${command.aliases.map(alias => `/${alias}`).join(' ')}）` : ''}`),
    '快捷键：Esc 停止当前回复 · Ctrl+C 清空输入／停止运行／连按两次退出 · Ctrl+D 空输入时退出 · Ctrl+O 展开或折叠工具 · Ctrl+L 选择模型 · Ctrl+P 切换到下一个模型 · Shift+Tab 切换思考等级 · Alt+Enter（或 Ctrl+Q）排队到下一次运行 · Alt+↑（或 Alt+Q）撤回并编辑排队消息 · Ctrl+G 外部编辑器 · Ctrl+V 粘贴附件 · Ctrl+X 复制 · PageUp/PageDown 浏览'].join('\n');
}
const supportedLevels = (levels: readonly string[]) => levels.filter(level => ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level));
type SavedProfile = { id: string; name: string; modelId: string; defaultThinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' } & ({ providerId: string } | { protocol: 'chat-completions' | 'responses' | 'messages'; baseURL: string; apiKeyEnv: string; authHeader: 'api-key' | 'bearer'; thinking: Record<string, Record<string, unknown>> });
type McpConfig = { id: string; enabled: boolean; command?: string; args: string[]; url?: string; protocolVersion?: 'legacy' | '2026-07-28'; headersEnv: Record<string, string>; env: Record<string, string> };
type ToolActivity = { contextId: string; runId: string | null; toolCallId: string; toolName: string; state: 'running' | 'finished' | 'failed' | 'denied'; args?: unknown; progress?: unknown; summary?: unknown; startedAt?: string; updatedAt?: string; legacy?: boolean; originContextId?: string };
type LocalAttachment = { name: string; mediaType: string; bytes: Buffer; sha256: string };
const MAX_ATTACHMENT = 16 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 32 * 1024 * 1024;
type Timing = { kind: 'once'; at: string } | { kind: 'interval'; anchorAt: string; everyMs: number } | { kind: 'cron'; expression: string };
type SavedSchedule = { id: string; name: string; status: string; revision: number; task: string; nextFireAt: string | null; timing: Timing; timezone: string; contextId: string; output: { kind: string; contextId: string } };

function contextTree(contexts: ContextRecord[]): Array<{ context: ContextRecord; depth: number }> {
  const byId = new Map(contexts.map(item => [item.id, item])); const children = new Map<string, ContextRecord[]>();
  const roots: ContextRecord[] = [];
  for (const context of contexts) {
    if (!context.parentContextId || !byId.has(context.parentContextId) || context.parentContextId === context.id) roots.push(context);
    else { const list = children.get(context.parentContextId) ?? []; list.push(context); children.set(context.parentContextId, list); }
  }
  const result: Array<{ context: ContextRecord; depth: number }> = []; const seen = new Set<string>();
  const visit = (root: ContextRecord) => {
    const stack = [{ context: root, depth: 0 }];
    while (stack.length) {
      const item = stack.pop()!; if (seen.has(item.context.id)) continue;
      seen.add(item.context.id); result.push(item);
      const descendants = children.get(item.context.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index--) stack.push({ context: descendants[index]!, depth: item.depth + 1 });
    }
  };
  for (const root of roots) visit(root);
  for (const context of contexts) if (!seen.has(context.id)) visit(context);
  return result;
}

class SafeAutocomplete implements AutocompleteProvider {
  constructor(private readonly provider: CombinedAutocompleteProvider, private readonly base: string, private readonly commandSupported: (name: string) => boolean = () => true) {}
  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }) {
    const result = await this.provider.getSuggestions(lines, cursorLine, cursorCol, options);
    if (!result) return null;
    const line = (lines[cursorLine] ?? '').trimStart();
    const isArgument = !options.force && line.startsWith('/') && line.slice(0, cursorCol).includes(' ') && !result.prefix.startsWith('/');
    const items = result.items.filter(item => {
      if (![item.value, item.label, item.description ?? ''].every(text => !/[\p{Cc}؜‎‏‪-‮⁦-⁩]/u.test(text) && !/(?:^|[\\/@"'])\.private(?:[\\/]|$)/i.test(text))) return false;
      const isCommand = !options.force && result.prefix.startsWith('/') && !result.prefix.slice(1).includes('/') && line.startsWith('/');
      if (isCommand) return this.commandSupported(item.value.replace(/^\//, ''));
      if (isArgument && /^[a-z]+$/.test(item.value)) return true;
      const raw = item.description ?? item.value.replace(/^@/, '').replace(/^"|"$/g, '');
      const display = raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(2)) : raw;
      try { return !/(?:^|[\\/])\.private(?:[\\/]|$)/i.test(fs.realpathSync(path.resolve(this.base, display))); }
      catch { return false; }
    });
    return items.length ? { ...result, items } : null;
  }
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) { return this.provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix); }
  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) { return this.provider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol); }
}

class SecretInput extends Input {
  override render(width: number): string[] {
    const count = Math.min(Array.from(this.getValue()).length, Math.max(0, width - 3));
    return [truncateToWidth(`› ${'•'.repeat(count)}`, Math.max(0, width - 1), '') + (this.focused ? CURSOR_MARKER : '')];
  }
}

class SearchSelector extends Container {
  focused = false;
  private readonly search = new Input({ prompt: '搜索 › ' });
  constructor(private list: SelectList, private readonly items: SelectItem[], private readonly filter?: (query: string) => string[]) { super(); this.addChild(this.search); this.addChild(list); }
  override render(width: number) { this.search.focused = this.focused; return super.render(width); }
  handleInput(data: string) {
    if ([Key.up, Key.down, Key.pageUp, Key.pageDown, Key.enter, Key.escape, Key.ctrl('c')].some(key => matchesKey(data, key))) this.list.handleInput(data);
    else {
      this.search.handleInput(data);
      const query = this.search.getValue();
      const selected = this.filter?.(query);
      const filtered = selected ? selected.flatMap(value => { const item = this.items.find(candidate => candidate.value === value); return item ? [item] : []; }) : fuzzyFilter(this.items, query.trim(), item => `${item.label} ${item.value} ${item.description ?? ''}`);
      const next = new SelectList(filtered, 10, selectTheme);
      next.onSelect = this.list.onSelect; next.onCancel = this.list.onCancel;
      this.removeChild(this.list); this.list = next; this.addChild(next);
    }
  }
}

class ToolCard extends Container {
  private expanded = false;
  private readonly title = new Text('', 1, 0);
  private readonly detail = new Text('', 2, 0);
  readonly region: MouseRegion;
  data: ToolActivity;
  constructor(data: ToolActivity, private readonly renderNow: () => void) {
    super(); this.data = data;
    this.region = new MouseRegion(this, event => {
      if (event.type !== 'click' || event.button !== 'left') return undefined;
      this.toggle(); return { handled: true };
    });
    this.rebuild();
  }
  update(next: ToolActivity) { this.data = { ...this.data, ...next, args: next.args ?? this.data.args, progress: next.progress ?? this.data.progress, summary: next.summary ?? this.data.summary }; this.rebuild(); }
  toggle() { this.expanded = !this.expanded; this.rebuild(); this.renderNow(); }
  isExpanded() { return this.expanded; }
  setExpanded(value: boolean) { if (this.expanded !== value) { this.expanded = value; this.rebuild(); } }
  private rebuild() {
    const state: Record<string, string> = { running: '进行中', finished: '完成', failed: '失败', denied: '已拒绝' };
    const bg = this.data.state === 'running' ? 'toolPendingBg' : this.data.state === 'finished' ? 'toolSuccessBg' : 'toolErrorBg';
    const paint = (text: string) => theme.bg(bg, text); this.title.setCustomBgFn(paint); this.detail.setCustomBgFn(paint);
    const elapsed = this.data.startedAt && this.data.updatedAt ? (Date.parse(this.data.updatedAt) - Date.parse(this.data.startedAt)) / 1000 : NaN;
    const timing = Number.isFinite(elapsed) && elapsed >= 0.1 && this.data.state !== 'running' ? ` ${elapsed.toFixed(1)}s` : '';
    this.title.setText(`${theme.fg('muted', this.expanded ? '▾' : '▸')} ${toolCallLine(this.data.toolName, this.data.args)} ${theme.fg(this.data.state === 'failed' || this.data.state === 'denied' ? 'error' : 'muted', `· ${state[this.data.state] ?? label(this.data.state)}${timing}`)}${this.data.originContextId ? theme.fg('muted', ` · 来自 ${label(this.data.originContextId)}`) : ''}`);
    this.clear(); this.addChild(this.title);
    if (this.expanded) {
      const lines = [...describeFields('参数', this.data.args), ...describeFields('进度', this.data.progress), ...describeFields('结果', this.data.summary)];
      if (this.data.legacy) lines.push('旧记录不包含公开参数。');
      if (!lines.length) lines.push('没有可公开的参数或结果统计。');
      this.detail.setText(theme.fg('toolOutput', safeTerminalText(lines.join('\n')))); this.addChild(this.detail);
    }
  }
}

const toolLabels: Record<string, string> = {
  mastra_workspace_execute_command: '$', mastra_workspace_read_file: 'read', mastra_workspace_write_file: 'write', mastra_workspace_apply_patch: 'edit',
  mastra_workspace_list_files: 'ls', mastra_workspace_grep: 'grep', mastra_workspace_file_stat: 'stat', mastra_workspace_mkdir: 'mkdir',
  mastra_workspace_get_process_output: 'output', mastra_workspace_kill_process: 'kill', web_fetch: 'fetch', web_search: 'search',
};
/** Folded tool line in the shape of Pi's call renderers: `$ cmd`, `read path`, `grep /pat/ in dir`. */
export function toolCallLine(toolName: string, args: unknown) {
  const row = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === 'string' ? safeTerminalText(value).replace(/\s+/g, ' ').slice(0, 160) : Array.isArray(value) ? value.map(String).join(', ').slice(0, 160) : '';
  const name = toolLabels[toolName] ?? label(toolName || '工具');
  const title = (value: string) => theme.fg('toolTitle', theme.bold(value));
  if (name === '$') return title(`$ ${text(row.command) || '…'}`) + (typeof row.timeout === 'number' ? theme.fg('muted', ` (timeout ${row.timeout}s)`) : '');
  if (name === 'grep') return `${title('grep')} ${theme.fg('accent', `/${text(row.pattern)}/`)}${theme.fg('toolOutput', ` in ${text(row.path) || '.'}`)}`;
  const target = text(row.path ?? row.paths ?? row.directory ?? row.url ?? row.query ?? row.pattern ?? row.title ?? row.name);
  return target ? `${title(name)} ${theme.fg('accent', target)}` : title(name);
}
const reportOutcome: Record<string, string> = { succeeded: '成功', failed: '失败', blocked: '受阻' };
/** Task report as text: outcome, summary, each check, deliveries with hash, unresolved items. */
export function formatReport(report: TaskReport | null) {
  if (!report) return '暂无报告';
  const lines = [`结果：${reportOutcome[report.outcome] ?? label(report.outcome)}`, safeTerminalText(report.summary), '', '检查：', ...report.checks.map(check => `  ${check.passed ? '✓' : '✗'} ${label(check.description)}`)];
  if (report.deliveries.length) lines.push('交付：', ...report.deliveries.map(item => `  ${label(item.title)}（${item.kind}）${item.kind === 'file' ? ` ${label(item.value)}${item.sha256 ? ` · SHA-256 ${item.sha256.slice(0, 12)}…` : ''}` : item.kind === 'json' ? '' : `：${label(item.value).slice(0, 200)}`}`));
  if (report.unresolved.length) lines.push('未解决：', ...report.unresolved.map(item => `  • ${label(item)}`));
  return lines.join('\n');
}
const occurrenceStatus: Record<string, string> = { pending: '进行中', succeeded: '成功', failed: '失败', unreported: '未报告', interrupted: '中断', blocked: '受阻', cancelled: '取消' };
function formatOccurrence(occurrence: Occurrence) {
  const when = new Date(occurrence.scheduledAt).toLocaleString();
  const dispatch = occurrence.dispatchStatus === 'failed' ? ` · 未能派发 ${label(occurrence.errorCode)}` : '';
  return `  ${when} ${occurrence.kind === 'manual' ? '（手动）' : ''}${occurrenceStatus[occurrence.report.status] ?? label(occurrence.report.status)}${dispatch}${occurrence.report.summary ? ` · ${label(occurrence.report.summary).slice(0, 120)}` : ''}`;
}
/** Readable key/value lines instead of raw JSON; nested values stay compact. */
function describeFields(heading: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object') return [`${heading}：${String(value)}`];
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return [];
  const show = (item: unknown): string => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      if (row.truncated === true) return `（已截断，${row.characters ?? '?'} 字符）`;
      if (row.type === 'text' && typeof row.characters === 'number') return `文本 ${row.characters} 字符${typeof row.lines === 'number' ? ` · ${row.lines} 行` : ''}`;
      if (row.type === 'array' && typeof row.items === 'number') return `${row.items} 项`;
      return JSON.stringify(item);
    }
    if (typeof item === 'string') return item.includes('\n') ? `\n${item.split('\n').map(line => `    ${line}`).join('\n')}` : item;
    return Array.isArray(item) ? item.map(String).join(', ') : String(item);
  };
  return [`${heading}：`, ...entries.map(([key, item]) => `  ${key}：${show(item)}`)];
}

class Modal implements Component {
  focused = false;
  capturesViewportInput = true;
  constructor(private readonly box: Box, private readonly target: Component, private readonly onEscape?: () => void) {}
  render(width: number) { if ('focused' in this.target) (this.target as Component & { focused: boolean }).focused = this.focused; return this.box.render(width); }
  invalidate() { this.box.invalidate(); }
  handleInput(data: string) { if (this.onEscape && matchesKey(data, Key.escape)) this.onEscape(); else this.target.handleInput?.(data); }
  handleMouse(event: TuiMouseEvent) {
    const result = this.box.handleMouse(event);
    return result ? { handled: true, render: result.render, capture: result.capture } : undefined;
  }
}

export type ApprovalChoice = 'once' | 'task' | 'duty' | 'decline' | 'later';
const approvalLabels: Record<ApprovalChoice, string> = { once: '同意此次', task: '同意，并在此任务内放行同类调用', duty: '同意，并在此定时职责内放行', decline: '拒绝', later: '稍后处理' };
const APPROVAL_PAGE = 10;
/** Pi footer formatTokens. */
export function formatTokens(count: number) {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}
interface UsageTotals { input: number; output: number; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null }
const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: null, cacheWrite: null, reasoning: null });
function addUsage(total: UsageTotals, usage: Record<string, unknown>) {
  const n = (key: string) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && (usage[key] as number) >= 0 ? usage[key] as number : undefined;
  total.input += n('promptTokens') ?? 0; total.output += n('completionTokens') ?? 0;
  const read = n('cachedInputTokens'), write = n('cacheCreationInputTokens'), reasoning = n('reasoningTokens');
  if (read !== undefined) total.cacheRead = (total.cacheRead ?? 0) + read;
  if (write !== undefined) total.cacheWrite = (total.cacheWrite ?? 0) + write;
  if (reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + reasoning;
  return total;
}
/** ↑input ↓output R/W cache, as in Pi's footer; unreported cache fields are omitted, not shown as zero. */
function usageLine(total: UsageTotals) {
  const parts = [`↑${formatTokens(total.input)}`, `↓${formatTokens(total.output)}`];
  if (total.cacheRead !== null) parts.push(`R${formatTokens(total.cacheRead)}`);
  if (total.cacheWrite !== null) parts.push(`W${formatTokens(total.cacheWrite)}`);
  return parts.join(' ');
}
const failureTitles: Record<string, string> = {
  model_execution_failed: '模型请求未完成', context_capacity_exceeded: '上下文超出模型输入预算', model_credentials_unavailable: '模型凭据不可用',
  model_profile_not_found: '模型配置不存在', model_not_found: '供应商没有这个模型', model_provider_unavailable: '模型供应商不可用', step_budget_exhausted: '已达到单次运行的最大步骤数',
  snapshot_failed: '上下文快照保存失败', context_snapshot_failed: '上下文快照保存失败', task_execution_failed: '后台任务执行失败',
};
const failureHints: Record<string, string> = {
  model_execution_failed: '可重发消息；持续失败时用 /status 查看连接，或 /model 换用其他模型。',
  context_capacity_exceeded: '可用 /context 查看估算，在 /sessions 中从已完成轮次分支出新的上下文，或在运行设置中改为“警告并继续”。',
  model_credentials_unavailable: '用 /login 登录供应商，或在 /menu → 凭据 中设置凭据。',
  model_profile_not_found: '用 /model 选择已有配置，或在 /menu → 配置模型 中新建。', model_not_found: '用 /model 选择其他模型。',
  model_provider_unavailable: '用 /login 检查供应商登录状态。', step_budget_exhausted: '可补充说明后继续，或在 /menu → 运行设置 调高最大步骤数。',
};
function approvalError(error: unknown) {
  const code = error instanceof AppError ? error.code : 'request_failed';
  return ({ approval_not_active: '该请求已失效（运行已结束或已被处理）', approval_not_pending: '该请求已被处理', approval_target_changed: '目标配置已变化，请在新的请求中重新审批', approval_scope_not_available: '所选授权范围不适用于此请求' } as Record<string, string>)[code] ?? label(code);
}
/** One-line summary of what the tool will touch, for the prompt title. */
export function approvalTarget(args: unknown) {
  if (!args || typeof args !== 'object') return '';
  const row = args as Record<string, unknown>;
  for (const key of ['command', 'path', 'url', 'query', 'paths', 'directory', 'pattern']) {
    const value = row[key]; if (value === undefined) continue;
    return Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return '';
}
/**
 * Pure key dispatch for the approval prompt (after Hermes prompts.tsx approvalAction): digits pick,
 * Enter confirms, ↑↓ move, v pages a long request. Esc postpones instead of denying: a decline here is final.
 */
export function approvalKey(data: string, selected: number, options: readonly ApprovalChoice[]): { kind: 'choose'; choice: ApprovalChoice } | { kind: 'move'; delta: -1 | 1 } | { kind: 'page' } | { kind: 'noop' } {
  if (matchesKey(data, Key.escape)) return { kind: 'choose', choice: 'later' };
  if (/^[1-9]$/.test(data) && Number(data) <= options.length) return { kind: 'choose', choice: options[Number(data) - 1]! };
  if (matchesKey(data, Key.enter)) return { kind: 'choose', choice: options[selected]! };
  if (data === 'v' || data === 'V') return { kind: 'page' };
  if (matchesKey(data, Key.up) && selected > 0) return { kind: 'move', delta: -1 };
  if (matchesKey(data, Key.down) && selected < options.length - 1) return { kind: 'move', delta: 1 };
  return { kind: 'noop' };
}
class ApprovalPrompt implements Component {
  focused = false; selected = 0; page = 0;
  constructor(private readonly title: string, private readonly body: string[], readonly options: readonly ApprovalChoice[], private readonly done: (choice: ApprovalChoice) => void, private readonly redraw: () => void) {}
  invalidate() {}
  render(width: number) {
    const inner = Math.max(20, width - 4);
    const wrapped = this.body.flatMap(line => wrapTextWithAnsi(line, inner));
    const pages = Math.max(1, Math.ceil(wrapped.length / APPROVAL_PAGE)); const start = (this.page % pages) * APPROVAL_PAGE;
    const lines = [theme.fg('warning', theme.bold(truncateToWidth(this.title, inner))), ...wrapped.slice(start, start + APPROVAL_PAGE).map(line => `  ${line}`)];
    if (pages > 1) lines.push(theme.fg('warning', `  第 ${start + 1}–${Math.min(wrapped.length, start + APPROVAL_PAGE)} 行，共 ${wrapped.length} 行 · v 翻页`));
    lines.push('');
    this.options.forEach((option, index) => {
      const text = `${index === this.selected ? '▸ ' : '  '}${index + 1}. ${approvalLabels[option]}`;
      lines.push(index === this.selected ? theme.fg('accent', text) : theme.fg(option === 'decline' ? 'error' : 'muted', text));
    });
    lines.push(theme.fg('dim', `↑↓ 选择 · Enter 确认 · 1-${this.options.length} 快选 · Esc 稍后处理`));
    const border = theme.fg('warning', '│');
    return [theme.fg('warning', `╭${'─'.repeat(Math.max(0, width - 2))}╮`), ...lines.map(line => `${border} ${truncateToWidth(line, width - 4, '…', true)} ${border}`), theme.fg('warning', `╰${'─'.repeat(Math.max(0, width - 2))}╯`)];
  }
  handleInput(data: string) {
    const action = approvalKey(data, this.selected, this.options);
    if (action.kind === 'choose') this.done(action.choice);
    else if (action.kind === 'move') { this.selected += action.delta; this.redraw(); }
    else if (action.kind === 'page') { this.page++; this.redraw(); }
  }
}

/** Interactive terminal client. Only server-authorized messages are rendered in the transcript. */
export class TerminalApp {
  private readonly ui: TuiAltScreen;
  private readonly transcript = new Container();
  private readonly scroll = new ScrollView(this.transcript, { follow: 'end', primary: true, scrollbar: 'auto' });
  private readonly header = new Text('', 1, 0);
  private readonly footer = new Text('', 1, 0);
  private readonly queuePreview = new Container();
  private readonly userRows = new Map<string, { view: Text; status: string }>();
  private activeTasks = 0;
  private readonly taskStates = new Map<string, string>();
  private tasksLoaded = false;
  private taskVersion = 0;
  /** Hermes-style "N background tasks running" plus one line when a task this client saw running ends. */
  private async refreshTasks() {
    const version = ++this.taskVersion;
    try {
      const { tasks } = await this.request<{ tasks: TaskRecord[] }>('/tasks', { signal: this.lifetime.signal });
      if (this.stopped || version !== this.taskVersion) return;
      const active = ['pending', 'running', 'waiting', 'pausing', 'cancelling'];
      const ended: Record<string, [string, 'success' | 'error' | 'warning' | 'muted']> = { succeeded: ['已完成', 'success'], failed: ['失败', 'error'], blocked: ['受阻', 'warning'], cancelled: ['已取消', 'muted'], interrupted: ['已中断', 'warning'], unreported: ['结束但未报告结果', 'warning'], paused: ['已暂停', 'warning'] };
      for (const task of tasks) {
        const before = this.taskStates.get(task.id);
        if (this.tasksLoaded && before && active.includes(before) && ended[task.status]) {
          const [text, tone] = ended[task.status]!;
          this.transcript.addChild(new Text(theme.fg(tone, `后台任务${text}：${label(task.title)}`) + theme.fg('dim', ' · /tasks 查看'), 1, 0));
        }
        this.taskStates.set(task.id, task.status);
      }
      this.tasksLoaded = true;
      this.activeTasks = tasks.filter(task => active.includes(task.status)).length; this.status(this.statusText);
    } catch { /* Task list is informational here. */ }
  }
  private pendingApprovals: ApprovalRecord[] = [];
  private readonly postponedApprovals = new Set<string>();
  private approvalOpen?: string;
  private approvalVersion = 0;
  private approvalDeferred = false;
  private async refreshApprovals() {
    const version = ++this.approvalVersion;
    try {
      const { approvals } = await this.request<{ approvals: ApprovalRecord[] }>('/approvals', { signal: this.lifetime.signal });
      if (this.stopped || version !== this.approvalVersion) return;
      this.pendingApprovals = approvals.filter(row => row.status === 'pending');
      for (const id of this.postponedApprovals) if (!this.pendingApprovals.some(row => row.id === id)) this.postponedApprovals.delete(id);
      if (this.approvalOpen && !this.pendingApprovals.some(row => row.id === this.approvalOpen)) this.pendingModal?.();
      this.status(this.statusText); void this.presentApproval();
    } catch { /* The stream reports connection state; a later state event retries. */ }
  }
  /** Open the oldest unhandled approval, but never over another dialog or a half-typed message. */
  private async presentApproval() {
    if (this.stopped || !this.started || this.approvalOpen || this.ui.hasOverlay()) return;
    if (this.editor.getText().trim()) { this.approvalDeferred = true; return; }
    // Current context first, then background work in arrival order: delegated tasks wait on the user here.
    const open = this.pendingApprovals.filter(row => !this.postponedApprovals.has(row.id)).sort((a, b) => Number(b.contextId === this.contextId) - Number(a.contextId === this.contextId) || a.createdAt.localeCompare(b.createdAt));
    const approval = open[0];
    if (!approval) return;
    this.approvalOpen = approval.id;
    try { await this.decideApproval(approval); }
    catch (error) { if (!this.stopped) this.note(`审批未完成：${approvalError(error)}`); }
    finally { this.approvalOpen = undefined; }
    void this.presentApproval();
  }
  private async decideApproval(approval: ApprovalRecord) {
    const task = approval.taskId ? await this.request<TaskRecord>(`/tasks/${routeId(approval.taskId)}`).catch(() => undefined) : undefined;
    this.approvalDeferred = false;
    const options: ApprovalChoice[] = ['once', ...(task ? ['task' as const] : []), ...(task?.occurrenceId ? ['duty' as const] : []), 'decline', 'later'];
    const target = approvalTarget(approval.args);
    const body = [
      theme.fg('muted', `上下文 ${label(approval.contextId)}${task ? ` · 任务 ${label(task.title)}` : ''}`),
      ...(target ? [theme.fg('text', safeTerminalText(target))] : []),
      theme.fg('dim', '完整参数：'),
      ...safeTerminalText(JSON.stringify(approval.args, null, 2) ?? '').split('\n').map(line => theme.fg('toolOutput', line)),
    ];
    const choice = await this.approvalPrompt(`需要审批 · ${label(approval.toolName)}`, body, options);
    if (!choice || choice === 'later') { this.postponedApprovals.add(approval.id); this.note(`已暂缓审批 ${label(approval.toolName)}；/approvals 可随时处理。`); this.status(this.statusText); return; }
    const decision = choice === 'decline' ? 'decline' : 'approve';
    const scope = choice === 'decline' ? 'once' : choice;
    await this.write(`/approvals/${routeId(approval.id)}`, { decision, scope });
    this.pendingApprovals = this.pendingApprovals.filter(row => row.id !== approval.id);
    this.note(decision === 'approve' ? `已同意 ${label(approval.toolName)}${scope === 'once' ? '' : `（${approvalLabels[choice].replace(/^同意，并/, '')}）`}。` : `已拒绝 ${label(approval.toolName)}。`);
    this.status(this.statusText);
  }
  private approvalPrompt(title: string, body: string[], options: readonly ApprovalChoice[]): Promise<ApprovalChoice | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let handle: OverlayHandle;
      const finish = (value?: ApprovalChoice) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); };
      const cancel = () => finish(); this.pendingModal = cancel;
      const prompt = new ApprovalPrompt(title, body, options, finish, () => this.ui.requestRender());
      handle = this.overlays.openOverlay(prompt, { width: '90%', maxHeight: '80%', margin: 1 });
    });
  }
  private model?: { profileId: string; name: string; modelId: string | null; thinkingLevel: string | null; source: 'session' | 'profile' | 'provider-default'; unavailable?: string | null; configuredProfiles?: number; providerId?: string | null };
  private guidanceShown = new Set<string>();
  private modelVersion = 0;
  private async refreshModel() {
    const context = this.contextId; const version = ++this.modelVersion;
    try {
      const state = await this.request<NonNullable<TerminalApp['model']>>(`/contexts/${routeId(context)}/model`, { signal: this.contextController.signal });
      if (this.stopped || context !== this.contextId || version !== this.modelVersion) return;
      this.model = state; this.editor.borderColor = text => theme.thinking(state.thinkingLevel ?? 'off', text); this.status(this.statusText);
      if (state.unavailable && this.isMainContext && !this.guidanceShown.has(context)) { this.guidanceShown.add(context); this.modelGuidance(); }
    } catch { /* Older cores have no model endpoint; the footer simply omits the model. */ }
  }
  /** Shown once per context when the selected model cannot be used (Pi auth-guidance). */
  private modelGuidance() {
    const code = this.model?.unavailable ?? '';
    const none = !this.model?.configuredProfiles;
    this.transcript.addChild(new Spacer(1));
    const provider = this.model?.providerId ? label(this.model.providerId) : '';
    this.transcript.addChild(new Text(theme.fg('warning', theme.bold(none ? '还没有可用的模型' : code === 'model_credentials_unavailable' && provider ? `${provider} 尚未登录或凭据已失效` : `当前模型不可用：${failureTitles[code] ?? label(code)}`)), 1, 0));
    this.transcript.addChild(new Text(theme.fg('muted', [
      ...(code === 'model_credentials_unavailable' && provider ? [`  /login   重新登录 ${provider}`] : []),
      '  /login   登录供应商（OAuth 或 API key）',
      '  /menu → 配置模型   添加 Chat Completions / Responses / Messages 接口',
      '  /model   选择已配置的模型',
      '也可以在 .env 中设置 SHITTIMCHEST_MODEL_* 后重启核心。',
    ].join('\n')), 1, 0));
    this.ui.requestRender();
  }
  /** Ctrl+P, as in Pi: next configured model for this context; the session thinking override is kept when supported. */
  private async cycleModel() {
    if (!this.isMainContext) { this.note('当前上下文无法切换模型。'); return; }
    const { models } = await this.request<{ models: Array<{ id: string; name: string }> }>('/models');
    if (models.length < 2) { this.note(models.length ? '只有一个已配置的模型。' : '还没有已配置的模型；/login 或 /menu → 配置模型。'); return; }
    const index = models.findIndex(row => row.id === this.model?.profileId);
    const next = models[(index + 1) % models.length]!;
    await this.write(`/contexts/${routeId(this.contextId)}/model`, { profileId: next.id });
    await this.refreshModel(); this.note(`已切换到 ${label(next.name)}${this.model?.thinkingLevel ? `（思考：${label(this.model.thinkingLevel)}）` : ''}，用于后续请求。`);
  }
  /** Shift+Tab, as in Pi: step through the levels the current model supports and apply to later requests. */
  private async cycleThinking() {
    if (!this.model || !this.isMainContext) { this.note('当前上下文无法切换思考等级。'); return; }
    const { models } = await this.request<{ models: Array<{ id: string; modelId: string; providerId?: string; thinking?: Record<string, unknown> }> }>('/models');
    const profile = models.find(row => row.id === this.model!.profileId);
    let levels = Object.keys(profile?.thinking ?? {});
    if (profile?.providerId) {
      const catalog = await this.request<{ models: Array<{ modelId: string; thinkingLevels?: string[] }> }>(`/provider-models?provider=${routeId(profile.providerId)}`);
      levels = catalog.models.find(entry => entry.modelId === profile.modelId)?.thinkingLevels ?? [];
    }
    levels = supportedLevels(levels);
    if (levels.length < 2) { this.note('当前模型不支持切换思考等级。'); return; }
    const current = this.model.thinkingLevel ?? 'off';
    const next = levels[(levels.indexOf(current) + 1) % levels.length]!;
    await this.write(`/contexts/${routeId(this.contextId)}/model`, { profileId: this.model.profileId, thinkingLevel: next });
    await this.refreshModel(); this.note(`思考等级：${next}（用于后续请求）`);
  }
  private setUserState(row: { view: Text; status: string }, status: string) {
    if (row.status === status) return;
    row.status = status; row.view.setText(userMessageState(status)); this.ui.requestRender();
  }
  private editor: Editor;
  private readonly editors = new Map<string, Editor>();
  private readonly seededHistory = new Set<string>();
  private readonly completionBase: string;
  private readonly completionFdPath?: string;
  private readonly clipboard?: NativeClipboard;
  private overlays: ReturnType<typeof createOverlayHandlers>;
  private contextId: string;
  private currentRunId?: string;
  private queueCount = 0;
  private queueRefreshVersion = 0;
  private statusText = '连接中';
  private usageText = '';
  private capacityText = '';
  private isMainContext = false;
  private contextRole?: ContextRole;
  private workingSet?: ContextRecord['workingSet'];
  private contextReady = false;
  private cursor = 0;
  private storageId = '';
  private instanceId = '';
  private readonly lifetime = new AbortController();
  private capabilities = new Set<string>();
  private contextController = new AbortController();
  private streamController?: AbortController;
  private seen = new Set<string>();
  private readonly drafts = new Map<string, { view: Container; body: Markdown; text: string; signalId: string }>();
  private readonly toolCards = new Map<string, ToolCard>();
  private generation = 0;
  private stopped = false;
  private started = false;
  private stopTask?: Promise<void>;
  private externalTask?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private pendingModal?: () => void;
  private failedSubmission?: { id: string; text: string; context: string; mode?: 'queue' | 'steer'; expectedRunId?: string; attachmentIds: string[] };
  private readonly pendingAttachments = new Map<string, AssetInfo[]>();
  private readonly visibleAttachments = new Map<string, Set<string>>();
  private readonly lastAssistant = new Map<string, string>();
  private readonly uncertainWrites = new Map<string, string>();
  private readonly onSignal = () => { void this.stop(); };
  private done!: () => void;
  private readonly completion = new Promise<void>(resolve => { this.done = resolve; });

  constructor(private readonly client: Client, contextId = 'main', terminal: Terminal = new ProcessTerminal(), options: { completionBase?: string; fdPath?: string; clipboard?: NativeClipboard; theme?: Theme } = {}) {
    applyTheme(options.theme ?? (terminal instanceof ProcessTerminal && colorEnabled() ? new Theme(detectAppearance()) : plainTheme));
    this.contextId = contextId;
    this.clipboard = options.clipboard;
    this.ui = new TuiAltScreen(terminal, true, undefined, { mouse: true, copyOnSelect: false, copySelection: async text => {
      const clipboard = this.clipboard ?? getNativeClipboard(); if (!clipboard?.setText) return '剪贴板不可用';
      try { await clipboard.setText(text); return true; } catch { return '复制失败'; }
    } });
    this.completionBase = options.completionBase ?? process.cwd(); this.completionFdPath = options.fdPath ?? findFd();
    this.editor = this.createEditor(); this.editors.set(contextId, this.editor);
    this.overlays = createOverlayHandlers(this.ui, this.editor);
    this.mountEditor();
    this.ui.addInputListener(data => {
      if (this.ui.hasOverlay()) return undefined;
      if (matchesKey(data, Key.ctrl('g'))) { void this.externalEditor().catch(error => { if (!this.stopped) this.note(`外部编辑器失败：${label(error instanceof AppError ? error.code : 'editor_failed')}`); }); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('v')) && this.capabilities.has('attachments')) { void this.clipboardPaste(); return { consume: true }; }
      if (matchesKey(data, Key.ctrlShift('c')) || matchesKey(data, Key.ctrl('x'))) { void this.copySelectionOrLast(); return { consume: true }; }
      // Same defaults as Pi: Alt+Enter queues a follow-up, Alt+Up restores queued input (Ctrl+Q / Alt+Q where Alt is taken).
      if (!this.editor.isShowingAutocomplete() && (matchesKey(data, Key.alt('enter')) || matchesKey(data, Key.ctrl('q')))) { void this.followUp(); return { consume: true }; }
      if (matchesKey(data, Key.alt('up')) || matchesKey(data, Key.alt('q'))) { void this.restoreQueue(); return { consume: true }; }
      if (matchesKey(data, Key.shift('tab')) && !this.editor.isShowingAutocomplete()) { void this.cycleThinking().catch(error => { if (!this.stopped) this.note(`切换失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('o'))) { this.toggleAllTools(); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('p'))) { void this.cycleModel().catch(error => { if (!this.stopped) this.note(`切换失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('l'))) { void this.models().catch(error => { if (!this.stopped) this.note(`操作失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }); return { consume: true }; }
      // Esc stops the running reply (Pi's app.interrupt); with completions open it belongs to the editor.
      if (matchesKey(data, Key.escape) && !this.editor.isShowingAutocomplete() && this.currentRunId && this.isMainContext) { this.stopForeground(); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('d')) && !this.editor.getText()) { void this.stop(); return { consume: true }; }
      if (!matchesKey(data, Key.ctrl('c'))) return undefined;
      if (this.ui.hasActiveSelection()) { void this.copySelection(); return { consume: true }; }
      if (this.editor.getText()) { this.editor.setText(''); this.ui.requestRender(); }
      else if (this.currentRunId && this.isMainContext) this.stopForeground();
      // Idle Ctrl+C asks for a second press within 500 ms, as Pi does, so a stray key never quits.
      else if (Date.now() - this.lastCtrlC < 500) void this.stop();
      else { this.lastCtrlC = Date.now(); this.note('再按一次 Ctrl+C 退出（或 Ctrl+D）。核心会继续运行。'); }
      return { consume: true };
    });
  }

  private createEditor(): Editor {
    const editor = new Editor(this.ui, editorTheme, { paddingX: 1 });
    const commands = tuiCommands.map(command => ({ name: command.name, description: command.description,
      ...(command.completions ? { getArgumentCompletions: (prefix: string) => command.completions!.filter(value => value.startsWith(prefix.toLowerCase())).map(value => ({ value, label: value })) } : {}) }));
    const supported = (name: string) => { const command = tuiCommands.find(entry => entry.name === name); return !command?.capability || this.capabilities.has(command.capability); };
    editor.setAutocompleteProvider(new SafeAutocomplete(new CombinedAutocompleteProvider(commands, this.completionBase, this.completionFdPath), this.completionBase, supported));
    editor.onSubmit = text => { void this.submit(text).finally(() => { if (this.approvalDeferred) void this.presentApproval(); }); };
    editor.onChange = text => { if (!text.trim() && this.approvalDeferred) void this.presentApproval(); };
    return editor;
  }
  private mountEditor() {
    this.ui.setLayoutRoot(new VStack([this.header, { component: this.scroll, grow: 1, minSize: 1 }, this.workingSlot, this.queuePreview, this.footer, this.editor]));
    if (this.started && !this.ui.hasOverlay()) this.ui.setFocus(this.editor);
  }
  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('terminal_required');
    process.on('SIGINT', this.onSignal); process.on('SIGTERM', this.onSignal);
    try {
      const handshake = protocolHandshakeSchema.safeParse(await this.client.handshake(this.contextController.signal));
      if (this.stopped) return;
      if (!handshake.success || !['snapshot', 'event-stream', 'conversation-history', 'reply-stream'].every(capability => handshake.data.capabilities.includes(capability))) throw new AppError('incompatible_core_protocol');
      this.capabilities = new Set(handshake.data.capabilities);
      this.ui.setFocus(this.editor); this.started = true; this.ui.start();
      this.status('连接中'); void this.loadContext(this.generation);
      await this.completion;
    } catch (error) { if (!this.stopped) throw error; }
    finally { await this.stop(); }
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.working?.stop(); this.working = undefined;
    this.lifetime.abort(); this.contextController.abort(); this.streamController?.abort();
    this.pendingModal?.(); process.removeListener('SIGINT', this.onSignal); process.removeListener('SIGTERM', this.onSignal);
    this.stopTask = (async () => {
      try { await this.externalTask?.catch(() => {}); if (this.started) await this.ui.terminal.drainInput(1000); }
      finally { if (this.started) this.ui.stop(); this.done(); }
    })();
    return this.stopTask;
  }
  private status(text: string) {
    this.statusText = text;
    this.header.setText(`${theme.fg('accent', theme.bold('ShittimChest'))}${theme.fg('dim', '  ·  ')}${label(this.contextId)}${this.contextRole && this.contextRole !== 'main' ? theme.fg('warning', ' · 只读工作上下文') : ''}${this.workingSet ? theme.fg('muted', ' · 派生工作集') : ''}`);
    const attachmentCount = this.pendingAttachments.get(this.contextId)?.length ?? 0;
    const tone = /错误|失败|断开/.test(text) ? 'error' : /处理中|连接中|重连/.test(text) ? 'warning' : 'success';
    const model = this.model ? `${label(this.model.name)} • ${this.model.thinkingLevel ? label(this.model.thinkingLevel) : '思考：供应商默认'}` : '';
    const parts = [theme.fg(tone, label(text)), this.capacityText, this.usageText && theme.fg('dim', this.usageText), this.queueCount ? theme.fg('warning', `队列 ${this.queueCount}`) : '', attachmentCount ? theme.fg('dim', `待发送附件 ${attachmentCount}`) : '', this.pendingApprovals.length ? theme.fg('warning', `待审批 ${this.pendingApprovals.length}`) : '', this.activeTasks ? theme.fg('muted', `后台任务 ${this.activeTasks}`) : '', model && theme.thinking(this.model?.thinkingLevel ?? 'off', model)].filter(Boolean);
    this.footer.setText(`${parts.join(theme.fg('dim', '  ·  '))}\n${theme.fg('dim', '/help 命令  /menu 管理  /quit 退出  ·  Shift+Tab 思考等级  ·  PageUp/PageDown 浏览')}`);
    this.ui.requestRender();
  }
  private note(text: string) { this.transcript.addChild(new Text(theme.fg('muted', safeTerminalText(text)), 1, 0)); this.ui.requestRender(); }
  private message(message: ConversationMessage) {
    if (message.contextId !== this.contextId || this.seen.has(message.id)) return;
    if (message.role !== 'user' && message.role !== 'assistant') return;
    this.seen.add(message.id);
    if (message.role === 'assistant' && message.status === 'committed') this.lastAssistant.set(message.contextId, message.content);
    if (message.originContextId) this.transcript.addChild(new Text(`来自上下文 ${label(message.originContextId)}`, 1, 0));
    const row = new Container();
    if (message.role === 'user') {
      row.addChild(new UserMessageComponent(safeTerminalText(message.content), markdownTheme, 1, [], undefined, undefined, { color: text => theme.fg('userMessageText', text), bgColor: text => theme.bg('userMessageBg', text) }));
      const state = { view: new Text(userMessageState(message.status), 1, 0), status: message.status }; row.addChild(state.view);
      if (message.id.startsWith('signal:')) this.userRows.set(message.id.slice(7), state);
      this.transcript.addChild(row);
    }
    else {
      this.transcript.addChild(new Spacer(1));
      this.transcript.addChild(new Text(theme.fg('accent', theme.bold(message.kind === 'artifact' ? '交付' : '阿罗娜')), 1, 0));
      this.transcript.addChild(new Markdown(safeTerminalText(message.content), 1, 0, markdownTheme));
      if (message.attachments?.length) this.transcript.addChild(row);
    }
    if (message.attachments?.length) this.showAttachmentMetadata(row, message.attachments, message.contextId);
    this.ui.requestRender();
  }
  private showAttachmentMetadata(row: Container, ids: string[], contextId: string) {
    const visible = this.visibleAttachments.get(contextId) ?? new Set<string>();
    for (const id of ids.slice(0, 8)) {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) continue;
      visible.add(id); row.addChild(new Text(`附件 · ${label(id)}`, 1, 0));
    }
    this.visibleAttachments.set(contextId, visible);
  }
  private async loadContext(generation: number) {
    if (this.stopped || generation !== this.generation) return;
    this.contextReady = false;
    try {
      const context = this.contextId;
      const snapshot = await this.client.snapshot(context, this.contextController.signal);
      if (this.stopped || generation !== this.generation) return;
      if (snapshot.protocolVersion !== 1 || snapshot.selectedContextId !== context || !Number.isSafeInteger(snapshot.watermark)) throw new AppError('invalid_core_response');
      const storageChanged = !!this.storageId && this.storageId !== snapshot.storageId;
      const discardedAttachments = storageChanged && [...this.pendingAttachments.values()].some(items => items.length);
      if (storageChanged) {
        this.pendingAttachments.clear(); this.visibleAttachments.clear(); this.lastAssistant.clear(); this.failedSubmission = undefined; this.usageText = '';
        const draft = this.editor.getText(); this.editors.clear(); this.seededHistory.clear(); this.editor = this.createEditor(); this.editor.setText(draft); this.editors.set(context, this.editor);
        this.overlays = createOverlayHandlers(this.ui, this.editor); this.mountEditor();
      }
      this.storageId = snapshot.storageId; this.instanceId = snapshot.instanceId; this.cursor = snapshot.watermark;
      const selectedContext = snapshot.contexts?.find(item => item.id === context);
      this.contextRole = selectedContext?.role; this.workingSet = selectedContext?.workingSet;
      this.isMainContext = this.contextRole === 'main';
      this.queueCount = snapshot.queuedMessages?.length ?? 0;
      this.updateCapacity(snapshot.capacity ?? null);
      void this.refreshModel(); void this.refreshUsage();
      this.pendingApprovals = ((snapshot.approvals ?? []) as ApprovalRecord[]).filter(row => row.status === 'pending');
      this.currentRunId = snapshot.runs?.find(run => run.status === 'running')?.id; if (this.currentRunId) this.runStartedAt = Date.parse(snapshot.runs!.find(run => run.id === this.currentRunId)!.createdAt) || Date.now();
      this.updateWorking();
      this.seen.clear(); this.drafts.clear(); this.toolCards.clear(); this.visibleAttachments.delete(context); this.lastAssistant.delete(context); this.transcript.clear();
      if (discardedAttachments) this.note('核心存储已变化，之前待发送的附件已清除，请重新选择。');
      let page: ConversationPage = snapshot.conversation; const history: string[] = []; const messages: ConversationMessage[] = [];
      for (;;) {
        for (const message of page.messages) {
          messages.push(message);
          if (!this.seededHistory.has(context) && message.role === 'user' && message.kind === 'message' && ['accepted', 'queued'].includes(message.status) && message.content.trim()) history.push(message.content);
        }
        if (!page.hasMore) break;
        if (!page.nextCursor) throw new AppError('invalid_history_cursor');
        const previous = page.nextCursor;
        page = await this.client.conversation(context, previous, this.contextController.signal);
        if (this.stopped || generation !== this.generation) return;
        if (page.hasMore && page.nextCursor === previous) throw new AppError('history_pagination_stalled');
      }
      const timeline: Array<{ at: string; order: number; message?: ConversationMessage; tool?: ToolActivity }> = messages.map((message, order) => ({ at: message.createdAt ?? '', order, message }));
      for (const item of snapshot.toolActivity ?? []) {
        if (!item || typeof item !== 'object') continue;
        const tool = item as ToolActivity;
        if (tool.contextId === context && typeof tool.toolCallId === 'string' && tool.toolCallId && typeof tool.toolName === 'string' && ['running', 'finished', 'failed', 'denied'].includes(tool.state)) timeline.push({ at: tool.startedAt ?? '', order: timeline.length, tool });
      }
      timeline.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
      for (const entry of timeline) { if (entry.message) this.message(entry.message); else if (entry.tool) this.updateTool(entry.tool); }
      for (const draft of snapshot.drafts ?? []) {
        if (!draft || typeof draft !== 'object') throw new AppError('invalid_reply_event');
        const restored = draft as { runId?: unknown; text?: unknown };
        if (typeof restored.runId !== 'string' || typeof restored.text !== 'string') throw new AppError('invalid_reply_event');
        const event = { seq: snapshot.watermark, contextId: context, runId: restored.runId, createdAt: '', data: draft };
        this.replyEvent({ ...event, kind: 'reply.start' }); this.replyEvent({ ...event, kind: 'reply.replace' });
      }
      if (!this.seededHistory.has(context)) { for (const value of history.slice(-100)) this.editor.addToHistory(value); this.seededHistory.add(context); }
      this.contextReady = true;
      void this.presentApproval(); void this.refreshTasks();
      this.status('已连接'); void this.refreshQueue(); void this.connectStream(generation);
    } catch {
      if (this.stopped || generation !== this.generation) return;
      this.status('连接暂不可用，正在重试'); this.timer = setTimeout(() => void this.loadContext(generation), 2000);
    }
  }
  private updateCapacity(capacity: ContextCapacity | null) {
    if (!capacity) { this.capacityText = ''; return; }
    if (!Number.isFinite(capacity.estimatedInputTokens) || capacity.estimatedInputTokens < 0 || (capacity.availableInputTokens !== null && (!Number.isFinite(capacity.availableInputTokens) || capacity.availableInputTokens < 0))) throw new AppError('invalid_capacity');
    const used = capacity.lastReportedInputTokens ?? capacity.estimatedInputTokens;
    if (capacity.availableInputTokens === null || capacity.availableInputTokens === 0) { this.capacityText = `上下文 ~${formatTokens(used)}/?`; return; }
    const percent = used / capacity.availableInputTokens * 100;
    const text = `上下文 ${capacity.lastReportedInputTokens === undefined ? '~' : ''}${percent.toFixed(1)}%/${formatTokens(capacity.availableInputTokens)}${capacity.overBudget ? (capacity.blockedBeforeProvider ? ' 已阻止' : ' 超出') : ''}`;
    this.capacityText = percent > 90 || capacity.overBudget ? theme.fg('error', text) : percent > 70 ? theme.fg('warning', text) : text;
  }
  private updateTool(data: ToolActivity) {
    if (data.contextId !== this.contextId || typeof data.toolCallId !== 'string' || !data.toolCallId || typeof data.toolName !== 'string' || !['running', 'finished', 'failed', 'denied'].includes(data.state)) throw new AppError('invalid_tool_event');
    const key = JSON.stringify([data.contextId, data.runId, data.toolCallId]);
    const existing = this.toolCards.get(key);
    if (existing) existing.update({ ...data, toolName: data.toolName || existing.data.toolName });
    else { const card = new ToolCard(data, () => this.ui.requestRender()); this.toolCards.set(key, card); this.transcript.addChild(card.region); }
    this.ui.requestRender();
  }
  private event(event: PublicEvent) {
    // Approvals are global: the footer counts every context and the prompt opens when you enter it.
    if (event.kind === 'state' && (event.data as { area?: string } | undefined)?.area === 'approvals') { void this.refreshApprovals(); return; }
    if (event.kind === 'state' && (event.data as { area?: string } | undefined)?.area === 'tasks') { void this.refreshTasks(); return; }
    if (event.contextId !== this.contextId) return;
    if (event.kind === 'conversation') {
      const message = event.data as ConversationMessage & { replyDraftId?: string };
      if (message.role === 'assistant' && typeof message.replyDraftId === 'string' && event.runId) {
        const key = JSON.stringify([event.runId, message.replyDraftId]); const draft = this.drafts.get(key);
        if (draft) { this.transcript.removeChild(draft.view); this.drafts.delete(key); }
      }
      this.message(message);
    }
    else if (event.kind.startsWith('reply.')) this.replyEvent(event);
    else if (event.kind === 'run') {
      const data = event.data as { state?: string; reason?: string };
      if (data.state === 'running' && event.runId) { this.currentRunId = event.runId; this.runStartedAt = Date.now(); }
      else if (data.state === 'ended' && event.runId === this.currentRunId) this.currentRunId = undefined;
      if (data.state === 'ended' && data.reason === 'aborted') this.transcript.addChild(new Text(theme.fg('warning', '已停止当前回复。已经发生的工具操作不会自动撤销。'), 1, 0));
      if (data.state === 'ended' && data.reason === 'error' && !this.failureShown.has(event.runId ?? '')) this.failure('model_execution_failed', event.runId);
      this.updateWorking();
      this.status(data.state === 'running' ? '处理中' : `已连接${data.reason === 'error' ? ' · 运行失败' : ''}`);
    } else if (event.kind === 'tool') {
      const data = event.data as Omit<ToolActivity, 'contextId' | 'runId'>;
      this.updateTool({ ...data, contextId: event.contextId, runId: event.runId });
      this.status(`工具 ${label(data.toolName)} · ${label(data.state)}`);
    } else if (event.kind === 'capacity') {
      this.updateCapacity(event.data as ContextCapacity); this.status(this.statusText);
    } else if (event.kind === 'usage') {
      // Each event is one model step; the footer shows the context's running total.
      if (event.data && typeof event.data === 'object') { addUsage(this.usageTotal, event.data as Record<string, unknown>); this.usageText = usageLine(this.usageTotal); this.status(this.statusText); }
    } else if (event.kind === 'state') {
      const data = event.data as { area?: string };
      if (data?.area === 'message-queue') void this.refreshQueue();
      else if (data?.area === 'approvals') void this.refreshApprovals();
      else if (data?.area === 'tasks') void this.refreshTasks();
      else if (data?.area === 'contexts' || data?.area === 'configuration') void this.refreshModel();
    } else if (event.kind === 'error') { const data = event.data as { code?: string; retryable?: boolean }; this.failure(String(data?.code ?? 'model_execution_failed'), event.runId, data?.retryable); this.status('运行发生错误'); }
  }
  private replyEvent(event: PublicEvent) {
    if (!event.data || typeof event.data !== 'object') throw new AppError('invalid_reply_event');
    const data = event.data as { draftId?: unknown; signalId?: unknown; contextId?: unknown; runId?: unknown; delta?: unknown; text?: unknown; output?: unknown };
    if (typeof data.draftId !== 'string' || typeof data.signalId !== 'string' || typeof data.runId !== 'string' || data.runId !== event.runId || data.contextId !== this.contextId) throw new AppError('invalid_reply_event');
    const key = JSON.stringify([data.runId, data.draftId]);
    if (event.kind === 'reply.start') {
      if (this.drafts.has(key)) return;
      const view = new Container(); const body = new Markdown('', 1, 0, markdownTheme);
      view.addChild(new Spacer(1)); view.addChild(new Text('阿罗娜 · 回复中', 1, 0)); view.addChild(body);
      this.drafts.set(key, { view, body, text: '', signalId: data.signalId }); this.transcript.addChild(view); this.ui.requestRender();
    } else if (event.kind === 'reply.delta') {
      const draft = this.drafts.get(key);
      if (typeof data.delta !== 'string' || !draft || draft.signalId !== data.signalId) throw new AppError('invalid_reply_event');
      draft.text += data.delta; draft.body.setText(safeTerminalText(draft.text)); this.ui.requestRender();
    } else if (event.kind === 'reply.replace') {
      const draft = this.drafts.get(key);
      if (typeof data.text !== 'string' || !draft || draft.signalId !== data.signalId) throw new AppError('invalid_reply_event');
      draft.text = data.text; draft.body.setText(safeTerminalText(draft.text)); this.ui.requestRender();
    } else if (event.kind === 'reply.cancel' || event.kind === 'reply.commit') {
      const draft = this.drafts.get(key);
      if (draft && draft.signalId !== data.signalId) throw new AppError('invalid_reply_event');
      if (event.kind === 'reply.commit') {
        const output = data.output as OutputRecord | undefined;
        if (!output || typeof output.id !== 'string' || output.kind !== 'message' || output.contextId !== this.contextId || output.runId !== data.runId || !Array.isArray(output.signalIds) || !output.signalIds.includes(data.signalId) || typeof output.content !== 'string') throw new AppError('invalid_reply_event');
        if (draft) { this.transcript.removeChild(draft.view); this.drafts.delete(key); }
        this.message({ id: `output:${output.id}`, contextId: output.contextId, role: 'assistant', content: output.content, createdAt: output.createdAt, runId: output.runId, status: 'committed', kind: 'message' });
      } else if (draft) { this.transcript.removeChild(draft.view); this.drafts.delete(key); }
      this.ui.requestRender();
    }
  }
  private renderQueue(rows: Array<Pick<SignalRecord, 'content' | 'attachments'>>) {
    this.queuePreview.clear();
    if (!rows.length) return;
    const shown = rows.slice(0, 3);
    for (const row of shown) this.queuePreview.addChild(new TruncatedText(theme.fg('dim', `排队：${label(row.content) || '（仅附件）'}${row.attachments?.length ? ` · 附件 ${row.attachments.length}` : ''}`), 1, 0));
    if (rows.length > shown.length) this.queuePreview.addChild(new TruncatedText(theme.fg('dim', `…另有 ${rows.length - shown.length} 条`), 1, 0));
    this.queuePreview.addChild(new TruncatedText(theme.fg('dim', '↳ Alt+↑ 撤回并编辑全部排队消息 · /queue 逐条管理'), 1, 0));
  }
  private async refreshQueue() {
    if (!this.capabilities.has('message-queue')) return;
    const context = this.contextId; const version = ++this.queueRefreshVersion;
    try {
      const rows = await this.request<Array<SignalRecord & { revision: number }>>(`/contexts/${routeId(context)}/message-queue`, { signal: this.contextController.signal });
      if (this.stopped || context !== this.contextId || version !== this.queueRefreshVersion) return;
      this.queueCount = rows.length; this.renderQueue(rows);
      const queued = new Set(rows.map(row => row.id));
      for (const [id, row] of this.userRows) {
        if (queued.has(id)) { this.setUserState(row, 'queued'); continue; }
        if (row.status !== 'queued') continue;
        // Left the queue: either started (accepted) or withdrawn; ask once rather than guessing.
        void this.request<SignalRecord>(`/signals/${routeId(id)}`, { signal: this.contextController.signal }).then(signal => {
          if (!this.stopped && context === this.contextId) this.setUserState(row, signal.status);
        }).catch(() => {});
      }
      this.status(this.statusText);
    } catch { /* The current connection state is reported by the stream. */ }
  }
  private async connectStream(generation: number) {
    if (this.stopped || generation !== this.generation) return;
    const controller = new AbortController(); this.streamController = controller;
    try {
      const handshake = protocolHandshakeSchema.safeParse(await this.client.handshake(this.contextController.signal));
      if (this.stopped || generation !== this.generation) return;
      if (!handshake.success || !['snapshot', 'event-stream', 'conversation-history', 'reply-stream'].every(capability => handshake.data.capabilities.includes(capability))) throw new AppError('incompatible_core_protocol');
      this.capabilities = new Set(handshake.data.capabilities);
      if (handshake.data.storageId !== this.storageId || handshake.data.instanceId !== this.instanceId) {
        await this.loadContext(generation); return;
      }
      this.status(this.currentRunId ? '处理中' : '已连接');
      for await (const frame of this.client.events({ after: this.cursor, contextId: this.contextId, signal: controller.signal })) {
        if (this.stopped || generation !== this.generation) return;
        if (frame.type === 'checkpoint') {
          if (frame.storageId !== this.storageId || frame.instanceId !== this.instanceId) { controller.abort(); await this.loadContext(generation); return; }
          if (frame.cursor > this.cursor) this.cursor = frame.cursor;
        } else if (frame.event.seq > this.cursor) {
          this.event(frame.event); this.cursor = frame.event.seq;
        }
      }
      if (!this.stopped && generation === this.generation) { this.status('连接暂不可用，正在重试'); this.timer = setTimeout(() => void this.connectStream(generation), 2000); }
    } catch {
      if (this.stopped || generation !== this.generation || controller.signal.aborted) return;
      this.status('连接暂不可用，正在重试'); this.timer = setTimeout(() => void this.connectStream(generation), 2000);
    }
  }
  private switchContext(contextId: string) {
    this.generation++; if (this.timer) clearTimeout(this.timer); this.contextController.abort(); this.contextController = new AbortController(); this.streamController?.abort();
    this.contextId = contextId;
    this.editor = this.editors.get(contextId) ?? this.createEditor(); this.editors.set(contextId, this.editor);
    this.overlays = createOverlayHandlers(this.ui, this.editor); this.mountEditor();
    this.currentRunId = undefined; this.contextRole = undefined; this.workingSet = undefined; this.contextReady = false; this.isMainContext = false; this.queueCount = 0; this.queuePreview.clear(); this.userRows.clear(); this.model = undefined; this.modelVersion++; this.usageTotal = emptyUsage(); this.usageVersion++; this.working?.stop(); this.working = undefined; this.workingSlot.clear(); this.usageText = ''; this.capacityText = ''; this.queueRefreshVersion++; this.cursor = 0; this.seen.clear(); this.drafts.clear(); this.toolCards.clear(); this.transcript.clear(); this.ui.resetTextSelection();
    this.status('连接中'); void this.loadContext(this.generation);
  }
  private request<T>(route: string, init?: RequestInit) {
    const signal = init?.signal ? AbortSignal.any([this.lifetime.signal, init.signal]) : this.lifetime.signal;
    return this.client.request<T>(route, { ...init, signal });
  }
  private async write(route: string, body: unknown, method = 'POST') {
    const serialized = JSON.stringify(body);
    const retryable = route === '/tasks' || route === '/schedules';
    const fingerprint = retryable ? createHash('sha256').update(JSON.stringify([method, route, serialized])).digest('hex') : '';
    const key = this.uncertainWrites.get(fingerprint) ?? randomUUID();
    try {
      const result = await this.request(route, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: serialized });
      if (retryable) this.uncertainWrites.delete(fingerprint);
      return result;
    } catch (error) {
      if (retryable && (!(error instanceof AppError) || error.status >= 500)) this.uncertainWrites.set(fingerprint, key);
      else if (retryable) this.uncertainWrites.delete(fingerprint);
      throw error;
    }
  }
  private runStartedAt = 0;
  private usageTotal: UsageTotals = emptyUsage();
  private usageVersion = 0;
  private async refreshUsage() {
    const context = this.contextId; const version = ++this.usageVersion;
    try {
      const report = await this.request<{ contexts?: Array<{ contextId: string; usage?: Record<string, unknown> }> }>(`/usage?contextId=${routeId(context)}`, { signal: this.contextController.signal });
      if (this.stopped || context !== this.contextId || version !== this.usageVersion) return;
      const row = report.contexts?.find(item => item.contextId === context);
      this.usageTotal = addUsage(emptyUsage(), row?.usage ?? {}); this.usageText = this.usageTotal.input || this.usageTotal.output ? usageLine(this.usageTotal) : ''; this.status(this.statusText);
    } catch { /* Usage is informational. */ }
  }
  private readonly failureShown = new Set<string>();
  private working?: Loader;
  private readonly workingSlot = new Container();
  /** Spinner with elapsed time while a run is active (Pi WorkingStatusIndicator). */
  private updateWorking() {
    const active = Boolean(this.currentRunId && this.isMainContext);
    if (!active) { this.working?.stop(); this.working = undefined; this.workingSlot.clear(); return; }
    if (!this.working) {
      this.working = new Loader(this.ui, text => theme.fg('accent', text), text => theme.fg('muted', text), '处理中');
      this.workingSlot.clear(); this.workingSlot.addChild(this.working); this.working.start();
      const tick = () => { if (!this.working) return; const seconds = Math.floor((Date.now() - (this.runStartedAt || Date.now())) / 1000); this.working.setMessage(`处理中 ${seconds}s · Esc 停止 · Alt+Enter 排队`); setTimeout(tick, 1000).unref(); };
      tick();
    }
  }
  /** A readable failure line in the transcript with the next step, instead of a bare status flag. */
  private failure(code: string, runId?: string | null, retryable?: boolean) {
    if (runId) { if (this.failureShown.has(runId)) return; this.failureShown.add(runId); }
    const hint = failureHints[code] ?? '';
    this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(new Text(theme.fg('error', `运行失败：${failureTitles[code] ?? label(code)}`), 1, 0));
    if (hint || retryable) this.transcript.addChild(new Text(theme.fg('muted', [hint, retryable ? '这是暂时性错误，可以直接重发。' : ''].filter(Boolean).join(' ')), 1, 0));
    this.ui.requestRender();
  }
  private lastCtrlC = 0;
  private stopForeground() {
    if (!this.currentRunId) return;
    if (this.capabilities.has('foreground-interrupt')) void this.interrupt(this.contextId, this.currentRunId);
    else this.note('服务端不支持停止当前运行。');
  }
  /** Ctrl+O: expand every tool card if any is folded, otherwise fold them all (Pi app.tools.expand). */
  private toggleAllTools() {
    const cards = [...this.toolCards.values()]; if (!cards.length) return;
    const expand = cards.some(card => !card.isExpanded()); for (const card of cards) card.setExpanded(expand);
    this.ui.requestRender();
  }
  private async interrupt(contextId: string, expectedRunId: string) {
    try {
      await this.write(`/contexts/${routeId(contextId)}/interrupt`, { expectedRunId });
      if (!this.stopped && this.contextId === contextId) this.note('已请求停止；已发生的外部操作不会自动撤销。');
    } catch (error) { if (!this.stopped && this.contextId === contextId) this.note(`停止请求失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }
  }
  /** Alt+Enter: queue for the next run while busy, otherwise behave like Enter. */
  private async followUp() {
    const text = this.editor.getExpandedText().trim();
    if (!text && !(this.pendingAttachments.get(this.contextId) ?? []).length) return;
    this.editor.setText('');
    await this.submit(text, this.currentRunId && this.isMainContext && this.capabilities.has('message-queue') ? 'queue' : undefined);
  }
  /** Alt+Up: withdraw every not-yet-started queued message and put the text back in the editor, oldest first. */
  private async restoreQueue() {
    if (!this.capabilities.has('message-queue') || this.contextRole !== 'main') { this.note('当前上下文没有可恢复的队列消息。'); return; }
    const context = this.contextId;
    try {
      const rows = await this.request<Array<SignalRecord & { revision: number }>>(`/contexts/${routeId(context)}/message-queue`, { signal: this.contextController.signal });
      const restored: string[] = []; const kept: string[] = []; let started = 0;
      for (const row of rows) {
        if (row.attachments?.length) { kept.push(row.id); continue; }
        try { await this.write(`/messages/${routeId(row.id)}`, { revision: row.revision }, 'DELETE'); restored.push(row.content); }
        catch (error) { if (error instanceof AppError && ['message_already_started', 'queued_message_not_found', 'revision_conflict'].includes(error.code)) started++; else throw error; }
      }
      if (this.stopped || context !== this.contextId) return;
      if (restored.length) {
        const current = this.editor.getText();
        this.editor.setText([...restored, current].filter(part => part.trim()).join('\n\n'));
      }
      const parts = [restored.length ? `已撤回 ${restored.length} 条队列消息并恢复到输入框` : '没有可恢复的队列消息'];
      if (started) parts.push(`${started} 条已开始执行`);
      if (kept.length) parts.push(`${kept.length} 条带附件，仍留在队列中（可在 /queue 中处理）`);
      this.note(`${parts.join('；')}。`);
    } catch (error) { if (!this.stopped) this.note(`恢复队列失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }
    finally { void this.refreshQueue(); }
  }
  private async submit(text: string, preset?: 'queue' | 'steer') {
    if (this.stopped) return;
    const staged = this.pendingAttachments.get(this.contextId) ?? [];
    if (!text.trim() && !staged.length) return;
    if (!staged.length && /^\/[a-z]/i.test(text.trim())) { await this.command(text.trim()); return; }
    if (!this.contextRole || !this.contextReady) { this.editor.setText(text); this.note('上下文尚未就绪，请等待连接。'); return; }
    if (this.contextRole !== 'main') { this.editor.setText(text); this.note('工作上下文为只读；请通过任务菜单发送补充。'); return; }
    if (this.model?.unavailable) { this.guidanceShown.add(this.contextId); await this.refreshModel(); if (this.model?.unavailable) { this.editor.setText(text); this.modelGuidance(); return; } }
    const context = this.contextId; const observedRunId = this.currentRunId;
    const attachmentIds = staged.map(item => item.id);
    if (attachmentIds.length) {
      const confirm = await this.choose(`确认发送以下附件？\n${staged.map(item => `${label(item.name).slice(0, 60)} · ${label(item.mediaType)} · ${item.bytes} 字节`).join('\n')}`, [{ value: 'no', label: '返回编辑' }, { value: 'yes', label: '发送' }]);
      if (confirm !== 'yes') { if (!this.stopped) this.editor.setText(text); return; }
    }
    let mode: 'queue' | 'steer' | undefined = observedRunId && this.isMainContext && this.capabilities.has('message-queue') ? preset : undefined;
    if (!mode && observedRunId && this.isMainContext && this.capabilities.has('message-queue')) {
      const choice = await this.choose('当前运行尚未结束（Alt+Enter 可直接排队）', [{ value: 'queue', label: '排队：用于下一次运行' }, { value: 'steer', label: '补充：发送到当前运行' }, { value: 'cancel', label: '返回编辑' }]);
      if (choice !== 'queue' && choice !== 'steer') { if (!this.stopped) this.editor.setText(text); return; }
      mode = choice;
    }
    const expectedRunId = mode === 'steer' ? observedRunId : undefined;
    const previous = this.failedSubmission;
    const id = previous?.text === text && previous.context === context && previous.mode === mode && previous.expectedRunId === expectedRunId && JSON.stringify(previous.attachmentIds) === JSON.stringify(attachmentIds) ? previous.id : randomUUID();
    this.editor.disableSubmit = true;
    try {
      const receipt = await this.write('/messages', { id, contextId: context, content: text, ...(attachmentIds.length ? { attachments: attachmentIds } : {}), ...(mode ? { mode } : {}), ...(expectedRunId ? { expectedRunId } : {}) }) as SignalRecord;
      if (receipt.status !== 'accepted' && receipt.status !== 'queued') throw new AppError(receipt.errorCode || 'message_not_accepted', 409);
      this.failedSubmission = undefined;
      if (attachmentIds.length) this.pendingAttachments.set(context, (this.pendingAttachments.get(context) ?? []).filter(item => !attachmentIds.includes(item.id)));
      if (context === this.contextId && !this.stopped) {
        this.editor.addToHistory(text);
        this.message({ id: `signal:${id}`, contextId: context, role: 'user', content: text, createdAt: new Date().toISOString(), runId: null, status: receipt.status, kind: 'message', ...(attachmentIds.length ? { attachments: attachmentIds } : {}) });
        this.status(this.statusText);
        if (receipt.status === 'queued') { this.note('消息已加入队列；Alt+↑ 撤回到输入框，/queue 逐条管理。'); void this.refreshQueue(); }
        else if (mode === 'steer') this.note('补充已发送到当前运行。');
      }
    } catch (error) {
      const uncertain = !(error instanceof AppError) || error.status >= 500 || error.code === 'message_admission_pending';
      this.failedSubmission = uncertain ? { id, text, context, mode, expectedRunId, attachmentIds } : undefined;
      if (!this.stopped) {
        if (context === this.contextId && !this.editor.getText()) this.editor.setText(text);
        else this.note(`未确认的消息（上下文 ${label(context)}）：\n${safeTerminalText(text)}`);
        this.note(`${uncertain ? '提交结果未确认，可用相同内容重试' : '消息未接收'}：${label(error instanceof AppError ? error.code : 'request_failed')}`);
      }
    } finally { this.editor.disableSubmit = false; }
  }
  /** Runs a local slash command. Unknown names are reported locally and never sent to the model. */
  private async command(text: string) {
    const space = text.indexOf(' ');
    const name = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
    const arg = space === -1 ? '' : text.slice(space + 1).trim();
    const entry = tuiCommands.find(command => command.name === name || command.aliases?.includes(name));
    if (!entry) { this.note(`未知命令 /${label(name)}。输入 /help 查看可用命令。`); return; }
    if (entry.capability && !this.capabilities.has(entry.capability)) { this.note(`服务端不支持 /${entry.name}。`); return; }
    try {
      switch (entry.name) {
        case 'quit': await this.stop(); return;
        case 'help': this.note(commandHelp()); return;
        case 'menu': await this.manage(); return;
        case 'new': {
          if (!arg) { await this.createContext(); return; }
          const created = await this.write('/contexts', { name: arg, role: 'main' }) as ContextRecord;
          this.switchContext(created.id); return;
        }
        case 'sessions': {
          if (!arg) { await this.contexts(); return; }
          const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
          const target = contexts.find(context => context.id === arg) ?? contexts.find(context => context.name === arg);
          if (!target) { this.note(`没有找到上下文：${label(arg)}`); return; }
          this.switchContext(target.id); return;
        }
        case 'name': {
          const value = arg || await this.prompt('上下文名称');
          if (!value?.trim()) return;
          await this.write(`/contexts/${routeId(this.contextId)}`, { name: value.trim() }, 'PATCH'); this.note('上下文已更新。'); return;
        }
        case 'fork': {
          const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
          const current = contexts.find(context => context.id === this.contextId);
          if (!current || current.role !== 'main' || current.archived) { this.note('只能从交流上下文分支。'); return; }
          await this.branchContext(current); return;
        }
        case 'tree': await this.contexts(); return;
        case 'model': {
          if (!arg) { await this.models(); return; }
          const { models } = await this.request<{ models: Array<{ id: string; name: string; modelId: string }> }>('/models');
          const target = models.find(model => model.id === arg) ?? models.find(model => model.name === arg || model.modelId === arg);
          if (!target) { this.note(`没有找到模型配置：${label(arg)}`); return; }
          await this.write(`/contexts/${routeId(this.contextId)}/model`, { profileId: target.id }); this.note(`已切换到 ${label(target.name)}，将用于后续请求。`); return;
        }
        case 'think': {
          const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
          const current = contexts.find(context => context.id === this.contextId);
          if (!current) throw new AppError('context_not_found', 404);
          const level = arg.toLowerCase();
          if (!level) { this.note(`用法：/think <${thinkingCommandLevels.join('|')}|default>`); return; }
          if (level !== 'default' && !thinkingCommandLevels.includes(level as typeof thinkingCommandLevels[number])) { this.note(`不支持的思考等级：${label(arg)}`); return; }
          await this.write(`/contexts/${routeId(this.contextId)}/model`, { profileId: current.modelProfile, thinkingLevel: level === 'default' ? null : level });
          this.note(level === 'default' ? '已清除会话覆盖，后续请求使用配置默认。' : `思考等级已设为 ${level}，将用于后续请求。`); return;
        }
        case 'stop': {
          if (!this.currentRunId || !this.isMainContext) { this.note('当前没有可停止的运行。'); return; }
          await this.interrupt(this.contextId, this.currentRunId); return;
        }
        case 'copy': await this.copySelectionOrLast(); return;
        case 'status': this.note(this.statusSummary()); return;
        case 'usage': await this.showUsage(); return;
        case 'context': await this.showCapacity(); return;
        case 'tasks': await this.tasks(); return;
        case 'task': await this.createTask(arg || undefined); return;
        case 'approvals': await this.approvals(); return;
        case 'queue': await this.messageQueue(); return;
        case 'schedules': await this.schedules(); return;
        case 'tools': await this.toolActivity(); return;
        case 'attach': await this.attachments(); return;
        case 'login': await this.providerAuth(arg || undefined); return;
        case 'mcp': await this.mcp(); return;
        case 'memory': await this.memory(); return;
        case 'editor': await this.externalEditor(); return;
      }
    } catch (error) { if (!this.stopped) this.note(`操作失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }
  }
  private statusSummary() {
    return [
      `上下文：${label(this.contextId)}${this.contextRole ? `（${this.contextRole === 'main' ? '交流' : '只读工作上下文'}）` : ''}`,
      `状态：${label(this.statusText)}${this.currentRunId ? ` · 运行 ${label(this.currentRunId)}` : ''}`,
      ...(this.capacityText ? [`容量：${label(this.capacityText)}`] : []),
      ...(this.usageText ? [label(this.usageText)] : []),
      ...(this.queueCount ? [`队列：${this.queueCount} 条待执行`] : []),
      `核心实例：${label(this.instanceId) || '未知'}`,
    ].join('\n');
  }
  private choose(title: string, items: SelectItem[], filter?: (query: string) => string[], preview?: Component): Promise<string | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const safeItems = items.map(item => ({ value: item.value, label: label(item.label) || label(item.value) || '[无名称]', description: item.description === undefined ? undefined : label(item.description) }));
      const list = new SelectList(safeItems, 10, selectTheme);
      const box = new Box(1, 1, s => `\x1b[48;5;236m${s}\x1b[49m`);
      const selector = new SearchSelector(list, safeItems, filter);
      box.addChild(new Text(safeTerminalText(title), 0, 0)); if (preview) box.addChild(preview); box.addChild(new Spacer(1)); box.addChild(selector); box.addChild(new Text('输入搜索  ↑↓ 选择  Enter 确认  Esc 返回', 0, 0));
      const modal = new Modal(box, selector); let handle: OverlayHandle;
      const finish = (value?: string) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); queueMicrotask(() => { void this.presentApproval(); }); };
      const cancel = () => finish(); this.pendingModal = cancel;
      list.onSelect = item => finish(item.value); list.onCancel = cancel;
      handle = this.overlays.openOverlay(modal, { width: '80%', maxHeight: '80%', margin: 1 });
    });
  }
  private prompt(title: string, initial = '', secret = false): Promise<string | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const input = secret ? new SecretInput() : new Input({ prompt: '› ' }); input.setValue(initial);
      const box = new Box(1, 1, s => `\x1b[48;5;236m${s}\x1b[49m`);
      box.addChild(new Text(safeTerminalText(title), 0, 0)); box.addChild(input); box.addChild(new Text('Enter 确认  Esc 返回', 0, 0));
      const modal = new Modal(box, input); let handle: OverlayHandle;
      const finish = (value?: string) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); };
      const cancel = () => finish(); this.pendingModal = cancel; input.onSubmit = value => finish(value); input.onEscape = cancel;
      handle = this.overlays.openOverlay(modal, { width: '80%', maxHeight: '80%', margin: 1 });
    });
  }
  private promptLong(title: string, initial = ''): Promise<string | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const input = new Editor(this.ui, editorTheme, { paddingX: 0 }); input.setText(initial);
      const box = new Box(1, 1, s => `\x1b[48;5;236m${s}\x1b[49m`);
      box.addChild(new Text(safeTerminalText(title), 0, 0)); box.addChild(input); box.addChild(new Text('Enter 确认  Shift+Enter 换行  Esc 返回', 0, 0));
      let handle: OverlayHandle;
      const finish = (value?: string) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); };
      const cancel = () => finish(); this.pendingModal = cancel; input.onSubmit = value => finish(value);
      handle = this.overlays.openOverlay(new Modal(box, input, cancel), { width: '80%', maxHeight: '80%', margin: 1 });
    });
  }
  private async manage() {
    try {
      const required: Record<string, string> = { queue: 'message-queue', 'provider-auth': 'provider-auth', web: 'web-tools', attachments: 'attachments', capacity: 'context-capacity' };
      const action = await this.choose('管理', [
        { value: 'contexts', label: '上下文' }, { value: 'create', label: '新建上下文' },
        { value: 'models', label: '切换模型' }, { value: 'model-create', label: '配置模型' }, { value: 'model-edit', label: '编辑模型配置' }, { value: 'runtime', label: '运行设置' }, { value: 'web', label: '网页搜索设置' },
        { value: 'approvals', label: '审批' }, { value: 'queue', label: '消息队列' }, { value: 'attachments', label: '附件' }, { value: 'tasks', label: '任务' }, { value: 'task-create', label: '新建任务' },
        { value: 'schedules', label: '定时任务' }, { value: 'mcp', label: 'MCP 连接' }, { value: 'workspaces', label: '工作区' }, { value: 'methods', label: '方法' }, { value: 'workflows', label: '工作流' },
        { value: 'memory', label: '记忆' }, { value: 'notifications', label: '待处理通知' }, { value: 'usage', label: '用量' }, { value: 'capacity', label: '上下文容量' }, { value: 'tools', label: '工具活动' }, { value: 'external-editor', label: '外部编辑器' },
        { value: 'credentials', label: '凭据' }, { value: 'provider-auth', label: '供应商登录' },
      ].filter(item => !required[item.value] || this.capabilities.has(required[item.value]!)));
      if (action === 'contexts') await this.contexts();
      else if (action === 'create') await this.createContext();
      else if (action === 'models') await this.models();
      else if (action === 'model-create') await this.createModel();
      else if (action === 'model-edit') await this.editModel();
      else if (action === 'runtime') await this.runtimeSettings();
      else if (action === 'web') await this.webSettings();
      else if (action === 'approvals') await this.approvals();
      else if (action === 'queue') await this.messageQueue();
      else if (action === 'attachments') await this.attachments();
      else if (action === 'tasks') await this.tasks();
      else if (action === 'task-create') await this.createTask();
      else if (action === 'schedules') await this.schedules();
      else if (action === 'mcp') await this.mcp();
      else if (action === 'workspaces') await this.workspaces();
      else if (action === 'methods') await this.methods();
      else if (action === 'workflows') await this.workflows();
      else if (action === 'memory') await this.memory();
      else if (action === 'notifications') await this.notifications();
      else if (action === 'external-editor') await this.externalEditor();
      else if (action === 'tools') await this.toolActivity();
      else if (action === 'usage') await this.showUsage();
      else if (action === 'capacity') await this.showCapacity();
      else if (action === 'credentials') await this.credentials();
      else if (action === 'provider-auth') await this.providerAuth();
    } catch (error) { if (!this.stopped) this.note(`操作失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }
  }
  private async contexts() {
    const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
    const tree = contextTree(contexts);
    const sessions: SessionInfo[] = tree.map(({ context }) => ({ id: context.id, name: context.name, cwd: context.workspaceId ?? '', allMessagesText: context.purpose ?? '', modified: new Date(context.updatedAt ?? 0) }));
    const choice = await this.choose('选择上下文', tree.map(({ context, depth }) => ({ value: context.id, label: `${depth ? `${'│ '.repeat(Math.min(depth - 1, 12))}└─ ` : ''}${context.name || context.id}`, description: `${context.id} · ${context.role === 'main' ? '交流' : '工作'}${context.parentContextId ? ` · 来源 ${context.parentContextId}` : ''}${context.archived ? ' · 已归档' : ''}` })), query => filterAndSortSessions(sessions, query, 'relevance').map(session => session.id));
    if (!choice) return;
    const context = contexts.find(x => x.id === choice); if (!context) return;
    const options: SelectItem[] = [{ value: 'open', label: context.role === 'main' ? '打开对话' : '查看只读历史' }, { value: 'details', label: '查看来源和用途' }, { value: 'rename', label: '重命名' }, { value: 'archive', label: context.archived ? '取消归档' : '归档' }];
    if (context.role === 'main' && !context.archived && this.capabilities.has('context-branch')) options.push({ value: 'branch', label: '从已完成轮次分支' });
    const action = await this.choose(context.name, options);
    if (action === 'open') this.switchContext(choice);
    else if (action === 'details') this.note(`上下文 ${label(context.name)} · ${label(context.role)}\n${safeTerminalText(context.purpose ?? '')}${context.parentContextId ? `\n来源上下文：${label(context.parentContextId)}\n来源运行：${label(context.parentRunId)}` : ''}${context.workingSet ? `\n派生工作集：${label(context.workingSet.fromRunId)} 至 ${label(context.workingSet.throughRunId)}（非摘要，源上下文未修改）` : ''}`);
    else if (action === 'branch') await this.branchContext(context);
    else if (action === 'rename') { const name = await this.prompt('上下文名称', context.name); if (name?.trim()) { await this.write(`/contexts/${routeId(choice)}`, { name: name.trim() }, 'PATCH'); this.note('上下文已更新。'); } }
    else if (action === 'archive') { await this.write(`/contexts/${routeId(choice)}`, { archived: !context.archived }, 'PATCH'); this.note('上下文已更新。'); }
  }
  private async branchContext(source: ContextRecord) {
    const snapshot = await this.client.snapshot(source.id, this.lifetime.signal);
    const known = new Map<string, RunRecord>((snapshot.runs ?? []).map(run => [run.id, run]));
    let page = snapshot.conversation; const referenced = new Set<string>(); const prompts = new Map<string, string>();
    for (;;) {
      for (const message of page.messages) if (message.runId) { referenced.add(message.runId); if (message.role === 'user' && !prompts.has(message.runId)) prompts.set(message.runId, message.content); }
      if (!page.hasMore) break;
      if (!page.nextCursor) throw new AppError('invalid_history_cursor');
      const cursor = page.nextCursor; page = await this.client.conversation(source.id, cursor, this.lifetime.signal);
      if (page.hasMore && page.nextCursor === cursor) throw new AppError('history_pagination_stalled');
    }
    const missing = [...referenced].filter(id => !known.has(id));
    for (let offset = 0; offset < missing.length; offset += 8) {
      const fetched = await Promise.all(missing.slice(offset, offset + 8).map(async id => {
        try { return await this.request<RunRecord>(`/runs/${routeId(id)}`); }
        catch (error) { if (error instanceof AppError && error.status === 404) return undefined; throw error; }
      }));
      for (const run of fetched) if (run) known.set(run.id, run);
    }
    const runs = [...known.values()].filter(run => run.contextId === source.id && run.status === 'succeeded').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!runs.length) { this.note('没有可分支的已成功运行。'); return; }
    // Like Pi /fork: pick a turn by what you said, not by an internal id.
    const turn = (run: RunRecord) => ({ value: run.id, label: label(prompts.get(run.id) ?? '（无用户消息的运行）').slice(0, 120), description: new Date(run.finishedAt ?? run.createdAt).toLocaleString() });
    const sourceRunId = await this.choose('从哪一轮之后分支（含该轮）', runs.map(turn)); if (!sourceRunId) return;
    const scope = await this.choose('派生范围', [{ value: 'full', label: '从最早记录到所选轮次' }, { value: 'range', label: '选择起止轮次的工作集' }]); if (!scope) return;
    let fromRunId: string | undefined;
    if (scope === 'range') {
      fromRunId = await this.choose('选择起始轮次（不得晚于结束轮次）', runs.map(turn));
      if (!fromRunId) return;
    }
    const name = await this.prompt('新对话名称', `${label(source.name)} 分支`); if (!name?.trim()) return;
    const description = scope === 'range' ? '只复制选定的完整轮次作为派生工作集；源上下文原文完整保留。不是摘要或记忆整理，不会继承任务、审批或授权。' : '复制该轮次之前的对话；不会继承在途任务、审批或授权。';
    const confirm = await this.choose(description, [{ value: 'no', label: '返回' }, { value: 'yes', label: '创建分支' }]);
    if (confirm !== 'yes') return;
    const branch = await this.write(`/contexts/${routeId(source.id)}/branch`, { sourceRunId, name: name.trim(), ...(fromRunId ? { fromRunId } : {}) }) as ContextRecord;
    this.switchContext(branch.id);
  }
  private async createContext() {
    const name = await this.prompt('上下文名称'); if (!name?.trim()) return;
    const purpose = await this.prompt('用途（可留空）'); if (purpose === undefined) return;
    const { workspaces } = await this.request<{ workspaces: Array<{ id: string; name?: string; path?: string }> }>('/workspaces');
    const workspaceId = await this.choose('选择工作区', workspaces.map(x => ({ value: x.id, label: x.name ?? x.id, description: x.path })));
    if (!workspaceId) return;
    const created = await this.write('/contexts', { name: name.trim(), purpose, workspaceId, role: 'main' }) as ContextRecord;
    this.switchContext(created.id);
  }
  private async models() {
    const { models } = await this.request<{ models: Array<{ id: string; name: string; modelId: string; providerId?: string; thinking?: Record<string, unknown> }> }>('/models');
    // Pi model selector: current first with ✓, provider badge, fuzzy search.
    const current = this.model?.profileId;
    const ordered = [...models].sort((a, b) => Number(b.id === current) - Number(a.id === current));
    const id = await this.choose('选择模型', ordered.map(x => ({ value: x.id, label: `${x.id === current ? '✓ ' : '  '}${x.name}`, description: `${x.modelId}${x.providerId ? ` [${x.providerId}]` : ''}${x.id === current ? ' · 当前' : ''}` }))); if (!id) return;
    const model = models.find(x => x.id === id)!;
    let levels = Object.keys(model.thinking ?? {});
    if (model.providerId) {
      const catalog = await this.request<{ models: Array<{ modelId: string; thinkingLevels?: string[] }> }>(`/provider-models?provider=${routeId(model.providerId)}`);
      levels = supportedLevels(catalog.models.find(entry => entry.modelId === model.modelId)?.thinkingLevels ?? []);
    }
    const level = await this.choose('选择模式', [{ value: '', label: '保留当前或使用配置默认' }, { value: 'reset', label: '清除会话覆盖，使用配置默认' }, ...levels.map(x => ({ value: x, label: x }))]);
    if (level === undefined) return;
    await this.write(`/contexts/${routeId(this.contextId)}/model`, { profileId: id, ...(level === 'reset' ? { thinkingLevel: null } : level ? { thinkingLevel: level } : {}) }); this.note('模型已切换，将用于后续请求。');
  }
  private async createModel() {
    const existing = await this.request<{ models: Array<{ id: string }> }>('/models');
    const source = await this.choose('模型来源', [{ value: 'catalog', label: '供应商模型目录' }, { value: 'custom', label: '自定义接口' }]);
    if (!source) return;
    if (source === 'catalog') {
      const { models } = await this.request<{ models: Array<{ providerId: string; modelId: string; name: string; thinkingLevels?: string[] }> }>('/provider-models');
      const providerIds = [...new Set(models.map(model => model.providerId))];
      const providerId = await this.choose('供应商', providerIds.map(value => ({ value, label: value }))); if (!providerId) return;
      const available = models.filter(model => model.providerId === providerId);
      const modelId = await this.choose('模型', available.map(model => ({ value: model.modelId, label: model.name || model.modelId, description: model.modelId }))); if (!modelId) return;
      const id = await this.prompt('模型配置 ID'); if (!id?.trim()) return;
      if (existing.models.some(model => model.id === id.trim())) throw new AppError('model_profile_already_exists');
      const selected = available.find(model => model.modelId === modelId)!;
      const name = await this.prompt('名称', selected.name ?? id); if (!name?.trim()) return;
      const defaultLevel = await this.choose('默认思考模式', [{ value: 'unset', label: '不指定' }, ...supportedLevels(selected.thinkingLevels ?? []).map(value => ({ value, label: value }))]); if (defaultLevel === undefined) return;
      await this.write('/configuration/model', { id: id.trim(), name: name.trim(), providerId, modelId, ...(defaultLevel !== 'unset' ? { defaultThinkingLevel: defaultLevel } : {}) });
      this.note('模型配置已保存。'); return;
    }
    const id = await this.prompt('模型配置 ID'); if (!id?.trim()) return;
    if (existing.models.some(model => model.id === id.trim())) throw new AppError('model_profile_already_exists');
    const name = await this.prompt('名称', id); if (!name?.trim()) return;
    const protocol = await this.choose('接口协议', [{ value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }, { value: 'messages', label: 'Messages' }]); if (!protocol) return;
    const baseURL = await this.prompt('服务地址'); if (!baseURL?.trim()) return;
    const modelId = await this.prompt('模型 ID'); if (!modelId?.trim()) return;
    const apiKeyEnv = await this.prompt('凭据名称（不是密钥）'); if (!apiKeyEnv?.trim()) return;
    const authHeader = await this.choose('认证方式', [{ value: 'api-key', label: 'API key header' }, { value: 'bearer', label: 'Bearer' }]); if (!authHeader) return;
    await this.write('/configuration/model', { id: id.trim(), name: name.trim(), protocol, baseURL: baseURL.trim(), modelId: modelId.trim(), apiKeyEnv: apiKeyEnv.trim(), authHeader, thinking: {} });
    this.note('模型配置已保存。');
  }
  private async editModel() {
    const configuration = await this.request<{ modelProfiles: SavedProfile[] }>('/configuration');
    const id = await this.choose('编辑模型配置', configuration.modelProfiles.map(x => ({ value: x.id, label: x.name, description: x.id }))); if (!id) return;
    const profile = configuration.modelProfiles.find(x => x.id === id); if (!profile) return;
    const fields: SelectItem[] = [{ value: 'name', label: '名称' }, { value: 'modelId', label: '模型 ID' }, { value: 'defaultThinkingLevel', label: '默认思考模式' }];
    if ('providerId' in profile) fields.push({ value: 'providerId', label: '供应商 ID' });
    else fields.push({ value: 'baseURL', label: '服务地址' }, { value: 'apiKeyEnv', label: '凭据引用' }, { value: 'authHeader', label: '认证方式' }, { value: 'protocol', label: '协议' }, { value: 'thinking', label: '思考模式配置' });
    const field = await this.choose(`编辑 ${label(profile.name)}`, fields); if (!field) return;
    let next: SavedProfile = { ...profile };
    if (field === 'defaultThinkingLevel') {
      let levels: string[];
      if ('providerId' in next) {
        const catalog = await this.request<{ models: Array<{ modelId: string; thinkingLevels?: string[] }> }>(`/provider-models?provider=${routeId(next.providerId)}`);
        const model = catalog.models.find(item => item.modelId === next.modelId); if (!model) throw new AppError('model_not_found', 404);
        levels = supportedLevels(model.thinkingLevels ?? []);
      } else levels = supportedLevels(Object.keys(next.thinking));
      const value = await this.choose('默认思考模式（不指定则使用提供方默认）', [{ value: 'unset', label: '不指定' }, ...levels.map(level => ({ value: level, label: level }))]); if (!value) return;
      if (value === 'unset') { next = { ...next }; delete next.defaultThinkingLevel; }
      else next = { ...next, defaultThinkingLevel: value as NonNullable<typeof next.defaultThinkingLevel> };
    } else if (field === 'thinking' && 'thinking' in next) {
      const existingThinking = next.thinking;
      const level = await this.choose('思考模式', ['off', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value, description: existingThinking[value] ? '已配置' : undefined }))); if (!level) return;
      const action = await this.choose('配置思考模式', [{ value: 'set', label: '设置' }, { value: 'remove', label: '移除' }]); if (!action) return;
      const thinking = { ...next.thinking };
      if (action === 'remove') {
        if (next.defaultThinkingLevel === level) {
          const confirm = await this.choose('移除映射也会清除默认思考模式。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]); if (confirm !== 'yes') return;
          next = { ...next }; delete next.defaultThinkingLevel;
        }
        delete thinking[level];
      }
      else if (next.protocol === 'messages') {
        const type = await this.choose('思考类型', [{ value: 'adaptive', label: 'Adaptive' }, { value: 'disabled', label: 'Disabled' }, { value: 'between_tools', label: 'Between tools' }, { value: 'enabled', label: 'Enabled（指定预算）' }, { value: 'none', label: '只设置 effort' }]); if (!type) return;
        const effort = await this.choose('Effort', [{ value: '', label: '不设置' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value }))]); if (effort === undefined) return;
        let setting: Record<string, unknown> = {};
        if (type === 'enabled') { const raw = await this.prompt('预算 tokens（至少 1024）'); if (!raw) return; const budgetTokens = Number(raw); if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1024) throw new AppError('invalid_budget'); setting = { thinking: { type, budgetTokens } }; }
        else if (type !== 'none') setting = { thinking: { type } };
        if (effort) setting.effort = effort;
        if (!Object.keys(setting).length) throw new AppError('invalid_thinking_options');
        thinking[level] = setting;
      } else {
        const reasoningEffort = await this.choose('Reasoning effort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value }))); if (!reasoningEffort) return;
        thinking[level] = { reasoningEffort };
      }
      next = { ...next, thinking };
    } else if (field === 'authHeader' && 'authHeader' in next) {
      const value = await this.choose('认证方式', [{ value: 'api-key', label: 'API key header' }, { value: 'bearer', label: 'Bearer' }]); if (!value) return;
      next = { ...next, authHeader: value as 'api-key' | 'bearer' };
    } else if (field === 'protocol' && 'protocol' in next) {
      const value = await this.choose('接口协议', [{ value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }, { value: 'messages', label: 'Messages' }]); if (!value) return;
      if (value !== next.protocol) { const confirm = await this.choose('切换协议将清除不兼容的思考模式配置。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]); if (confirm !== 'yes') return; }
      if (value !== next.protocol) { next = { ...next }; delete next.defaultThinkingLevel; }
      next = { ...next, protocol: value as typeof next.protocol, thinking: value === next.protocol ? next.thinking : {} };
    } else {
      const initial = String((next as unknown as Record<string, unknown>)[field] ?? '');
      const value = await this.prompt(field === 'apiKeyEnv' ? '凭据名称（不是密钥）' : field, initial); if (!value?.trim()) return;
      next = { ...next, [field]: value.trim() } as SavedProfile;
      if ('providerId' in next && next.defaultThinkingLevel && (field === 'providerId' || field === 'modelId')) {
        const catalog = await this.request<{ models: Array<{ modelId: string; thinkingLevels?: string[] }> }>(`/provider-models?provider=${routeId(next.providerId)}`);
        const model = catalog.models.find(item => item.modelId === next.modelId); if (!model) throw new AppError('model_not_found', 404);
        if (!supportedLevels(model.thinkingLevels ?? []).includes(next.defaultThinkingLevel)) {
          const confirm = await this.choose('新模型不支持当前默认思考模式，是否清除？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '清除' }]); if (confirm !== 'yes') return;
          next = { ...next }; delete next.defaultThinkingLevel;
        }
      }
    }
    await this.write('/configuration/model', next); this.note('模型配置已更新。');
  }
  private async runtimeSettings() {
    const { runtime, models } = await this.request<{ runtime: { memoryEnabled: boolean; maxSteps: number; defaultWorkModel: string; memoryModel: string; contextOverflow?: 'warn' | 'block' }; models: Array<{ id: string; name: string }> }>('/configuration');
    const field = await this.choose('运行设置', [{ value: 'memoryEnabled', label: `记忆：${runtime.memoryEnabled ? '启用' : '停用'}` }, { value: 'maxSteps', label: `最大步骤：${runtime.maxSteps}` }, { value: 'defaultWorkModel', label: `工作模型：${runtime.defaultWorkModel}` }, { value: 'memoryModel', label: `记忆模型：${runtime.memoryModel}` }, ...(this.capabilities.has('context-capacity') ? [{ value: 'contextOverflow', label: `超出上下文预算：${runtime.contextOverflow === 'block' ? '阻止' : '警告'}` }] : [])]); if (!field) return;
    let value: string | boolean | number;
    if (field === 'contextOverflow') { const choice = await this.choose('估算超出输入预算时', [{ value: 'warn', label: '警告并继续' }, { value: 'block', label: '在请求提供方前阻止' }]); if (!choice) return; value = choice; }
    else if (field === 'memoryEnabled') { const choice = await this.choose('记忆', [{ value: 'on', label: '启用' }, { value: 'off', label: '停用' }]); if (!choice) return; value = choice === 'on'; }
    else if (field === 'maxSteps') { const raw = await this.prompt('最大步骤（4–512）', String(runtime.maxSteps)); if (!raw) return; value = Number(raw); if (!Number.isInteger(value) || value < 4 || value > 512) throw new AppError('invalid_max_steps'); }
    else { const selected = await this.choose('选择模型', [...(field === 'memoryModel' ? [{ value: 'same', label: '与源上下文相同' }] : []), ...models.map(model => ({ value: model.id, label: model.name }))]); if (!selected) return; value = selected; }
    await this.write('/configuration/runtime', { [field]: value }); this.note('运行设置已更新。');
  }
  private async externalEditor() {
    const suggested = process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad.exe' : 'vi');
    const command = await this.prompt('本机编辑器程序路径（参数另行填写）', suggested); if (!command?.trim()) return;
    const args = await this.editStrings('编辑器参数', []); if (!args) return;
    const confirmation = await this.choose('该程序将读取当前输入的临时文件，确认启动？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '启动' }]); if (confirmation !== 'yes') return;
    const editor = this.editor; const content = editor.getExpandedText();
    const operation = (async () => {
      await this.ui.terminal.drainInput(1000); if (this.stopped) return;
      this.ui.stop(); this.started = false;
      try {
        const result = await editExternally({ command: command.trim(), args, content, signal: this.lifetime.signal });
        if (this.stopped) return;
        if (result.status === 'complete') editor.setText(result.content); else this.note(result.message);
      } finally {
        if (!this.stopped) { this.started = true; this.ui.start(); this.ui.setFocus(editor); this.ui.requestRender(true); }
      }
    })();
    this.externalTask = operation;
    try { await operation; } finally { if (this.externalTask === operation) this.externalTask = undefined; }
  }
  private async saveDownload(fetchBytes: () => Promise<Buffer>): Promise<boolean> {
    const raw = await this.prompt('保存到本机的新文件路径（不会覆盖）'); if (!raw?.trim()) return false;
    const text = raw.trim(); const target = path.resolve(text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text);
    const confirm = await this.choose(`确认保存到本机？\n${safeTerminalText(target)}`, [{ value: 'no', label: '返回' }, { value: 'yes', label: '保存' }]); if (confirm !== 'yes') return false;
    const bytes = await fetchBytes(); this.lifetime.signal.throwIfAborted();
    const handle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let identity: { ino: number; dev: number } | undefined; let complete = false;
    try { const stat = await handle.stat(); identity = { ino: stat.ino, dev: stat.dev }; await handle.writeFile(bytes, { signal: this.lifetime.signal }); await handle.sync(); complete = true; }
    finally {
      await handle.close();
      if (!complete && identity) {
        const visible = await fs.promises.lstat(target).catch(() => undefined);
        if (visible?.isFile() && !visible.isSymbolicLink() && visible.ino === identity.ino && visible.dev === identity.dev) await fs.promises.unlink(target).catch(() => {});
      }
    }
    this.note('文件已保存到本机。'); return true;
  }
  private async inspectAttachment(name: string, bytes: Buffer): Promise<LocalAttachment> {
    if (!name || name.length > 240 || /[\u0000-\u001f\u007f/:\\]/u.test(name) || name === '.' || name === '..') throw new AppError('invalid_asset_name');
    if (!bytes.length) throw new AppError('empty_asset');
    if (bytes.length > MAX_ATTACHMENT) throw new AppError('asset_too_large');
    const detected = await fileTypeFromBuffer(bytes);
    let mediaType = detected?.mime;
    if (mediaType && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) throw new AppError('asset_type_not_supported');
    if (!mediaType) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (bytes.includes(0)) throw new Error(); }
      catch { throw new AppError('asset_type_not_supported'); }
      mediaType = 'text/plain';
    }
    return { name, bytes, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  private async readLocalAttachment(input: string): Promise<LocalAttachment> {
    const file = path.resolve(input);
    const beforePath = await fs.promises.realpath(file);
    if (/(?:^|[\\/])\.private(?:[\\/]|$)/i.test(file) || /(?:^|[\\/])\.private(?:[\\/]|$)/i.test(beforePath)) throw new AppError('attachment_private_path');
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(); const visible = await fs.promises.lstat(file);
      if (!before.isFile() || before.nlink !== 1 || visible.isSymbolicLink() || visible.ino !== before.ino || visible.dev !== before.dev) throw new AppError('attachment_redirected');
      if (before.size > MAX_ATTACHMENT) throw new AppError('asset_too_large');
      const bytes = await handle.readFile({ signal: this.lifetime.signal });
      const after = await handle.stat(); const afterPath = await fs.promises.realpath(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || beforePath !== afterPath) throw new AppError('attachment_changed');
      return this.inspectAttachment(path.basename(file), bytes);
    } finally { await handle.close(); }
  }
  private async stageAttachment(attachment: LocalAttachment, context = this.contextId) {
    const storageId = this.storageId; if (!storageId) throw new AppError('core_not_ready');
    const items = this.pendingAttachments.get(context) ?? [];
    if (items.length >= 8) throw new AppError('too_many_attachments');
    if (items.reduce((total, item) => total + item.bytes, 0) + attachment.bytes.length > MAX_MESSAGE_ATTACHMENTS) throw new AppError('message_attachments_too_large');
    const image = attachment.mediaType.startsWith('image/') && getCapabilities().images
      ? new Image(attachment.bytes.toString('base64'), attachment.mediaType, { fallbackColor: identity }, { maxWidthCells: 40, maxHeightCells: 5, filename: label(attachment.name) }) : undefined;
    const description = `附件：${label(attachment.name)}\n${label(attachment.mediaType)} · ${attachment.bytes.length} 字节\nSHA-256 ${attachment.sha256}${attachment.mediaType.startsWith('image/') && !image ? '\n当前终端不支持图像预览。' : ''}`;
    const confirm = await this.choose(description, [{ value: 'no', label: '取消' }, { value: 'yes', label: '上传并暂存' }], undefined, image);
    if (confirm !== 'yes' || this.stopped) return;
    if (storageId !== this.storageId) throw new AppError('core_storage_changed');
    const info = await this.request<AssetInfo>(`/assets?name=${encodeURIComponent(attachment.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-ShittimChest-Storage-Id': storageId }, body: new Uint8Array(attachment.bytes) });
    if (storageId !== this.storageId) throw new AppError('core_storage_changed');
    if (!/^[0-9a-f-]{36}$/i.test(info.id) || info.name !== attachment.name || info.sha256 !== attachment.sha256 || info.bytes !== attachment.bytes.length || info.mediaType !== attachment.mediaType) throw new AppError('attachment_integrity_mismatch');
    const latest = this.pendingAttachments.get(context) ?? [];
    if (latest.length >= 8 || latest.reduce((total, item) => total + item.bytes, 0) + info.bytes > MAX_MESSAGE_ATTACHMENTS) throw new AppError('message_attachments_too_large');
    this.pendingAttachments.set(context, [...latest, info]);
    if (context === this.contextId && !this.stopped) { this.note(`附件已暂存：${label(info.name)}。发送消息时还需确认。`); this.status(this.statusText); }
  }
  private async copySelectionOrLast() {
    if (this.ui.hasActiveSelection()) { await this.copySelection(); return; }
    const value = this.lastAssistant.get(this.contextId); const clipboard = this.clipboard ?? getNativeClipboard();
    if (!value || !clipboard?.setText) { this.note('没有可复制的回复或剪贴板不可用。'); return; }
    try { await clipboard.setText(safeTerminalText(value)); this.note('已复制回复。'); } catch { this.note('复制失败。'); }
  }
  private async copySelection() {
    try { if (!await this.ui.copyActiveSelectionToClipboard()) this.note('没有可复制的选区或剪贴板不可用。'); }
    catch { this.note('复制失败。'); }
  }
  private async clipboardPaste() {
    try {
      const clipboard = this.clipboard ?? getNativeClipboard();
      if (!clipboard) { this.note('当前环境没有可用的剪贴板。'); return; }
      const context = this.contextId;
      const paths = await clipboard.getFilePaths?.();
      if (paths?.length) {
        const selected = await this.choose('选择剪贴板文件', paths.map(value => ({ value, label: path.basename(value), description: value })));
        if (selected) await this.stageAttachment(await this.readLocalAttachment(selected), context);
        return;
      }
      const image = await clipboard.getImage();
      if (image?.length) { await this.stageAttachment(await this.inspectAttachment('clipboard-image', Buffer.from(image)), context); return; }
      const text = await clipboard.getText();
      if (text && context === this.contextId && !this.ui.hasOverlay() && !this.stopped) { this.editor.insertTextAtCursor(text); this.ui.requestRender(); }
      else if (text === null || text === undefined) this.note('剪贴板中没有可用内容。');
    } catch (error) { if (!this.stopped) this.note(`剪贴板操作失败：${label(error instanceof AppError ? error.code : 'clipboard_unavailable')}`); }
  }
  private async attachments() {
    const context = this.contextId; const pending = this.pendingAttachments.get(context) ?? [];
    const action = await this.choose('附件', [{ value: 'file', label: '选择本地文件' }, { value: 'clipboard', label: '选择剪贴板内容' }, { value: 'pending', label: `待发送附件（${pending.length}）` }, { value: 'history', label: '查看对话附件' }]);
    if (action === 'file') {
      const raw = await this.prompt('本地文件路径'); if (!raw?.trim()) return;
      const value = raw.trim(); const file = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
      await this.stageAttachment(await this.readLocalAttachment(file), context);
    } else if (action === 'clipboard') await this.clipboardPaste();
    else if (action === 'pending') {
      const id = await this.choose('待发送附件', pending.map(item => ({ value: item.id, label: item.name, description: `${item.mediaType} · ${item.bytes} 字节` }))); if (!id) return;
      const confirm = await this.choose('从待发送列表移除？已上传到核心的文件不会被删除。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '移除' }]);
      if (confirm === 'yes') { this.pendingAttachments.set(context, (this.pendingAttachments.get(context) ?? []).filter(item => item.id !== id)); this.status(this.statusText); }
    } else if (action === 'history') {
      const ids = [...(this.visibleAttachments.get(context) ?? [])];
      const id = await this.choose('对话附件', ids.map(value => ({ value, label: value }))); if (!id) return;
      const info = await this.client.assetInfo(id, this.contextController.signal);
      const choice = await this.choose(`${label(info.name)}\n${label(info.mediaType)} · ${info.bytes} 字节\nSHA-256 ${label(info.sha256)}`, [{ value: 'no', label: '返回' }, { value: 'view', label: '查看内容' }, { value: 'save', label: '保存到本机' }]);
      const fetchVerified = async () => {
        const bytes = await this.client.assetBytes(id, this.contextController.signal);
        if (bytes.length !== info.bytes || createHash('sha256').update(bytes).digest('hex') !== info.sha256) throw new AppError('attachment_integrity_mismatch');
        return bytes;
      };
      if (choice === 'save') { await this.saveDownload(fetchVerified); return; }
      if (choice !== 'view') return;
      const bytes = await fetchVerified();
      if (info.mediaType === 'text/plain') {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); this.note(`附件 ${label(info.name)}：\n${safeTerminalText(text.slice(0, 64_000))}${text.length > 64_000 ? '\n（内容已截断）' : ''}`);
      } else if (info.mediaType.startsWith('image/') && getCapabilities().images) {
        this.transcript.addChild(new Text(`附件 ${label(info.name)}`, 1, 0)); this.transcript.addChild(new Image(bytes.toString('base64'), info.mediaType, { fallbackColor: identity }, { maxWidthCells: 60, maxHeightCells: 20, filename: label(info.name) })); this.ui.requestRender();
      } else this.note(`附件 ${label(info.name)} · ${label(info.mediaType)} · ${info.bytes} 字节；当前终端不支持图像预览。`);
    }
  }
  private async webSettings() {
    type WebConfig = { type: 'none' } | { type: 'brave'; apiKeyEnv: string } | { type: 'searxng'; baseURL: string };
    const { web } = await this.request<{ web: WebConfig }>('/configuration');
    const options = [{ value: 'none', label: '停用搜索' }, { value: 'brave', label: 'Brave Search' }, { value: 'searxng', label: 'SearXNG' }];
    options.sort((a, b) => Number(b.value === web.type) - Number(a.value === web.type));
    const type = await this.choose('网页搜索设置', options); if (!type) return;
    let config: WebConfig;
    if (type === 'brave') { const ref = await this.prompt('凭据名称（不是密钥）', web.type === 'brave' ? web.apiKeyEnv : ''); if (!ref?.trim()) return; config = { type, apiKeyEnv: ref.trim() }; }
    else if (type === 'searxng') { const url = await this.prompt('SearXNG 服务地址', web.type === 'searxng' ? web.baseURL : ''); if (!url?.trim()) return; config = { type, baseURL: url.trim() }; }
    else if (type === 'none') config = { type };
    else throw new AppError('invalid_web_configuration');
    const confirmation = await this.choose('确认保存网页搜索设置？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '保存' }]);
    if (confirmation === 'yes') { await this.write('/configuration/web', config); this.note('网页搜索设置已更新。'); }
  }
  private async messageQueue() {
    const context = this.contextId;
    const rows = await this.request<Array<SignalRecord & { revision: number }>>(`/contexts/${routeId(context)}/message-queue`, { signal: this.contextController.signal });
    const id = await this.choose('消息队列', rows.map(row => ({ value: row.id, label: label(row.content).slice(0, 160), description: row.createdAt }))); if (!id) return;
    const item = rows.find(row => row.id === id); if (!item) return;
    const action = await this.choose('队列消息', [{ value: 'details', label: '查看原文' }, { value: 'edit', label: '编辑并移到队尾' }, { value: 'cancel', label: '撤回' }]);
    if (action === 'details') { this.note(`队列消息：\n${safeTerminalText(item.content)}`); return; }
    if (action === 'cancel') {
      const confirm = await this.choose('确认撤回这条尚未开始的消息？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '撤回' }]);
      if (confirm === 'yes') { await this.write(`/messages/${routeId(id)}`, { revision: item.revision }, 'DELETE'); this.note('队列消息已撤回。'); void this.refreshQueue(); }
    } else if (action === 'edit') {
      const content = await this.promptLong('编辑队列消息（保存后移到队尾）', item.content); if (!content?.trim() || content === item.content) return;
      const confirm = await this.choose('确认替换原消息并移到队尾？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '替换' }]); if (confirm !== 'yes') return;
      try { await this.write(`/messages/${routeId(id)}`, { revision: item.revision, id: randomUUID(), content }, 'PATCH'); this.note('消息已替换并移到队尾。'); void this.refreshQueue(); }
      catch (error) { this.note('替换未完成或结果未确认，请检查队列后再操作。'); throw error; }
    }
  }
  private async approvals() {
    await this.refreshApprovals();
    const pending = this.pendingApprovals;
    if (!pending.length) { this.note('没有待处理的审批。'); return; }
    const id = await this.choose('待审批', pending.map(x => ({ value: x.id, label: `${x.toolName}${approvalTarget(x.args) ? ` · ${approvalTarget(x.args).slice(0, 80)}` : ''}`, description: `${x.contextId}${this.postponedApprovals.has(x.id) ? ' · 已暂缓' : ''}` }))); if (!id) return;
    const approval = pending.find(x => x.id === id)!;
    this.postponedApprovals.delete(id); this.approvalOpen = id;
    try { await this.decideApproval(approval); } catch (error) { if (!this.stopped) this.note(`审批未完成：${approvalError(error)}`); }
    finally { this.approvalOpen = undefined; }
  }
  private async providerAuth(requested?: string) {
    const { providers } = await this.request<{ providers: Array<{ id: string; name: string; methods: Array<{ type: 'api_key' | 'oauth'; name: string }> }> }>('/auth/providers');
    const match = requested ? providers.find(provider => provider.id === requested || provider.name.toLowerCase() === requested.toLowerCase()) : undefined;
    if (requested && !match) this.note(`没有名为 ${label(requested)} 的供应商，请从列表中选择。`);
    const id = match?.id ?? await this.choose('供应商登录', providers.map(provider => ({ value: provider.id, label: provider.name, description: provider.id }))); if (!id) return;
    const provider = providers.find(x => x.id === id)!;
    const status = await this.request<{ configured: boolean; source?: string }>(`/auth/status/${routeId(id)}`);
    const actions: SelectItem[] = provider.methods.map(method => ({ value: method.type, label: method.name }));
    if (status.configured) actions.push({ value: 'logout', label: '移除已保存凭据' });
    const method = await this.choose(`${provider.name} · ${status.configured ? `已配置 ${label(status.source)}` : '未配置'}`, actions);
    if (!method) return;
    if (method === 'logout') {
      const confirm = await this.choose('确认移除该供应商的已保存凭据？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '移除' }]);
      if (confirm === 'yes') { await this.request(`/auth/providers/${routeId(id)}`, { method: 'DELETE' }); this.note('已移除保存的凭据。'); }
      return;
    }
    type AuthPrompt = { type: 'text' | 'secret' | 'manual_code'; message: string } | { type: 'select'; message: string; options: Array<{ id: string; label: string; description?: string }> };
    type AuthEvent = { type: string; message?: string; url?: string; instructions?: string; verificationUri?: string; userCode?: string; links?: Array<{ url: string; label?: string }> };
    type Job = { id: string; state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; prompt?: AuthPrompt; promptId?: string; events?: Array<{ sequence: number; event: AuthEvent }> };
    let job = await this.write(`/auth/${routeId(id)}/start`, { type: method }) as Job;
    let lastSequence = 0; let latestEvent = '';
    const showEvents = (next: Job) => {
      for (const item of next.events ?? []) {
        if (!Number.isSafeInteger(item.sequence) || item.sequence <= lastSequence) continue;
        lastSequence = item.sequence; const event = item.event;
        const pieces = event.type === 'auth_url' ? [event.instructions, event.url] : event.type === 'device_code' ? [event.verificationUri, event.userCode] : [event.message, ...(event.links ?? []).map(link => `${link.label ?? ''} ${link.url}`)];
        const text = pieces.filter((piece): piece is string => typeof piece === 'string' && !!piece).map(safeTerminalText).join('\n');
        if (text) { latestEvent = text; this.note(`登录信息：\n${text}`); }
      }
    };
    try {
      while (!this.stopped && job.state === 'running') {
        job = await this.request<Job>(`/auth/jobs/${routeId(job.id)}`); showEvents(job);
        if (job.state !== 'running') break;
        const initialPromptId = job.promptId;
        if (job.prompt && !initialPromptId) throw new AppError('invalid_auth_prompt');
        const prompt = job.prompt;
        const promptTitle = prompt && latestEvent ? `${prompt.message}\n登录信息已显示在对话区` : prompt?.message;
        const modal = prompt ? (prompt.type === 'select' ? this.choose(promptTitle!, prompt.options.map(option => ({ value: option.id, label: option.label, description: option.description }))) : this.prompt(promptTitle!, '', prompt.type !== 'text')) : this.choose(`等待登录完成${latestEvent ? `\n${latestEvent}` : ''}`, [{ value: 'cancel', label: '取消登录' }]);
        const input = modal.then(value => ({ type: 'input' as const, value }));
        let automatic = false; let value: string | undefined;
        for (;;) {
          const outcome = await Promise.race([input, new Promise<{ type: 'poll' }>(resolve => { const timer = setTimeout(() => resolve({ type: 'poll' }), 500); timer.unref(); })]);
          if (outcome.type === 'input') { value = outcome.value; break; }
          if (this.stopped) { automatic = true; break; }
          const next = await this.request<Job>(`/auth/jobs/${routeId(job.id)}`); const previousSequence = lastSequence; showEvents(next);
          if (next.state !== 'running' || next.promptId !== initialPromptId || (!prompt && lastSequence !== previousSequence)) {
            job = next; automatic = true; this.pendingModal?.(); await modal; break;
          }
          job = next;
        }
        if (automatic) continue;
        if (value === undefined || !prompt) break;
        job = await this.write(`/auth/jobs/${routeId(job.id)}/respond`, { value, promptId: initialPromptId }) as Job; showEvents(job);
      }
      if (job.state === 'completed') this.note('供应商登录已完成。');
      else if (job.state === 'failed') this.note('供应商登录失败。');
    } finally {
      if (job.state === 'running' || job.state === 'cancelling') await this.client.request(`/auth/jobs/${routeId(job.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(1000) }).catch(() => {});
    }
  }
  private async credentials() {
    const { credentials } = await this.request<{ credentials: Array<{ name: string }> }>('/credentials');
    const id = await this.choose('凭据', [{ value: 'new', label: '设置凭据' }, ...credentials.map(x => ({ value: `existing:${x.name}`, label: x.name }))]);
    if (!id) return;
    const name = id === 'new' ? await this.prompt('凭据名称（环境变量名）') : id.slice('existing:'.length);
    if (!name?.trim()) return;
    const action = id === 'new' ? 'set' : await this.choose(label(name), [{ value: 'set', label: '更新密钥' }, { value: 'remove', label: '删除密钥' }]);
    if (action === 'remove') {
      const confirmed = await this.choose(`删除 ${label(name)}？`, [{ value: 'no', label: '返回' }, { value: 'yes', label: '删除' }]);
      if (confirmed === 'yes') { await this.request(`/credentials/${routeId(name.trim())}`, { method: 'DELETE' }); this.note('凭据已移除。'); }
    } else if (action === 'set') {
      const secret = await this.prompt('输入密钥', '', true);
      if (secret && !this.stopped) { await this.write(`/credentials/${routeId(name.trim())}`, { value: secret }, 'PUT'); this.note('凭据已保存。'); }
    }
  }
  private async createTask(initialContent?: string) {
    const title = await this.prompt('任务名称', initialContent ? initialContent.slice(0, 40) : ''); if (!title?.trim()) return;
    const content = initialContent ?? await this.promptLong('任务内容'); if (!content?.trim()) return;
    const { workspaces } = await this.request<{ workspaces: Array<{ id: string; name: string; path: string }> }>('/workspaces');
    const workspaceId = await this.choose('选择工作区', workspaces.map(x => ({ value: x.id, label: x.name, description: x.path }))); if (!workspaceId) return;
    const permissionMode = await this.choose('任务权限', [{ value: 'safe', label: '默认：写入、执行和 MCP 按需审批' }, { value: 'custom', label: '明确授予任务权限' }]); if (!permissionMode) return;
    const grants = { write: false, execute: false, mcp: false };
    if (permissionMode === 'custom') {
      for (;;) {
        const action = await this.choose('可授予的权限', [{ value: 'done', label: '完成' }, { value: 'write', label: `${grants.write ? '[x]' : '[ ]'} 工作区写入` }, { value: 'execute', label: `${grants.execute ? '[x]' : '[ ]'} 执行命令` }, { value: 'mcp', label: `${grants.mcp ? '[x]' : '[ ]'} MCP 工具` }]);
        if (action === undefined) return; if (action === 'done') break;
        if (action === 'write' || action === 'execute' || action === 'mcp') grants[action] = !grants[action];
      }
    }
    const confirm = await this.choose(`确认提交后台任务？${permissionMode === 'custom' ? `\n授权：写入 ${grants.write ? '是' : '否'} · 执行 ${grants.execute ? '是' : '否'} · MCP ${grants.mcp ? '是' : '否'}` : ''}`, [{ value: 'yes', label: '提交' }, { value: 'no', label: '返回' }]);
    if (confirm !== 'yes') return;
    const task = await this.write('/tasks', { title: title.trim(), content, workspaceId, returnContextId: this.contextId, ...(permissionMode === 'custom' ? { grants } : {}) }) as TaskRecord;
    this.note(`任务已提交：${label(task.id)} · ${label(task.status)}`);
  }
  private async workspaces() {
    const { workspaces } = await this.request<{ workspaces: Array<{ id: string; name: string; path: string }> }>('/workspaces');
    const choice = await this.choose('工作区', [{ value: '__add__', label: '添加工作区' }, ...workspaces.map(x => ({ value: `workspace:${x.id}`, label: x.name, description: x.path }))]);
    if (choice !== '__add__') { const workspace = workspaces.find(x => `workspace:${x.id}` === choice); if (workspace) this.note(`工作区：${label(workspace.name)}\n${safeTerminalText(workspace.path)}`); return; }
    const id = await this.prompt('工作区 ID'); if (!id?.trim()) return;
    const name = await this.prompt('工作区名称', id); if (!name?.trim()) return;
    const path = await this.prompt('服务端工作区路径'); if (!path?.trim()) return;
    const confirm = await this.choose(`确认添加工作区 ${label(name)}？`, [{ value: 'yes', label: '添加' }, { value: 'no', label: '返回' }]);
    if (confirm === 'yes') { await this.write('/configuration/workspace', { id: id.trim(), name: name.trim(), path: path.trim() }); this.note('工作区已添加。'); }
  }
  private async editStrings(title: string, original: string[]): Promise<string[] | undefined> {
    const values = [...original];
    for (;;) {
      const action = await this.choose(title, [{ value: 'done', label: '完成' }, { value: 'add', label: '添加' }, ...values.map((value, index) => ({ value: `item:${index}`, label: value || '（空）' }))]);
      if (action === undefined) return undefined;
      if (action === 'done') return values;
      if (action === 'add') { const value = await this.prompt('参数值'); if (value !== undefined) values.push(value); continue; }
      const index = Number(action.slice('item:'.length)); if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new AppError('invalid_selection');
      const operation = await this.choose('参数', [{ value: 'edit', label: '修改' }, { value: 'remove', label: '移除' }]);
      if (operation === 'remove') values.splice(index, 1);
      else if (operation === 'edit') { const value = await this.prompt('参数值', values[index]); if (value !== undefined) values[index] = value; }
    }
  }
  private async editReferences(title: string, original: Record<string, string>): Promise<Record<string, string> | undefined> {
    const values = { ...original };
    for (;;) {
      const action = await this.choose(title, [{ value: 'done', label: '完成' }, { value: 'add', label: '添加引用' }, ...Object.entries(values).map(([key, value]) => ({ value: `item:${key}`, label: key, description: value }))]);
      if (action === undefined) return undefined;
      if (action === 'done') return values;
      if (action === 'add') {
        const key = await this.prompt('名称'); if (!key?.trim()) continue;
        const reference = await this.prompt('凭据/环境变量名称（不是密钥）'); if (!reference?.trim()) continue;
        Object.defineProperty(values, key.trim(), { value: reference.trim(), configurable: true, enumerable: true, writable: true }); continue;
      }
      const key = action.slice('item:'.length); if (!Object.hasOwn(values, key)) throw new AppError('invalid_selection');
      const operation = await this.choose(key, [{ value: 'edit', label: '修改引用' }, { value: 'remove', label: '移除' }]);
      if (operation === 'remove') delete values[key];
      else if (operation === 'edit') { const reference = await this.prompt('凭据/环境变量名称（不是密钥）', values[key]); if (reference?.trim()) values[key] = reference.trim(); }
    }
  }
  private async mcp() {
    const { servers } = await this.request<{ servers: Array<{ id: string; connected: boolean; transport: string; enabled: boolean }> }>('/mcp');
    const choice = await this.choose('MCP 连接', [{ value: '__add__', label: '配置新连接' }, ...servers.map(x => ({ value: `server:${x.id}`, label: x.id, description: `${x.transport} · ${x.connected ? '已连接' : '未连接'}` }))]);
    if (!choice) return;
    if (choice === '__add__') {
      const name = await this.prompt('连接 ID'); if (!name?.trim()) return;
      if (servers.some(server => server.id === name.trim())) throw new AppError('mcp_server_already_exists');
      const transport = await this.choose('连接方式', [{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: '本地进程' }]); if (!transport) return;
      let config: McpConfig = { id: name.trim(), enabled: true, args: [], headersEnv: {}, env: {} };
      if (transport === 'http') {
        const url = await this.prompt('服务地址'); if (!url?.trim()) return;
        const headersEnv = await this.editReferences('请求头凭据引用', {}); if (!headersEnv) return;
        config = { ...config, url: url.trim(), headersEnv };
      } else {
        const command = await this.prompt('服务端可执行程序路径'); if (!command?.trim()) return;
        const args = await this.editStrings('进程参数', []); if (!args) return;
        const env = await this.editReferences('进程环境变量引用', {}); if (!env) return;
        config = { ...config, command: command.trim(), args, env };
      }
      const protocol = await this.choose('协议版本', [{ value: 'default', label: '默认' }, { value: 'legacy', label: 'Legacy' }, { value: '2026-07-28', label: '2026-07-28' }]); if (!protocol) return;
      if (protocol !== 'default') config.protocolVersion = protocol as McpConfig['protocolVersion'];
      const confirm = await this.choose('确认保存连接配置？', [{ value: 'yes', label: '保存' }, { value: 'no', label: '返回' }]);
      if (confirm === 'yes') { await this.write('/configuration/mcp', config); this.note('连接配置已保存。'); }
      return;
    }
    const id = choice.slice('server:'.length);
    const action = await this.choose(id, [{ value: 'edit', label: '编辑配置' }, { value: 'connect', label: '连接' }, { value: 'reconnect', label: '重新连接' }, { value: 'disconnect', label: '断开' }]); if (!action) return;
    if (action === 'edit') { await this.editMcp(id); return; }
    const confirm = await this.choose(action === 'disconnect' ? '确认断开？' : '连接可能启动服务端配置的本地进程，确认继续？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]);
    if (confirm === 'yes') { await this.write(`/mcp/${routeId(id)}/${action}`, {}); this.note('连接操作已完成。'); }
  }
  private async editMcp(id: string) {
    const { mcpConfigurations } = await this.request<{ mcpConfigurations: McpConfig[] }>('/configuration');
    const current = mcpConfigurations.find(row => row.id === id); if (!current) throw new AppError('mcp_server_not_found', 404);
    let config = { ...current, args: [...current.args], env: { ...current.env }, headersEnv: { ...current.headersEnv } };
    const fields: SelectItem[] = [{ value: 'enabled', label: '启用状态' }, { value: 'protocolVersion', label: '协议版本' }];
    if (config.url) fields.push({ value: 'url', label: '服务地址' }, { value: 'headersEnv', label: '请求头凭据引用' });
    else fields.push({ value: 'command', label: '程序路径' }, { value: 'args', label: '进程参数' }, { value: 'env', label: '进程环境变量引用' });
    const field = await this.choose(`编辑 ${label(id)}`, fields); if (!field) return;
    if (field === 'enabled') { const value = await this.choose('启用状态', [{ value: 'on', label: '启用' }, { value: 'off', label: '停用' }]); if (!value) return; config.enabled = value === 'on'; }
    else if (field === 'protocolVersion') { const value = await this.choose('协议版本', [{ value: 'default', label: '默认' }, { value: 'legacy', label: 'Legacy' }, { value: '2026-07-28', label: '2026-07-28' }]); if (!value) return; if (value === 'default') delete config.protocolVersion; else config.protocolVersion = value as McpConfig['protocolVersion']; }
    else if (field === 'args') { const value = await this.editStrings('进程参数', config.args); if (!value) return; config.args = value; }
    else if (field === 'headersEnv' || field === 'env') { const value = await this.editReferences(field === 'env' ? '进程环境变量引用' : '请求头凭据引用', config[field]); if (!value) return; config = { ...config, [field]: value }; }
    else if (field === 'url' || field === 'command') { const value = await this.prompt(field === 'url' ? '服务地址' : '程序路径', config[field] ?? ''); if (!value?.trim()) return; config = { ...config, [field]: value.trim() }; }
    else throw new AppError('invalid_selection');
    const confirm = await this.choose('保存会断开当前连接，确认继续？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '保存' }]);
    if (confirm === 'yes') { await this.write('/configuration/mcp', config); this.note('连接配置已更新。'); }
  }
  private async showUsage() {
    const report = await this.request<{ contexts?: Array<{ contextId: string; role?: string; usage?: Record<string, unknown> }>; runs?: Array<{ runId?: string; modelProfile?: string | null; usage?: Record<string, unknown> }>; cost?: unknown }>(`/usage?contextId=${routeId(this.contextId)}`);
    const row = report.contexts?.find(item => item.contextId === this.contextId);
    const total = addUsage(emptyUsage(), row?.usage ?? {});
    const byProfile = new Map<string, UsageTotals>();
    for (const run of report.runs ?? []) { const key = run.modelProfile ?? '未知'; byProfile.set(key, addUsage(byProfile.get(key) ?? emptyUsage(), run.usage ?? {})); }
    const fmt = (value: number | null) => value === null ? '未报告' : value.toLocaleString('en-US');
    const lines = [
      `上下文 ${label(this.contextId)} 的累计用量（供应商实际返回）`,
      `  输入      ${fmt(total.input)}`, `  输出      ${fmt(total.output)}`, `  缓存读取  ${fmt(total.cacheRead)}`, `  缓存写入  ${fmt(total.cacheWrite)}`, `  推理      ${fmt(total.reasoning)}`,
      ...(byProfile.size > 1 ? ['按模型配置：', ...[...byProfile].map(([profile, usage]) => `  ${label(profile)}  ${usageLine(usage)}`)] : []),
      '费用：未知（不按估算价格计算）',
    ];
    this.note(lines.join('\n'));
  }
  private async showCapacity() {
    const { capacity } = await this.request<{ capacity: ContextCapacity | null }>(`/contexts/${routeId(this.contextId)}/capacity`);
    if (!capacity) { this.note('当前上下文尚无容量估算。'); return; }
    this.updateCapacity(capacity); this.status(this.statusText);
    this.note(`模型：${label(capacity.providerId)} / ${label(capacity.modelId)}\n估算输入：${capacity.estimatedInputTokens} tokens（非精确，图片亦为估算）\n上下文窗口：${capacity.contextWindow ?? '未知'}\n输出软预留：${capacity.outputReserveTokens}（不是硬输出上限） · 安全余量：${capacity.safetyMarginTokens}\n可用输入：${capacity.availableInputTokens ?? '未知'}\n依据：${capacity.basis === 'heuristic' ? '启发式估算' : '已报告前缀加估算'}\n状态：${capacity.overBudget ? (capacity.blockedBeforeProvider ? '超出预算，已阻止请求' : '超出预算，警告') : '未超预算'}`);
  }
  private async toolActivity() {
    const items = [...this.toolCards.entries()];
    const key = await this.choose('工具活动（选择以展开或折叠）', items.map(([value, card]) => ({ value, label: card.data.toolName || '工具', description: `${card.data.state} · ${card.data.toolCallId}` }))); if (!key) return;
    this.toolCards.get(key)?.toggle();
  }
  private async memory() {
    const status = await this.request<{ enabled: boolean; version: string; generation: number; jobs: Array<{ id: string; runId: string; contextId: string; status: string }> }>('/memory');
    const action = await this.choose(`记忆 · ${status.enabled ? '启用' : '停用'} · 版本 ${label(status.version)}`, [{ value: 'resident', label: '查看当前记忆' }, { value: 'jobs', label: '处理记录' }, { value: 'request', label: '请求处理指定运行' }]);
    if (action === 'resident') { const resident = await this.request<{ text: string }>('/memory/resident'); this.note(`当前记忆：\n${safeTerminalText(resident.text)}`); }
    else if (action === 'jobs') {
      const id = await this.choose('记忆处理记录', status.jobs.map(job => ({ value: job.id, label: job.status, description: `${job.contextId} · ${job.runId}` }))); if (!id) return;
      const job = status.jobs.find(item => item.id === id)!;
      if (!['failed', 'interrupted'].includes(job.status)) { this.note(`记忆任务：${label(job.status)}`); return; }
      const confirm = await this.choose('重试此记忆任务？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '重试' }]);
      if (confirm === 'yes') { await this.write(`/memory/jobs/${routeId(id)}/retry`, {}); this.note('记忆任务已提交。'); }
    } else if (action === 'request') {
      const snapshot = await this.request<TuiSnapshot>(`/snapshot?contextId=${routeId(this.contextId)}`);
      const runId = await this.choose('选择来源运行', snapshot.runs.filter(run => run.status !== 'running').map(run => ({ value: run.id, label: run.status, description: run.id }))); if (!runId) return;
      const confirm = await this.choose('确认提交记忆处理？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]);
      if (confirm === 'yes') { await this.write('/memory/requests', { runId }); this.note('记忆处理请求已提交。'); }
    }
  }
  private async notifications() {
    const { pending } = await this.request<{ pending: Array<{ id: string; contextId: string }> }>('/notifications');
    const id = await this.choose('待处理通知', pending.map(item => ({ value: item.id, label: item.id, description: item.contextId }))); if (!id) return;
    const confirm = await this.choose('重试此通知？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '重试' }]);
    if (confirm === 'yes') { await this.write(`/notifications/${routeId(id)}/retry`, {}); this.note('通知重试已提交。'); }
  }
  private async workflows() {
    const { workflows } = await this.request<{ workflows: Array<{ id: string; description: string }> }>('/workflows');
    const id = await this.choose('工作流', workflows.map(flow => ({ value: flow.id, label: flow.id, description: flow.description }))); if (!id) return;
    if (id !== 'verify-files') { this.note('该工作流没有可用的交互表单。'); return; }
    const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
    const contextId = await this.choose('选择工作上下文', contexts.filter(x => x.role === 'work' && !x.archived).map(x => ({ value: x.id, label: x.name, description: x.id }))); if (!contextId) return;
    const paths = await this.editStrings('工作区相对文件路径', []); if (!paths?.length) return;
    const confirmation = await this.choose('确认读取这些工作区文件以计算摘要？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]); if (confirmation !== 'yes') return;
    const result = await this.write(`/workflows/${routeId(id)}/run`, { contextId, input: { paths } });
    this.note(`工作流结果：\n${describeFields('结果', result).slice(1).join('\n') || '无输出'}`);
  }
  private async methodEvidence(original: string[]): Promise<string[] | undefined> {
    const { tasks } = await this.request<{ tasks: TaskRecord[] }>('/tasks');
    const candidates = tasks.filter(task => task.status === 'succeeded' && task.report?.outcome === 'succeeded' && task.report.checks.length > 0 && task.report.checks.every(check => check.passed) && task.report.unresolved.length === 0); const selected = new Set(original);
    for (;;) {
      const missing = [...selected].filter(id => !candidates.some(task => task.id === id));
      const action = await this.choose('已验证任务证据', [{ value: 'done', label: '完成' }, ...candidates.map(task => ({ value: `task:${task.id}`, label: `${selected.has(task.id) ? '[x]' : '[ ]'} ${task.title}`, description: task.id })), ...missing.map(id => ({ value: `task:${id}`, label: '[x] 不再有效的证据', description: id }))]);
      if (action === undefined) return undefined;
      if (action === 'done') return [...selected];
      const id = action.slice('task:'.length); if (!selected.has(id) && !candidates.some(task => task.id === id)) throw new AppError('invalid_selection');
      if (selected.has(id)) selected.delete(id); else selected.add(id);
    }
  }
  private async methodReferences(original: Record<string, string>): Promise<Record<string, string> | undefined> {
    const values = { ...original };
    for (;;) {
      const action = await this.choose('参考资料', [{ value: 'done', label: '完成' }, { value: 'add', label: '添加' }, ...Object.keys(values).map(key => ({ value: `item:${key}`, label: key }))]);
      if (action === undefined) return undefined;
      if (action === 'done') return values;
      if (action === 'add') {
        const key = await this.prompt('相对路径'); if (!key?.trim()) continue;
        const value = await this.promptLong('参考资料内容'); if (value === undefined) continue;
        Object.defineProperty(values, key.trim(), { value, configurable: true, enumerable: true, writable: true }); continue;
      }
      const key = action.slice('item:'.length); if (!Object.hasOwn(values, key)) throw new AppError('invalid_selection');
      const operation = await this.choose(key, [{ value: 'edit', label: '编辑' }, { value: 'remove', label: '移除' }]);
      if (operation === 'remove') delete values[key];
      else if (operation === 'edit') { const value = await this.promptLong('参考资料内容', values[key]); if (value !== undefined) values[key] = value; }
    }
  }
  private async methods() {
    type Method = { name: string; description: string; instructions: string; references: Record<string, string>; evidenceTaskIds: string[]; revision: number; enabled: boolean };
    const { methods } = await this.request<{ methods: Method[] }>('/methods');
    const name = await this.choose('方法', [{ value: '__add__', label: '创建方法' }, ...methods.map(item => ({ value: item.name, label: item.name, description: `${item.enabled ? '启用' : '停用'} · ${item.description}` }))]); if (!name) return;
    if (name === '__add__') {
      const methodName = await this.prompt('方法名称（小写字母、数字或连字符）'); if (!methodName?.trim()) return;
      if (methods.some(method => method.name === methodName.trim())) throw new AppError('method_already_exists');
      const description = await this.prompt('适用场景'); if (!description?.trim()) return;
      const instructions = await this.promptLong('方法内容'); if (!instructions?.trim()) return;
      const references = await this.methodReferences({}); if (!references) return;
      const evidenceTaskIds = await this.methodEvidence([]); if (!evidenceTaskIds?.length) throw new AppError('method_requires_verified_work');
      const confirm = await this.choose('确认保存方法？', [{ value: 'yes', label: '保存' }, { value: 'no', label: '返回' }]);
      if (confirm === 'yes') { await this.write('/methods', { method: { name: methodName.trim(), description, instructions, references, evidenceTaskIds } }); this.note('方法已保存。'); }
      return;
    }
    const method = methods.find(x => x.name === name)!;
    const action = await this.choose(name, [{ value: 'details', label: '查看详情' }, { value: 'edit', label: '编辑方法' }, { value: 'toggle', label: method.enabled ? '停用' : '启用' }, { value: 'rollback', label: '恢复历史版本' }]);
    if (action === 'details') this.note(`方法 ${label(name)}\n${safeTerminalText(method.description)}\n${safeTerminalText(method.instructions)}`);
    else if (action === 'edit') {
      const field = await this.choose('选择修改项', [{ value: 'description', label: '适用场景' }, { value: 'instructions', label: '方法内容' }, { value: 'references', label: '参考资料' }, { value: 'evidenceTaskIds', label: '验证任务证据' }]); if (!field) return;
      let value: unknown;
      if (field === 'references') value = await this.methodReferences(method.references);
      else if (field === 'evidenceTaskIds') value = await this.methodEvidence(method.evidenceTaskIds);
      else if (field === 'instructions') value = await this.promptLong('方法内容', method.instructions);
      else value = await this.prompt('适用场景', method.description);
      if (value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) return;
      const body = { name: method.name, description: method.description, instructions: method.instructions, references: method.references, evidenceTaskIds: method.evidenceTaskIds };
      await this.write('/methods', { method: { ...body, [field]: value }, revision: method.revision }); this.note('方法已更新。');
    } else if (action === 'toggle') { await this.write(`/methods/${routeId(name)}/control`, { revision: method.revision, enabled: !method.enabled }); this.note('方法状态已更新。'); }
    else if (action === 'rollback') {
      const value = await this.prompt('要恢复的版本号'); if (!value) return;
      const restoreRevision = Number(value); if (!Number.isSafeInteger(restoreRevision) || restoreRevision < 1) throw new AppError('invalid_revision');
      const confirm = await this.choose(`确认恢复到版本 ${restoreRevision}？`, [{ value: 'no', label: '返回' }, { value: 'yes', label: '恢复' }]);
      if (confirm === 'yes') { await this.write(`/methods/${routeId(name)}/rollback`, { revision: method.revision, restoreRevision }); this.note('方法版本已恢复。'); }
    }
  }
  private async editTiming(current?: Timing): Promise<Timing | undefined> {
    const choices = [{ value: 'once', label: '一次' }, { value: 'interval', label: '固定间隔' }, { value: 'cron', label: 'Cron' }];
    choices.sort((a, b) => Number(b.value === current?.kind) - Number(a.value === current?.kind));
    const kind = await this.choose('执行方式', choices); if (!kind) return;
    if (kind === 'once') { const at = await this.prompt('执行时间（ISO 8601，含时区）', current?.kind === 'once' ? current.at : ''); return at?.trim() ? { kind, at: at.trim() } : undefined; }
    if (kind === 'interval') {
      const anchorAt = await this.prompt('起始时间（ISO 8601，含时区）', current?.kind === 'interval' ? current.anchorAt : ''); if (!anchorAt?.trim()) return;
      const raw = await this.prompt('间隔毫秒数', current?.kind === 'interval' ? String(current.everyMs) : ''); if (!raw?.trim()) return;
      const everyMs = Number(raw); if (!Number.isSafeInteger(everyMs) || everyMs < 1000) throw new AppError('invalid_interval');
      return { kind, anchorAt: anchorAt.trim(), everyMs };
    }
    const expression = await this.prompt('Cron 表达式', current?.kind === 'cron' ? current.expression : ''); return expression?.trim() ? { kind: 'cron', expression: expression.trim() } : undefined;
  }
  private async schedules() {
    const { schedules } = await this.request<{ schedules: SavedSchedule[] }>('/schedules');
    const id = await this.choose('定时任务', [{ value: '__add__', label: '创建定时任务' }, ...schedules.map(x => ({ value: x.id, label: x.name, description: `${x.status} · ${x.nextFireAt ?? ''}` }))]); if (!id) return;
    if (id === '__add__') {
      const name = await this.prompt('名称'); if (!name?.trim()) return;
      const task = await this.promptLong('任务内容'); if (!task?.trim()) return;
      const timing = await this.editTiming(); if (!timing) return;
      const timezone = await this.prompt('时区（IANA，可留空使用服务端默认值）'); if (timezone === undefined) return;
      const outputKind = await this.choose('交付方式', [{ value: 'none', label: '不指定' }, { value: 'message', label: '消息' }, { value: 'artifact', label: '交付物' }, { value: 'both', label: '消息与交付物' }]); if (!outputKind) return;
      const confirm = await this.choose('确认创建定时任务？', [{ value: 'yes', label: '创建' }, { value: 'no', label: '返回' }]);
      if (confirm === 'yes') { await this.write('/schedules', { version: 2, name: name.trim(), task, contextId: this.contextId, timing, ...(timezone.trim() ? { timezone: timezone.trim() } : {}), output: { kind: outputKind, contextId: this.contextId } }); this.note('定时任务已创建。'); }
      return;
    }
    const schedule = schedules.find(x => x.id === id)!;
    const action = await this.choose(schedule.name, [{ value: 'details', label: '查看详情' }, { value: 'edit', label: '编辑定时任务' }, { value: 'history', label: '执行记录' }, { value: 'pause', label: '暂停' }, { value: 'resume', label: '恢复' }, { value: 'cancel', label: '取消' }, { value: 'run', label: '立即执行' }]);
    if (action === 'details') { this.note(`定时任务 ${label(schedule.name)}\n${safeTerminalText(schedule.task)}\n状态：${label(schedule.status)}\n下次：${label(schedule.nextFireAt)}`); return; }
    if (action === 'edit') {
      const field = await this.choose('选择修改项', [{ value: 'name', label: '名称' }, { value: 'task', label: '任务内容' }, { value: 'timing', label: '执行时间' }, { value: 'timezone', label: '时区' }, { value: 'output', label: '交付方式及上下文' }, { value: 'contextId', label: '执行上下文' }]); if (!field) return;
      let value: unknown;
      if (field === 'timing') { value = await this.editTiming(schedule.timing); if (!value) return; }
      else if (field === 'output') {
        const kind = await this.choose('交付方式', [{ value: 'none', label: '不指定' }, { value: 'message', label: '消息' }, { value: 'artifact', label: '交付物' }, { value: 'both', label: '消息与交付物' }]); if (!kind) return;
        const contexts = await this.request<{ contexts: ContextRecord[] }>('/contexts');
        const contextId = await this.choose('交付上下文', contexts.contexts.map(x => ({ value: x.id, label: x.name, description: x.id }))); if (!contextId) return;
        value = { kind, contextId };
      } else if (field === 'contextId') {
        const contexts = await this.request<{ contexts: ContextRecord[] }>('/contexts');
        value = await this.choose('执行上下文', contexts.contexts.filter(x => x.role === 'work' && !x.archived).map(x => ({ value: x.id, label: x.name, description: x.id }))); if (!value) return;
      } else {
        value = field === 'task' ? await this.promptLong('任务内容', schedule.task) : await this.prompt(field === 'name' ? '名称' : '时区（IANA）', field === 'name' ? schedule.name : schedule.timezone); if (typeof value !== 'string' || !value.trim()) return;
      }
      await this.write(`/schedules/${routeId(id)}`, { revision: schedule.revision, [field]: value }, 'PATCH'); this.note('定时任务已更新。'); return;
    }
    if (action === 'history') {
      let offset = 0;
      for (;;) {
        const page = await this.request<{ occurrences: unknown[]; nextOffset: number }>(`/schedules/${routeId(id)}/occurrences?offset=${offset}&limit=40`);
        this.note(`执行记录（${offset + 1} 起）：\n${(page.occurrences as Occurrence[]).map(formatOccurrence).join('\n') || '暂无'}`);
        if (page.occurrences.length < 40) return;
        if (page.nextOffset <= offset) throw new AppError('history_pagination_stalled');
        const next = await this.choose('执行记录', [{ value: 'more', label: '加载更多' }, { value: 'end', label: '返回' }]); if (next !== 'more') return;
        offset = page.nextOffset;
      }
    }
    if (!action) return;
    const confirm = await this.choose(`确认执行 ${label(action)}？`, [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]);
    if (confirm === 'yes') { await this.write(`/schedules/${routeId(id)}/${action}`, action === 'run' ? {} : { revision: schedule.revision }); this.note('定时任务操作已提交。'); }
  }
  private async taskDeliveries(id: string) {
    const task = await this.request<TaskRecord>(`/tasks/${routeId(id)}`);
    const files = (task.report?.deliveries ?? []).flatMap((delivery, index) => delivery.kind === 'file' && typeof delivery.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(delivery.sha256) ? [{ index, delivery }] : []);
    if (!files.length) { this.note('没有可下载的已验证文件交付。'); return; }
    const selected = await this.choose(`任务交付 · 版本 ${task.revision}`, files.map(({ index, delivery }) => ({ value: String(index), label: delivery.title, description: `${String(delivery.value)} · SHA-256 ${delivery.sha256}` }))); if (selected === undefined) return;
    const entry = files.find(item => String(item.index) === selected); if (!entry) throw new AppError('invalid_selection');
    await this.saveDownload(() => this.client.deliveryBytes(task.id, entry.index, task.revision, entry.delivery.sha256!, this.lifetime.signal));
  }
  private async tasks() {
    const { tasks } = await this.request<{ tasks: TaskRecord[] }>('/tasks');
    const id = await this.choose('任务', tasks.map(x => ({ value: x.id, label: x.title, description: `${x.status} · ${x.id}` }))); if (!id) return;
    const task = tasks.find(x => x.id === id)!;
    const actions: SelectItem[] = [
      { value: 'details', label: '查看详情和报告' }, { value: 'open', label: '打开上下文' }, { value: 'message', label: '补充消息' },
      { value: 'pause', label: '暂停' }, { value: 'resume', label: '恢复' }, { value: 'cancel', label: '取消' }, { value: 'retry', label: '重试' },
    ];
    if (this.capabilities.has('file-deliveries')) actions.push({ value: 'deliveries', label: '下载文件交付' });
    const action = await this.choose(`${label(task.title)} · ${label(task.status)}`, actions);
    if (action === 'deliveries') { await this.taskDeliveries(id); }
    else if (action === 'details') { const detail = await this.request<TaskRecord>(`/tasks/${routeId(id)}`); this.note(`任务 ${label(detail.title)} · ${label(detail.status)}${detail.attempt > 1 ? ` · 第 ${detail.attempt} 次尝试` : ''}\n${safeTerminalText(detail.content)}\n\n${formatReport(detail.report)}`); }
    else if (action === 'open') this.switchContext(task.contextId);
    else if (action === 'message') { const content = await this.promptLong('补充消息'); if (content?.trim()) { await this.write(`/tasks/${routeId(id)}/messages`, { content }); this.note('消息已提交。'); } }
    else if (action) { const confirm = await this.choose(`确认对任务执行 ${label(action)}？`, [{ value: 'yes', label: '确认' }, { value: 'no', label: '返回' }]); if (confirm === 'yes') { await this.write(`/tasks/${routeId(id)}/${action}`, { revision: task.revision }); this.note('任务操作已提交。'); } }
  }
}

export async function runTui(client: Client, contextId = 'main', signal?: AbortSignal): Promise<void> {
  const app = new TerminalApp(client, contextId);
  const abort = () => { void app.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  try { if (signal?.aborted) { await app.stop(); return; } await app.run(); }
  finally { signal?.removeEventListener('abort', abort); await app.stop(); }
}
