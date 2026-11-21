import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { isMemoryAudio, validateMemoryAudioWav } from '../memory/v1/audio.js';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as waitFor } from 'node:timers/promises';
import {
  Box, Container, Editor, Loader, fuzzyFilter, Input, Markdown, ProcessTerminal, ScrollView, SelectList, Spacer, CombinedAutocompleteProvider, Image, MouseRegion, getCapabilities, getNativeClipboard,
  Text, TruncatedText, TuiAltScreen, VStack, wrapTextWithAnsi, matchesKey, isKeyRelease, Key, CURSOR_MARKER, truncateToWidth,
  type Component, type EditorTheme, type MarkdownTheme, type OverlayHandle, type SelectItem, type AutocompleteProvider, type AutocompleteItem,
  type SelectListTheme, type Terminal, type TuiMouseEvent, type NativeClipboard, type SlashCommand,
} from '@earendil-works/pi-tui';
import type { Client, ClientRequestInit } from '../client.js';
import { thinkingLevels as thinkingCommandLevels, type ThinkingLevel, type ModelState } from '../models.js';
import { safeTerminalText, safeValueText, terminalLabel as label, terminalTarget } from '../terminal-format.js';
export { safeTerminalText } from '../terminal-format.js';
import { AppError } from '../domain.js';
import { appBuildInfo, type AppBuildInfo } from '../version.js';
import { isBase64String } from '../base64.js';
import type { OutputRecord, RunRecord, SignalRecord } from '../domain.js';
import type { AssetInfo } from '../assets.js';
import type { ContextCapacity } from '../context-policy.js';
import type { CompanionRhythmView } from '../companion-rhythm.js';
import { fileTypeFromBuffer } from 'file-type';
import type { ConversationMessage, ConversationPage, PublicApproval, PublicEvent, TuiSnapshot,SessionTransferJob,ToolActivityView,ToolResultIdentity } from '../protocol.js';
import type { ContextRecord, ContextRole, TaskRecord, TaskReport } from '../runtime-store.js';
import type { Occurrence } from '../schedules.js';
import { createOverlayHandlers } from './upstream/tui-overlays.js';
import { UserMessageComponent } from './upstream/user-message.js';
import { editExternally } from './upstream/external-editor.js';
import { TerminalEditor,TerminalInput,editorDisplayText, editorTakesPriority, isMacCopyShortcut, isRepeatedCopyOrInterrupt } from './terminal-editor.js';
import { documentFormatForMime } from '../tools/documents.js';
import { createChatViewport } from './upstream/chat-viewport.js';
import { queueDraft } from './queue-draft.js';
import type { QueueWithdrawalResult, QueueEditDocument, QueueEditEntry, QueueEditPage, MessageQueueSummary,QueueInputSource,ProjectDirectory } from '../protocol.js';
import { QueueEditingControls } from './queue-editor.js';
import { QueueLocalEdits, type QueueLocalEdit } from './queue-local-edits.js';
import {resolvedMemoryJob} from './memory-jobs.js';
import type {PublicMemoryJob} from '../memory/job-view.js';
import {saveQueueEntry} from './queue-entry-save.js';
import { SessionControls } from './session-controls.js';
import type { FilterMode } from './upstream/tree-selector.js';
import type { SessionTreeView, SessionNavigationResult } from '../protocol.js';
import { filterAndSortSessions, type SessionInfo } from './upstream/session-selector-search.js';
import { protocolHandshakeSchema } from '../protocol.js';
import { findFd } from '../tools/fd.js';
import { ProjectAutocomplete } from './project-autocomplete.js';
import { automaticWebDefaults, editAutomaticWeb, webRouteLabel } from './web-settings.js';
import type { WebConfiguration } from '../web/index.js';
import type { AutomaticWebConfiguration, WebProviderRuntime } from '../web/provider-config.js';
import { colorEnabled, detectAppearance, plainTheme, Theme } from './upstream/theme.js';
import { runShell, shellResultText, SHELL_MAX_LINES } from './shell.js';
import { ShellOutputCaptures } from './shell-output.js';
import { submitLogicalInput,saveLogicalInput,acknowledgeLogicalInput,logicalInputAdmitted,resolveLogicalInputVersions,type LogicalInputIntent,type LogicalInputHost } from './logical-input.js';
import { collectForm, formCancelled, type FormSchema } from './schema-form.js';
import { taskLifecyclePageSchema } from '../protocol.js';
import { TuiPreferences } from './preferences.js';
import {TuiInputHistory} from './input-history.js';
import { InteractionAnswerDrafts, InteractionAnswerDelivery, answerDeliveryLabel, boundAnswerReceipt, answerReviewId, matchesQuestion } from './interaction-answers.js';
import type { InteractionReference } from '../interactions.js';
import { ToolOutput } from './tool-output.js';
import type { PublicToolText } from '../tool-output.js';
import { decodeSessionImport, encodeSessionArchive, readSessionText, writeSessionExport, type SessionTransferArchive } from './session-transfer.js';
import {SessionTransferFiles,type LocalSessionTransfer} from './session-transfers.js';
import { renderSessionHtml,renderSessionFileHtml } from './session-html.js';
import { transcriptTimeline } from './transcript-order.js';
import { ToolResultContent, type ToolResultPart } from './tool-content.js';
import { openWebUrl } from './open-url.js';
import { LoginDialogComponent } from './upstream/login-dialog.js';

const identity = (s: string) => s;
// Module-level theme so free functions and components share one palette; set per app instance.
let theme: Theme = plainTheme;
let selectTheme: SelectListTheme = theme.selectList();
let editorTheme: EditorTheme = theme.editor();
let markdownTheme: MarkdownTheme = theme.markdown();
const liveEditorTheme: EditorTheme = { borderColor: text => editorTheme.borderColor(text), get selectList() { return selectTheme; } };
function applyTheme(next: Theme) { theme = next; selectTheme = next.selectList(); editorTheme = next.editor(); markdownTheme = next.markdown(); }

const routeId = (id: string) => encodeURIComponent(id);

/** Marks user input that did not (or not yet) reach a run; accepted input needs no annotation. */
function userMessageState(status: string) {
  if (status === 'queued') return '（排队中）';
  if (status === 'cancelled') return '（已撤回，未发送）';
  if (status === 'rejected') return '（未接收）';
  if (status === 'interrupted') return '（未执行：已中断）';
  return '';
}
interface TuiCommand { name: string; description: string; usage?: string; aliases?: string[]; capability?: string; completions?: readonly string[] }
/** Local slash commands; each maps to an existing management flow so behaviour stays in one place. */
export const tuiCommands: readonly TuiCommand[] = [
  { name: 'help', description: '查看命令', aliases: ['commands'] },
  { name: 'hotkeys', description: '查看快捷键' },
  { name: 'shutdown', description: '关闭核心及其后台工作' },
  { name: 'menu', description: '打开管理菜单', aliases: ['settings'] },
  { name: 'new', description: '新建交流上下文', usage: '/new [名称]' },
  { name: 'sessions', description: '切换上下文', usage: '/sessions [ID或名称]', aliases: ['session', 'resume'] },
  { name: 'name', description: '重命名当前上下文', usage: '/name [名称]' },
  { name: 'fork', description: '从用户消息前分支并重新编辑，或选择已完成轮次', capability: 'context-branch' },
  { name: 'clone', description: '复制当前对话为独立对话', usage: '/clone [名称]', capability: 'context-clone' },
  { name: 'compact', usage: '/compact [侧重说明]', description: '摘要较早对话，在新的派生上下文中继续', capability: 'context-compaction' },
  { name: 'tree', description: '浏览消息树、分支和标签', capability: 'context-tree' },
  { name: 'export', description: '导出 HTML、Markdown 或 JSONL；--pi 保留会话树，--backup 保存工作记录', usage: '/export [--pi] [--backup] [路径]' },
  { name: 'import', description: '从本机 JSONL 文件导入独立对话', usage: '/import <路径>', capability: 'context-transfer' },
  { name: 'transfers', description: '查看、继续或取消会话文件传输', capability: 'session-transfer-stream' },
  { name: 'model', description: '切换模型', usage: '/model [配置ID或名称]', aliases: ['models'] },
  { name: 'think', description: '选择或设置当前模型的思考等级', usage: '/think [等级|default]', aliases: ['thinking'] },
  { name: 'stop', description: '停止当前运行', aliases: ['abort'], capability: 'foreground-interrupt' },
  { name: 'copy', description: '复制最近回复或选区' },
  { name: 'status', description: '当前连接与运行状态' },
  { name: 'usage', description: '当前上下文用量' },
  { name: 'context', description: '上下文容量估算', capability: 'context-capacity' },
  { name: 'tasks', description: '后台任务' },
  { name: 'task', description: '新建后台任务', usage: '/task [任务内容]' },
  { name: 'approvals', description: '待处理审批' },
  { name: 'questions', description: '回答问题或确认计划', capability: 'interactive-tools' },
  { name: 'queue', description: '查看、编辑或撤回排队消息', capability: 'message-queue' },
  { name: 'schedules', description: '定时任务' },
  { name: 'tools', description: '展开或折叠工具活动' },
  { name: 'attach', description: '附件', usage: '/attach [本机路径]', capability: 'attachments' },
  { name: 'login', description: '供应商登录', usage: '/login [供应商]', aliases: ['auth'], capability: 'provider-auth' },
  { name: 'logout', description: '移除供应商保存的登录凭据', usage: '/logout [供应商]', capability: 'provider-auth' },
  { name: 'mcp', description: 'MCP 连接' },
  { name: 'skills', description: '查看、使用和管理工作区 Skills', capability: 'workspace-skills' },
  { name: 'skill', description: '使用指定 Skill', usage: '/skill <名称> [要求]', capability: 'workspace-skill-invoke' },
  { name: 'reload', description: '重新读取当前上下文和工作区资源' },
  { name: 'memory', description: '记忆' },
  { name: 'editor', description: '外部编辑器（Ctrl+G）' },
  { name: 'quit', description: '退出（核心继续运行）', aliases: ['exit'] },
];
function commandHelp() {
  return ['可用命令：', ...tuiCommands.map(command => `  ${command.usage ?? `/${command.name}`}  ${command.description}${command.aliases?.length ? `（别名 ${command.aliases.map(alias => `/${alias}`).join(' ')}）` : ''}`),
    '!命令 在本机执行并把结果带入下一条消息 · !!命令 执行但不带入 · 快捷键：↑/↓ 浏览输入历史（空输入或首行行首） · Esc 停止当前回复或命令 · Ctrl+C 清空输入／停止运行／连按两次退出 · Ctrl+D 空输入时退出 · Ctrl+O 展开或折叠工具 · Ctrl+T 展开或折叠思考 · Ctrl+Z 挂起到后台（fg 恢复） · Ctrl+L 选择模型 · Ctrl+P 切换到下一个模型 · Shift+Tab 切换思考等级 · Alt+Enter（或 Ctrl+Q）排队到下一次运行 · Alt+↑（或 Alt+Q）撤回并编辑排队消息 · Ctrl+G 外部编辑器 · Ctrl+V（或 Alt+V）粘贴附件 · Ctrl+X 复制 · Ctrl+J 换行 · PageUp/PageDown 浏览'].join('\n');
}
const supportedLevels = (levels: readonly string[]) => thinkingCommandLevels.filter(level => levels.includes(level));
type SavedProfile = { id: string; name: string; modelId: string; defaultThinkingLevel?: ThinkingLevel } & ({ providerId: string } | { protocol: 'chat-completions' | 'responses' | 'messages'; baseURL: string; apiKeyEnv: string; authHeader: 'api-key' | 'bearer';requestAuth?:'api-key'|'bearer'; thinkingMode?: 'auto' | 'manual'; thinking: Record<string, Record<string, unknown>> });
type McpConfig = { id: string; enabled: boolean; command?: string; args: string[]; url?: string; protocolVersion?: 'legacy' | '2026-07-28'; headersEnv: Record<string, string>; env: Record<string, string>; oauth?: { clientId?: string; clientMetadataUrl?: string; clientSecretEnv?: string; scopes?: string[]; redirectPort?: number } };
type ToolActivity = ToolActivityView;
type UserInteraction = { id: string; contextId: string; runId: string; toolCallId: string; toolName: 'ask_user' | 'submit_plan'; kind: 'question' | 'plan'; payload: { question?: string; options?: Array<{ label: string; description?: string }>; selectionMode?: 'single_select' | 'multi_select'; path?: string; title?: string; plan?: string }; status: 'pending' | 'answered' | 'cancelled' | 'interrupted'; createdAt: string };
type ProjectSkillSummary = { name: string; path: string; description: string; enabled: boolean; 'user-invocable'?: boolean; disableModelInvocation: boolean };
type LocalAttachment = { name: string; mediaType: string; bytes: Buffer; sha256: string };
const MAX_ATTACHMENT = 16 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 32 * 1024 * 1024;
type Timing = { kind: 'once'; at: string } | { kind: 'interval'; anchorAt: string; everyMs: number } | { kind: 'cron'; expression: string };
type SavedSchedule = { id: string; name: string; status: string; revision: number; task: string; nextFireAt: string | null; timing: Timing; timezone: string; contextId: string; output: { kind: string; contextId: string } };

function contextTree(input: ContextRecord[]): Array<{ context: ContextRecord; depth: number }> {
  const contexts = [...input].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
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
      if (![item.value, item.label, item.description ?? ''].every(text => !/(?:^|[\\/@"'])\.private(?:[\\/]|$)/i.test(text))) return false;
      const isCommand = !options.force && result.prefix.startsWith('/') && !result.prefix.slice(1).includes('/') && line.startsWith('/');
      if (isCommand) return this.commandSupported(item.value.replace(/^\//, ''));
      if (isArgument) return true;
      const raw = item.description ?? item.value.replace(/^@/, '').replace(/^"|"$/g, '');
      const display = raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(2)) : raw;
      try { return !/(?:^|[\\/])\.private(?:[\\/]|$)/i.test(fs.realpathSync(path.resolve(this.base, display))); }
      catch { return false; }
    });
    return items.length ? { ...result, items:items.map(item=>({...item,label:editorDisplayText(item.label),...(item.description===undefined?{}:{description:editorDisplayText(item.description)})})) } : null;
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
  private readonly search = new TerminalInput({ prompt: '搜索 › ' });
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
  private resultNotice?:string;
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
  update(next: ToolActivity) { this.data = { ...this.data, ...next, args: next.args ?? this.data.args, progress: next.progress ?? this.data.progress, summary: next.summary ?? this.data.summary, output: next.output ?? this.data.output, diff: next.diff ?? this.data.diff }; this.rebuild(); }
  setResultNotice(value?:string){if(this.resultNotice!==value){this.resultNotice=value;this.rebuild();this.renderNow();}}
  toggle() { this.expanded = !this.expanded; this.rebuild(); this.renderNow(); }
  isExpanded() { return this.expanded; }
  setExpanded(value: boolean) { if (this.expanded !== value) { this.expanded = value; this.rebuild(); } }
  private rebuild() {
    const state: Record<string, string> = { running: '进行中', finished: '完成', failed: '失败', denied: '已拒绝' };
    const bg = this.data.state === 'running' ? 'toolPendingBg' : this.data.state === 'finished' ? 'toolSuccessBg' : 'toolErrorBg';
    const paint = (text: string) => theme.bg(bg, text); this.title.setCustomBgFn(paint); this.detail.setCustomBgFn(paint);
    const elapsed = this.data.startedAt && this.data.updatedAt ? (Date.parse(this.data.updatedAt) - Date.parse(this.data.startedAt)) / 1000 : NaN;
    const timing = Number.isFinite(elapsed) && elapsed >= 0.1 && this.data.state !== 'running' ? ` ${elapsed.toFixed(1)}s` : '';
    this.title.setText(`${theme.fg('muted', this.expanded ? '▾' : '▸')} ${toolCallLine(this.data.toolName, this.data.args)} ${theme.fg(this.data.state === 'failed' || this.data.state === 'denied' ? 'error' : 'muted', `· ${typeof this.data.state === 'string' && Object.hasOwn(state, this.data.state) ? state[this.data.state] : label(this.data.state)}${typeof this.data.exitCode === 'number' ? ` · 退出码 ${this.data.exitCode}` : ''}${timing}`)}${this.data.originContextId ? theme.fg('muted', ` · 来自 ${label(this.data.originContextId)}`) : ''}`);
    this.clear(); this.addChild(this.title);
    if (this.data.output || this.data.diff) this.addChild(new ToolOutput(this.data, this.expanded, theme, paint));
    if (this.data.resultContent?.length) this.addChild(new ToolResultContent(this.data.resultContent, this.expanded, theme, paint, !this.data.output));
    if(this.resultNotice)this.addChild(new Text(theme.fg('muted',this.resultNotice),2,0));
    if (this.expanded) {
      const lines = [...describeFields('参数', this.data.args), ...describeFields('进度', this.data.progress), ...describeFields('结果', this.data.summary)];
      if (this.data.legacy) lines.push('旧记录不包含公开参数。');
      if (!lines.length) lines.push('没有可公开的参数或结果统计。');
      this.detail.setText(theme.fg('toolOutput', safeTerminalText(lines.join('\n')))); this.addChild(this.detail);
    }
  }
}

const toolLabels: Record<string, string> = {
  mastra_workspace_execute_command: '$', mastra_workspace_read_file: 'read', mastra_workspace_write_file: 'write', mastra_workspace_apply_patch: 'edit', mastra_workspace_edit_file: 'edit',
  mastra_workspace_list_files: 'ls', mastra_workspace_grep: 'grep', mastra_workspace_file_stat: 'stat', mastra_workspace_mkdir: 'mkdir',
  mastra_workspace_get_process_output: 'output', mastra_workspace_kill_process: 'kill', web_fetch: 'fetch', web_search: 'search',
};
/** Folded tool line in the shape of Pi's call renderers: `$ cmd`, `read path`, `grep /pat/ in dir`. */
export function toolCallLine(toolName: string, args: unknown) {
  const row = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const text = (value: unknown) => terminalTarget(value).slice(0, 160);
  const name = typeof toolName === 'string' && Object.hasOwn(toolLabels, toolName) ? toolLabels[toolName]! : label(toolName) || '工具';
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
  if (typeof value !== 'object') return [`${heading}：${safeValueText(value)}`];
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return [];
  const show = (item: unknown): string => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      if (row.truncated === true) return `（已截断，${safeValueText(row.characters ?? '?')} 字符）`;
      if (row.type === 'text' && typeof row.characters === 'number') return `文本 ${row.characters} 字符${typeof row.lines === 'number' ? ` · ${row.lines} 行` : ''}`;
      if (row.type === 'array' && typeof row.items === 'number') return `${row.items} 项`;
      return safeValueText(item);
    }
    if (typeof item === 'string') return item.includes('\n') ? `\n${item.split('\n').map(line => `    ${line}`).join('\n')}` : item;
    return terminalTarget(item);
  };
  return [`${heading}：`, ...entries.map(([key, item]) => `  ${label(key)}：${show(item)}`)];
}

/** `!command` output card after Pi BashExecutionComponent: last 20 lines folded, Ctrl+O shows all. */
class ShellCard extends Container {
  private lines: string[] = [''];
  private state: 'running' | 'done' | 'failed' | 'cancelled' | 'unknown' = 'running';
  private exitCode?: number;
  private expanded = false;
  constructor(private readonly command: string, private readonly shared: boolean) { super(); this.rebuild(); }
  append(text: string) { const parts = text.split('\n'); this.lines[this.lines.length - 1] = (this.lines.at(-1) ?? '') + (parts[0] ?? ''); this.lines.push(...parts.slice(1)); if (this.lines.length > SHELL_MAX_LINES) this.lines = this.lines.slice(-SHELL_MAX_LINES); this.rebuild(); }
  finish(result: { exitCode: number | undefined; cancelled: boolean; captureFailed?:boolean; unknown?:boolean }) { this.exitCode = result.exitCode; this.state = result.unknown||result.captureFailed?'unknown':result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'done' : 'failed'; this.rebuild(); }
  isExpanded() { return this.expanded; }
  setExpanded(value: boolean) { if (this.expanded !== value) { this.expanded = value; this.rebuild(); } }
  private rebuild() {
    const tone = this.shared ? 'accent' : 'dim';
    this.clear(); this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg(tone, theme.bold(`$ ${safeTerminalText(this.command)}`)) + theme.fg('dim', this.shared ? '  · 结果会带入下一条消息' : '  · 不带入对话'), 1, 0));
    const body = this.lines.join('\n').replace(/\n$/, '').split('\n');
    const shown = this.expanded ? body : body.slice(-20);
    if (body.length > shown.length) this.addChild(new Text(theme.fg('dim', `…前 ${body.length - shown.length} 行已折叠（Ctrl+O 展开）`), 1, 0));
    if (shown.some(line => line)) this.addChild(new Text(theme.fg('muted', safeTerminalText(shown.join('\n'))), 1, 0));
    const status = this.state === 'running' ? theme.fg('muted', '运行中… Esc 取消') : this.state === 'done' ? theme.fg('success', '已退出 · 退出码 0') : this.state === 'cancelled' ? theme.fg('warning', '已取消') : this.state==='unknown'?theme.fg('warning','命令状态未确认 · 已保留收到的输出'):theme.fg('error', `退出码 ${this.exitCode ?? '?'}`);
    this.addChild(new Text(status, 1, 0));
  }
}

class ThinkingBlock extends Container {
  text = '';
  private readonly body = new Markdown('', 1, 0, markdownTheme, { color: value => theme.fg('thinkingText', value), italic: true });
  private readonly placeholder = new Text('', 1, 0);
  constructor(private hidden: boolean) { super(); this.rebuild(); }
  append(delta: string) { this.text += delta; this.body.setText(safeTerminalText(this.text.trim())); }
  setHidden(hidden: boolean) { if (this.hidden !== hidden) { this.hidden = hidden; this.rebuild(); } }
  private rebuild() {
    this.clear(); this.addChild(new Spacer(1));
    if (this.hidden) { this.placeholder.setText(theme.italic(theme.fg('thinkingText', '思考中…（Ctrl+T 展开）'))); this.addChild(this.placeholder); }
    else this.addChild(this.body);
  }
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
/** 按空格拆分编辑器命令，保留引号内的完整路径以支持带空格的 Windows 路径。 */
export function splitCommand(text: string) { return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]!); }
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
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
  if (total.cacheRead) parts.push(`R${formatTokens(total.cacheRead)}`);
  if (total.cacheWrite) parts.push(`W${formatTokens(total.cacheWrite)}`);
  return parts.join(' ');
}
const failureTitles: Record<string, string> = {
  model_execution_failed: '模型请求未完成', context_capacity_exceeded: '上下文超出模型输入预算', model_credentials_unavailable: '模型凭据不可用',
  model_profile_not_found: '模型配置不存在', model_not_found: '供应商没有这个模型', model_provider_unavailable: '模型供应商不可用', step_budget_exhausted: '已达到单次运行的最大步骤数',
  snapshot_failed: '上下文快照保存失败', context_snapshot_failed: '上下文快照保存失败', task_execution_failed: '后台任务执行失败',
  model_authentication_failed: '模型登录失效', model_access_denied: '账号无权使用该模型', model_rate_limited: '模型请求受到限流', model_quota_exhausted: '模型服务额度不足', model_timeout: '模型请求超时', model_service_unavailable: '模型服务暂时不可用',
  model_protocol_error: '模型返回的数据无法安全处理',
  model_thinking_output_capacity:'输出上限不足以容纳思考预算',
};
const failureHints: Record<string, string> = {
  model_authentication_failed: '用 /login 重新登录供应商，再重试。',
  model_access_denied: '核对供应商账号是否有权使用当前模型；/model 可选择其他模型。',
  model_not_found: '检查模型 ID，或从供应商目录重新选择实际可用的模型。',
  model_rate_limited: '按服务提示稍后重试，或切换其他可用模型。',
  model_quota_exhausted: '先核对账号额度与账单；重复发送不会补充额度。',
  model_timeout: '检查网络与服务状态，再重试当前请求。',
  model_service_unavailable: '稍后重试，或用 /model 切换其他可用模型。',
  model_protocol_error: '用 /model 切换模型或检查接口设置后重试。',
  model_thinking_output_capacity:'请提高输出上限或降低思考设置后重试。',
  model_execution_failed: '可重发消息；持续失败时用 /status 查看连接，或 /model 换用其他模型。',
  context_capacity_exceeded: '用 /compact 摘要较早对话后在新上下文中继续（原文保留），或用 /fork 只带走需要的轮次；/context 查看估算。',
  model_credentials_unavailable: '用 /login 登录供应商，或在 /menu → 凭据 中设置凭据。',
  model_profile_not_found: '用 /model 选择已有配置，或在 /menu → 配置模型 中新建。',
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
    return terminalTarget(value);
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
  constructor(private readonly title: string, private readonly body: string[], readonly options: readonly ApprovalChoice[], private readonly done: (choice: ApprovalChoice) => void, private readonly redraw: () => void, private readonly labels: Readonly<Record<ApprovalChoice, string>> = approvalLabels) {}
  invalidate() {}
  render(width: number) {
    const inner = Math.max(20, width - 4);
    const wrapped = this.body.flatMap(line => wrapTextWithAnsi(line, inner));
    const pages = Math.max(1, Math.ceil(wrapped.length / APPROVAL_PAGE)); const start = (this.page % pages) * APPROVAL_PAGE;
    const lines = [theme.fg('warning', theme.bold(truncateToWidth(this.title, inner))), ...wrapped.slice(start, start + APPROVAL_PAGE).map(line => `  ${line}`)];
    if (pages > 1) lines.push(theme.fg('warning', `  第 ${start + 1}–${Math.min(wrapped.length, start + APPROVAL_PAGE)} 行，共 ${wrapped.length} 行 · v 翻页`));
    lines.push('');
    this.options.forEach((option, index) => {
      const text = `${index === this.selected ? '▸ ' : '  '}${index + 1}. ${this.labels[option]}`;
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

type SkillSubmission = { name: string; content: string; sourceText: string };
type RecoverableDraft = {
  key: string; text: string; context: string; storageId: string;
  attachments: AssetInfo[]; shell: string[];
  skill?: SkillSubmission;
  localInputId?:string;
  localOnly?:QueueLocalEdit;
  logicalInput?:LogicalInputIntent;
  logicalInputPending?:boolean;
  restoredFromSignalIds?: string[];
  submission?: { id: string; outgoing: string; sourceText?: string; restoredFromSignalIds?: string[]; mode?: 'queue' | 'steer'; expectedRunId?: string; uncertain: boolean };
};

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
  private readonly taskMessageDraftStores = new Map<string, Map<string, string>>();
  private get taskMessageDrafts() {
    let drafts = this.taskMessageDraftStores.get(this.storageId);
    if (!drafts) { drafts = new Map(); this.taskMessageDraftStores.set(this.storageId, drafts); } return drafts;
  }
  private readonly taskCreationDraftStores = new Map<string, Map<string, { title: string; content: string; workspaceId?: string; permissionMode?: string; grants: { write: boolean; execute: boolean; mcp: boolean } }>>();
  private get taskCreationDrafts() {
    let drafts = this.taskCreationDraftStores.get(this.storageId);
    if (!drafts) { drafts = new Map(); this.taskCreationDraftStores.set(this.storageId, drafts); } return drafts;
  }
  private tasksLoaded = false;
  private taskVersion = 0;
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
  private pendingApprovals: PublicApproval[] = [];
  private pendingInteractions: UserInteraction[] = [];
  private readonly postponedInteractions = new Set<string>();
  private interactionOpen?: string;
  private interactionVersion = 0;
  private answerDelivery?: InteractionAnswerDelivery;
  private answerCacheProblem?: string;
  private interactionRefresh?: Promise<void>;
  private interactionDirty = false;
  private interactionTimer?: ReturnType<typeof setTimeout>;
  private delivery() {
    if (!this.capabilities.has('interaction-answer-outbox') || !this.storageId) return undefined;
    if (this.answerDelivery?.storageId !== this.storageId) {
      const storageId = this.storageId;
      try {
        this.answerDelivery = new InteractionAnswerDelivery(storageId, async <T>(route: string, body?: unknown) => {
          if (this.storageId !== storageId || this.stopped) throw new AppError('core_storage_changed', 409);
          return body === undefined ? this.request<T>(route) : await this.write(route, body) as T;
        }, this.answerDrafts, { receiptLookup: this.capabilities.has('interaction-answer-receipt-lookup') });
        this.answerCacheProblem = undefined;
      } catch (error) {
        if (this.answerCacheProblem !== storageId) this.note('本机回答缓存无法读取，原文件已保留；回答恢复暂缓，其他交流仍可继续。');
        this.answerCacheProblem = storageId; throw error;
      }
    }
    return this.answerDelivery;
  }
  private refreshInteractions(): Promise<void> {
    if (!this.capabilities.has('interactive-tools') || this.stopped) return Promise.resolve();
    if (this.interactionRefresh) { this.interactionDirty = true; return this.interactionRefresh; }
    this.interactionRefresh = (async () => {
      do {
        this.interactionDirty = false;
        const version = this.interactionVersion;
        try {
          const { interactions } = await this.request<{ interactions: UserInteraction[] }>('/interactions', { signal: this.lifetime.signal });
          if (this.stopped || version !== this.interactionVersion) return;
          this.pendingInteractions = interactions.filter(item => item.status === 'pending');
          this.status(this.statusText);
          await this.delivery()?.refresh(interactions);
          if (this.stopped || version !== this.interactionVersion) return;
          this.pendingInteractions = interactions.filter(item => item.status === 'pending');
          for (const id of this.postponedInteractions) if (!this.pendingInteractions.some(item => item.id === id)) this.postponedInteractions.delete(id);
          if (this.interactionOpen && !this.pendingInteractions.some(item => item.id === this.interactionOpen)) this.pendingModal?.();
          this.status(this.statusText); void this.presentInteraction();
        } catch { /* Retain unanswered questions and local answers until Core can be reached. */ }
      } while (this.interactionDirty && !this.stopped);
    })().finally(() => {
      this.interactionRefresh = undefined;
      if (this.interactionDirty && !this.stopped) queueMicrotask(() => { void this.refreshInteractions(); });
      if (this.interactionTimer) clearTimeout(this.interactionTimer);
      if (!this.stopped && (this.answerDelivery?.needsRefresh() || this.answerCacheProblem && this.answerCacheProblem === this.storageId)) this.interactionTimer = setTimeout(() => { void this.refreshInteractions(); }, 2000).unref();
    });
    return this.interactionRefresh;
  }
  private async presentInteraction() {
    if (this.stopped || !this.started || this.interactionOpen || this.approvalOpen || this.modalFlow || this.pendingModal || this.ui.hasOverlay() || this.editor.getText().trim()) return;
    if (this.answerCacheProblem === this.storageId) return;
    const item = this.pendingInteractions.filter(row => !this.postponedInteractions.has(row.id) && !this.answerDelivery?.hasAnswer(row.id)).sort((a, b) => Number(b.contextId === this.contextId) - Number(a.contextId === this.contextId) || a.createdAt.localeCompare(b.createdAt))[0];
    if (!item) return;
    this.interactionOpen = item.id;
    try { await this.withModalFlow(() => this.answerInteraction(item)); }
    catch (error) { if (!this.stopped) { this.postponedInteractions.add(item.id); this.note(`回答未确认：${label(error instanceof AppError ? error.code : 'request_failed')}；/questions 可核对后继续。`); } }
    finally { this.interactionOpen = undefined; }
    void this.presentApproval(); void this.presentInteraction();
  }
  private async answerInteraction(item: UserInteraction) {
    let answer: string | string[] | { action: 'approved' | 'rejected'; feedback?: string } | undefined;
    if (item.kind === 'plan') {
      const body = [`上下文 ${label(item.contextId)}`, ...safeTerminalText(item.payload.plan ?? item.payload.question ?? '').split('\n')];
      const decision = await this.approvalPrompt(label(item.payload.title ?? '确认计划'), body, ['once', 'decline', 'later'], { ...approvalLabels, once: '同意计划', decline: '拒绝计划', later: '稍后处理' });
      if (decision === 'once') answer = { action: 'approved' };
      else if (decision === 'decline') { const feedback = await this.promptLong('拒绝原因（可留空）'); if (feedback !== undefined) answer = { action: 'rejected', ...(feedback ? { feedback } : {}) }; }
    } else if (item.payload.options?.length) {
      const selected = new Set<number>();
      for (;;) {
        const multi = item.payload.selectionMode === 'multi_select';
        const choice = await this.choose(`${label(item.payload.question ?? '请选择')} · ${label(item.contextId)}`, [
          ...item.payload.options.map((option, index) => ({ value: String(index), label: `${multi ? selected.has(index) ? '☑ ' : '☐ ' : ''}${option.label}`, description: option.description })),
          ...(multi ? [{ value: 'done', label: '确认所选项' }] : []), { value: 'text', label: multi ? '补充其他回答' : '输入其他回答' },
        ]);
        if (choice === undefined) break;
        if (choice === 'text') {
          const value = await this.promptLong(item.payload.question ?? '你的回答');
          if (value !== undefined && value.trim()) answer = multi ? [...new Set([...selected].sort((a, b) => a - b).map(index => item.payload.options![index]!.label).concat(value))] : value;
          break;
        }
        if (choice === 'done') { if (selected.size) { answer = [...selected].sort((a, b) => a - b).map(index => item.payload.options![index]!.label); break; } continue; }
        const index = Number(choice); if (!Number.isInteger(index) || !item.payload.options[index]) continue;
        if (!multi) { answer = item.payload.options[index]!.label; break; }
        if (selected.has(index)) selected.delete(index); else selected.add(index);
      }
    } else answer = await this.promptLong(`${item.payload.question ?? '你的回答'}\n上下文 ${label(item.contextId)}`);
    if (typeof answer === 'string' && !answer.trim()) answer = undefined;
    if (typeof answer === 'string' && item.kind === 'question' && item.payload.selectionMode === 'multi_select') answer = [answer];
    if (answer === undefined) { this.postponedInteractions.add(item.id); this.note('已暂缓回答；/questions 可继续处理。'); return; }
    if (!this.modalScopeCurrent()) throw new AppError('core_storage_changed', 409);
    const delivery = this.delivery();
    if (delivery) {
      try { const entry = await delivery.stage(item, answer); this.note(`${answerDeliveryLabel(entry)}；/questions 可查看。`); }
      catch (error) { this.note(`${delivery.hasAnswer(item.id) ? '回答保留在当前窗口，保存尚未确认' : '回答尚未保存'}：${label(error instanceof AppError ? error.code : 'request_failed')}；/questions 可查看。`); }
      this.postponedInteractions.delete(item.id); this.status(this.statusText); void this.refreshInteractions(); return;
    }
    await this.write(`/interactions/${routeId(item.id)}/answer`, { expectedRunId: item.runId, answer });
    this.pendingInteractions = this.pendingInteractions.filter(row => row.id !== item.id);
    this.postponedInteractions.delete(item.id); this.note('已提交回答。'); this.status(this.statusText);
  }
  private async questions() {
    await this.refreshInteractions();
    let delivery: InteractionAnswerDelivery | undefined; let localAnswersUnavailable = false;
    try { delivery = this.delivery(); } catch { localAnswersUnavailable = true; }
    const entries = delivery?.entries() ?? [];
    const choices = this.pendingInteractions.map(item => ({ value: item.id, label: item.payload.title ?? item.payload.question ?? (item.kind === 'plan' ? '确认计划' : '问题'), description: `${item.contextId}${delivery?.hasAnswer(item.id) ? ' · ' + answerDeliveryLabel(entries.find(entry => entry.interactionId === item.id)!) : ''}` }));
    for (const entry of entries) if (!choices.some(choice => choice.value === entry.interactionId)) choices.push({ value: entry.interactionId, label: answerDeliveryLabel(entry), description: entry.contextId });
    const id = await this.pick('问题、计划与回答状态', choices, '没有待回答的问题或计划。');
    const saved = entries.find(entry => entry.interactionId === id);
    if (saved && delivery) {
      const receipt = boundAnswerReceipt(saved);
      const action = await this.choose(answerDeliveryLabel(saved), [{ value: 'check', label: '重新核对状态' }, ...(saved.draft ? [{ value: 'view', label: saved.drafts && saved.drafts.length > 1 ? '查看本机保留的各个版本' : '查看本机保留的回答' }] : []), ...(receipt && !['delivered', 'cancelled'].includes(receipt.status) ? [{ value: 'retry', label: '请求继续送达原回答' }] : []), { value: 'cancel', label: '停止这项请求所属的运行' }]);
      if (action === 'view' && saved.draft) {
        const versions = saved.drafts ?? [saved.draft];
        const localId = versions.length > 1 ? await this.choose('本机保留的回答版本', versions.map((row, index) => ({ value: row.localId!, label: `版本 ${index + 1} · ${row.updatedAt}`, description: typeof row.answer === 'string' ? row.answer : JSON.stringify(row.answer) }))) : versions[0]!.localId;
        const version = versions.find(row => row.localId === localId);
        if (version) {
          const text = typeof version.answer === 'string' ? version.answer : JSON.stringify(version.answer, null, 2);
          const canReview = !saved.selectionRequired && this.capabilities.has('interaction-reference') && this.capabilities.has('input-draft-review');
          const decision = await this.approvalPrompt('本机保留的回答', safeTerminalText(text).split('\n'), saved.selectionRequired || canReview ? ['once', 'later'] : ['later'], { ...approvalLabels, once: saved.selectionRequired ? '选择并送达这个版本' : '恢复为新的补充草稿', later: '返回' });
          if (decision === 'once' && saved.selectionRequired) await delivery.choose(saved.interactionId, version.localId!, this.pendingInteractions);
          if (decision === 'once' && canReview) {
            const reference = await this.request<InteractionReference>(`/interactions/${routeId(saved.interactionId)}/reference?expectedRunId=${encodeURIComponent(saved.runId)}`);
            if (!matchesQuestion(version, reference.interaction)) throw new AppError('interaction_reference_changed', 409);
            if (!reference.target) throw new AppError(reference.unavailable ?? 'interaction_destination_unavailable', 409);
            const context = JSON.stringify({ kind: 'prior-interaction-reference', interaction: reference.interaction, taskIds: reference.taskIds });
            await this.reviewLocalInput({ id: answerReviewId(version), contextId: reference.target.contextId, content: text, localContext: context });
          }
        }
      }
      if (action === 'retry') await delivery.retry(saved.interactionId);
      if (action === 'cancel') {
        const confirm = await this.choose('确认停止？已经发生的外部操作不会撤销。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '停止' }]);
        if (confirm === 'yes') await delivery.cancel(saved.interactionId, saved.runId);
      }
      if (action) await this.refreshInteractions(); return;
    }
    const item = this.pendingInteractions.find(row => row.id === id); if (!item) return;
    const action = await this.choose('处理这项请求', [localAnswersUnavailable ? { value: 'view', label: '查看问题（本机回答暂不可读）' } : { value: 'answer', label: '回答或查看计划' }, { value: 'cancel', label: '停止这项请求所属的运行' }]);
    if (action === 'view') await this.approvalPrompt(item.payload.title ?? '待处理的请求', safeTerminalText(item.kind === 'plan' ? item.payload.plan ?? item.payload.question ?? '' : JSON.stringify(item.payload, null, 2)).split('\n'), ['later'], { ...approvalLabels, later: '返回' });
    if (action === 'cancel') {
      const confirm = await this.choose('确认停止？已经发生的外部操作不会撤销。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '停止' }]);
      if (confirm === 'yes') { await this.write(`/interactions/${routeId(item.id)}/cancel`, { expectedRunId: item.runId }); this.pendingInteractions = this.pendingInteractions.filter(row => row.id !== item.id); }
    } else if (action === 'answer') {
      this.interactionOpen = item.id;
      try { await this.answerInteraction(item); } catch (error) { this.postponedInteractions.add(item.id); throw error; } finally { this.interactionOpen = undefined; }
    }
  }
  private readonly postponedApprovals = new Set<string>();
  private approvalOpen?: string;
  private approvalVersion = 0;
  private approvalDeferred = false;
  private async refreshApprovals() {
    const version = ++this.approvalVersion;
    try {
      const { approvals } = await this.request<{ approvals: PublicApproval[] }>('/approvals', { signal: this.lifetime.signal });
      if (this.stopped || version !== this.approvalVersion) return;
      this.pendingApprovals = approvals.filter(row => row.status === 'pending');
      for (const id of this.postponedApprovals) if (!this.pendingApprovals.some(row => row.id === id)) this.postponedApprovals.delete(id);
      if (this.approvalOpen && !this.pendingApprovals.some(row => row.id === this.approvalOpen)) this.pendingModal?.();
      this.status(this.statusText); void this.presentApproval();
    } catch { /* The stream reports connection state; a later state event retries. */ }
  }
  /** Open the oldest unhandled approval, but never over another dialog or a half-typed message. */
  private async presentApproval() {
    if (this.stopped || !this.started || this.approvalOpen || this.modalFlow || this.pendingModal || this.ui.hasOverlay()) return;
    if (this.editor.getText().trim()) { this.approvalDeferred = true; return; }
    // Current context first, then background work in arrival order: delegated tasks wait on the user here.
    const open = this.pendingApprovals.filter(row => !this.postponedApprovals.has(row.id)).sort((a, b) => Number(b.contextId === this.contextId) - Number(a.contextId === this.contextId) || a.createdAt.localeCompare(b.createdAt));
    const approval = open[0];
    if (!approval) return;
    this.approvalOpen = approval.id;
    try { await this.withModalFlow(() => this.decideApproval(approval, true)); }
    catch (error) { if (!this.stopped) this.note(`审批未完成：${approvalError(error)}`); }
    finally { this.approvalOpen = undefined; }
    void this.presentApproval(); void this.presentInteraction();
  }
  private async decideApproval(approval: PublicApproval, automatic = false) {
    const task = approval.taskId ? await this.request<TaskRecord>(`/tasks/${routeId(approval.taskId)}`).catch(() => undefined) : undefined;
    if (this.stopped || !this.pendingApprovals.some(row => row.id === approval.id)) return;
    if (automatic && this.editor.getText().trim()) { this.approvalDeferred = true; return; }
    this.approvalDeferred = false;
    const scopes = approval.allowedScopes ?? ['once'];
    const options: ApprovalChoice[] = ['once', ...(task && scopes.includes('task') ? ['task' as const] : []), ...(task?.occurrenceId && scopes.includes('duty') ? ['duty' as const] : []), 'decline', 'later'];
    const target = approvalTarget(approval.args);
    const body = [
      theme.fg('muted', `上下文 ${label(approval.contextId)}${task ? ` · 任务 ${label(task.title)}` : ''}`),
      ...(target ? [theme.fg('text', safeTerminalText(target))] : []),
      ...(approval.argsDisplayNotice?[theme.fg('warning',safeTerminalText(approval.argsDisplayNotice))]:[]),
      theme.fg('dim', '完整参数：'),
      ...safeTerminalText(approval.argsText??JSON.stringify(approval.args, null, 2)??'').split('\n').map(line => theme.fg('toolOutput', line)),
    ];
    const choice = await this.approvalPrompt(`需要审批 · ${label(approval.toolName)}`, body, options);
    if (this.stopped) return;
    if (!choice || choice === 'later') { this.postponedApprovals.add(approval.id); this.note(`已暂缓审批 ${label(approval.toolName)}；/approvals 可随时处理。`); this.status(this.statusText); return; }
    const decision = choice === 'decline' ? 'decline' : 'approve';
    const scope = choice === 'decline' ? 'once' : choice;
    await this.write(`/approvals/${routeId(approval.id)}`, { decision, scope });
    this.pendingApprovals = this.pendingApprovals.filter(row => row.id !== approval.id);
    this.note(decision === 'approve' ? `已同意 ${label(approval.toolName)}${scope === 'once' ? '' : `（${approvalLabels[choice].replace(/^同意，并/, '')}）`}。` : `已拒绝 ${label(approval.toolName)}。`);
    this.status(this.statusText);
  }
  private approvalPrompt(title: string, body: string[], options: readonly ApprovalChoice[], labels?: Readonly<Record<ApprovalChoice, string>>): Promise<ApprovalChoice | undefined> {
    if (this.stopped || !this.modalScopeCurrent() || this.pendingModal || this.ui.hasOverlay()) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let handle: OverlayHandle;
      const finish = (value?: ApprovalChoice) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); };
      const cancel = () => finish(); this.pendingModal = cancel;
      const prompt = new ApprovalPrompt(title, body, options, finish, () => this.ui.requestRender(), labels);
      handle = this.overlays.openOverlay(prompt, { width: '90%', maxHeight: '80%', margin: 1 });
    });
  }
  private model?: ModelState;
  private guidanceShown = new Set<string>();
  private modelRefresh: Promise<void> = Promise.resolve();
  private modelChange: Promise<void> = Promise.resolve();
  private async readModelState() {
    const context = this.contextId, generation = this.generation;
    const state = await this.request<ModelState>(`/contexts/${routeId(context)}/model`, { signal: this.contextController.signal });
    if (this.stopped || context !== this.contextId || generation !== this.generation) throw new AppError('context_changed', 409);
    if (!state.profileId || (state.contextId && state.contextId !== context)) throw new AppError('invalid_core_response');
    return state;
  }
  private async availableThinking(state: ModelState): Promise<ThinkingLevel[]> {
    if (Array.isArray(state.thinkingLevels)) return supportedLevels(state.thinkingLevels);
    // Compatibility with cores predating the model capability response.
    const { models } = await this.request<{ models: Array<{ id: string; modelId: string; providerId?: string; thinking?: Record<string, unknown> }> }>('/models');
    const profile = models.find(row => row.id === state.profileId);
    if (!profile?.providerId) return supportedLevels(Object.keys(profile?.thinking ?? {}));
    const catalog = await this.request<{ models: Array<{ modelId: string; thinkingLevels?: string[] }> }>(`/provider-models?provider=${routeId(profile.providerId)}`);
    return supportedLevels(catalog.models.find(row => row.modelId === profile.modelId)?.thinkingLevels ?? []);
  }
  private async changeModel(action: (context: string, current: () => boolean) => Promise<void>) {
    const context = this.contextId, generation = this.generation, storage = this.storageGeneration;
    const current = () => !this.stopped && context === this.contextId && generation === this.generation && storage === this.storageGeneration;
    const next = this.modelChange.then(async () => { if (current()) await action(context, current); });
    this.modelChange = next.catch(() => {});
    await next;
  }
  private async refreshModel() {
    const context = this.contextId, generation = this.generation;
    const next = this.modelRefresh.then(async () => {
      if (this.stopped || context !== this.contextId || generation !== this.generation) return;
      try {
        const state = await this.readModelState();
        this.model = state; this.editor.borderColor = text => theme.thinking(state.thinkingLevel ?? 'off', text); this.status(this.statusText);
        if (state.unavailable && this.isMainContext && !this.guidanceShown.has(context)) { this.guidanceShown.add(context); this.modelGuidance(); }
      } catch { /* Older cores have no model endpoint; the footer simply omits the model. */ }
    });
    this.modelRefresh = next;
    await next;
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
  /**
   * Export uses the Core's public projection; native session transfer preserves the complete graph.
   * Public exports exclude hidden reasoning; explicit backups retain continuation records.
   * The file is written by this client, relative to where the TUI was started; existing files are kept.
   */
  private async exportConversation(arg: string) {
    const args = splitCommand(arg); let backup = false, pi = false;
    while (args[0]?.startsWith('--')) { const option = args.shift(); if (option === '--backup' && !backup) backup = true; else if (option === '--pi' && !pi) pi = true; else throw new AppError('export_invalid_arguments'); }
    if (args.length > 1) throw new AppError('export_invalid_arguments');
    if (pi && !this.capabilities.has('pi-session-import')) throw new AppError('pi_session_transfer_unavailable');
    if (backup && !this.capabilities.has('context-continuation')) throw new AppError('context_continuation_unavailable');
    const raw = args[0];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.resolve(this.completionBase, raw || `shittimchest-${label(this.contextName || this.contextId).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60)}-${stamp}.${backup || pi ? 'jsonl' : this.capabilities.has('pi-session-import') ? 'html' : 'md'}`);
    if (backup && !target.endsWith('.jsonl')) throw new AppError('session_backup_requires_jsonl');
    if (pi && !target.endsWith('.jsonl')) throw new AppError('pi_session_export_requires_jsonl');
    if(this.capabilities.has('session-transfer-stream')&&(pi||/\.html?$/i.test(target)||target.endsWith('.jsonl'))){
      const row=this.transferFiles.begin({storageId:this.storageId,direction:'export',file:target,contextId:this.contextId,format:pi||/\.html?$/i.test(target)?'pi':'archive',continuation:backup,...(/\.html?$/i.test(target)?{html:true}:{})});await this.performFileTransfer(row);return;
    }
    if (pi || /\.html?$/i.test(target)) {
      if (!this.capabilities.has('pi-session-import')) throw new AppError('pi_session_transfer_unavailable');
      const { jsonl } = await this.request<{ jsonl: string }>(`/contexts/${routeId(this.contextId)}/export-pi${backup ? '?continuation=1' : ''}`);
      const body = pi ? jsonl : await renderSessionHtml(jsonl);
      try { await writeSessionExport(target, body); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { this.note(`文件已存在，未覆盖：${target}`); return; } throw error; }
      this.note(`${backup ? '已保存会话树工作记录备份' : pi ? '已导出 Pi 会话树' : '已导出 HTML 会话树'}：${target}`); return;
    }
    if (target.endsWith('.jsonl') && this.capabilities.has('context-transfer')) {
      const archive = await this.request<SessionTransferArchive>(`/contexts/${routeId(this.contextId)}/export${backup ? '?continuation=1' : ''}`);
      try { await writeSessionExport(target, encodeSessionArchive(archive)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { this.note(`文件已存在，未覆盖：${target}`); return; } throw error; }
      this.note(`${backup ? '已保存工作记录备份' : `已导出 ${archive.messages.length} 条消息`}：${target}`); return;
    }
    const context = this.contextId; const messages: ConversationMessage[] = [];
    let page = await this.client.conversation(context, undefined, this.lifetime.signal);
    for (;;) {
      messages.push(...page.messages);
      if (!page.hasMore || !page.nextCursor) break;
      const cursor = page.nextCursor; page = await this.client.conversation(context, cursor, this.lifetime.signal);
      if (page.hasMore && page.nextCursor === cursor) throw new AppError('history_pagination_stalled');
    }
    const shown = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.status !== 'cancelled' && message.status !== 'rejected');
    if (/(?:^|[\\/])\.private(?:[\\/]|$)/i.test(target)) throw new AppError('export_private_path');
    const jsonl = target.endsWith('.jsonl');
    const body = jsonl
      ? shown.map(message => JSON.stringify({ id: message.id, role: message.role, kind: message.kind, createdAt: message.createdAt, runId: message.runId, content: message.content, ...(message.originContextId ? { originContextId: message.originContextId } : {}) })).join('\n') + '\n'
      : [`# ${this.contextName || context}`, '', `导出时间：${new Date().toLocaleString()} · 上下文 ${context}`, '',
        ...shown.flatMap(message => [`## ${message.role === 'user' ? '用户' : message.kind === 'artifact' ? '交付' : '阿罗娜'}${message.createdAt ? ` · ${new Date(message.createdAt).toLocaleString()}` : ''}`, '', message.content, ''])].join('\n');
    try { await writeSessionExport(target, body); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { this.note(`文件已存在，未覆盖：${target}`); return; } throw error; }
    this.note(`已导出 ${shown.length} 条消息：${target}`);
  }
  private async importConversation(arg: string) {
    const args = splitCommand(arg); if (args.length > 1) throw new AppError('import_invalid_arguments');
    const raw = args[0] ?? await this.prompt('本机 JSONL 文件路径');
    if (!raw?.trim()) return;
    const source = path.resolve(this.completionBase, raw.trim());
    if(this.capabilities.has('session-transfer-stream')){
      const confirm=await this.choose(`将「${label(path.basename(source))}」中的完整会话导入为独立对话？`,[{value:'no',label:'返回'},{value:'yes',label:'导入'}]);if(confirm!=='yes')return;
      const{contexts}=await this.request<{contexts:ContextRecord[]}>('/contexts'),workspaceId=contexts.find(row=>row.id===this.contextId)?.workspaceId;
      const row=this.transferFiles.begin({storageId:this.storageId,direction:'import',file:source,importOptions:workspaceId?{workspaceId}:{}});await this.performFileTransfer(row);return;
    }
    const imported = decodeSessionImport(await readSessionText(source));
    if (imported.format === 'pi') {
      if(imported.requiredCapabilities?.some(required=>!this.capabilities.has(required))){this.note('当前核心版本不能完整读取此文件中的附件资料。请连接支持该文件的核心后重试，本机原文件已保留。');return;}
      if (!this.capabilities.has('pi-session-import')) throw new AppError('pi_session_transfer_unavailable');
      const confirm = await this.choose(`将「${label(path.basename(source))}」的 Pi 会话树导入为独立对话？`, [{ value: 'no', label: '返回' }, { value: 'yes', label: '导入' }]);
      if (confirm !== 'yes') return;
      const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
      const workspaceId = contexts.find(context => context.id === this.contextId)?.workspaceId;
      const created = await this.write('/contexts/import-pi', { jsonl: imported.jsonl, ...(workspaceId ? { workspaceId } : {}) }) as ContextRecord;
      this.switchContext(created.id); return;
    }
    const archive = imported.archive;
    const confirm = await this.choose(`导入「${label(archive.context.name)}」的 ${archive.messages.length} 条消息为独立对话？`, [{ value: 'no', label: '返回' }, { value: 'yes', label: '导入' }]);
    if (confirm !== 'yes') return;
    const created = await this.write('/contexts/import', { archive }) as ContextRecord;
    this.switchContext(created.id);
  }
  private fileTransferController?:AbortController;
  private async performFileTransfer(input:LocalSessionTransfer){
    if(input.storageId!==this.storageId)throw new AppError('core_storage_changed',409);if(this.fileTransferController)throw new AppError('session_transfer_busy',409);
    const controller=new AbortController(),originContext=this.contextId,originGeneration=this.generation;this.fileTransferController=controller;let row=input,last='';const signal=AbortSignal.any([controller.signal,this.lifetime.signal,...(this.modalController?[this.modalController.signal]:[])]);
    const progress=(job:SessionTransferJob)=>{row=this.transferFiles.progress(row,job);const states:Record<SessionTransferJob['state'],string>={uploading:'上传中',uploaded:'已传完，等待校验',preparing:'正在准备完整会话',validating:'正在校验',publishing:'正在导入会话',ready:'核心文件已准备，正在保存到本机',completed:row.direction==='import'?'核心导入已完成':'核心文件已准备',failed:'未完成',cancelled:'已取消'},percent=job.bytes?Math.floor(job.receivedBytes/job.bytes*10)*10:0,key=job.state+':'+percent+':'+Boolean(job.waitingForCapacity);if(key!==last&&!this.stopped&&input.storageId===this.storageId){last=key;this.note(`${job.waitingForCapacity?'已保存，等待文件处理资源':states[job.state]}${job.state==='uploading'?` ${percent}%`:''}；Esc 可取消。`);}};
    try{
      const options={operationId:row.operationId,signal,onProgress:progress};let job:SessionTransferJob;
      if(row.direction==='import')job=await this.client.importSessionFile(row.file,row.importOptions??{},options);
      else{const staged=row.html?path.join(path.dirname(row.file),`.session-${row.operationId}.jsonl`):row.file;job=await this.client.exportSessionFile(staged,{contextId:row.contextId!,format:row.format!,continuation:row.continuation},options);if(row.html){signal.throwIfAborted();await renderSessionFileHtml(staged,row.file);await fs.promises.unlink(staged);}}
      row=this.transferFiles.save({...row,jobId:job.id,state:job.state,localComplete:true,updatedAt:new Date().toISOString()});if(this.stopped||row.storageId!==this.storageId)return;
      const unavailable=job.warnings?.filter(warning=>warning.code==='history_artifacts_unavailable').reduce((sum,warning)=>sum+warning.count,0)??0,notice=unavailable?`其中 ${unavailable} 项原件不可用，已保留来源与校验信息。`:'';
      if(row.direction==='import'){const open=originContext===this.contextId&&originGeneration===this.generation;if(job.result&&open)await this.switchContext(job.result.id);this.note(`${unavailable?'会话已导入':'完整会话已导入'}${open?'。':'，可从 /transfers 打开。'}${notice}`);}else this.note(`${unavailable?'会话归档':'完整会话'}已保存：${editorDisplayText(row.file)}${notice?`\n${notice}`:''}`);
    }catch(error){
      if(error instanceof AppError&&error.code==='session_data_feature_unsupported'){this.transferFiles.save({...row,errorCode:error.code,updatedAt:new Date().toISOString()});if(!this.stopped)this.note('当前核心版本不能完整读取此文件中的附件资料。请连接支持该文件的核心后，从 /transfers 继续。本机原文件已保留。');return;}
      if(controller.signal.aborted&&row.jobId&&!this.stopped&&row.storageId===this.storageId){try{const result=await this.client.request<{transfer:SessionTransferJob}>(`/session-transfers/${row.jobId}`,{method:'DELETE',signal:this.lifetime.signal,headers:{'X-ShittimChest-Storage-Id':row.storageId}});row=this.transferFiles.progress(row,result.transfer);if(result.transfer.state==='completed'&&row.direction==='import'){this.transferFiles.save({...row,localComplete:true,updatedAt:new Date().toISOString()});this.note('取消前会话已完成导入，可从 /transfers 查看。');return;}}catch{}}
      if(!this.stopped)this.note(`${controller.signal.aborted?'已请求取消':'会话文件操作未完成'}：${label(error instanceof AppError?error.code:'connection_failed')}。本机文件和操作记录保留，可从 /transfers 继续核对。`);
    }finally{if(this.fileTransferController===controller)this.fileTransferController=undefined;}
  }
  private async fileTransfers(){
    const local=this.transferFiles.list(this.storageId),jobs:SessionTransferJob[]=[];let after:string|undefined;
    for(;;){const page=await this.request<{jobs:SessionTransferJob[];nextCursor:string|null}>(`/session-transfers${after?`?after=${routeId(after)}`:''}`,{headers:{'X-ShittimChest-Storage-Id':this.storageId}});jobs.push(...page.jobs);if(!page.nextCursor)break;after=page.nextCursor;}
    const status=(job?:SessionTransferJob,row?:LocalSessionTransfer)=>{const state=job?.state??row?.state,labels:Record<SessionTransferJob['state'],string>={uploading:'正在上传',uploaded:'已上传，等待校验',preparing:'正在准备',validating:'正在校验',publishing:'正在导入',ready:'核心文件已准备',completed:(job?.direction??row?.direction)==='import'?'已导入':'核心已确认文件',failed:'未完成',cancelled:'已取消'},count=(job?.warnings??row?.warnings)?.reduce((sum,warning)=>sum+warning.count,0)??0;return `${row?.localComplete?(row.direction==='import'?'已导入':'已保存到本机'):state?labels[state]:'尚未确认'}${count?` · ${count} 项原件不可用`:''}`;};
    const known=new Set(local.flatMap(row=>row.jobId?[row.jobId]:[])),selected=await this.pick('会话文件传输',[...local.map(row=>({value:row.operationId,label:`${row.direction==='import'?'导入':'导出'} · ${label(editorDisplayText(path.basename(row.file)))}`,description:`${status(jobs.find(job=>job.id===row.jobId),row)} · ${row.operationId.slice(0,8)}`})),...jobs.filter(job=>!known.has(job.id)).map(job=>({value:job.id,label:`${job.direction==='import'?'导入':'导出'} · ${job.id.slice(0,8)}`,description:status(job)}))],'没有会话文件传输记录。');if(!selected)return;
    const row=local.find(value=>value.operationId===selected),job=jobs.find(value=>value.id===(row?.jobId??selected)),action=await this.choose(row?label(row.file):selected,[...(row&&!row.localComplete&&(job?.state!=='cancelled'||row.direction==='export'&&job.readyAt)?[{value:'resume',label:job?.state==='cancelled'?'核对已保存的文件':'继续此文件操作'}]:[]),...(job?.result?[{value:'open',label:'打开已导入的对话'}]:[]),...(job&&!['completed','cancelled'].includes(job.state)?[{value:'cancel',label:'取消传输'}]:[]),{value:'back',label:'返回'}]);
    if(action==='resume'&&row)await this.performFileTransfer(row);else if(action==='open'&&job?.result)await this.switchContext(job.result.id);else if(action==='cancel'&&job){const result=await this.write(`/session-transfers/${job.id}`,{},'DELETE') as {transfer:SessionTransferJob};if(row)this.transferFiles.progress(row,result.transfer);this.note(result.transfer.state==='completed'?'此会话操作已完成。':result.transfer.state==='cancelled'?'已取消。':'取消请求已保存，正在等待确认。');}
  }
  private compactController?: AbortController;
  private automaticCompaction = false;
  private afterLoad?: () => void;
  private readonly compactHinted = new Set<string>();
  private async compact(instructions = '') {
    if (!this.isMainContext) { this.note('只能压缩交流上下文。'); return; }
    if (this.currentRunId) { this.note('当前运行结束后再压缩。'); return; }
    const source = this.contextId; const controller = new AbortController(); this.compactController = controller;
    const loader = new Loader(this.ui, text => theme.fg('accent', text), text => theme.fg('muted', text), '正在压缩较早对话… Esc 取消');
    this.workingSlot.clear(); this.workingSlot.addChild(loader); loader.start();
    try {
      const inPlace = this.capabilities.has('context-tree');
      const result = await this.request<{ context: ContextRecord; summary: string; summarizedMessages: number; keptMessages: number }>(`/contexts/${routeId(source)}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(instructions ? { instructions } : {}), ...(inPlace ? { inPlace: true } : {}) }), signal: controller.signal, timeoutMs: 600_000 });
      if (this.stopped) return;
      // The card is drawn once the derived context has loaded, so the reload does not wipe it.
      this.afterLoad = () => {
        this.transcript.addChild(new Spacer(1));
        this.transcript.addChild(new Text(theme.fg('customMessageLabel', theme.bold(`已压缩：摘要 ${result.summarizedMessages} 条较早消息，原样保留最近 ${result.keptMessages} 条`)), 1, 0));
        this.transcript.addChild(new Text(theme.fg('muted', inPlace ? '仍在当前会话；原始记录和压缩节点可用 /tree 查看。' : `原上下文 ${label(source)} 未修改，可用 /sessions 返回。`), 1, 0));
        this.transcript.addChild(new Markdown(safeTerminalText(result.summary), 1, 0, markdownTheme));
      };
      this.switchContext(result.context.id);
    } catch (error) {
      if (controller.signal.aborted) this.note('已取消压缩，原上下文未修改。');
      else if (error instanceof AppError && error.code === 'compaction_not_needed') this.note('对话还很短，没有需要压缩的较早内容。');
      else throw error;
    } finally { loader.stop(); if (this.compactController === controller) this.compactController = undefined; if (!this.working) this.workingSlot.clear(); }
  }
  /** Ctrl+P, as in Pi: next configured model for this context; the session thinking override is kept when supported. */
  private async cycleModel(direction: 1 | -1 = 1) {
    if (!this.isMainContext) { this.note('当前上下文无法切换模型。'); return; }
    await this.changeModel(async (context, current) => {
      const { models } = await this.request<{ models: Array<{ id: string; name: string }> }>('/models');
      if (!current()) return;
      if (models.length < 2) { this.note(models.length ? '只有一个已配置的模型。' : '还没有已配置的模型；/login 或 /menu → 配置模型。'); return; }
      const state = await this.readModelState();
      const index = models.findIndex(row => row.id === state.profileId);
      const nextIndex = index < 0 ? direction === 1 ? 0 : models.length - 1 : (index + direction + models.length) % models.length;
      const next = models[nextIndex]!;
      if (!current()) return;
      await this.write(`/contexts/${routeId(context)}/model`, { profileId: next.id });
      if (!current()) return;
      await this.refreshModel(); this.note(`已切换到 ${label(next.name)}${this.model?.thinkingLevel ? `（思考：${label(this.model.thinkingLevel)}）` : ''}，用于后续请求。`);
    });
  }
  /** Shift+Tab, as in Pi: step through the levels the current model supports and apply to later requests. */
  private async cycleThinking() {
    if (!this.isMainContext) { this.note('当前上下文无法切换思考等级。'); return; }
    await this.changeModel(async (context, current) => {
      const state = await this.readModelState();
      const levels = await this.availableThinking(state);
      if (!current()) return;
      if (levels.length < 2) { this.note(levels.length ? '当前模型不支持切换思考等级。' : '当前模型尚未声明可用的思考等级。'); return; }
      const next = state.nextThinkingLevel ?? levels[(levels.indexOf(state.thinkingLevel ?? 'off') + 1) % levels.length]!;
      await this.write(`/contexts/${routeId(context)}/model`, { profileId: state.profileId, thinkingLevel: next });
      if (!current()) return;
      await this.refreshModel(); this.note(`思考等级：${this.model?.thinkingLevel ?? next}（用于后续请求）`);
    });
  }
  private async selectThinking(argument = '') {
    const state = await this.readModelState();
    const context = this.contextId, generation = this.generation;
    const levels = await this.availableThinking(state);
    if (this.stopped || context !== this.contextId || generation !== this.generation) return;
    let level = argument.toLowerCase();
    if (!level) {
      const automatic = state.source !== 'session';
      const descriptions: Record<ThinkingLevel, string> = { off: '关闭思考', minimal: '最少', low: '较少', medium: '均衡', high: '较多', xhigh: '更充分', max: '最多' };
      level = await this.choose(`思考等级 · ${label(state.name)} · 当前 ${state.thinkingLevel ?? '供应商默认'}`, [
        { value: 'default', label: `${automatic ? '✓ ' : ''}default`, description: state.defaultThinkingLevel ? `模型默认：${state.defaultThinkingLevel}` : '使用供应商默认' },
        ...levels.map(value => ({ value, label: `${!automatic && value === state.thinkingLevel ? '✓ ' : ''}${value}`, description: `${descriptions[value]}${value === state.thinkingLevel ? ' · 当前生效' : ''}` })),
      ]) ?? '';
      if (!level) return;
    }
    if (context !== this.contextId || generation !== this.generation) return;
    if (level !== 'default' && !thinkingCommandLevels.includes(level as ThinkingLevel)) { this.note(`不支持的思考等级：${label(level)}${levels.length ? `；当前模型可用：${levels.join('、')}` : '；当前模型尚未声明可用等级'}`); return; }
    await this.changeModel(async (_context, current) => {
      const latest = await this.readModelState();
      if (!current() || latest.profileId !== state.profileId) { this.note('模型已变更，请重新选择思考等级。'); return; }
      await this.write(`/contexts/${routeId(context)}/model`, { profileId: state.profileId, thinkingLevel: level === 'default' ? null : level });
      if (!current()) return;
      await this.refreshModel();
      const effective = this.model?.thinkingLevel ?? level;
      this.note(level === 'default' ? `已使用模型默认${this.model?.thinkingLevel ? `：${this.model.thinkingLevel}` : ''}。`
        : effective === level ? `思考等级已设为 ${effective}，将用于后续请求。` : `已保存 ${level} 的思考偏好；当前模型使用 ${effective}。`);
    });
  }
  private setUserState(row: { view: Text; status: string }, status: string) {
    if (row.status === status) return;
    row.status = status; row.view.setText(userMessageState(status)); this.ui.requestRender();
  }
  private editor: Editor;
  private readonly projectSkills = new Map<string, ProjectSkillSummary[]>();
  private skillVersion = 0;
  private readonly editors = new Map<string, Editor>();
  private readonly seededHistory = new Set<string>();
  private readonly completionBase: string;
  private readonly completionFdPath?: string;
  private completionRevision = 0;
  private automaticWebDraft?: { storageId?: string; config: AutomaticWebConfiguration };
  private readonly clipboard?: NativeClipboard;
  private overlays: ReturnType<typeof createOverlayHandlers>;
  private contextId: string;
  private currentRunId?: string;
  private queueCount = 0;
  private queueRefreshVersion = 0;
  private queueRefreshTask?:Promise<void>;
  private queueRefreshRequested=false;
  private statusText = '连接中';
  private usageText = '';
  private capacityText = '';
  private isMainContext = false;
  private contextRole?: ContextRole;
  private contextName = '';
  private workingSet?: ContextRecord['workingSet'];
  private contextReady = false;
  private cursor = 0;
  private storageId = '';
  private storageGeneration = 0;
  private instanceId = '';
  private readonly lifetime = new AbortController();
  private capabilities = new Set<string>();
  private contextController = new AbortController();
  private streamController?: AbortController;
  private seen = new Set<string>();
  private readonly drafts = new Map<string, { view: Container; body: Markdown; text: string; signalId: string }>();
  private readonly toolCards = new Map<string, ToolCard>();
  private readonly pendingToolResults=new Map<string,ToolResultIdentity>();
  private toolResultRefresh?:{generation:number;again:boolean};
  private toolResultRetry?:ReturnType<typeof setTimeout>;
  private toolResultRetryDelay=500;
  private generation = 0;
  private stopped = false;
  private started = false;
  private stopTask?: Promise<void>;
  private externalTask?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private pendingModal?: () => void;
  private loginDialog?: LoginDialogComponent;
  private sessionSelector?: Component & { dispose?(): void };
  private treeFilterMode: FilterMode = 'default';
  private treeNavigationController?: AbortController;
  private modalFlow?: symbol;
  private readonly modalScope = new AsyncLocalStorage<{ storageId: string; generation: number; controller: AbortController }>();
  private modalController?: AbortController;
  private modalScopeCurrent() {
    const scope = this.modalScope.getStore();
    return !scope || (scope.storageId === this.storageId && scope.generation === this.storageGeneration);
  }
  /** A flow owns its network gaps as well as its visible dialogs. */
  private async withModalFlow<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (this.stopped || this.modalFlow || this.pendingModal || this.ui.hasOverlay()) return undefined;
    const owner = Symbol(); this.modalFlow = owner;
    const scope = { storageId: this.storageId, generation: this.storageGeneration, controller: new AbortController() };
    this.modalController = scope.controller;
    try { return await this.modalScope.run(scope, action); }
    finally {
      if (this.modalFlow === owner) { this.modalFlow = undefined; this.modalController = undefined; }
      queueMicrotask(() => { void this.presentApproval(); void this.presentInteraction(); });
    }
  }
  private readonly recoverableDrafts = new Map<string, RecoverableDraft>();
  private readonly restoredDrafts = new WeakMap<Editor, RecoverableDraft>();
  private readonly queueCaptureInputs=new WeakMap<Editor,{id:string;storageId:string;contextId:string;content:string;attachments:string[];shell:string[];captureQueue?:boolean;saved?:{content:string;attachments:string[];localContext:string}}>();
  private queueEditing?:QueueEditingControls;
  private queueEditingCapabilities='';
  private readonly verifiedQueueCaptures=new Set<string>();
  private readonly editExternal = editExternally;
  private readonly openWebUrl = openWebUrl;
  private readonly pendingAttachments = new Map<string, AssetInfo[]>();
  private readonly visibleAttachments = new Map<string, Set<string>>();
  private readonly lastAssistant = new Map<string, string>();
  private readonly uncertainWrites = new Map<string, string>();
  private readonly onSignal = () => { void this.stop(); };
  private done!: () => void;
  private readonly completion = new Promise<void>(resolve => { this.done = resolve; });

  private readonly preferences?: TuiPreferences;
  private readonly inputHistory:TuiInputHistory;
  private readonly queueEdits:QueueLocalEdits;
  private readonly transferFiles:SessionTransferFiles;
  private readonly shellOutputs:ShellOutputCaptures;
  private readonly answerDrafts?: InteractionAnswerDrafts;
  private readonly resumePrevious: boolean;
  private resumeCandidate?: { storageId: string; fallbackContextId: string };
  constructor(private readonly client: Client, contextId = 'main', terminal: Terminal = new ProcessTerminal(), options: { completionBase?: string; fdPath?: string; clipboard?: NativeClipboard; theme?: Theme; preferences?: TuiPreferences; inputHistory?:TuiInputHistory; answerDrafts?: InteractionAnswerDrafts; queueEdits?:QueueLocalEdits; transferFiles?:SessionTransferFiles;shellOutputs?:ShellOutputCaptures; resume?: boolean } = {}) {
    this.preferences = options.preferences; this.resumePrevious = options.resume ?? false;
    this.answerDrafts = options.answerDrafts;
    this.inputHistory=options.inputHistory??new TuiInputHistory();
    this.queueEdits=options.queueEdits??new QueueLocalEdits();
    this.transferFiles=options.transferFiles??new SessionTransferFiles();
    this.shellOutputs=options.shellOutputs??new ShellOutputCaptures();
    const appearance = this.preferences?.read().appearance;
    this.treeFilterMode = this.preferences?.read().treeFilterMode ?? 'default';
    applyTheme(options.theme ?? (appearance === 'plain' ? plainTheme : terminal instanceof ProcessTerminal && colorEnabled() ? new Theme(appearance ?? detectAppearance()) : plainTheme));
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
      if (isKeyRelease(data)) return undefined;
      if (isRepeatedCopyOrInterrupt(data)) return { consume: true };
      if (isMacCopyShortcut(data)) { if (this.ui.hasActiveSelection()) void this.copySelection(); return { consume: true }; }
      if (this.loginDialog || this.sessionSelector || this.ui.hasOverlay()) return undefined;
      if (editorTakesPriority(this.editor, data)) return undefined;
      if (matchesKey(data, Key.ctrl('g'))) { void this.withModalFlow(() => this.externalEditor()).catch(error => { if (!this.stopped) this.note(`外部编辑器失败：${label(error instanceof AppError ? error.code : 'editor_failed')}`); }); return { consume: true }; }
      if ((matchesKey(data, Key.ctrl('v')) || matchesKey(data, Key.alt('v'))) && this.capabilities.has('attachments')) { void this.withModalFlow(() => this.clipboardPaste()); return { consume: true }; }
      if (matchesKey(data, Key.ctrlShift('c')) || matchesKey(data, Key.ctrl('x'))) { void this.copySelectionOrLast(); return { consume: true }; }
      if (!this.editor.isShowingAutocomplete() && (matchesKey(data, Key.alt('enter')) || matchesKey(data, Key.ctrl('q')))) { void this.followUp(); return { consume: true }; }
      if (matchesKey(data, Key.alt('up')) || matchesKey(data, Key.alt('q'))) { void this.restoreQueue(); return { consume: true }; }
      if (matchesKey(data, Key.shift('tab')) && !this.editor.isShowingAutocomplete()) { void this.cycleThinking().catch(error => { if (!this.stopped) this.note(`切换失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('o'))) { this.toggleAllTools(); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('z'))) { this.suspend(); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('t'))) { this.toggleThinking(); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('p'))) { void this.cycleModel().catch(error => { if (!this.stopped) this.note(`切换失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }); return { consume: true }; }
      if (matchesKey(data, Key.ctrlShift('p')) || (process.platform === 'win32' && matchesKey(data, Key.alt('p')))) { void this.cycleModel(-1).catch(error => { if (!this.stopped) this.note(`切换失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }); return { consume: true }; }
      if (matchesKey(data, Key.ctrl('l'))) { void this.withModalFlow(() => this.models()).catch(error => { if (!this.stopped) this.note(`操作失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }); return { consume: true }; }
      // Esc stops the running reply (Pi's app.interrupt); with completions open it belongs to the editor.
      if (matchesKey(data, Key.escape) && this.treeNavigationController) { this.treeNavigationController.abort(); return { consume: true }; }
      if (matchesKey(data, Key.escape) && this.fileTransferController) { this.fileTransferController.abort(new AppError('session_transfer_cancelled',409)); return { consume: true }; }
      if (matchesKey(data, Key.escape) && this.compactController) { this.compactController.abort(); return { consume: true }; }
      if (matchesKey(data, Key.escape) && this.shellController && !this.editor.isShowingAutocomplete()) { this.shellController.abort(); return { consume: true }; }
      if (matchesKey(data, Key.escape) && !this.editor.isShowingAutocomplete() && this.currentRunId && this.isMainContext) { this.stopForeground(); return { consume: true }; }
      if (matchesKey(data, Key.escape) && !this.editor.isShowingAutocomplete() && this.bashMode) { this.editor.setText(''); this.ui.requestRender(); return { consume: true }; }
      if (matchesKey(data, Key.escape) && !this.editor.isShowingAutocomplete() && !this.editor.getText().trim()) {
        if (Date.now() - this.lastEscape < 500) { this.lastEscape = 0; void this.withModalFlow(() => this.capabilities.has('context-tree') ? this.sessionControls().tree() : this.contexts()); }
        else this.lastEscape = Date.now();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl('d')) && !this.editor.getText()) { void this.stop(); return { consume: true }; }
      if (!matchesKey(data, Key.ctrl('c'))) return undefined;
      if (this.editor.isShowingAutocomplete()) return undefined;
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
    const editor = new TerminalEditor(this.ui, liveEditorTheme, { paddingX: 1 });
    this.configureCompletions(editor);
    editor.onSubmit = text => { void this.submit(text, undefined, editor).finally(() => { if (this.approvalDeferred) void this.presentApproval(); void this.presentInteraction(); }); };
    editor.onChange = text => {
      if (editor !== this.editor) return;
      if(this.queueCaptureInputs.has(editor))try{this.cacheQueueCapture(editor);}catch{this.note('本机队列输入保存失败；当前编辑器中的文字仍保留。');}
      if (!text.trim() && this.approvalDeferred) void this.presentApproval();
      if (!text.trim()) void this.presentInteraction();
      // Pi colours the editor border in bash mode so a leading ! is never sent by surprise.
      const bash = text.trimStart().startsWith('!');
      if (bash !== this.bashMode) { this.bashMode = bash; editor.borderColor = bash ? (value => theme.fg(text.trimStart().startsWith('!!') ? 'dim' : 'warning', value)) : (value => theme.thinking(this.model?.thinkingLevel ?? 'off', value)); this.ui.requestRender(); }
    };
    return editor;
  }
  private configureCompletions(editor: Editor) {
    const argumentCommands = new Set(['think', 'model', 'sessions', 'login', 'logout', 'skill']);
    const commands: SlashCommand[] = tuiCommands.flatMap(command => [command.name, ...(command.aliases ?? [])].map(name => ({ name, description: command.description,
      argumentHint: command.usage?.slice(command.usage.indexOf(' ') + 1),
      ...(argumentCommands.has(command.name) ? { getArgumentCompletions: (prefix: string) => this.commandCompletions(command.name, prefix) }
        : command.completions ? { getArgumentCompletions: (prefix: string) => command.completions!.filter(value => value.startsWith(prefix.toLowerCase())).map(value => ({ value, label: value })) } : {}) })));
    if (this.capabilities.has('workspace-skill-invoke')) for (const skill of this.projectSkills.get(this.contextId) ?? []) if (skill.enabled && skill['user-invocable'] !== false) commands.push({ name: `skill:${skill.name}`, description: skill.description });
    const supported = (name: string) => { const command = tuiCommands.find(entry => entry.name === name || entry.aliases?.includes(name)); return !command?.capability || this.capabilities.has(command.capability); };
    const native = new CombinedAutocompleteProvider(commands, this.completionBase, this.completionFdPath);
    editor.setAutocompleteProvider(new ProjectAutocomplete(native, new SafeAutocomplete(native, this.completionBase, supported), {
      client: this.client,
      scope: () => ({ contextId: this.contextId, storageId: this.storageId, instanceId: this.instanceId, generation: this.generation, revision: this.completionRevision, projectCompletions: this.capabilities.has('project-path-completion'), ready: this.contextReady }),
    }));
  }
  private async commandCompletions(command: string, prefix: string): Promise<AutocompleteItem[] | null> {
    const context = this.contextId, generation = this.generation;
    const entry = tuiCommands.find(item => item.name === command);
    if (entry?.capability && !this.capabilities.has(entry.capability)) return null;
    let items: AutocompleteItem[];
    try {
      if (command === 'think') {
        const state = this.model ?? await this.readModelState();
        const levels = await this.availableThinking(state);
        items = [...levels.map(value => ({ value, label: value, description: value === state.thinkingLevel ? '当前生效' : undefined })),
          { value: 'default', label: 'default', description: state.defaultThinkingLevel ? `模型默认：${state.defaultThinkingLevel}` : '使用供应商默认' }];
      } else if (command === 'model') {
        const { models } = await this.request<{ models: Array<{ id: string; name: string; modelId: string }> }>('/models', { signal: this.contextController.signal });
        items = models.map(model => ({ value: model.id, label: model.name, description: model.modelId }));
      } else if (command === 'sessions') {
        const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts', { signal: this.contextController.signal });
        items = contexts.filter(row => !row.archived).map(row => ({ value: row.id, label: row.name, description: row.id === context ? '当前对话' : row.id }));
      } else if (command === 'login' || command === 'logout') {
        const { providers } = await this.request<{ providers: Array<{ id: string; name: string }> }>('/auth/providers', { signal: this.contextController.signal });
        items = providers.map(provider => ({ value: provider.id, label: provider.name, description: provider.id }));
      } else if (command === 'skill') {
        items = (this.projectSkills.get(context) ?? []).filter(skill => skill.enabled && skill['user-invocable'] !== false).map(skill => ({ value: skill.name, label: skill.name, description: skill.description }));
      } else return null;
      if (this.stopped || context !== this.contextId || generation !== this.generation) return null;
      return fuzzyFilter(items, prefix, item => `${item.value} ${item.label} ${item.description ?? ''}`);
    } catch { return null; }
  }
  private async refreshProjectSkills() {
    if (!this.capabilities.has('workspace-skills')) return;
    const context = this.contextId, version = ++this.skillVersion;
    try {
      const { skills } = await this.request<{ skills: ProjectSkillSummary[] }>(`/contexts/${routeId(context)}/skills`, { signal: this.contextController.signal });
      if (this.stopped || context !== this.contextId || version !== this.skillVersion) return;
      this.projectSkills.set(context, skills); this.configureCompletions(this.editor);
    } catch { /* /skills exposes errors when the user explicitly requests management. */ }
  }
  private mountEditor() {
    if (this.sessionSelector) { this.ui.setLayoutRoot(new VStack([{ component: this.sessionSelector, basis: 0, grow: 1, shrink: 1, minSize: 1 }])); if (this.started && !this.ui.hasOverlay()) this.ui.setFocus(this.sessionSelector); return; }
    this.ui.setLayoutRoot(createChatViewport({ header: this.header, transcript: this.scroll, pendingMessages: this.queuePreview, status: this.workingSlot, footer: this.footer, editor: this.loginDialog ?? this.editor, terminal: this.ui.terminal }));
    if (this.started && !this.ui.hasOverlay()) this.ui.setFocus(this.loginDialog ?? this.editor);
  }
  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('terminal_required');
    process.on('SIGINT', this.onSignal); process.on('SIGTERM', this.onSignal);
    try {
      const handshake = protocolHandshakeSchema.safeParse(await this.client.handshake(this.contextController.signal));
      if (this.stopped) return;
      if (!handshake.success || !['snapshot', 'event-stream', 'conversation-history', 'reply-stream'].every(capability => handshake.data.capabilities.includes(capability))) throw new AppError('incompatible_core_protocol');
      this.capabilities = new Set(handshake.data.capabilities);
      const previous = this.preferences?.read();
      if (this.resumePrevious && previous?.storageId === handshake.data.storageId && previous.contextId) {
        const { contexts } = await this.client.request<{ contexts: ContextRecord[] }>('/contexts', { signal: this.contextController.signal });
        if (contexts.some(context => context.id === previous.contextId && !context.archived)) {
          this.resumeCandidate = { storageId: handshake.data.storageId, fallbackContextId: this.contextId };
          this.contextId = previous.contextId; this.editor = this.createEditor(); this.editors.set(this.contextId, this.editor);
          this.overlays = createOverlayHandlers(this.ui, this.editor); this.mountEditor();
        }
      }
      this.ui.setFocus(this.editor); this.started = true; this.ui.start();
      this.status('连接中'); void this.loadContext(this.generation);
      await this.completion;
    } catch (error) { if (!this.stopped) throw error; }
    finally { await this.stop(); }
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true; this.generation++; if (this.timer) clearTimeout(this.timer); if(this.toolResultRetry)clearTimeout(this.toolResultRetry); this.working?.stop(); this.working = undefined;
    if (this.interactionTimer) clearTimeout(this.interactionTimer);
    this.lifetime.abort(); this.contextController.abort(); this.streamController?.abort();
    this.pendingModal?.(); this.modalFlow = undefined; process.removeListener('SIGINT', this.onSignal); process.removeListener('SIGTERM', this.onSignal);
    this.stopTask = (async () => {
      try { await this.externalTask?.catch(() => {}); if (this.started) await this.ui.terminal.drainInput(1000); }
      finally { if (this.started) this.ui.stop(); this.done(); }
    })();
    return this.stopTask;
  }
  private status(text: string) {
    this.statusText = text;
    this.header.setText(`${theme.fg('accent', theme.bold('ShittimChest'))}${theme.fg('muted', ` v${label(appBuildInfo.version)}`)}${theme.fg('dim', '  ·  ')}${label(this.contextName || this.contextId)}${this.contextRole && this.contextRole !== 'main' ? theme.fg('warning', ' · 只读工作上下文') : ''}${this.workingSet ? theme.fg('muted', ' · 派生工作集') : ''}`);
    const attachmentCount = this.pendingAttachments.get(this.contextId)?.length ?? 0;
    const tone = /错误|失败|断开/.test(text) ? 'error' : /处理中|连接中|重连/.test(text) ? 'warning' : 'success';
    const model = this.model ? `${label(this.model.name)} • ${this.model.thinkingLevel ? label(this.model.thinkingLevel) : '思考：供应商默认'}` : '';
    const unanswered = this.pendingInteractions.filter(item => !this.answerDelivery?.hasAnswer(item.id)).length;
    const savedAnswers = this.answerDelivery?.entries().filter(entry => { const receipt = boundAnswerReceipt(entry); return !entry.draft?.cancelAcknowledgedAt && (!receipt || !['delivered', 'cancelled'].includes(receipt.status)); }).length ?? 0;
    const parts = [theme.fg(tone, label(text)), this.capacityText, this.usageText && theme.fg('dim', this.usageText), this.queueCount ? theme.fg('warning', `队列 ${this.queueCount}`) : '', attachmentCount ? theme.fg('dim', `待发送附件 ${attachmentCount}`) : '', unanswered ? theme.fg('warning', `待回答 ${unanswered}`) : '', savedAnswers ? theme.fg('warning', `回答待送达 ${savedAnswers}`) : '', this.pendingApprovals.length ? theme.fg('warning', `待审批 ${this.pendingApprovals.length}`) : '', this.activeTasks ? theme.fg('muted', `后台任务 ${this.activeTasks}`) : '', this.sharedShell.get(this.contextId)?.length ? theme.fg('accent', `待带入命令结果 ${this.sharedShell.get(this.contextId)!.length}`) : '', model && theme.thinking(this.model?.thinkingLevel ?? 'off', model)].filter(Boolean);
    this.footer.setText(`${parts.join(theme.fg('dim', '  ·  '))}\n${theme.fg('dim', '/help 命令  /menu 管理  /quit 退出  ·  Shift+Tab 思考等级  ·  Ctrl+J 换行 · PageUp/PageDown 浏览')}`);
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
      visible.add(id); const line = new Text(theme.fg('muted', `附件 · ${label(id).slice(0, 8)}…`), 1, 0); row.addChild(line);
      // Name, type and size come from the core's metadata; the id is only a placeholder until then.
      void this.request<AssetInfo>(`/assets/${routeId(id)}/metadata`, { signal: this.contextController.signal }).then(info => {
        if (this.stopped || contextId !== this.contextId) return;
        line.setText(theme.fg('muted', `附件 · ${label(info.name)} · ${label(info.mediaType)} · ${formatBytes(info.bytes)}`)); this.ui.requestRender();
      }).catch(() => {});
    }
    this.visibleAttachments.set(contextId, visible);
  }
  private loadContext(generation: number) {
    // The loader and its long-lived stream are not continuations of a management operation.
    return this.modalScope.exit(() => this.loadContextSnapshot(generation));
  }
  private async loadContextSnapshot(generation: number) {
    if (this.stopped || generation !== this.generation) return;
    this.contextReady = false;
    try {
      const context = this.contextId;
      const snapshot = await this.client.snapshot(context, this.contextController.signal, { toolResultContent: true });
      if (this.stopped || generation !== this.generation) return;
      if (snapshot.protocolVersion !== 1 || snapshot.selectedContextId !== context || !Number.isSafeInteger(snapshot.watermark)) throw new AppError('invalid_core_response');
      if (this.resumeCandidate) {
        const candidate = this.resumeCandidate; this.resumeCandidate = undefined;
        if (candidate.storageId !== snapshot.storageId) { this.switchContext(candidate.fallbackContextId); return; }
      }
      const storageChanged = !!this.storageId && this.storageId !== snapshot.storageId;
      const retainedQueueEdits=storageChanged&&this.queueEdits.hasStorage(this.storageId);
      const discardedAttachments = storageChanged && [...this.pendingAttachments.values()].some(items => items.length);
      if (storageChanged) {
        this.storageGeneration++; this.interactionVersion++; this.pendingInteractions = []; this.postponedInteractions.clear(); this.projectSkills.clear(); this.skillVersion++;
        this.answerDelivery = undefined; this.answerCacheProblem = undefined; if (this.interactionTimer) clearTimeout(this.interactionTimer);
        this.modalController?.abort(); this.pendingModal?.();
        for (const [id, editor] of this.editors) {
          const text = editor.getExpandedText(); const attachments = this.pendingAttachments.get(id) ?? []; const shell = this.sharedShell.get(id) ?? [];
          if (text || attachments.length || shell.length) this.rememberDraft({ text, context: id, storageId: this.storageId, attachments: [...attachments], shell: [...shell] });
        }
        this.pendingAttachments.clear(); this.visibleAttachments.clear(); this.lastAssistant.clear(); this.sharedShell.clear(); this.usageText = '';
        const draft = this.editor.getExpandedText(); this.editors.clear(); this.seededHistory.clear(); this.editor = this.createEditor(); this.editor.setText(draft); this.editors.set(context, this.editor);
        this.overlays = createOverlayHandlers(this.ui, this.editor); this.mountEditor();
      }
      this.storageId = snapshot.storageId; this.instanceId = snapshot.instanceId; this.cursor = snapshot.watermark;
      const selectedContext = snapshot.contexts?.find(item => item.id === context);
      if (selectedContext && !selectedContext.archived) this.savePreferences();
      this.contextRole = selectedContext?.role; this.workingSet = selectedContext?.workingSet; this.contextName = selectedContext?.name ?? '';
      this.isMainContext = this.contextRole === 'main';
      this.queueCount = snapshot.queuedMessages?.length ?? 0;
      this.updateCapacity(snapshot.capacity ?? null);
      void this.refreshModel(); void this.refreshUsage();
      this.pendingApprovals = ((snapshot.approvals ?? []) as PublicApproval[]).filter(row => row.status === 'pending');
      this.currentRunId = snapshot.runs?.find(run => run.status === 'running')?.id; if (this.currentRunId) this.runStartedAt = Date.parse(snapshot.runs!.find(run => run.id === this.currentRunId)!.createdAt) || Date.now();
      this.updateWorking();
      this.seen.clear(); this.drafts.clear(); this.toolCards.clear(); this.pendingToolResults.clear(); this.thinkingBlocks.clear(); this.visibleAttachments.delete(context); this.lastAssistant.delete(context); this.failureShown.clear(); this.failureRows.clear(); this.transcript.clear();
      if (discardedAttachments) this.note('核心存储已变化，之前待发送的附件已清除，请重新选择。');
      if(retainedQueueEdits)this.note('核心存储已变化；本机未确认的队列编辑仍保留，未发送到新存储。');
      let page: ConversationPage = snapshot.conversation; const history: Array<{id:string;text:string}> = []; const messages: ConversationMessage[] = [];
      for (;;) {
        for (const message of page.messages) {
          messages.push(message);
          if (!this.seededHistory.has(context) && message.role === 'user' && message.kind === 'message' && ['accepted', 'queued'].includes(message.status) && message.content.trim()) history.push({id:message.id,text:message.content});
        }
        if (!page.hasMore) break;
        if (!page.nextCursor) throw new AppError('invalid_history_cursor');
        const previous = page.nextCursor;
        page = await this.client.conversation(context, previous, this.contextController.signal);
        if (this.stopped || generation !== this.generation) return;
        if (page.hasMore && page.nextCursor === previous) throw new AppError('history_pagination_stalled');
      }
      const tools: ToolActivity[] = [];
      for (const item of snapshot.toolActivity ?? []) {
        if (!item || typeof item !== 'object') continue;
        const tool = item as ToolActivity;
        if (tool.contextId === context && typeof tool.toolCallId === 'string' && tool.toolCallId && typeof tool.toolName === 'string' && ['running', 'finished', 'failed', 'denied'].includes(tool.state)) tools.push(tool);
      }
      const thoughts = new Map((snapshot.thinking ?? []).map(item => [item.runId, item]));
      const timeline = transcriptTimeline(messages, tools, (snapshot.runs ?? []).filter(run => run.contextId === context && run.status === 'failed'));
      for (const entry of timeline) {
        if (entry.message?.role === 'assistant' && entry.message.runId && thoughts.has(entry.message.runId)) { const item = thoughts.get(entry.message.runId)!; thoughts.delete(item.runId); this.thinking(item.runId, item.text); }
        if (entry.message) this.message(entry.message); else if (entry.tool) this.updateTool(entry.tool); else if (entry.failedRun) this.failure(entry.failedRun.errorCode ?? 'model_execution_failed', entry.failedRun.id);
      }
      for (const item of thoughts.values()) this.thinking(item.runId, item.text);
      this.restoreShellObservations();
      for (const draft of snapshot.drafts ?? []) {
        if (!draft || typeof draft !== 'object') throw new AppError('invalid_reply_event');
        const restored = draft as { runId?: unknown; text?: unknown };
        if (typeof restored.runId !== 'string' || typeof restored.text !== 'string') throw new AppError('invalid_reply_event');
        const event = { seq: snapshot.watermark, contextId: context, runId: restored.runId, createdAt: '', data: draft };
        this.replyEvent({ ...event, kind: 'reply.start' }); this.replyEvent({ ...event, kind: 'reply.replace' });
      }
      if (!this.seededHistory.has(context)) { let values=history.slice(-100).map(row=>row.text);try{this.inputHistory.seed(this.storageId,context,history);values=this.inputHistory.list(this.storageId,context);}catch{this.note('本机输入历史暂不可用，当前会话历史仍可用。');}for (const value of values) this.editor.addToHistory(value); this.seededHistory.add(context); }
      this.contextReady = true;
      if (this.coreChanged) { this.coreChanged = false; this.streamLost = false; this.transcript.addChild(new Text(theme.fg('warning', '核心已重启；已重新加载会话与等待中的操作，请核对当前状态。'), 1, 0)); }
      const after = this.afterLoad; this.afterLoad = undefined; after?.();
      void this.presentApproval(); void this.refreshTasks(); void this.refreshInteractions(); void this.refreshProjectSkills();
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
    if ((percent >= 80 || capacity.overBudget) && this.capabilities.has('context-compaction') && !this.compactHinted.has(this.contextId)) { this.compactHinted.add(this.contextId); this.transcript.addChild(new Text(theme.fg('warning', `上下文已用约 ${Math.min(999, Math.round(percent))}%；可用 /compact 摘要较早对话后在新上下文中继续（原文保留）。`), 1, 0)); }
  }
  private updateTool(data: ToolActivity) {
    if (data.contextId !== this.contextId || typeof data.toolCallId !== 'string' || !data.toolCallId || typeof data.toolName !== 'string' || !['running', 'finished', 'failed', 'denied'].includes(data.state)) throw new AppError('invalid_tool_event');
    const key = JSON.stringify([data.contextId, data.runId, data.toolCallId, ...(data.nativeMessageId ? [data.nativeMessageId] : data.runId === null && data.entryId ? [data.entryId] : [])]);
    const existing = this.toolCards.get(key);
    if (existing) existing.update({ ...data, toolName: data.toolName || existing.data.toolName });
    else { const card = new ToolCard(data, () => this.ui.requestRender()); this.toolCards.set(key, card); this.transcript.addChild(card.region); }
    this.ui.requestRender();
  }
  private requestToolResult(data:ToolActivity){
    if(!this.capabilities.has('tool-result-lookup')||data.state==='running')return;
    const identity:ToolResultIdentity={runId:data.runId,toolCallId:data.toolCallId,...(data.nativeMessageId?{nativeMessageId:data.nativeMessageId}:{}),...(data.entryId?{entryId:data.entryId}:{})},key=JSON.stringify([data.contextId,data.runId,data.toolCallId,...(data.nativeMessageId?[data.nativeMessageId]:data.runId===null&&data.entryId?[data.entryId]:[])]);
    if(this.toolCards.get(key)?.data.resultContent!==undefined)return;
    this.toolCards.get(key)?.setResultNotice('正在读取完整工具内容…');
    this.pendingToolResults.set(key,identity);void this.refreshToolResults();
  }
  private async refreshToolResults(){
    if(this.stopped||!this.capabilities.has('tool-result-lookup')||!this.pendingToolResults.size)return;
    const generation=this.generation;if(this.toolResultRefresh?.generation===generation){this.toolResultRefresh.again=true;return;}
    if(this.toolResultRetry){clearTimeout(this.toolResultRetry);this.toolResultRetry=undefined;}
    const state={generation,again:false},contextId=this.contextId,storageId=this.storageId,instanceId=this.instanceId,signal=this.contextController.signal,valid=()=>!this.stopped&&generation===this.generation&&contextId===this.contextId&&storageId===this.storageId&&instanceId===this.instanceId&&!signal.aborted;let retry=false;
    this.toolResultRefresh=state;
    try{const entries=[...this.pendingToolResults];for(let offset=0;offset<entries.length;offset+=4){if(!valid())return;await Promise.all(entries.slice(offset,offset+4).map(async([key,identity])=>{
      try{const result=await this.client.toolResult(contextId,identity,{storageId,instanceId,signal});if(!valid()||this.pendingToolResults.get(key)!==identity)return;
        this.toolResultRetryDelay=500;if(result.availability==='pending')return;this.pendingToolResults.delete(key);const card=this.toolCards.get(key);if(result.availability==='available'&&result.tool){if(card){card.update(result.tool);card.setResultNotice();this.ui.requestRender();}}else card?.setResultNotice('完整工具内容不可用。');
      }catch(error){if(!valid())return;if(!(error instanceof AppError)||error.status>=500||error.status===408||error.status===429){retry=true;this.toolCards.get(key)?.setResultNotice('完整工具内容暂未读到，正在重试…');}else{this.pendingToolResults.delete(key);this.toolCards.get(key)?.setResultNotice('完整工具内容无法读取。');}}
    }));}}
    finally{if(this.toolResultRefresh===state){this.toolResultRefresh=undefined;if(valid()&&this.pendingToolResults.size){if(state.again)void this.refreshToolResults();else if(retry){const delay=this.toolResultRetryDelay;this.toolResultRetryDelay=Math.min(10000,delay*2);this.toolResultRetry=setTimeout(()=>{this.toolResultRetry=undefined;if(valid())void this.refreshToolResults();},delay);}}}}
  }
  private event(event: PublicEvent) {
    // Approvals are global: the footer counts every context and the prompt opens when you enter it.
    if (event.kind === 'state' && (event.data as { area?: string } | undefined)?.area === 'approvals') { void this.refreshApprovals(); return; }
    if (event.kind === 'state' && (event.data as { area?: string } | undefined)?.area === 'tasks') { void this.refreshTasks(); return; }
    if (event.kind === 'state' && (event.data as { area?: string } | undefined)?.area === 'interactions') { void this.refreshInteractions(); return; }
    if (event.kind === 'state' && (event.data as { area?: string } | undefined)?.area === 'configuration') {
      this.completionRevision++;
      void this.refreshModel(); void this.refreshProjectSkills();
      return;
    }
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
    else if (event.kind === 'thinking') { const data = event.data as { delta?: unknown }; if (typeof data?.delta === 'string') this.thinking(event.runId, data.delta); }
    else if (event.kind === 'run') {
      const data = event.data as { state?: string; reason?: string };
      if (data.state === 'running' && event.runId) { this.currentRunId = event.runId; this.runStartedAt = Date.now(); }
      else if (data.state === 'ended' && event.runId === this.currentRunId) { this.currentRunId = undefined; this.automaticCompaction = false; }
      if (data.state === 'ended' && data.reason === 'aborted') this.transcript.addChild(new Text(theme.fg('warning', '已停止当前回复。已经发生的工具操作不会自动撤销。'), 1, 0));
      if (data.state === 'ended' && data.reason === 'error' && !this.failureShown.has(event.runId ?? '')) this.failure('model_execution_failed', event.runId);
      if(data.state==='ended')void this.refreshToolResults();
      this.updateWorking();
      this.status(data.state === 'running' ? '处理中' : `已连接${data.reason === 'error' ? ' · 运行失败' : ''}`);
    } else if (event.kind === 'tool') {
      const data = event.data as Omit<ToolActivity, 'contextId' | 'runId'>;
      this.updateTool({ ...data, contextId: event.contextId, runId: event.runId });
      this.requestToolResult({...data,contextId:event.contextId,runId:event.runId});
      this.status(`工具 ${label(data.toolName)} · ${label(data.state)}`);
    } else if (event.kind === 'compaction') {
      const data = event.data as { state?: string; coveredMessages?: number; code?: string };
      if (data.state === 'running') {
        this.automaticCompaction = true; this.note('正在自动整理较早上下文，原始记录会保留。'); this.status('正在整理上下文');
      } else if (data.state === 'finished') {
        this.automaticCompaction = false; this.capacityText = ''; this.compactHinted.delete(this.contextId);
        this.note(`较早上下文已整理${typeof data.coveredMessages === 'number' ? `（${data.coveredMessages} 条记录）` : ''}，继续当前工作。`); this.status(this.currentRunId ? '处理中' : '已连接');
      } else if (data.state === 'failed') {
        this.automaticCompaction = false;
        this.note(data.code === 'compaction_cancelled' ? '已取消上下文整理，原始记录保留。' : '上下文整理未完成，原始记录保留；/context 查看容量，/compact 可手动整理。'); this.status(this.currentRunId ? '处理中' : '已连接');
      }
    } else if (event.kind === 'capacity') {
      this.updateCapacity(event.data as ContextCapacity); this.status(this.statusText);
    } else if (event.kind === 'usage') {
      // Each event is one model step; the footer shows the context's running total.
      if (event.data && typeof event.data === 'object') { addUsage(this.usageTotal, event.data as Record<string, unknown>); this.usageText = usageLine(this.usageTotal); this.status(this.statusText); }
    } else if (event.kind === 'state') {
      const data = event.data as { area?: string; selectedPathChanged?: boolean };
      if (data?.area === 'session-tree') { if (data.selectedPathChanged && !this.treeNavigationController && !this.compactController) this.switchContext(this.contextId);else void this.refreshToolResults(); }
      else if (data?.area === 'message-queue') void this.refreshQueue();
      else if (data?.area === 'approvals') void this.refreshApprovals();
      else if (data?.area === 'tasks') void this.refreshTasks();
      else if (data?.area === 'contexts' || data?.area === 'configuration') {
        void this.refreshModel();
        const context = this.contextId;
        void this.request<{ contexts: ContextRecord[] }>('/contexts', { signal: this.contextController.signal }).then(({ contexts }) => {
          const row = contexts.find(item => item.id === context); if (row && context === this.contextId && !this.stopped) { this.contextName = row.name; this.status(this.statusText); }
        }).catch(() => {});
      }
    } else if (event.kind === 'error') { const data = event.data as { code?: string; retryable?: boolean }; this.failure(label(data?.code ?? 'model_execution_failed'), event.runId, data?.retryable); this.status('运行发生错误'); }
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
  private renderQueue(rows: Array<Pick<SignalRecord, 'content' | 'attachments'>>, drafts:QueueEditDocument[]=[],totalCount=rows.length) {
    this.queuePreview.clear();
    const local=this.capabilities.has('message-queue-editor')?this.queueEdits.captures(this.storageId,this.contextId).filter(row=>!this.verifiedQueueCaptures.has(this.queueCaptureFingerprint(row))).length:0;
    if (!rows.length&&!drafts.length&&!local) return;
    if(local)this.queuePreview.addChild(new TruncatedText(theme.fg('warning',`本机有 ${local} 份输入尚未确认保存 · Alt+↑ 核对并继续`),1,0));
    if(drafts.length)this.queuePreview.addChild(new TruncatedText(theme.fg('dim',`队列草稿：${drafts.reduce((sum,row)=>sum+row.entryCount,0)} 条待处理 · Alt+↑ 继续编辑 · /queue 管理`),1,0));
    const shown = rows.slice(0, 3);
    for (const row of shown) this.queuePreview.addChild(new TruncatedText(theme.fg('dim', `排队：${label(row.content) || '（仅附件）'}${row.attachments?.length ? ` · 附件 ${row.attachments.length}` : ''}`), 1, 0));
    if (totalCount > shown.length) this.queuePreview.addChild(new TruncatedText(theme.fg('dim', `…另有 ${totalCount - shown.length} 条`), 1, 0));
    this.queuePreview.addChild(new TruncatedText(theme.fg('dim', '↳ Alt+↑ 撤回并编辑全部排队消息 · /queue 逐条管理'), 1, 0));
  }
  private refreshQueue():Promise<void> {
    this.queueRefreshRequested=true;
    if(this.queueRefreshTask)return this.queueRefreshTask;
    const task=this.modalScope.exit(async()=>{do{this.queueRefreshRequested=false;await this.refreshQueueOnce();}while(this.queueRefreshRequested&&!this.stopped);}).finally(()=>{if(this.queueRefreshTask===task)this.queueRefreshTask=undefined;if(this.queueRefreshRequested&&!this.stopped)void this.refreshQueue();});
    this.queueRefreshTask=task;return task;
  }
  private async refreshQueueOnce() {
    if (!this.capabilities.has('message-queue')) return;
    const context = this.contextId; const version = ++this.queueRefreshVersion;
    try {
      const [rows,{drafts}]=await Promise.all([
        this.capabilities.has('message-queue-editor')?this.request<MessageQueueSummary>(`/contexts/${routeId(context)}/message-queue?view=summary`,{signal:this.contextController.signal}):this.request<Array<SignalRecord & { revision: number }>>(`/contexts/${routeId(context)}/message-queue`, { signal: this.contextController.signal }),
        this.capabilities.has('message-queue-editor')&&this.contextRole==='main'?this.request<{drafts:QueueEditDocument[]}>(`/contexts/${routeId(context)}/message-queue/drafts`,{signal:this.contextController.signal}):Promise.resolve({drafts:[] as QueueEditDocument[]}),
      ]);
      if (this.stopped || context !== this.contextId || version !== this.queueRefreshVersion) return;
      const summary=Array.isArray(rows)?{count:rows.length,ids:rows.map(row=>row.id),preview:rows}:rows;
      this.queueCount = summary.count; this.renderQueue(summary.preview,drafts,summary.count);
      const queued = new Set(summary.ids);
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
        this.coreChanged = this.instanceId !== '' && handshake.data.instanceId !== this.instanceId;
        await this.loadContext(generation); return;
      }
      if (this.streamLost) { this.streamLost = false; this.transcript.addChild(new Text(theme.fg('success', '已重新连接；断开期间的事件已补齐。'), 1, 0)); }
      this.status(this.currentRunId ? '处理中' : '已连接');
      for await (const frame of this.client.events({ after: this.cursor, contextId: this.contextId, signal: controller.signal })) {
        if (this.stopped || generation !== this.generation) return;
        if (frame.type === 'checkpoint') {
          if (frame.storageId !== this.storageId || frame.instanceId !== this.instanceId) { controller.abort(); await this.loadContext(generation); return; }
          if (frame.cursor > this.cursor) this.cursor = frame.cursor;
          void this.refreshToolResults();
        } else if (frame.event.seq > this.cursor) {
          this.event(frame.event); this.cursor = frame.event.seq;
        }
      }
      if (!this.stopped && generation === this.generation) { this.streamLost = true; this.status('连接暂不可用，正在重试'); this.timer = setTimeout(() => void this.connectStream(generation), 2000); }
    } catch {
      if (this.stopped || generation !== this.generation || controller.signal.aborted) return;
      this.streamLost = true; this.status('连接暂不可用，正在重试'); this.timer = setTimeout(() => void this.connectStream(generation), 2000);
    }
  }
  private switchContext(contextId: string) {
    this.generation++; if (this.timer) clearTimeout(this.timer); this.contextController.abort(); this.contextController = new AbortController(); this.streamController?.abort();
    this.pendingToolResults.clear();
    if(this.toolResultRetry){clearTimeout(this.toolResultRetry);this.toolResultRetry=undefined;}this.toolResultRetryDelay=500;
    this.contextId = contextId;
    this.editor = this.editors.get(contextId) ?? this.createEditor(); this.editors.set(contextId, this.editor);
    this.overlays = createOverlayHandlers(this.ui, this.editor); this.mountEditor();
    this.currentRunId = undefined; this.automaticCompaction = false; this.contextRole = undefined; this.contextName = ''; this.workingSet = undefined; this.contextReady = false; this.isMainContext = false; this.queueCount = 0; this.queuePreview.clear(); this.userRows.clear(); this.model = undefined; this.usageTotal = emptyUsage(); this.usageVersion++; this.working?.stop(); this.working = undefined; this.workingSlot.clear(); this.usageText = ''; this.capacityText = ''; this.queueRefreshVersion++; this.cursor = 0; this.seen.clear(); this.drafts.clear(); this.toolCards.clear(); this.thinkingBlocks.clear(); this.shellCards.length = 0; this.failureShown.clear(); this.failureRows.clear(); this.transcript.clear(); this.ui.resetTextSelection();
    this.status('连接中'); return this.loadContext(this.generation);
  }
  private async request<T>(route: string, init?: ClientRequestInit) {
    if (!this.modalScopeCurrent()) throw new AppError('core_storage_changed', 409);
    const generation = this.storageGeneration; const storageId = this.storageId;
    const scope = this.modalScope.getStore();
    const signal = AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : []), ...(scope ? [scope.controller.signal] : [])]);
    const headers = new Headers(init?.headers);
    if (init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method.toUpperCase())) {
      if (storageId) headers.set('X-ShittimChest-Storage-Id', storageId);
      if (this.instanceId) headers.set('X-ShittimChest-Instance-Id', this.instanceId);
    }
    const result = await this.client.request<T>(route, { ...init, headers, signal });
    // A delayed read cannot open another dialog for a different storage generation.
    if ((!init?.method || init.method === 'GET') && (generation !== this.storageGeneration || storageId !== this.storageId)) throw new AppError('core_storage_changed', 409);
    return result;
  }
  private async write(route: string, body: unknown, method = 'POST', signal?: AbortSignal) {
    const storageId = this.storageId; const generation = this.storageGeneration;
    const current = () => storageId === this.storageId && generation === this.storageGeneration;
    const serialized = JSON.stringify(body);
    const retryable = route === '/companion' || route === '/tasks' || route === '/schedules' || route === '/contexts' || route === '/contexts/import' || route === '/contexts/import-pi' || /^\/contexts\/[^/]+\/(clone|fork|branch)$/.test(route) || /^\/contexts\/[^/]+\/tree\/navigate$/.test(route) || /^\/contexts\/[^/]+\/tree\/[^/]+\/label$/.test(route) || /^\/contexts\/[^/]+\/message-queue\/withdraw$/.test(route) || /^\/contexts\/[^/]+\/message-queue\/drafts(?:\/[^/]+(?:\/(?:submit|reopen))?)?$/.test(route) || /^\/contexts\/[^/]+\/skills\/[^/]+\/invoke$/.test(route);
    const fingerprint = retryable ? createHash('sha256').update(JSON.stringify([storageId, method, route, serialized])).digest('hex') : '';
    const previousKey = this.uncertainWrites.get(fingerprint);
    const key = previousKey ?? randomUUID();
    if (retryable) this.uncertainWrites.set(fingerprint, key);
    try {
      const result = await this.request(route, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: serialized, ...(signal ? { signal } : {}) });
      if (!current()) throw new AppError('core_storage_changed', 409);
      if (retryable) this.uncertainWrites.delete(fingerprint);
      return result;
    } catch (error) {
      if (retryable && current() && (previousKey || !(error instanceof AppError) || error.status >= 500)) this.uncertainWrites.set(fingerprint, key);
      else if (retryable && current()) this.uncertainWrites.delete(fingerprint);
      throw error;
    }
  }
  private async queueDraftWrite(route:string,body:unknown,method='POST',operationId?:string){
    const storageId=this.storageId,generation=this.storageGeneration;
    const send=async()=>{const result=operationId?await this.request(route,{method,headers:{'content-type':'application/json','Idempotency-Key':operationId},body:JSON.stringify(body)}):await this.write(route,body,method);if(storageId!==this.storageId||generation!==this.storageGeneration)throw new AppError('core_storage_changed',409);return result;};
    try{return await send();}catch(error){
      if(this.stopped||!this.modalScopeCurrent()||this.modalScope.getStore()?.controller.signal.aborted||!(error instanceof AppError)||error.status<500)throw error;
      return send();
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
  private readonly failureRows = new Map<string, { title: Text; hint: Text; code: string }>();
  private working?: Loader;
  private readonly workingSlot = new Container();
  /** Spinner with elapsed time while a run is active (Pi WorkingStatusIndicator). */
  private updateWorking() {
    const active = Boolean(this.currentRunId && this.isMainContext);
    if (!active) { this.working?.stop(); this.working = undefined; this.workingSlot.clear(); return; }
    if (!this.working) {
      this.working = new Loader(this.ui, text => theme.fg('accent', text), text => theme.fg('muted', text), '处理中');
      this.workingSlot.clear(); this.workingSlot.addChild(this.working); this.working.start();
      const tick = () => { if (!this.working) return; const seconds = Math.floor((Date.now() - (this.runStartedAt || Date.now())) / 1000); this.working.setMessage(`${this.automaticCompaction ? '整理较早上下文' : '处理中'} ${seconds}s · Esc 停止 · Alt+Enter 排队`); setTimeout(tick, 1000).unref(); };
      tick();
    }
  }
  /** A readable failure line in the transcript with the next step, instead of a bare status flag. */
  private failure(code: string, runId?: string | null, retryable?: boolean) {
    const known = Object.hasOwn(failureTitles, code) ? code : 'model_execution_failed';
    const hint = failureHints[known] ?? '';
    retryable = retryable && !['model_authentication_failed', 'model_access_denied', 'model_not_found', 'model_quota_exhausted', 'model_protocol_error','model_thinking_output_capacity'].includes(known);
    const titleText = theme.fg('error', `运行失败：${failureTitles[known]}`);
    const hintText = theme.fg('muted', [hint, retryable ? '这是暂时性错误，可以直接重发。' : ''].filter(Boolean).join(' '));
    const previous = runId ? this.failureRows.get(runId) : undefined;
    if (previous) {
      if (previous.code !== 'model_execution_failed' || known === 'model_execution_failed') return;
      previous.code = known; previous.title.setText(titleText); previous.hint.setText(hintText); this.ui.requestRender(); return;
    }
    if (runId) this.failureShown.add(runId);
    const title = new Text(titleText, 1, 0), hintView = new Text(hintText, 1, 0);
    this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(title);
    if (hint || retryable) this.transcript.addChild(hintView);
    if (runId) this.failureRows.set(runId, { title, hint: hintView, code: known });
    this.ui.requestRender();
  }
  private lastCtrlC = 0;
  private lastEscape = 0;
  private hideThinking = false;
  private shellController?: AbortController;
  private bashMode = false;
  private readonly shellCards: ShellCard[] = [];
  /** Results of `!` commands waiting to ride along with the next message (Pi: bash results join the context). */
  private readonly sharedShell = new Map<string, string[]>();
  private readonly shellCaptureTexts=new Map<string,string>();
  private logicalInputHost(contextId:string,storageId:string,validate:()=>void):LogicalInputHost{return {attachmentParts:this.capabilities.has('queue-entry-attachment-parts'),local:this.queueEdits,request:<T>(route:string)=>this.request<T>(route),write:(route,body,method,key)=>this.queueDraftWrite(route,body,method,key),validate,saved:intent=>this.shellOutputs.claim(intent.shellCaptureIds??[],storageId,contextId,intent.id,intent.shellObservations),confirmed:intent=>this.shellOutputs.markConsumed(intent.shellCaptureIds??[],storageId,contextId,intent.id,intent.shellObservations)};}
  private async publishShellCaptures(captureIds:string[],storageId:string,contextId:string,validate:()=>void,observations:Record<string,string>={}){
    const published=[];for(const captureId of captureIds){validate();published.push(await this.shellOutputs.publish(captureId,storageId,contextId,async(bytes,name,metadata)=>{validate();const info=await this.request<AssetInfo>(`/assets?${new URLSearchParams({name,...metadata,bytes:String(metadata.bytes)})}`,{method:'POST',headers:{'content-type':'application/octet-stream','X-ShittimChest-Storage-Id':storageId},body:new Uint8Array(bytes)});validate();return info;},observations[captureId]));}return published;
  }
  private async reviewDirectInput(local:QueueLocalEdit){
    const storageId=this.storageId,contextId=this.contextId,generation=this.storageGeneration,validate=()=>{if(this.stopped||this.storageId!==storageId||this.storageGeneration!==generation||this.contextId!==contextId)throw new AppError('core_context_changed',409);};
    const directInput=local.directInput;if(!directInput||local.storageId!==storageId||local.contextId!==contextId)throw new AppError('logical_input_scope_changed',409);
    const unbound=local.sourcePending?structuredClone(local):undefined;
    if(unbound){const project=await this.request<ProjectDirectory>(`/contexts/${routeId(contextId)}/project-directory`,{headers:{'X-ShittimChest-Storage-Id':storageId}});validate();if(await this.choose(`原项目目录未确认。将原输入作为当前项目的新草稿审查？\n${terminalTarget(project.directory.path)}`,[{value:'back',label:'返回，保留原输入'},{value:'current',label:'使用当前项目并审查'}])!=='current')return;validate();local={...local,expectedSource:{workspaceId:project.workspaceId,directory:project.directory},sourcePending:false};}
    let attachments=[...local.attachments],material=local.localContext;
    if(local.publicationPending){const captures=local.shellCaptureIds??[],published=await this.publishShellCaptures(captures,storageId,contextId,validate,local.shellObservations);attachments.push(...published.flatMap(row=>row.attachments));material=[material,...published.map(row=>row.text)].filter(Boolean).join('\n\n')||undefined;}
    const intent:LogicalInputIntent={id:local.entryId,storageId,contextId,content:local.content,attachments,...(material?{localContext:material}:{}),...(local.selectedSkillName?{selectedSkillName:local.selectedSkillName}:{}),...(local.shellCaptureIds?.length?{shellCaptureIds:local.shellCaptureIds}:{}),...(local.shellObservations?{shellObservations:local.shellObservations}:{}),...(local.restoredFromSignalIds?.length?{restoredFromSignalIds:local.restoredFromSignalIds}:{}),...(local.expectedSource?{expectedSource:local.expectedSource}:{}),...directInput},host=this.logicalInputHost(contextId,storageId,validate);
    const adopted=this.queueEdits.adopt(local);let draft:QueueEditDocument;
    try{draft=await saveLogicalInput(host,intent);}catch(error){
      if(!(error instanceof AppError)||!['logical_input_version_conflict','revision_conflict','captured_input_changed'].includes(error.code))throw error;
      draft=await this.queueDraftWrite(`/contexts/${routeId(contextId)}/message-queue/drafts`,{current:{content:'',attachments:[],clientDraftId:intent.id,...(intent.selectedSkillName?{selectedSkillName:intent.selectedSkillName}:{}),...(intent.restoredFromSignalIds?.length?{restoredFromSignalIds:intent.restoredFromSignalIds}:{})},localCapture:true,captureQueue:false,...(intent.expectedSource?{expectedSource:intent.expectedSource}:{})},'POST',intent.id) as QueueEditDocument;
      validate();const capture=draft.captures?.find(row=>row.draftId===intent.id),entryId=capture?.entryId??draft.capturedEntryId;if(!entryId)throw error;
      const {localId,pending,...base}=adopted;this.queueEdits.save({...base,draftId:draft.id,entryId,base:{...local.base,id:entryId},content:intent.content,attachments:intent.attachments,localContext:intent.localContext,provisional:false,localOnly:false});
      this.note('本机输入和核心草稿版本不同，两版均已保留；请在草稿中选择。');
    }
    validate();
    if(unbound)this.queueEdits.acknowledgeExactVersion(unbound);
    if(logicalInputAdmitted(draft)){acknowledgeLogicalInput(host,intent,draft);this.note('已核对原输入的受理记录，没有重复发送。');return;}
    await this.queueEditingControls().open(contextId,draft.id);
  }
  private async rebaseDirectInput(local:QueueLocalEdit){
    const storageId=this.storageId,contextId=this.contextId,generation=this.storageGeneration,validate=()=>{if(this.stopped||this.storageId!==storageId||this.storageGeneration!==generation||this.contextId!==contextId)throw new AppError('core_context_changed',409);};
    if(local.storageId!==storageId||local.contextId!==contextId)throw new AppError('logical_input_scope_changed',409);
    const current=this.queueEdits.current({storageId,contextId,draftId:local.draftId},local.entryId)??local,directInput=current.directInput;if(current.publicationPending||!directInput)throw new AppError('logical_input_materials_unconfirmed',409);
    const project=await this.request<ProjectDirectory>(`/contexts/${routeId(contextId)}/project-directory`,{headers:{'X-ShittimChest-Storage-Id':storageId}});validate();
    if(await this.choose(`原项目来源已变化。把原文、附件和资料移到当前项目的新草稿审查？旧来源与执行权限不会作为新授权；所选 Skill 将从当前项目重新载入。\n${terminalTarget(project.directory.path)}`,[{value:'back',label:'返回，保留原输入'},{value:'current',label:'移到当前项目并审查'}])!=='current')return;validate();
    const expectedSource={workspaceId:project.workspaceId,directory:project.directory},hash=createHash('sha256').update(JSON.stringify(['queue-local-rebase-v1',storageId,contextId,current.entryId,current.content,current.attachments,current.localContext??'',current.selectedSkillName??null,current.restoredFromSignalIds??[],expectedSource])).digest('hex'),id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const created=await this.queueDraftWrite(`/contexts/${routeId(contextId)}/message-queue/drafts`,{current:{content:'',attachments:[],clientDraftId:id,...(current.selectedSkillName?{selectedSkillName:current.selectedSkillName}:{}),...(current.restoredFromSignalIds?.length?{restoredFromSignalIds:current.restoredFromSignalIds}:{})},localCapture:true,captureQueue:false,expectedSource},'POST',id) as QueueEditDocument;validate();
    const capture=created.captures?.find(row=>row.draftId===id),entryId=capture?.entryId??created.capturedEntryId;if(!entryId)throw new AppError('logical_input_capture_changed',409);
    const route=`/contexts/${routeId(contextId)}/message-queue/drafts/${routeId(created.id)}`,saved=await saveQueueEntry({attachmentParts:this.capabilities.has('queue-entry-attachment-parts'),request:<T>(route:string)=>this.request<T>(route),write:(route,body,method,key)=>this.queueDraftWrite(route,body,method,key)},route,entryId,{operationId:`${id}.edit`,baseRevision:1,content:current.content,attachments:current.attachments,captureDraftId:id,...(current.localContext!==undefined?{localContext:current.localContext}:{})});validate();
    const moved=await this.queueDraftWrite(`${route}/rebase`,{expectedRevision:saved.revision,expectedSource},'POST',`${id}.rebase`) as QueueEditPage;validate();
    const preserved=moved.entries.some(row=>row.content===current.content&&JSON.stringify(row.attachments)===JSON.stringify(current.attachments));if(preserved){this.shellOutputs.markConsumed(current.shellCaptureIds??[],storageId,contextId,current.entryId,current.shellObservations);resolveLogicalInputVersions(this.queueEdits,{id:current.entryId,storageId,contextId,content:current.content,attachments:current.attachments,...(current.localContext?{localContext:current.localContext}:{}),...(current.selectedSkillName?{selectedSkillName:current.selectedSkillName}:{}),...(current.shellCaptureIds?.length?{shellCaptureIds:current.shellCaptureIds}:{}),...(current.shellObservations?{shellObservations:current.shellObservations}:{}),...(current.restoredFromSignalIds?.length?{restoredFromSignalIds:current.restoredFromSignalIds}:{}),...(current.expectedSource?{expectedSource:current.expectedSource}:{}),...directInput});this.note('原输入与资料已另存为草稿，尚未发送。');}else this.note('目标草稿已有其他修改；原本机版本仍保留。');
    await this.queueEditingControls().open(contextId,moved.draft.id);
  }
  private restoreShellObservations(){
    this.shellCards.length=0;
    try{for(const row of this.shellOutputs.list(this.storageId,this.contextId)){
      const preview=row.preview||((row.state==='incomplete'||row.state==='running')&&(row.streams.stdout.bytes||row.streams.stderr.bytes)?`（已保存 stdout ${row.streams.stdout.bytes} 字节、stderr ${row.streams.stderr.bytes} 字节；预览尚未完成）`:''),card=new ShellCard(row.command,row.shared);card.append(preview);card.finish({exitCode:row.exitCode,cancelled:row.state==='cancelled',unknown:row.state==='incomplete'||row.state==='running'});this.shellCards.push(card);this.transcript.addChild(card);
      if(row.legacyUnknown){this.note('这条旧命令的共享状态尚未确认，原始记录仍保留，没有自动带入下一条消息。');continue;}
      if(row.shared&&!row.consumedBy&&!row.claimedBy){const text=shellResultText(row.command,{output:preview,exitCode:row.exitCode,cancelled:row.state==='cancelled',truncated:Boolean(row.truncated)});this.shellCaptureTexts.set(row.id,text);const rows=this.sharedShell.get(this.contextId)??[];if(!rows.includes(text))rows.push(text);this.sharedShell.set(this.contextId,rows);}
    }}catch{this.note('本机命令记录暂时无法读取；原始记录仍保留，尚未发送。');}
  }
  private recordInputHistory(source:Editor,text:string,id?:string){source.addToHistory(text);if(!this.storageId)return;try{this.inputHistory.append(this.storageId,this.contextId,text,id);}catch{this.note('本机输入历史尚未保存，当前窗口仍可用 ↑ 找回。');}}
  /**
   * `!cmd` runs in a local shell here and its result is attached to your next message; `!!cmd` runs
   * without sharing (Pi semantics). It runs as you, in the directory the TUI started in, with no
   * approval step: the same as typing it in your own shell, and not sandboxed.
   */
  private async shell(text: string) {
    const shared = !text.startsWith('!!');
    const command = (shared ? text.slice(1) : text.slice(2)).trim();
    if (!command) return;
    if (this.shellController) { this.note('已有命令在运行；Esc 取消后再试。'); this.editor.setText(text); return; }
    this.recordInputHistory(this.editor,text);
    const card = new ShellCard(command, shared); this.shellCards.push(card); this.transcript.addChild(card); this.ui.requestRender();
    const context = this.contextId,storageId=this.storageId; const controller = new AbortController(); this.shellController = controller;
    try {
      const capture=this.shellOutputs.start({storageId,contextId:context,command,cwd:this.completionBase,shared});
      const result = await runShell(command, { cwd: this.completionBase, signal: AbortSignal.any([controller.signal, this.lifetime.signal]),onRaw:(stream,bytes)=>this.shellOutputs.append(capture.id,stream,bytes), onChunk: chunk => { card.append(chunk); this.ui.requestRender(); } });
      this.shellOutputs.finish(capture.id,result);
      card.finish(result); this.ui.requestRender();
      if (shared && (!result.cancelled||this.capabilities.has('logical-input'))) { const rows = this.sharedShell.get(context) ?? [],text=shellResultText(command,result);rows.push(text);this.shellCaptureTexts.set(capture.id,text);this.sharedShell.set(context, rows); this.status(this.statusText); }
      if(result.captureFailed)this.note('本机命令输出未完整保存；已保留收到的部分，命令不会自动重跑。');
    } catch(error){card.finish({exitCode:undefined,cancelled:false,unknown:true});this.note(`本机命令未完成：${label(error instanceof AppError?error.code:'shell_failed')}。已保存的原始输出仍保留。`);
    } finally { if (this.shellController === controller) this.shellController = undefined; }
  }
  private readonly thinkingBlocks = new Map<string, ThinkingBlock>();
  private thinking(runId: string | null | undefined, delta: string) {
    if (!runId || !delta) return;
    let block = this.thinkingBlocks.get(runId);
    if (!block) { block = new ThinkingBlock(this.hideThinking); this.thinkingBlocks.set(runId, block); this.transcript.addChild(block); }
    block.append(delta); this.ui.requestRender();
  }
  /** Ctrl+T, as in Pi app.thinking.toggle: show or hide every thinking block. */
  private toggleThinking() {
    this.hideThinking = !this.hideThinking;
    for (const block of this.thinkingBlocks.values()) block.setHidden(this.hideThinking);
    this.note(this.hideThinking ? '已折叠思考内容（Ctrl+T 展开）。' : '已展开思考内容。');
  }
  private streamLost = false;
  private coreChanged = false;
  /** Ctrl+Z, as in Pi: hand the terminal back to the shell; fg resumes. The core keeps running either way. */
  private suspend() {
    if (process.platform === 'win32') { this.note('Windows 不支持挂起到后台。'); return; }
    const keepAlive = setInterval(() => {}, 2 ** 30); const ignore = () => {};
    process.on('SIGINT', ignore);
    process.once('SIGCONT', () => { clearInterval(keepAlive); process.removeListener('SIGINT', ignore); if (!this.stopped) { this.started = true; this.ui.start(); this.ui.requestRender(true); } });
    try { this.ui.stop(); this.started = false; process.kill(0, 'SIGTSTP'); }
    catch { clearInterval(keepAlive); process.removeListener('SIGINT', ignore); this.started = true; this.ui.start(); this.note('无法挂起到后台。'); }
  }
  private stopForeground() {
    if (!this.currentRunId) return;
    if (this.capabilities.has('foreground-interrupt')) void this.interrupt(this.contextId, this.currentRunId);
    else this.note('服务端不支持停止当前运行。');
  }
  /** Ctrl+O: expand every tool card if any is folded, otherwise fold them all (Pi app.tools.expand). */
  private toggleAllTools() {
    const cards: Array<{ isExpanded(): boolean; setExpanded(value: boolean): void }> = [...this.toolCards.values(), ...this.shellCards]; if (!cards.length) return;
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
    const source = this.editor;
    if (this.stopped || source.disableSubmit || this.modalFlow || this.pendingModal || this.ui.hasOverlay()) return;
    const text = source.getExpandedText().trim();
    if (!text && !(this.pendingAttachments.get(this.contextId) ?? []).length) return;
    source.setText('');
    await this.submit(text, this.currentRunId && this.isMainContext && this.capabilities.has('message-queue') ? 'queue' : undefined, source);
  }
  /** Alt+Up: withdraw every not-yet-started queued message and put the text back in the editor, oldest first. */
  private cacheQueueCapture(source:Editor){const claim=this.queueCaptureInputs.get(source);if(!claim||claim.storageId!==this.storageId)return;const content=source.getExpandedText(),attachments=(this.pendingAttachments.get(claim.contextId)??[]).map(row=>row.id),localContext=(this.sharedShell.get(claim.contextId)??[]).join('\n\n');this.queueEdits.save({storageId:claim.storageId,contextId:claim.contextId,draftId:claim.id,entryId:claim.id,baseRevision:1,base:{id:claim.id,content:'',attachments:[],sourceSignalIds:[],removed:false},content,attachments,localContext,provisional:true,...(claim.captureQueue===false?{captureQueue:false}:{}),updatedAt:new Date().toISOString()});}
  async reviewLocalInput(input:{id?:string;contextId:string;content:string;attachments?:string[];localContext?:string}){
    if(!this.capabilities.has('input-draft-review')||!this.storageId)throw new AppError('input_draft_review_unavailable',409);
    const storageId=this.storageId,nonce=input.id??randomUUID();const cache=(contextId:string,content:string,attachments:string[],localContext:string,id:string,localOnly=false)=>{const value:QueueLocalEdit={storageId,contextId,draftId:id,entryId:id,baseRevision:1,base:{id,content:'',attachments:[],sourceSignalIds:[],removed:false},content,attachments,localContext,provisional:true,captureQueue:false,...(localOnly?{localOnly:true}:{}),updatedAt:new Date().toISOString()};try{return this.queueEdits.save(value);}catch{const kept=this.queueEdits.current(value,id);if(!kept)throw new AppError('queue_local_save_failed');this.note('本机缓存未写入磁盘，未提交输入保留在当前进程。');return kept;}};
    const local=cache(input.contextId,input.content,input.attachments??[],input.localContext??'',nonce);
    const save=async(row:QueueLocalEdit)=>{const created=await this.queueDraftWrite(`/contexts/${routeId(row.contextId)}/message-queue/drafts`,{current:{clientDraftId:row.entryId,content:'',attachments:[]},localCapture:true,captureQueue:false},'POST',row.entryId) as QueueEditDocument;const draft=this.queueCaptureFor(created,row.entryId);if(draft.status==='submitted'){const page=await this.request<QueueEditPage>(`/contexts/${routeId(row.contextId)}/message-queue/drafts/${routeId(draft.id)}?limit=50`),entry=page.entries.find(value=>value.id===draft.capturedEntryId);if(entry?.content!==row.content||JSON.stringify(entry.attachments)!==JSON.stringify(row.attachments))throw new AppError('local_input_version_conflict',409);this.queueEdits.acknowledge(row,row.entryId,row);return draft;}const result=await this.saveCapturedQueueEntry(draft,storageId,row.content,row.attachments,row.localContext??'');this.queueEdits.acknowledge(row,row.entryId,row);return result;};
    const action=async()=>{
      const {contexts}=await this.request<{contexts:ContextRecord[]}>('/contexts');const target=contexts.find(row=>row.id===input.contextId);if(!target||target.archived||target.role!=='main')throw new AppError('context_not_available',409);
      if(input.contextId!==this.contextId){const context=this.contextId,source=this.editor,attachments=[...(this.pendingAttachments.get(context)??[])],shell=[...(this.sharedShell.get(context)??[])],text=source.getExpandedText();if(text||attachments.length||shell.length){if(this.contextRole==='main'){const id=randomUUID();this.queueCaptureInputs.set(source,{id,storageId,contextId:context,content:text,attachments:attachments.map(row=>row.id),shell,captureQueue:false});const prior=cache(context,text,attachments.map(row=>row.id),shell.join('\n\n'),id);const saved=await save(prior);await this.syncCapturedQueueInput(saved,source,storageId);}else{const id=randomUUID(),row=cache(context,text,attachments.map(row=>row.id),shell.join('\n\n'),id,true),key=`local-input:${row.localId??id}`;this.recoverableDrafts.set(key,{key,text,context,storageId,attachments,shell,localOnly:row,localInputId:id});}}
        await this.switchContext(input.contextId);if(this.storageId!==storageId||!this.contextReady||this.contextId!==input.contextId)throw new AppError('core_storage_changed',409);
      }
      const saved=await save(local);await this.queueEditingControls().open(input.contextId,saved.id,saved.capturedEntryId);return {draftId:saved.id,entryId:saved.capturedEntryId!};
    };
    return this.modalFlow?await action():await this.withModalFlow(action);
  }
  private async restoreQueue(inFlow = false) {
    if (!this.capabilities.has('message-queue') || this.contextRole !== 'main') { this.note('当前上下文没有可恢复的队列消息。'); return; }
    if(this.capabilities.has('message-queue-editor')){
      const restore=async()=>{
        const context=this.contextId,source=this.editor,storageId=this.storageId;
        await this.reconcileQueueCaptures(context,storageId);const text=source.getExpandedText();
        const existing=await this.request<{drafts:QueueEditDocument[]}>(`/contexts/${routeId(context)}/message-queue/drafts`);
        const queued=await this.request<MessageQueueSummary>(`/contexts/${routeId(context)}/message-queue?view=summary`);
        if(!queued.count&&!existing.drafts.length){const local=this.queueEdits.drafts(storageId,context);if(local.length){const selected=local.length===1?local[0]:await this.choose('本机未确认队列版本',local.map(id=>({value:id,label:`本机未确认版本 · ${id.slice(0,8)}`})));if(selected&&!inFlow)await this.queueEditingControls().open(context,selected);}else this.note('没有可恢复的队列消息。');return;}
        if(!queued.count&&existing.drafts.length){const claim=this.queueCaptureInputs.get(source);const draft=existing.drafts.find(row=>row.capturedDraftId===claim?.id||row.captures?.some(capture=>capture.draftId===claim?.id))??existing.drafts.at(-1)!;const captured=claim?.storageId===storageId&&claim.contextId===context&&(draft.capturedDraftId===claim.id||draft.captures?.some(capture=>capture.draftId===claim.id));if(captured)await this.syncCapturedQueueInput(draft,source,storageId);if(captured||!text&&!(this.pendingAttachments.get(context)??[]).length&&!(this.sharedShell.get(context)??[]).length){if(!inFlow&&context===this.contextId&&source===this.editor)await this.queueEditingControls().open(context,draft.id);return;}}
        const attachments=[...(this.pendingAttachments.get(context)??[])],shell=[...(this.sharedShell.get(context)??[])];
        const previousClaim=this.queueCaptureInputs.get(source);const claim=previousClaim?.storageId===storageId&&previousClaim.contextId===context&&previousClaim.content===text&&JSON.stringify(previousClaim.attachments)===JSON.stringify(attachments.map(row=>row.id))&&JSON.stringify(previousClaim.shell)===JSON.stringify(shell)?previousClaim:{id:randomUUID(),storageId,contextId:context,content:text,attachments:attachments.map(row=>row.id),shell};this.queueCaptureInputs.set(source,claim);
        this.cacheQueueCapture(source);
        let result:QueueEditDocument;
        try{result=await this.queueDraftWrite(`/contexts/${routeId(context)}/message-queue/drafts`,{current:{clientDraftId:claim.id,content:'',attachments:[]},localCapture:true},'POST',claim.id) as QueueEditDocument;}
        catch(error){if(error instanceof AppError&&error.code==='message_queue_empty'){this.note('没有可恢复的队列消息。');return;}throw error;}
        if(storageId!==this.storageId||this.stopped)return;
        result=await this.syncCapturedQueueInput(result,source,storageId);
        void this.refreshQueue();
        if(inFlow){this.note(`已保存 ${result.entryCount} 条待发送消息到队列草稿。`);return;}
        if(context===this.contextId&&source===this.editor)await this.queueEditingControls().open(context,result.id);
      };
      if(inFlow)await restore();else try{await this.withModalFlow(restore);}catch(error){if(!this.stopped)this.note(error instanceof AppError&&error.code==='queue_capture_cancelled'?'已保留当前输入；队列草稿仍可继续编辑。':`队列草稿操作未完成：${label(error instanceof AppError?error.code:'request_failed')}。已保存的消息可从 /queue 继续。`);}return;
    }
    const restore = async () => {
      type Queued = SignalRecord & { revision: number };
      type Withdrawal = QueueWithdrawalResult;
      const context = this.contextId, source = this.editor, storageId = this.storageId;
      const originalAttachments = [...(this.pendingAttachments.get(context) ?? [])], originalShell = [...(this.sharedShell.get(context) ?? [])];
      const current = () => !this.stopped && this.modalScopeCurrent() && context === this.contextId && source === this.editor;
      const complete = this.capabilities.has('message-queue-withdraw');
      const existing = this.restoredDrafts.get(source);
      const carried = existing?.storageId === storageId && existing.context === context ? existing.restoredFromSignalIds ?? [] : [];
      const known = new Set(carried), metadata = new Map<string, AssetInfo>();
      let restored: Queued[] = [], skipped = 0, failed = false;
      try {
        const [rows, receipts] = await Promise.all([
          this.request<Queued[]>(`/contexts/${routeId(context)}/message-queue`, { signal: this.contextController.signal }),
          complete ? this.request<{ operations: Withdrawal[] }>(`/contexts/${routeId(context)}/message-queue/withdrawals`, { signal: this.contextController.signal }) : Promise.resolve({ operations: [] }),
        ]);
        const recovered = receipts.operations.flatMap(operation => operation.withdrawn).filter(row => !known.has(row.id));
        const candidates = [...new Map([...recovered, ...rows].map(row => [row.id, row])).values()];
        const ids = [...new Set(candidates.flatMap(row => row.attachments ?? []))];
        const descriptions = await Promise.allSettled(ids.map(id => this.request<AssetInfo>(`/assets/${routeId(id)}/metadata`, { signal: this.contextController.signal })));
        for (let index = 0; index < descriptions.length; index++) {
          const result = descriptions[index]!; if (result.status === 'rejected') throw result.reason;
          if (result.value.id !== ids[index]) throw new AppError('queue_attachment_unavailable', 409);
          metadata.set(result.value.id, result.value);
        }
        if (!current()) return;
        // Validate the complete editable input before cancelling any queued source.
        queueDraft(candidates, source.getExpandedText(), this.pendingAttachments.get(context) ?? [], metadata);
        restored = [...new Map(recovered.map(row => [row.id, row])).values()];
        if (complete && rows.length) {
          const result = await this.write(`/contexts/${routeId(context)}/message-queue/withdraw`, { entries: rows.map(row => ({ id: row.id, revision: row.revision })) }) as Withdrawal;
          restored.push(...result.withdrawn.filter(row => !known.has(row.id))); skipped = result.skipped.length;
        } else if (!complete) {
          for (const row of rows) {
            if (!current()) break;
            try { await this.write(`/messages/${routeId(row.id)}`, { revision: row.revision }, 'DELETE'); restored.push(row); }
            catch (error) {
              if (error instanceof AppError && ['message_already_started', 'queued_message_not_found', 'revision_conflict'].includes(error.code)) skipped++;
              else {
                const actual = await this.request<SignalRecord>(`/signals/${routeId(row.id)}`);
                if (actual.contextId === context && actual.status === 'cancelled') restored.push({ ...actual, revision: row.revision + 1 }); else throw error;
              }
            }
          }
        }
      } catch (error) {
        failed = true;
        if (current()) this.note(error instanceof AppError && error.code === 'queue_draft_too_large'
          ? '合并后的输入超过 64000 字符、8 个附件或 32 MiB 附件限制；本次未撤回排队消息，原顺序和附件均已保留。'
          : `恢复队列未完成或结果未确认：${label(error instanceof AppError ? error.code : 'request_failed')}。再次按 Alt+↑ 可核对撤回记录。`);
      } finally {
        restored = [...new Map(restored.map(row => [row.id, row])).values()];
        if (restored.length) {
          const ownSource = current();
          const shell = ownSource ? [...(this.sharedShell.get(context) ?? [])] : originalShell;
          const provenance = complete ? [...new Set([...carried, ...restored.map(row => row.id)])] : carried;
          try {
            const draft = queueDraft(restored, source.getExpandedText(), ownSource ? this.pendingAttachments.get(context) ?? [] : originalAttachments, metadata);
            const saved = this.rememberDraft({ ...draft, context, storageId, shell, ...(provenance.length ? { restoredFromSignalIds: provenance } : {}) });
            if (ownSource) {
              this.pendingAttachments.set(context, draft.attachments); source.setText(draft.text); this.restoredDrafts.set(source, saved);
              this.status(this.statusText); this.note(`已撤回 ${restored.length} 条队列消息并恢复文字和附件${skipped ? `；${skipped} 条已变化，未撤回` : ''}。`);
            }
          } catch {
            for (const row of restored) {
              const draft = queueDraft([row], '', [], metadata);
              this.rememberDraft({ ...draft, context, storageId, shell: [], ...(complete ? { restoredFromSignalIds: [row.id] } : {}) });
            }
            if (ownSource) this.note('输入在撤回期间发生变化；已撤回消息的完整内容保留在“恢复草稿”中，当前草稿未被覆盖。');
          }
        } else if (current() && !failed) this.note(skipped ? `${skipped} 条消息已变化，未撤回。` : '没有可恢复的队列消息。');
        void this.refreshQueue();
      }
    };
    if (inFlow) await restore(); else await this.withModalFlow(restore);
  }
  private async syncCapturedQueueInput(draft:QueueEditDocument,source:Editor,storageId:string){
    const context=draft.contextId;if(!draft.capturedEntryId)return draft;
    while(!this.stopped&&this.storageId===storageId){
      const content=source.getExpandedText(),attachments=[...(this.pendingAttachments.get(context)??[])],shell=[...(this.sharedShell.get(context)??[])];
      const claim=this.queueCaptureInputs.get(source);
      if(claim)draft=this.queueCaptureFor(draft,claim.id);
      try{
      if(draft.capturedInputDetached){
        const unchanged=!draft.capturedInputUnconfirmed&&claim?.content===content&&JSON.stringify(claim.attachments)===JSON.stringify(attachments.map(row=>row.id))&&JSON.stringify(claim.shell)===JSON.stringify(shell);
        if(!unchanged){if(await this.choose('另一客户端已修改这段草稿；将当前输入作为另一条消息保留？',[{value:'cancel',label:'返回，保留当前输入'},{value:'both',label:'在同一草稿中保留两版'}])!=='both')throw new AppError('queue_capture_cancelled',409);const previousEntryId=draft.capturedEntryId!,address={storageId,contextId:context,draftId:draft.id},local=this.queueEdits.current(address,previousEntryId);draft=await this.queueDraftWrite(`/contexts/${routeId(context)}/message-queue/drafts/${routeId(draft.id)}`,{expectedRevision:draft.revision,action:{kind:'add',afterId:draft.capturedEntryId,input:{content:'',attachments:[],clientDraftId:claim?.id}}},'PATCH') as QueueEditDocument;draft=await this.saveCapturedQueueEntry(draft,storageId,content,attachments.map(row=>row.id),shell.join('\n\n'));if(local&&local.content===content&&JSON.stringify(local.attachments)===JSON.stringify(attachments.map(row=>row.id))&&local.localContext===shell.join('\n\n'))this.queueEdits.acknowledge(address,previousEntryId,local);}
      }else draft=await this.saveCapturedQueueEntry(draft,storageId,content,attachments.map(row=>row.id),shell.join('\n\n'));
      }catch(error){if(!(error instanceof AppError)||!['captured_input_changed','revision_conflict'].includes(error.code))throw error;const page=await this.request<QueueEditPage>(`/contexts/${routeId(context)}/message-queue/drafts/${routeId(draft.id)}?limit=1`);draft=claim?this.queueCaptureFor(page.draft,claim.id):page.draft;draft={...draft,capturedInputDetached:true};continue;}
      if(this.storageId!==storageId||this.stopped)return draft;
      if(source.getExpandedText()===content&&JSON.stringify(this.pendingAttachments.get(context)??[])===JSON.stringify(attachments)&&JSON.stringify(this.sharedShell.get(context)??[])===JSON.stringify(shell)){
        source.setText('');this.pendingAttachments.delete(context);this.sharedShell.delete(context);const captured=this.queueCaptureInputs.get(source);this.queueCaptureInputs.delete(source);if(captured)this.queueEdits.remove({storageId,contextId:context,draftId:captured.id},captured.id);return draft;
      }
    }
    return draft;
  }
  private queueCaptureFor(draft:QueueEditDocument,nonce:string){const capture=draft.captures?.filter(row=>row.draftId===nonce).at(-1);if(capture)return {...draft,capturedDraftId:nonce,capturedEntryId:capture.entryId,capturedInputDetached:capture.detached,capturedInputUnconfirmed:capture.unconfirmed};if(draft.capturedDraftId===nonce)return draft;throw new AppError('captured_input_changed',409);}
  private async saveCapturedQueueEntry(draft:QueueEditDocument,storageId:string,content:string,attachments:string[],localContext:string){
    const route=`/contexts/${routeId(draft.contextId)}/message-queue/drafts/${routeId(draft.id)}`,entryId=draft.capturedEntryId!,address={storageId,contextId:draft.contextId,draftId:draft.id};let cursor:number|null=0,entry:QueueEditEntry|undefined;
    do{const page:QueueEditPage=await this.request<QueueEditPage>(`${route}?cursor=${cursor}&limit=20`);entry=page.entries.find(row=>row.id===entryId);cursor=page.nextCursor;}while(!entry&&cursor!==null);if(!entry)throw new AppError('queue_entry_not_found',404);
    const previous=this.queueEdits.current(address,entryId),writer={attachmentParts:this.capabilities.has('queue-entry-attachment-parts'),request:<T>(path:string)=>this.request<T>(path),write:(path:string,body:unknown,method?:string,key?:string)=>this.queueDraftWrite(path,body,method,key)};
    const claim=this.queueCaptureInputs.get(this.editor),known=previous?.base??(claim&&claim.id===draft.capturedDraftId?claim.saved:undefined);
    if(!previous?.pending&&!draft.capturedInputUnconfirmed&&(entry.content!==content||JSON.stringify(entry.attachments)!==JSON.stringify(attachments))&&(!known||entry.content!==known.content||JSON.stringify(entry.attachments)!==JSON.stringify(known.attachments))){try{this.queueEdits.save({...address,entryId,baseRevision:draft.revision,base:structuredClone(entry),content,attachments,localContext,updatedAt:new Date().toISOString()});}catch{this.note('本机缓存未写入磁盘，未确认输入保留在当前进程。');}throw new AppError('captured_input_changed',409);}
    let pending=previous?.pending;
    if(pending&&(pending.content!==content||JSON.stringify(pending.attachments)!==JSON.stringify(attachments)||pending.localContext!==localContext)){draft=await saveQueueEntry(writer,route,entryId,pending);entry={...entry,content:pending.content,attachments:pending.attachments};pending=undefined;}
    pending??={operationId:randomUUID(),baseRevision:draft.revision,content,attachments,captureDraftId:draft.capturedDraftId,localContext};
    const input={...address,entryId,baseRevision:draft.revision,base:previous?.base??structuredClone(entry),content,attachments,pending,localContext,updatedAt:new Date().toISOString()};let cached:QueueLocalEdit;try{cached=this.queueEdits.save(input);}catch{const kept=this.queueEdits.current(address,entryId);if(!kept)throw new AppError('queue_local_save_failed');cached=kept;this.note('本机缓存未写入磁盘，输入保留在当前进程；正在核对核心保存。');}
    const saved=await saveQueueEntry(writer,route,entryId,pending);this.queueEdits.acknowledge(address,entryId,cached);if(claim&&claim.id===draft.capturedDraftId)claim.saved={content,attachments:[...attachments],localContext};return draft.capturedDraftId?this.queueCaptureFor(saved,draft.capturedDraftId):saved;
  }
  private queueCaptureFingerprint(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
  private async reconcileQueueCaptures(contextId:string,storageId:string){
    for(const local of this.queueEdits.captures(storageId,contextId)){
      if(local.localOnly)continue;
      if(this.verifiedQueueCaptures.has(this.queueCaptureFingerprint(local)))continue;
      const recovered=await this.queueDraftWrite(`/contexts/${routeId(contextId)}/message-queue/drafts`,{current:{clientDraftId:local.entryId,content:'',attachments:[]},localCapture:true,...(local.captureQueue===false?{captureQueue:false}:{})},'POST',local.entryId) as QueueEditDocument,draft=this.queueCaptureFor(recovered,local.entryId);
      if(draft.capturedDraftId!==local.entryId||!draft.capturedEntryId){this.note('本机未确认输入仍保留，原草稿来源已变化。');continue;}
      if(draft.status!=='editing'){this.note('本机未确认输入仍保留；原草稿正在执行或已受理，请先核对。');continue;}
      if(draft.capturedInputDetached){const address={storageId,contextId,draftId:draft.id},entryId=draft.capturedEntryId;this.queueEdits.save({...address,entryId,baseRevision:draft.revision,base:{...local.base,id:entryId},content:local.content,attachments:local.attachments,localContext:local.localContext,updatedAt:local.updatedAt});}
      else try{await this.saveCapturedQueueEntry(draft,storageId,local.content,local.attachments,local.localContext??'');}catch(error){if(!(error instanceof AppError)||!['captured_input_changed','revision_conflict'].includes(error.code))throw error;this.note('本机未确认输入与核心版本不同，两版均已保留；请在队列草稿中核对。');this.verifiedQueueCaptures.add(this.queueCaptureFingerprint(local));continue;}
      this.verifiedQueueCaptures.add(this.queueCaptureFingerprint(local));
      const latest=this.queueEdits.captures(storageId,contextId).find(row=>row.entryId===local.entryId);if(latest&&latest.content===local.content&&JSON.stringify(latest.attachments)===JSON.stringify(local.attachments)&&latest.localContext===local.localContext)this.queueEdits.remove({storageId,contextId,draftId:local.draftId},local.entryId);
    }
  }
  private async submit(text: string, preset?: 'queue' | 'steer', source = this.editor) {
    if (this.stopped || source.disableSubmit) return;
    const context = this.contextId; const observedRunId = this.currentRunId;
    const staged = this.pendingAttachments.get(context) ?? [];
    if (!text.trim() && !staged.length) return;
    if (this.modalFlow || this.pendingModal || this.ui.hasOverlay() || source !== this.editor) { if (!source.getText()) source.setText(text); return; }
    if (/^\/[a-z]/i.test(text.trim())) { this.recordInputHistory(source,text); await this.command(text.trim(), text,preset); return; }
    if (!staged.length && text.trimStart().startsWith('!') && !preset) { await this.shell(text.trimStart()); return; }
    source.disableSubmit = true;
    try { await this.withModalFlow(() => this.submitMessage(text, preset, source, context, observedRunId)); }
    finally { source.disableSubmit = false; }
  }
  private async submitMessage(text: string, preset: 'queue' | 'steer' | undefined, source: Editor, context: string, observedRunId: string | undefined, requestedSkill?: SkillSubmission) {
    const storageId = this.storageId; const storageGeneration = this.storageGeneration,contextGeneration=this.generation;
    const current = () => !this.stopped && this.storageId === storageId && this.storageGeneration === storageGeneration && this.contextId === context && this.editor === source&&this.generation===contextGeneration;
    const staged = [...(this.pendingAttachments.get(context) ?? [])];
    const attachmentIds = staged.map(item => item.id);
    const pendingShell = [...(this.sharedShell.get(context) ?? [])];
    const restored = this.restoredDrafts.get(source);
    const sourceDraft = restored && this.recoverableDrafts.has(restored.key) && restored.storageId === storageId && restored.context === context ? restored : undefined;
    const restoredFromSignalIds = sourceDraft?.submission?.uncertain ? sourceDraft.submission.restoredFromSignalIds : sourceDraft?.restoredFromSignalIds;
    const ownsRestored = restored && this.recoverableDrafts.has(restored.key) && restored.storageId === storageId && restored.context === context && restored.text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').trim() === text
      && restored.skill?.name === requestedSkill?.name
      && JSON.stringify(restored.attachments.map(item => item.id)) === JSON.stringify(attachmentIds) && JSON.stringify(restored.shell) === JSON.stringify(pendingShell);
    const previous = ownsRestored ? restored : undefined;
    const id = previous?.submission?.uncertain ? previous.submission.id : previous?.localInputId??randomUUID();
    this.recordInputHistory(source,text,`signal:${id}`);
    // Reserve the entire envelope before preflight can yield to a newer draft.
    const unreservedAttachments=(this.pendingAttachments.get(context)??[]).filter(item=>!attachmentIds.includes(item.id));if(unreservedAttachments.length)this.pendingAttachments.set(context,unreservedAttachments);else this.pendingAttachments.delete(context);
    this.sharedShell.delete(context);
    const retry = previous?.submission?.uncertain ? previous.submission : undefined;
    const useLogicalInput=this.capabilities.has('logical-input')&&(!retry||Boolean(previous?.logicalInput||previous?.logicalInputPending));
    let mode: 'queue' | 'steer' | undefined = retry ? retry.mode : observedRunId && this.isMainContext && this.capabilities.has('message-queue') ? preset??(useLogicalInput?'steer':undefined) : undefined;
    let expectedSource:QueueInputSource|undefined=previous?.logicalInput?.expectedSource??previous?.localOnly?.expectedSource;
    const cachePreflight=()=>{
      if(!useLogicalInput||previous?.logicalInput)return;
      const address={storageId,contextId:context,draftId:id},old=this.queueEdits.current(address,id);if(old&&!old.publicationPending)return;
      const captures=old?.shellCaptureIds??this.shellOutputs.list(storageId,context,true).filter(row=>pendingShell.includes(this.shellCaptureTexts.get(row.id)??'')).map(row=>row.id),legacy=pendingShell.filter(value=>!captures.some(captureId=>this.shellCaptureTexts.get(captureId)===value)),observations=old?.shellObservations??Object.fromEntries(captures.map(captureId=>[captureId,this.shellOutputs.observe(captureId,storageId,context)]));
      this.queueEdits.save({...address,entryId:id,...(old?.localId?{localId:old.localId}:{}),baseRevision:1,base:{id,content:'',attachments:[],sourceSignalIds:[],removed:false,...(requestedSkill?{selectedSkillName:requestedSkill.name}:{})},content:text,attachments:attachmentIds,localContext:legacy.join('\n\n'),...(requestedSkill?{selectedSkillName:requestedSkill.name}:{}),...(captures.length?{shellCaptureIds:captures,shellObservations:observations}:{}),...(restoredFromSignalIds?.length?{restoredFromSignalIds}:{}),...(expectedSource?{expectedSource}:{}),sourcePending:!expectedSource,directInput:{mode:mode??'queue',...(mode==='steer'&&observedRunId?{expectedRunId:observedRunId}:{})},provisional:true,localOnly:true,captureQueue:false,publicationPending:true,updatedAt:new Date().toISOString()});
    };
    const restore = (saved = previous ?? this.rememberDraft({ text, context, storageId, attachments: staged, shell: pendingShell,...(useLogicalInput?{localInputId:id,localOnly:this.queueEdits.current({storageId,contextId:context,draftId:id},id),logicalInputPending:true}:{}), ...(restoredFromSignalIds?.length ? { restoredFromSignalIds } : {}), ...(requestedSkill ? { skill: requestedSkill } : {}) })) => {
      if (this.stopped) return;
      const canRestore = !source.getText() && (!current() || (!(this.pendingAttachments.get(context) ?? []).length && !(this.sharedShell.get(context) ?? []).length));
      if (canRestore) {
        source.setText(text); this.restoredDrafts.set(source, saved);
        if (current()) { this.pendingAttachments.set(context, [...staged]); if (pendingShell.length) this.sharedShell.set(context, [...pendingShell]); }
      }
    };
    try {
      if (!current()) { restore(); return; }
      if (!text.trim() && !staged.length) return;
      if (!this.contextRole || !this.contextReady) { restore(); this.note('上下文尚未就绪，请等待连接。'); return; }
      if (this.contextRole !== 'main') { restore(); this.note('工作上下文为只读；请通过任务菜单发送补充。'); return; }
      cachePreflight();
      if(useLogicalInput&&!expectedSource){const project=await this.request<ProjectDirectory>(`/contexts/${routeId(context)}/project-directory`,{headers:{'X-ShittimChest-Storage-Id':storageId}});if(!current())throw new AppError('core_context_changed',409);expectedSource={workspaceId:project.workspaceId,directory:project.directory};cachePreflight();}
      if (restoredFromSignalIds?.length && !this.capabilities.has('message-queue-withdraw')) throw new AppError('queue_restore_unavailable', 409);
      if (this.model?.unavailable) { this.guidanceShown.add(this.contextId); await this.refreshModel(); if (!current()) { restore(); return; } if (this.model?.unavailable) { restore(); this.modelGuidance(); return; } }
      if (!current()) { restore(); return; }
      if (attachmentIds.length) {
        const confirm = await this.choose(`确认发送以下附件？\n${staged.map(item => `${label(item.name).slice(0, 60)} · ${label(item.mediaType)} · ${item.bytes} 字节`).join('\n')}`, [{ value: 'no', label: '返回编辑' }, { value: 'yes', label: '发送' }]);
        if (confirm !== 'yes') { restore(); return; }
      }
      if (!current()) { restore(); return; }
      if (!retry && !mode && observedRunId && this.isMainContext && this.capabilities.has('message-queue')) {
        const choice = await this.choose('当前运行尚未结束（Alt+Enter 可直接排队）', [{ value: 'queue', label: '排队：用于下一次运行' }, { value: 'steer', label: '补充：发送到当前运行' }, { value: 'cancel', label: '返回编辑' }]);
        if (choice !== 'queue' && choice !== 'steer') { restore(); return; }
        mode = choice;
      }
      if (!current()) { restore(); return; }
    } catch (error) {
      restore();
      if(useLogicalInput&&this.queueEdits.storageProblem())this.note('本机缓存未写入磁盘，原输入仅保留在当前窗口；请保持窗口打开并检查本机存储。');
      if (!this.stopped) this.note(`消息未发送：${label(error instanceof AppError ? error.code : 'request_failed')}。原消息已保留，可从 /menu 的“恢复草稿”取回。`);
      return;
    }
    const expectedRunId = retry ? retry.expectedRunId : mode === 'steer' ? observedRunId : undefined;
    const content = requestedSkill?.content ?? text;
    const outgoing = retry?.outgoing ?? (pendingShell.length ? `${pendingShell.join('\n\n')}\n\n${content}`.slice(-64_000) : content);
    const sourceText = retry ? retry.sourceText ?? previous?.skill?.sourceText : requestedSkill?.sourceText ?? (this.capabilities.has('message-source-text') ? text : undefined);
    let logicalInput:LogicalInputIntent|undefined=previous?.logicalInput;
    try {
      if(useLogicalInput){
        const cached=this.queueEdits.current({storageId,contextId:context,draftId:logicalInput?.id??id},logicalInput?.id??id),captureIds=logicalInput?.shellCaptureIds??cached?.shellCaptureIds??this.shellOutputs.list(storageId,context,true).filter(row=>pendingShell.includes(this.shellCaptureTexts.get(row.id)??'')).map(row=>row.id),shellObservations=logicalInput?.shellObservations??cached?.shellObservations??Object.fromEntries(captureIds.map(captureId=>[captureId,this.shellOutputs.observe(captureId,storageId,context)]));
        const selectedSkillName=requestedSkill?.name,localId=logicalInput?.id??id;
        if(!logicalInput){
          const legacyShell=pendingShell.filter(value=>!captureIds.some(captureId=>this.shellCaptureTexts.get(captureId)===value));
          const before={storageId,contextId:context,draftId:localId,entryId:localId,baseRevision:1,base:{id:localId,content:'',attachments:[],sourceSignalIds:[],removed:false,...(selectedSkillName?{selectedSkillName}:{})},content:text,attachments:attachmentIds,localContext:legacyShell.join('\n\n'),...(selectedSkillName?{selectedSkillName}:{}),...(captureIds.length?{shellCaptureIds:captureIds,shellObservations}:{}),...(restoredFromSignalIds?.length?{restoredFromSignalIds}:{}),...(expectedSource?{expectedSource}:{}),directInput:{mode:mode??'queue',...(expectedRunId?{expectedRunId}:{})},provisional:true,localOnly:true,captureQueue:false,publicationPending:true,updatedAt:new Date().toISOString()} satisfies QueueLocalEdit;
          this.queueEdits.save(before);
          const publications=await this.publishShellCaptures(captureIds,storageId,context,()=>{if(!current())throw new AppError('core_context_changed',409);},shellObservations),material=[...legacyShell,...publications.map(row=>row.text)].join('\n\n');
          logicalInput={id:localId,storageId,contextId:context,content:text,attachments:[...attachmentIds,...publications.flatMap(row=>row.attachments)],...(material?{localContext:material}:{}),...(selectedSkillName?{selectedSkillName}:{}),...(captureIds.length?{shellCaptureIds:captureIds,shellObservations}:{}),...(restoredFromSignalIds?.length?{restoredFromSignalIds}:{}),...(expectedSource?{expectedSource}:{}),mode:mode??'queue',...(expectedRunId?{expectedRunId}:{})};
        }
        const receipt=await submitLogicalInput(this.logicalInputHost(context,storageId,()=>{if(!current())throw new AppError('core_context_changed',409);}),logicalInput);
        if(previous)this.recoverableDrafts.delete(previous.key);if(sourceDraft)this.recoverableDrafts.delete(sourceDraft.key);this.restoredDrafts.delete(source);
        if(current()){const queued=receipt.submission?.entries.some(row=>row.status==='queued');this.note(queued?'输入已保存并等待原生运行；Alt+↑ 可撤回编辑。':'输入已由原生运行受理；执行结果请查看会话。');this.status(this.statusText);void this.refreshQueue();}
        return;
      }
      const route = requestedSkill ? `/contexts/${routeId(context)}/skills/${routeId(requestedSkill.name)}/invoke` : '/messages';
      const receipt = await this.write(route, { id, ...(!requestedSkill ? { contextId: context } : {}), ...(sourceText !== undefined ? { sourceText } : {}), ...(restoredFromSignalIds?.length ? { restoredFromSignalIds } : {}), content: outgoing, ...(attachmentIds.length ? { attachments: attachmentIds } : {}), ...(mode ? { mode } : {}), ...(expectedRunId ? { expectedRunId } : {}) }) as SignalRecord;
      if (receipt.status !== 'accepted' && receipt.status !== 'queued') throw new AppError(receipt.errorCode || 'message_not_accepted', 409);
      if (previous) this.recoverableDrafts.delete(previous.key);
      if (sourceDraft?.restoredFromSignalIds?.length) this.recoverableDrafts.delete(sourceDraft.key);
      if (this.restoredDrafts.get(source)?.key === previous?.key || this.restoredDrafts.get(source)?.key === sourceDraft?.key) this.restoredDrafts.delete(source);
      if (current()) {
        this.message({ id: `signal:${id}`, contextId: context, role: 'user', content: text, createdAt: new Date().toISOString(), runId: null, status: receipt.status, kind: 'message', ...(attachmentIds.length ? { attachments: attachmentIds } : {}) });
        this.status(this.statusText);
        if (receipt.status === 'queued') { this.note('消息已加入队列；Alt+↑ 撤回到输入框，/queue 逐条管理。'); void this.refreshQueue(); }
        else if (mode === 'steer') this.note('补充已发送到当前运行。');
      }
    } catch (error) {
      const uncertain = !(error instanceof AppError) || error.status >= 500 || error.code === 'message_admission_pending';
      if (previous) this.recoverableDrafts.delete(previous.key);
      if (sourceDraft?.restoredFromSignalIds?.length) this.recoverableDrafts.delete(sourceDraft.key);
      const localOnly=useLogicalInput?this.queueEdits.current({storageId,contextId:context,draftId:logicalInput?.id??id},logicalInput?.id??id):undefined;
      const saved = this.rememberDraft({ text, context, storageId, attachments: [...staged], shell: pendingShell, ...(localOnly?{localOnly}:{}),...(logicalInput?{logicalInput}:useLogicalInput?{logicalInputPending:true}:{}),...(restoredFromSignalIds?.length ? { restoredFromSignalIds } : {}), ...(requestedSkill ? { skill: requestedSkill } : {}), submission: { id, outgoing, ...(sourceText !== undefined ? { sourceText } : {}), ...(restoredFromSignalIds?.length ? { restoredFromSignalIds } : {}), mode, expectedRunId, uncertain } });
      if (!this.stopped) {
        restore(saved);
        this.note(`${uncertain ? '提交结果未确认，可用相同内容重试' : '消息未接收'}：${label(error instanceof AppError ? error.code : 'request_failed')}。原消息已保留，可从 /menu 的“恢复草稿”取回。`);
        this.status(this.statusText);
      }
    }
  }
  private rememberDraft(draft: Omit<RecoverableDraft, 'key'>) {
    const saved: RecoverableDraft = { ...draft, key: randomUUID() };
    this.recoverableDrafts.set(saved.key, saved);
    return saved;
  }
  /** Restore explicitly; a newer draft is retained as a separate entry rather than overwritten. */
  private async recoverDraft() {
    const source = this.editor; const context = this.contextId; const storageId = this.storageId;
    const current = () => !this.stopped && source === this.editor && context === this.contextId && storageId === this.storageId;
    try{for(const row of this.queueEdits.captures(storageId).filter(value=>value.localOnly)){
      const key=`local-input:${row.localId??row.entryId}`;
      if(!row.directInput)try{const receipt=await this.request<SignalRecord>(`/signals/${routeId(row.entryId)}`);if(receipt.contextId===row.contextId&&receipt.source==='tui-message'&&receipt.type==='user-message'&&receipt.content===row.content&&JSON.stringify(receipt.attachments??[])===JSON.stringify(row.attachments)&&['accepted','queued'].includes(receipt.status)){this.recoverableDrafts.delete(key);continue;}}catch(error){if(error instanceof AppError&&error.status!==404)throw error;}
      if(![...this.recoverableDrafts.values()].some(value=>value.localOnly?.localId===row.localId&&value.localOnly?.entryId===row.entryId)&&!this.recoverableDrafts.has(key))this.recoverableDrafts.set(key,{key,text:row.content,context:row.contextId,storageId,attachments:[],shell:row.localContext?[row.localContext]:[],localOnly:row,localInputId:row.entryId});
    }}catch{this.note('本机未提交草稿暂未完成核对；原文件仍保留。');}
    const items = [...this.recoverableDrafts.values()];
    if (!items.length) { this.note('没有可恢复的草稿。'); return; }
    const key = await this.choose('恢复草稿（先核对保存状态，不会自动发送）', items.map(draft => ({ value: draft.key,
      label: `${draft.submission ? (draft.submission.uncertain ? '结果未确认' : '未接收') : '草稿'} · ${label(draft.text).slice(0, 80) || '附件消息'}` })));
    const saved = key ? this.recoverableDrafts.get(key) : undefined;
    if (!saved || !current()) return;
    const compatible = saved.context === context && saved.storageId === storageId;
    if(compatible&&saved.localOnly?.directInput&&this.capabilities.has('logical-input')){try{await this.reviewDirectInput(saved.localOnly);}catch(error){if(error instanceof AppError&&['queue_configuration_changed','queue_source_unverified','logical_input_source_changed','skill_workspace_changed'].includes(error.code)){try{await this.rebaseDirectInput(saved.localOnly);}catch(failure){this.note(`本机原输入仍保留：${label(failure instanceof AppError?failure.code:'request_failed')}。`);}}else this.note(`本机原输入仍保留：${label(error instanceof AppError?error.code:'request_failed')}。`);}return;}
    if(compatible&&saved.localOnly){try{saved.attachments=await Promise.all(saved.localOnly.attachments.map(id=>this.request<AssetInfo>(`/assets/${routeId(id)}/metadata`)));}catch{this.note(`原附件尚未核对，草稿完整保留，连接恢复后可重试。\n${safeTerminalText(saved.text)}`);return;}if(!current())return;}
    const text = source.getExpandedText();
    const attachments = this.pendingAttachments.get(context) ?? []; const shell = this.sharedShell.get(context) ?? [];
    if (text || attachments.length || shell.length || !compatible) {
      const action = await this.choose(compatible ? '保留当前草稿，再取回所选草稿？' : '来源上下文或存储已变化；仅取回文字，原附件与发送记录仍保留。', [
        { value: 'cancel', label: '返回' }, { value: 'restore', label: '保留当前草稿并取回' },
      ]);
      if (action !== 'restore' || !current()) return;
      // Text can change while the choice loads; capture the latest visible draft, never an earlier copy.
      const latest = source.getExpandedText(); const latestAttachments = this.pendingAttachments.get(context) ?? []; const latestShell = this.sharedShell.get(context) ?? [];
      const existing = this.restoredDrafts.get(source);
      const retained = existing && this.recoverableDrafts.has(existing.key) && existing.text === latest && existing.context === context && existing.storageId === storageId
        && JSON.stringify(existing.attachments) === JSON.stringify(latestAttachments) && JSON.stringify(existing.shell) === JSON.stringify(latestShell);
      if (!retained && (latest || latestAttachments.length || latestShell.length)) this.rememberDraft({ text: latest, context, storageId, attachments: [...latestAttachments], shell: [...latestShell], ...(existing?.storageId === storageId && existing.context === context && existing.restoredFromSignalIds?.length ? { restoredFromSignalIds: [...existing.restoredFromSignalIds] } : {}) });
    }
    this.pendingAttachments.set(context, compatible ? [...saved.attachments] : []);
    if (compatible && saved.shell.length) this.sharedShell.set(context, [...saved.shell]); else this.sharedShell.delete(context);
    source.setText(saved.text);
    if (compatible) this.restoredDrafts.set(source, saved); else this.restoredDrafts.delete(source);
    if (compatible && saved.submission?.uncertain) this.note('原提交结果未确认；内容不变时将使用原请求标识与发送目标重试。');
    this.status(this.statusText);
  }
  /** Runs a local slash command. Unknown names are reported locally and never sent to the model. */
  private async command(text: string, sourceText = text,preset?:'queue'|'steer') { await this.withModalFlow(() => this.executeCommand(text, sourceText,preset)); }
  private async executeCommand(text: string, sourceText = text,preset?:'queue'|'steer') {
    const space = text.indexOf(' ');
    const name = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
    const arg = space === -1 ? '' : text.slice(space + 1).trim();
    const entry = tuiCommands.find(command => command.name === name || command.aliases?.includes(name));
    if (name.startsWith('skill:') && this.capabilities.has('workspace-skill-invoke')) { try { await this.invokeSkill(`${name.slice(6)}${arg ? ` ${arg}` : ''}`, sourceText,preset); } catch (error) { if (!this.stopped) this.note(`操作失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); } return; }
    if (!entry) { this.note(`未知命令 /${label(name)}。输入 /help 查看可用命令。`); return; }
    if (entry.capability && !this.capabilities.has(entry.capability)) { this.note(`服务端不支持 /${entry.name}。`); return; }
    try {
      switch (entry.name) {
        case 'quit': await this.stop(); return;
        case 'help': this.note(commandHelp()); return;
        case 'hotkeys': this.note(commandHelp().split('\n').at(-1)!); return;
        case 'shutdown': {
          const answer = await this.choose('关闭核心会停止所有正在执行的工作，确认关闭？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '关闭核心' }]);
          if (answer === 'yes') { await this.write('/core/stop', {}); await this.stop(); } return;
        }
        case 'menu': await this.manageInFlow(); return;
        case 'new': await this.newConversation(arg || undefined); return;
        case 'sessions': {
          if (!arg) { if (this.capabilities.has('session-browser')) await this.sessionControls().browse(); else await this.contexts(true); return; }
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
          if (this.capabilities.has('context-tree')) await this.sessionControls().fork(); else if (this.capabilities.has('context-fork-message')) await this.forkMessage(current); else await this.branchContext(current); return;
        }
        case 'clone': {
          const route = `/contexts/${routeId(this.contextId)}/clone`, body = arg ? { name: arg } : {};
          const created = this.capabilities.has('context-tree') ? await this.navigateSessionTree<ContextRecord>(route, body) : await this.write(route, body) as ContextRecord;
          this.switchContext(created.id); return;
        }
        case 'tree': await this.sessionControls().tree(); return;
        case 'compact': await this.compact(arg); return;
        case 'export': await this.exportConversation(arg); return;
        case 'import': await this.importConversation(arg); return;
        case 'transfers': await this.fileTransfers(); return;
        case 'model': {
          if (!arg) { await this.models(); return; }
          const { models } = await this.request<{ models: Array<{ id: string; name: string; modelId: string }> }>('/models');
          const target = models.find(model => model.id === arg) ?? models.find(model => model.name === arg || model.modelId === arg);
          if (!target) { this.note(`没有找到模型配置：${label(arg)}`); return; }
          await this.write(`/contexts/${routeId(this.contextId)}/model`, { profileId: target.id }); await this.refreshModel(); this.note(`已切换到 ${label(target.name)}，将用于后续请求。`); return;
        }
        case 'think': await this.selectThinking(arg); return;
        case 'stop': {
          if (!this.currentRunId || !this.isMainContext) { this.note('当前没有可停止的运行。'); return; }
          await this.interrupt(this.contextId, this.currentRunId); return;
        }
        case 'copy': await this.copySelectionOrLast(); return;
        case 'status': await this.showStatus(); return;
        case 'usage': await this.showUsage(); return;
        case 'context': await this.showCapacity(); return;
        case 'tasks': await this.tasks(); return;
        case 'task': await this.createTask(arg || undefined); return;
        case 'approvals': await this.approvalsInFlow(); return;
        case 'questions': await this.questions(); return;
        case 'queue': await this.messageQueue(); return;
        case 'schedules': await this.schedules(); return;
        case 'tools': await this.toolActivity(); return;
        case 'attach': await this.attachments(arg); return;
        case 'login': await this.providerAuth(arg || undefined); return;
        case 'logout': await this.providerLogout(arg || undefined); return;
        case 'mcp': await this.mcp(); return;
        case 'skills': await this.skills(); return;
        case 'skill': await this.invokeSkill(arg, sourceText,preset); return;
        case 'reload': this.switchContext(this.contextId); return;
        case 'memory': await this.memory(); return;
        case 'editor': await this.externalEditor(); return;
      }
    } catch (error) { if (!this.stopped) this.note(`操作失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }
  }
  private statusSummary() {
    return [
      `客户端：${label(appBuildInfo.version)}${appBuildInfo.sourceHash ? ` · ${label(appBuildInfo.sourceHash).slice(0, 12)}` : ''}`,
      `上下文：${label(this.contextId)}${this.contextRole ? `（${this.contextRole === 'main' ? '交流' : '只读工作上下文'}）` : ''}`,
      `状态：${label(this.statusText)}${this.currentRunId ? ` · 运行 ${label(this.currentRunId)}` : ''}`,
      ...(this.capacityText ? [`容量：${label(this.capacityText)}`] : []),
      ...(this.usageText ? [label(this.usageText)] : []),
      ...(this.queueCount ? [`队列：${this.queueCount} 条待执行`] : []),
      `核心实例：${label(this.instanceId) || '未知'}`,
    ].join('\n');
  }
  private async showStatus() {
    let coreVersion = '核心版本：当前服务未提供版本信息';
    if (this.capabilities.has('app-build-info')) {
      try { const info = await this.request<AppBuildInfo>('/version'); coreVersion = `核心版本：${label(info.version)}${info.sourceHash ? ` · ${label(info.sourceHash).slice(0, 12)}` : ''}`; }
      catch { coreVersion = '核心版本：暂时无法读取'; }
    }
    this.note(`${this.statusSummary()}\n${coreVersion}`);
  }
  /** 无歧义的数据选择可直接取值；授权和操作确认仍由 choose 呈现。 */
  private async pick(title: string, items: SelectItem[], empty: string, filter?: (query: string) => string[]): Promise<string | undefined> {
    if (this.stopped || !this.modalScopeCurrent()) return undefined;
    if (!items.length) { this.note(empty); return undefined; }
    if (items.length === 1) return items[0]!.value;
    return this.choose(title, items, filter);
  }
  private choose(title: string, items: SelectItem[], filter?: (query: string) => string[], preview?: Component): Promise<string | undefined> {
    if (this.stopped || !this.modalScopeCurrent() || this.pendingModal || this.ui.hasOverlay()) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const safeItems = items.map(item => ({ value: item.value, label: label(item.label) || label(item.value) || '[无名称]', description: item.description === undefined ? undefined : label(item.description) }));
      const list = new SelectList(safeItems, 10, selectTheme);
      const box = new Box(1, 1, s => theme.bg('customMessageBg', s));
      const selector = new SearchSelector(list, safeItems, filter);
      box.addChild(new Text(safeTerminalText(title), 0, 0)); if (preview) box.addChild(preview); box.addChild(new Spacer(1)); box.addChild(selector); box.addChild(new Text('输入搜索  ↑↓ 选择  Enter 确认  Esc 返回', 0, 0));
      const modal = new Modal(box, selector); let handle: OverlayHandle;
      const finish = (value?: string) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); };
      const cancel = () => finish(); this.pendingModal = cancel;
      list.onSelect = item => finish(item.value); list.onCancel = cancel;
      handle = this.overlays.openOverlay(modal, { width: '80%', maxHeight: '80%', margin: 1 });
    });
  }
  private prompt(title: string, initial = '', secret = false): Promise<string | undefined> {
    if (this.stopped || !this.modalScopeCurrent() || this.pendingModal || this.ui.hasOverlay()) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const input = secret ? new SecretInput() : new TerminalInput({ prompt: '› ' }); input.setValue(initial);
      const box = new Box(1, 1, s => theme.bg('customMessageBg', s));
      box.addChild(new Text(safeTerminalText(title), 0, 0)); box.addChild(input); box.addChild(new Text('Enter 确认  Esc 返回', 0, 0));
      const modal = new Modal(box, input); let handle: OverlayHandle;
      const finish = (value?: string) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); };
      const cancel = () => finish(); this.pendingModal = cancel; input.onSubmit = value => finish(value); input.onEscape = cancel;
      handle = this.overlays.openOverlay(modal, { width: '80%', maxHeight: '80%', margin: 1 });
    });
  }
  private promptLong(title: string, initial = ''): Promise<string | undefined> {
    if (this.stopped || !this.modalScopeCurrent() || this.pendingModal || this.ui.hasOverlay()) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const input = new TerminalEditor(this.ui, editorTheme, { paddingX: 0 }); input.setText(initial);
      const box = new Box(1, 1, s => theme.bg('customMessageBg', s));
      box.addChild(new Text(safeTerminalText(title), 0, 0)); box.addChild(input); box.addChild(new Text('Enter 确认  Shift+Enter 或 Ctrl+J 换行  Esc 返回', 0, 0));
      let handle: OverlayHandle;
      const finish = (value?: string) => { if (this.pendingModal !== cancel) return; this.pendingModal = undefined; this.overlays.closeOverlay(handle); resolve(value); };
      const cancel = () => finish(); this.pendingModal = cancel; input.onSubmit = value => finish(value);
      handle = this.overlays.openOverlay(new Modal(box, input, cancel), { width: '80%', maxHeight: '80%', margin: 1 });
    });
  }
  private async manage() { await this.withModalFlow(() => this.manageInFlow()); }
  private async manageInFlow() {
    try {
      const required: Record<string, string> = { queue: 'message-queue', 'provider-auth': 'provider-auth', web: 'web-tools', attachments: 'attachments', capacity: 'context-capacity', questions: 'interactive-tools', skills: 'workspace-skills' };
      const action = await this.choose('管理', [
        { value: 'contexts', label: '上下文' }, { value: 'create', label: '新建上下文' },
        { value: 'models', label: '切换模型' }, { value: 'model-create', label: '配置模型' }, { value: 'model-edit', label: '编辑模型配置' }, { value: 'runtime', label: '运行设置' }, { value: 'web', label: '网页搜索设置' },
        { value: 'approvals', label: '审批' }, { value: 'questions', label: '问题与计划' }, { value: 'queue', label: '消息队列' }, { value: 'attachments', label: '附件' }, { value: 'tasks', label: '任务' }, { value: 'task-create', label: '新建任务' },
        { value: 'schedules', label: '定时任务' }, { value: 'mcp', label: 'MCP 连接' }, { value: 'workspaces', label: '工作区' }, { value: 'skills', label: 'Skills' }, { value: 'methods', label: '方法' }, { value: 'workflows', label: '工作流' },
        { value: 'memory', label: '记忆' }, { value: 'notifications', label: '待处理通知' }, { value: 'usage', label: '用量' }, { value: 'capacity', label: '上下文容量' }, { value: 'tools', label: '工具活动' }, { value: 'external-editor', label: '外部编辑器' }, { value: 'recover-draft', label: '恢复草稿' },
        { value: 'credentials', label: '凭据' }, { value: 'provider-auth', label: '供应商登录' }, { value: 'appearance', label: '界面设置' }, { value: 'shutdown', label: '关闭核心' },
      ].filter(item => !required[item.value] || this.capabilities.has(required[item.value]!)));
      if (action === 'contexts') await this.contexts();
      else if (action === 'create') await this.createContext();
      else if (action === 'models') await this.models();
      else if (action === 'model-create') await this.createModel();
      else if (action === 'model-edit') await this.editModel();
      else if (action === 'runtime') await this.runtimeSettings();
      else if (action === 'web') await this.webSettings();
      else if (action === 'approvals') await this.approvalsInFlow();
      else if (action === 'questions') await this.questions();
      else if (action === 'queue') await this.messageQueue();
      else if (action === 'attachments') await this.attachments();
      else if (action === 'tasks') await this.tasks();
      else if (action === 'task-create') await this.createTask();
      else if (action === 'schedules') await this.schedules();
      else if (action === 'mcp') await this.mcp();
      else if (action === 'workspaces') await this.workspaces();
      else if (action === 'skills') await this.skills();
      else if (action === 'methods') await this.methods();
      else if (action === 'workflows') await this.workflows();
      else if (action === 'memory') await this.memory();
      else if (action === 'notifications') await this.notifications();
      else if (action === 'external-editor') await this.externalEditor(true);
      else if (action === 'recover-draft') await this.recoverDraft();
      else if (action === 'tools') await this.toolActivity();
      else if (action === 'usage') await this.showUsage();
      else if (action === 'capacity') await this.showCapacity();
      else if (action === 'credentials') await this.credentials();
      else if (action === 'provider-auth') await this.providerAuth();
      else if (action === 'appearance') await this.appearanceSettings();
      else if (action === 'shutdown') await this.executeCommand('/shutdown');
    } catch (error) { if (!this.stopped) this.note(`操作失败：${label(error instanceof AppError ? error.code : 'request_failed')}`); }
  }
  private showSessionSelector<T>(build: (done: (value?: T) => void, signal: AbortSignal) => Component & { dispose?(): void }): Promise<T | undefined> {
    if (this.stopped || !this.modalScopeCurrent() || this.pendingModal || this.ui.hasOverlay() || this.sessionSelector) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const controller = new AbortController(); let component: (Component & { dispose?(): void }) | undefined;
      const finish = (value?: T) => {
        if (this.pendingModal !== cancel) return;
        this.pendingModal = undefined; controller.abort(); component?.dispose?.();
        if (this.sessionSelector === component) { this.sessionSelector = undefined; this.mountEditor(); this.ui.requestRender(); }
        resolve(value);
      };
      const cancel = () => finish(); this.pendingModal = cancel;
      try { component = build(finish, controller.signal); this.sessionSelector = component; this.mountEditor(); this.ui.requestRender(); }
      catch (error) { if (this.pendingModal === cancel) this.pendingModal = undefined; controller.abort(); component?.dispose?.(); reject(error); }
    });
  }
  private sessionControls() {
    return new SessionControls({
      contextId: () => this.contextId, theme: () => theme, rows: () => this.ui.terminal.rows, render: () => this.ui.requestRender(),
      request: <T>(route: string, init?: ClientRequestInit) => this.request<T>(route, init),
      write: (route, body, method, signal) => this.write(route, body, method, signal),
      select: <T>(build: (done: (value?: T) => void, signal: AbortSignal) => Component & { dispose?(): void }) => this.showSessionSelector<T>(build),
      choose: (title, items) => this.choose(title, items), edit: title => this.promptLong(title),
      copy: async text => { const clipboard = this.clipboard ?? getNativeClipboard(); if (!clipboard?.setText) throw new AppError('clipboard_unavailable'); await clipboard.setText(text); },
      note: text => this.note(text),
      open: (id, draft) => { this.switchContext(id); if (draft !== undefined && !this.editor.getText().trim()) this.editor.setText(draft); },
      navigate: (route, body) => this.navigateSessionTree(route, body),
      fork: (route, body) => this.navigateSessionTree<{ context: ContextRecord; draft: string }>(route, body),
      filter: () => this.treeFilterMode, saveFilter: value => { this.treeFilterMode = value; this.savePreferences(); },
    });
  }
  private async navigateSessionTree<T = SessionNavigationResult>(route: string, body: unknown): Promise<T> {
    if (this.treeNavigationController || this.compactController || this.automaticCompaction) throw new AppError('context_busy', 409);
    const controller = new AbortController(), contextId = this.contextId, storageId = this.storageId;
    this.treeNavigationController = controller;
    try {
      const queuedCount=async()=>this.capabilities.has('message-queue-editor')?(await this.request<MessageQueueSummary>(`/contexts/${routeId(contextId)}/message-queue?view=summary`,{signal:controller.signal})).count:(await this.request<SignalRecord[]>(`/contexts/${routeId(contextId)}/message-queue`,{signal:controller.signal})).length;
      if (await queuedCount()) {
        await this.restoreQueue(true);
        if (await queuedCount()) throw new AppError('queue_restore_required', 409);
      }
      controller.signal.throwIfAborted();
      const snapshot = await this.client.snapshot(contextId, controller.signal);
      if (snapshot.storageId !== storageId || !this.modalScopeCurrent() || contextId !== this.contextId) throw new AppError('core_storage_changed', 409);
      const active = snapshot.runs.find(run => run.contextId === contextId && run.status === 'running');
      if (active) {
        await this.write(`/contexts/${routeId(contextId)}/interrupt`, { expectedRunId: active.id }, 'POST', controller.signal);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
        for (;;) { const run = await this.request<RunRecord>(`/runs/${routeId(active.id)}`, { signal }); if (run.status !== 'running') break; await waitFor(50, undefined, { signal }); }
      }
      if (this.compactController || this.automaticCompaction) throw new AppError('context_busy', 409);
      const current = await this.request<SessionTreeView>(`/contexts/${routeId(contextId)}/tree`, { signal: controller.signal });
      controller.signal.throwIfAborted(); this.note('正在切换会话记录；Esc 可取消摘要。');
      return await this.write(route, { ...(body as Record<string, unknown>), ...(route.endsWith('/tree/navigate') ? { expectedRevision: current.revision, expectedLeafId: current.leafId } : {}) }, 'POST', controller.signal) as T;
    } catch (error) {
      if (controller.signal.aborted) throw new DOMException('Session navigation cancelled', 'AbortError');
      throw error;
    } finally { if (this.treeNavigationController === controller) this.treeNavigationController = undefined; }
  }
  private async contexts(openDirectly = false) {
    if (openDirectly && this.capabilities.has('session-browser')) { await this.sessionControls().browse(); return; }
    const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
    const tree = contextTree(openDirectly ? contexts.filter(context => !context.archived) : contexts);
    const sessions: SessionInfo[] = tree.map(({ context }) => ({ id: context.id, name: context.name, cwd: context.workspaceId ?? '', allMessagesText: context.purpose ?? '', modified: new Date(context.updatedAt ?? 0) }));
    const choice = await this.choose('选择上下文', tree.map(({ context, depth }) => ({ value: context.id, label: `${context.id === this.contextId ? '✓ ' : '  '}${depth ? `${'│ '.repeat(Math.min(depth - 1, 12))}└─ ` : ''}${context.name || context.id}`, description: `${context.updatedAt ? `${new Date(context.updatedAt).toLocaleString()} · ` : ''}${context.role === 'main' ? '交流' : '工作'}${context.parentContextId ? ` · 来源 ${context.parentContextId}` : ''}${context.archived ? ' · 已归档' : ''}` })), query => filterAndSortSessions(sessions, query, 'relevance').map(session => session.id));
    if (!choice) return;
    const context = contexts.find(x => x.id === choice); if (!context) return;
    if (openDirectly) { this.switchContext(context.id); return; }
    const options: SelectItem[] = [{ value: 'open', label: context.role === 'main' ? '打开对话' : '查看只读历史' }, { value: 'details', label: '查看来源和用途' }, { value: 'rename', label: '重命名' }, { value: 'archive', label: context.archived ? '取消归档' : '归档' }];
    if (context.role === 'main' && !context.archived && this.capabilities.has('context-branch')) options.push({ value: 'branch', label: '从已完成轮次分支' });
    if (context.role === 'main' && !context.archived && this.capabilities.has('context-fork-message')) options.push({ value: 'fork-message', label: '从用户消息前分支并重新编辑' });
    const action = await this.choose(context.name, options);
    if (action === 'open') this.switchContext(choice);
    else if (action === 'details') this.note(`上下文 ${label(context.name)} · ${label(context.role)}\n${safeTerminalText(context.purpose ?? '')}${context.parentContextId ? `\n来源上下文：${label(context.parentContextId)}\n来源运行：${label(context.parentRunId)}` : ''}${context.workingSet ? `\n派生工作集：${label(context.workingSet.fromRunId)} 至 ${label(context.workingSet.throughRunId)}（非摘要，源上下文未修改）` : ''}`);
    else if (action === 'branch') await this.branchContext(context);
    else if (action === 'fork-message') await this.forkMessage(context);
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
  private async forkMessage(source: ContextRecord) {
    const messages: ConversationMessage[] = [];
    let page = await this.client.conversation(source.id, undefined, this.lifetime.signal);
    const cursors = new Set<string>();
    for (;;) {
      messages.push(...page.messages.filter(message => message.role === 'user' && message.kind === 'message' && !['cancelled', 'rejected'].includes(message.status)));
      if (!page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new AppError('history_pagination_stalled');
      cursors.add(page.nextCursor); page = await this.client.conversation(source.id, page.nextCursor, this.lifetime.signal);
    }
    if (!messages.length) { this.note('没有可重新编辑的用户消息。'); return; }
    const id = await this.choose('从哪条用户消息前分支并重新编辑', [...messages].reverse().map(message => ({ value: message.id, label: label(message.content).slice(0, 120) || '（附件消息）', description: new Date(message.createdAt).toLocaleString() })));
    if (!id) return;
    const forked = await this.write(`/contexts/${routeId(source.id)}/fork`, { sourceMessageId: id }) as { context: ContextRecord; draft: string };
    this.switchContext(forked.context.id); this.editor.setText(forked.draft);
  }
  private async createContext(initialName?: string) {
    const name = initialName ?? await this.prompt('上下文名称'); if (!name?.trim()) return;
    const purpose = initialName ? '' : await this.prompt('用途（可留空）'); if (purpose === undefined) return;
    const { workspaces } = await this.request<{ workspaces: Array<{ id: string; name?: string; path?: string }> }>('/workspaces');
    const workspaceId = await this.pick('选择工作区', workspaces.map(x => ({ value: x.id, label: x.name ?? x.id, description: x.path })), '没有可用的工作区。');
    if (!workspaceId) return;
    const created = await this.write('/contexts', { name: name.trim(), purpose, workspaceId, role: 'main' }) as ContextRecord;
    this.switchContext(created.id);
  }
  private async newConversation(name = '新对话') {
    const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
    const source = contexts.find(context => context.id === this.contextId);
    const created = await this.write('/contexts', { name, purpose: '', workspaceId: source?.workspaceId ?? 'default', ...(source?.modelProfile ? { modelProfile: source.modelProfile } : {}), role: 'main' }) as ContextRecord;
    this.switchContext(created.id);
  }
  private async models() {
    const { models } = await this.request<{ models: Array<{ id: string; name: string; modelId: string; providerId?: string; thinking?: Record<string, unknown> }> }>('/models');
    // Pi model selector: current first with ✓, provider badge, fuzzy search.
    const current = this.model?.profileId;
    const ordered = [...models].sort((a, b) => Number(b.id === current) - Number(a.id === current));
    const id = await this.choose('选择模型', ordered.map(x => ({ value: x.id, label: `${x.id === current ? '✓ ' : '  '}${x.name}`, description: `${x.modelId}${x.providerId ? ` [${x.providerId}]` : ''}${x.id === current ? ' · 当前' : ''}` }))); if (!id) return;
    await this.write(`/contexts/${routeId(this.contextId)}/model`, { profileId: id }); await this.refreshModel(); this.note('模型已切换；/think 可调整思考等级。');
  }
  private async createModel() {
    const existing = await this.request<{ models: Array<{ id: string }> }>('/models');
    const source = await this.choose('模型来源', [{ value: 'catalog', label: '供应商模型目录' }, { value: 'custom', label: '自定义接口' }]);
    if (!source) return;
    if (source === 'catalog') {
      const { models } = await this.request<{ models: Array<{ providerId: string; modelId: string; name: string; thinkingLevels?: string[] }> }>('/provider-models');
      const providerIds = [...new Set(models.map(model => model.providerId))];
      const providerId = await this.pick('供应商', providerIds.map(value => ({ value, label: value })), '供应商目录为空。'); if (!providerId) return;
      const available = models.filter(model => model.providerId === providerId);
      const modelId = await this.pick('模型', available.map(model => ({ value: model.modelId, label: model.name || model.modelId, description: model.modelId })), '该供应商没有可用模型。'); if (!modelId) return;
      const id = await this.prompt('模型配置 ID'); if (!id?.trim()) return;
      if (existing.models.some(model => model.id === id.trim())) throw new AppError('model_profile_already_exists');
      const selected = available.find(model => model.modelId === modelId)!;
      const name = await this.prompt('名称', selected.name ?? id); if (!name?.trim()) return;
      const defaultLevel = await this.pick('默认思考模式', [{ value: 'unset', label: '不指定' }, ...supportedLevels(selected.thinkingLevels ?? []).map(value => ({ value, label: value }))], '该模型没有思考等级配置。'); if (defaultLevel === undefined) return;
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
    const authOptions=this.capabilities.has('model-request-auth')||protocol==='messages'?[{value:'api-key',label:'API key 请求头'},{value:'bearer',label:'Bearer'}]:[{value:'bearer',label:'Bearer'}];if(protocol!=='messages')authOptions.reverse();
    const authHeader = await this.choose('认证方式',authOptions); if (!authHeader) return;
    await this.write('/configuration/model', { id: id.trim(), name: name.trim(), protocol, baseURL: baseURL.trim(), modelId: modelId.trim(), apiKeyEnv: apiKeyEnv.trim(), authHeader,...(this.capabilities.has('model-request-auth')?{requestAuth:authHeader}:{}), thinking: {} });
    this.note('模型配置已保存。');
  }
  private async editModel() {
    const configuration = await this.request<{ modelProfiles: SavedProfile[] }>('/configuration');
    const id = await this.pick('编辑模型配置', configuration.modelProfiles.map(x => ({ value: x.id, label: x.name, description: x.id })), '还没有模型配置；/menu → 配置模型 添加。'); if (!id) return;
    const profile = configuration.modelProfiles.find(x => x.id === id); if (!profile) return;
    const fields: SelectItem[] = [{ value: 'name', label: '名称' }, { value: 'modelId', label: '模型 ID' }, { value: 'defaultThinkingLevel', label: '默认思考模式' }];
    if ('providerId' in profile) fields.push({ value: 'providerId', label: '供应商 ID' });
    else fields.push({ value: 'baseURL', label: '服务地址' }, { value: 'apiKeyEnv', label: '凭据引用' }, { value: 'authHeader', label: `认证方式：${(profile.requestAuth??(profile.protocol==='messages'?profile.authHeader:'bearer'))==='api-key'?'API key 请求头':'Bearer'}` }, { value: 'protocol', label: '协议' }, { value: 'thinkingMode', label: `思考能力：${profile.thinkingMode === 'manual' ? '仅使用手动映射' : '自动识别'}` }, { value: 'thinking', label: '思考参数映射' });
    const field = await this.choose(`编辑 ${label(profile.name)}`, fields); if (!field) return;
    let next: SavedProfile = { ...profile };
    if (field === 'defaultThinkingLevel') {
      let levels: string[];
      const capabilities = await this.request<{ thinking?: Record<string, { thinkingLevels: string[] }> }>('/models');
      const resolved = capabilities.thinking?.[next.id];
      if (resolved) levels = supportedLevels(resolved.thinkingLevels);
      else if ('providerId' in next) {
        const catalog = await this.request<{ models: Array<{ modelId: string; thinkingLevels?: string[] }> }>(`/provider-models?provider=${routeId(next.providerId)}`);
        const model = catalog.models.find(item => item.modelId === next.modelId); if (!model) throw new AppError('model_not_found', 404);
        levels = supportedLevels(model.thinkingLevels ?? []);
      } else levels = supportedLevels(Object.keys(next.thinking));
      const value = await this.choose('默认思考模式（不指定则使用提供方默认）', [{ value: 'unset', label: '不指定' }, ...levels.map(level => ({ value: level, label: level }))]); if (!value) return;
      if (value === 'unset') { next = { ...next }; delete next.defaultThinkingLevel; }
      else next = { ...next, defaultThinkingLevel: value as NonNullable<typeof next.defaultThinkingLevel> };
    } else if (field === 'thinkingMode' && 'thinking' in next) {
      const mode = await this.choose('思考能力', [{ value: 'auto', label: '自动识别模型能力', description: '保留自定义映射，其他等级采用模型设置' }, { value: 'manual', label: '仅使用手动映射', description: '用于需要自行限定等级的自定义服务' }]);
      if (!mode) return;
      if (mode === 'manual' && !Object.keys(next.thinking).length) { this.note('请先添加思考参数映射，再限定为手动模式。'); return; }
      next = { ...next, thinkingMode: mode as 'auto' | 'manual' };
    } else if (field === 'thinking' && 'thinking' in next) {
      const existingThinking = next.thinking;
      const level = await this.choose('思考模式', thinkingCommandLevels.map(value => ({ value, label: value, description: existingThinking[value] ? '已配置' : undefined }))); if (!level) return;
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
      const effective=next.requestAuth??(next.protocol==='messages'?next.authHeader:'bearer'),options=this.capabilities.has('model-request-auth')||next.protocol==='messages'?[{value:'api-key',label:'API key 请求头'},{value:'bearer',label:'Bearer'}]:[{value:'bearer',label:'Bearer'}];options.sort((a,b)=>Number(b.value===effective)-Number(a.value===effective));
      const value = await this.choose('认证方式',options.map(row=>({...row,...(row.value===effective?{description:'当前生效'}:{})}))); if (value!=='api-key'&&value!=='bearer') return;
      next = { ...next, authHeader:value,...(this.capabilities.has('model-request-auth')?{requestAuth:value}:{}) };
    } else if (field === 'protocol' && 'protocol' in next) {
      const value = await this.choose('接口协议', [{ value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }, { value: 'messages', label: 'Messages' }]); if (!value) return;
      if (value !== next.protocol) { const confirm = await this.choose('切换协议将清除不兼容的思考模式配置。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]); if (confirm !== 'yes') return; }
      if (value !== next.protocol) { next = { ...next }; delete next.defaultThinkingLevel; }
      next = { ...next, protocol: value as typeof next.protocol, thinking: value === next.protocol ? next.thinking : {} };
    } else {
      const initial = safeValueText((next as unknown as Record<string, unknown>)[field] ?? '');
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
  private savePreferences(appearance = this.preferences?.read().appearance) {
    try { this.preferences?.save({ ...(appearance ? { appearance } : {}), ...(this.treeFilterMode !== 'default' ? { treeFilterMode: this.treeFilterMode } : {}), storageId: this.storageId, contextId: this.contextId }); }
    catch { this.note('界面设置未能保存，本次会话仍可继续。'); }
  }
  private async appearanceSettings() {
    const appearance = await this.choose('界面主题', [{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'plain', label: '无颜色' }]);
    if (appearance !== 'dark' && appearance !== 'light' && appearance !== 'plain') return;
    applyTheme(appearance === 'plain' || !colorEnabled() ? plainTheme : new Theme(appearance));
    this.savePreferences(appearance);
    for (const editor of this.editors.values()) editor.invalidate();
    this.status(this.statusText); this.ui.requestRender();
    this.note('界面主题已更新；重新打开对话可刷新已有消息的颜色。');
  }
  private async runtimeSettings() {
    const { runtime, models } = await this.request<{ runtime: { memoryEnabled: boolean; maxSteps: number; defaultWorkModel: string; memoryModel: string; contextOverflow?: 'warn' | 'block' }; models: Array<{ id: string; name: string }> }>('/configuration');
    const field = await this.choose('运行设置', [{ value: 'memoryEnabled', label: `记忆：${runtime.memoryEnabled ? '启用' : '停用'}` }, { value: 'maxSteps', label: `最大步骤：${runtime.maxSteps}` }, { value: 'defaultWorkModel', label: `工作模型：${runtime.defaultWorkModel}` }, { value: 'memoryModel', label: `记忆模型：${runtime.memoryModel}` }, ...(this.capabilities.has('context-capacity') ? [{ value: 'contextOverflow', label: `超出上下文预算：${runtime.contextOverflow === 'block' ? '阻止' : '警告'}` }] : []), ...(this.capabilities.has('companion-state') ? [{ value: 'companion', label: '主动交流与安静时间' }] : [])]); if (!field) return;
    if (field === 'companion') { await this.companionSettings(); return; }
    let value: string | boolean | number;
    if (field === 'contextOverflow') { const choice = await this.choose('估算超出输入预算时', [{ value: 'warn', label: '警告并继续' }, { value: 'block', label: '在请求提供方前阻止' }]); if (!choice) return; value = choice; }
    else if (field === 'memoryEnabled') { const choice = await this.choose('记忆', [{ value: 'on', label: '启用' }, { value: 'off', label: '停用' }]); if (!choice) return; value = choice === 'on'; }
    else if (field === 'maxSteps') { const raw = await this.prompt('最大步骤（4–512）', String(runtime.maxSteps)); if (!raw) return; value = Number(raw); if (!Number.isInteger(value) || value < 4 || value > 512) throw new AppError('invalid_max_steps'); }
    else { const selected = await this.choose('选择模型', [...(field === 'memoryModel' ? [{ value: 'same', label: '与源上下文相同' }] : []), ...models.map(model => ({ value: model.id, label: model.name }))]); if (!selected) return; value = selected; }
    await this.write('/configuration/runtime', { [field]: value }); this.note('运行设置已更新。');
  }
  private async companionSettings() {
    const state = await this.request<CompanionRhythmView>('/companion');
    const status = { disabled: '停用', running: '启用', stopped: '已停止', blocked: '暂不可用' }[state.status];
    const field = await this.choose('主动交流与安静时间', [
      { value: 'enabled', label: `主动交流：${status}`, description: '安静期间可自行判断是否需要表达；会等待对话空闲。' },
      { value: 'interval', label: `基础间隔：${state.configuration.intervalMinutes === null ? '尚未设置' : state.configuration.intervalMinutes + ' 分钟'}`, description: '没有新活动时会逐渐延长，最多为基础间隔的八倍。' },
      { value: 'target', label: state.configuration.target === 'latest' ? '交流位置：最近与你交谈的主会话' : `交流位置：${state.configuration.contextId}` },
    ]);
    if (!field) return;
    const configuration = { ...state.configuration };
    if (field === 'enabled') {
      const enabled = await this.choose('主动交流', [{ value: 'on', label: '启用' }, { value: 'off', label: '停用' }]); if (!enabled) return;
      if (enabled === 'off') configuration.intervalMinutes = null;
      else if (configuration.intervalMinutes === null) { const raw = await this.prompt('基础间隔（分钟，1–525600）', '15'); if (raw === undefined) return; configuration.intervalMinutes = Number(raw); }
    } else if (field === 'interval') {
      const raw = await this.prompt('基础间隔（分钟，1–525600；保存后启用）', String(configuration.intervalMinutes ?? 15)); if (raw === undefined) return;
      configuration.intervalMinutes = Number(raw);
    } else {
      const target = await this.choose('交流位置', [{ value: 'latest', label: '最近与你交谈的主会话' }, { value: 'fixed', label: '固定主会话' }]); if (!target) return;
      configuration.target = target as 'latest' | 'fixed';
      if (target === 'fixed') {
        const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
        const id = await this.choose('选择主会话', contexts.filter(row => row.role === 'main' && !row.archived).map(row => ({ value: row.id, label: row.name || row.id, description: row.id })));
        if (!id) return; configuration.contextId = id;
      }
    }
    if (configuration.intervalMinutes !== null && (!Number.isFinite(configuration.intervalMinutes) || configuration.intervalMinutes < 1 || configuration.intervalMinutes > 525600)) throw new AppError('invalid_companion_interval');
    try { await this.write('/companion', { expectedRevision: state.revision, configuration }, 'PUT'); }
    catch (error) {
      if (this.stopped || !this.modalScopeCurrent()) throw error;
      const actual = await this.request<CompanionRhythmView>('/companion').catch(() => undefined);
      if (!actual || actual.revision !== state.revision + 1 || JSON.stringify(actual.configuration) !== JSON.stringify(configuration)) throw error;
    }
    this.note('主动交流设置已保存。');
  }
  /**
   * Ctrl+G, as in Pi: $VISUAL/$EDITOR opens directly (command split on spaces, Pi's rule). Without one
   * configured, or from /menu, the program and arguments are confirmed first.
   */
  private async externalEditor(ask = false) {
    const configured = (process.env.VISUAL || process.env.EDITOR || '').trim();
    let command: string; let args: string[];
    if (configured && !ask) { [command, ...args] = splitCommand(configured) as [string, ...string[]]; }
    else {
      const suggested = configured || (process.platform === 'win32' ? 'notepad' : 'nano');
      const chosen = await this.prompt('本机编辑器程序路径（参数另行填写）', suggested); if (!chosen?.trim()) return;
      const extra = await this.editStrings('编辑器参数', []); if (!extra) return;
      const confirmation = await this.choose('该程序将读取当前输入的临时文件，确认启动？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '启动' }]); if (confirmation !== 'yes') return;
      command = chosen.trim(); args = extra;
    }
    const editor = this.editor; const content = editor.getExpandedText();
    const context = this.contextId; const storageId = this.storageId;
    const current = () => this.editor === editor && this.contextId === context && this.storageId === storageId && editor.getExpandedText() === content;
    const operation = (async () => {
      await this.ui.terminal.drainInput(1000); if (this.stopped) return;
      this.ui.stop(); this.started = false;
      try {
        const result = await this.editExternal({ command, args, content, signal: this.lifetime.signal });
        if (this.stopped) return;
        if (result.status === 'complete') {
          if (current()) editor.setText(result.content);
          else {
            this.rememberDraft({ text: result.content, context, storageId, attachments: [], shell: [] });
            this.note('外部编辑结果已保留，可从 /menu 的“恢复草稿”取回；当前输入未改变。');
          }
        } else this.note(result.message);
      } finally {
        if (!this.stopped) { this.started = true; this.ui.start(); this.ui.setFocus(this.editor); this.ui.requestRender(true); }
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
    if (mediaType && isMemoryAudio(mediaType)) { validateMemoryAudioWav(bytes); mediaType = 'audio/wav'; }
    else if (mediaType && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType) && !documentFormatForMime(mediaType)) throw new AppError('asset_type_not_supported');
    if (!mediaType) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (bytes.includes(0)) throw new Error(); }
      catch { throw new AppError('asset_type_not_supported'); }
      mediaType = 'text/plain';
    }
    return { name, bytes, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  private async readLocalAttachment(input: string): Promise<LocalAttachment> {
    const file = path.resolve(this.completionBase, input);
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
    if (!this.capabilities.has('logical-input')&&items.length >= 8) throw new AppError('too_many_attachments');
    if (!this.capabilities.has('logical-input')&&items.reduce((total, item) => total + item.bytes, 0) + attachment.bytes.length > MAX_MESSAGE_ATTACHMENTS) throw new AppError('message_attachments_too_large');
    const info=await this.uploadAttachment(attachment);if(!info)return;
    const latest = this.pendingAttachments.get(context) ?? [];
    if (!this.capabilities.has('logical-input')&&(latest.length >= 8 || latest.reduce((total, item) => total + item.bytes, 0) + info.bytes > MAX_MESSAGE_ATTACHMENTS)) throw new AppError('message_attachments_too_large');
    this.pendingAttachments.set(context, [...latest, info]);
    if (context === this.contextId && !this.stopped) { this.note(`附件已暂存：${label(info.name)}。发送消息时还需确认。`); this.status(this.statusText); }
  }
  private async uploadAttachment(attachment:LocalAttachment){
    const storageId=this.storageId;if(!storageId)throw new AppError('core_not_ready');
    const image = attachment.mediaType.startsWith('image/') && getCapabilities().images
      ? new Image(attachment.bytes.toString('base64'), attachment.mediaType, { fallbackColor: identity }, { maxWidthCells: 40, maxHeightCells: 5, filename: label(attachment.name) }) : undefined;
    const description = `附件：${label(attachment.name)}\n${label(attachment.mediaType)} · ${attachment.bytes.length} 字节\nSHA-256 ${attachment.sha256}${attachment.mediaType.startsWith('image/') && !image ? '\n当前终端不支持图像预览。' : ''}`;
    const confirm = await this.choose(description, [{ value: 'no', label: '取消' }, { value: 'yes', label: '上传并暂存' }], undefined, image);
    if (confirm !== 'yes' || this.stopped) return;
    if (storageId !== this.storageId) throw new AppError('core_storage_changed');
    const info = await this.request<AssetInfo>(`/assets?name=${encodeURIComponent(attachment.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-ShittimChest-Storage-Id': storageId }, body: new Uint8Array(attachment.bytes) });
    if (storageId !== this.storageId) throw new AppError('core_storage_changed');
    if (!/^[0-9a-f-]{36}$/i.test(info.id) || info.name !== attachment.name || info.sha256 !== attachment.sha256 || info.bytes !== attachment.bytes.length || info.mediaType !== attachment.mediaType) throw new AppError('attachment_integrity_mismatch');
    return info;
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
  private async attachments(arg = '') {
    const context = this.contextId; const pending = this.pendingAttachments.get(context) ?? [];
    if (arg) {
      const files = splitCommand(arg); if (files.length !== 1) throw new AppError('attachment_invalid_arguments');
      await this.stageAttachment(await this.readLocalAttachment(files[0]!), context); return;
    }
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
      } else this.note(`附件 ${label(info.name)} · ${label(info.mediaType)} · ${info.bytes} 字节；可保存到本机查看。`);
    }
  }
  private async webSettings() {
    type Providers = { mode: string; catalog?: WebProviderRuntime['catalog']; search?: unknown; extract?: unknown };
    const { web, webProviders } = await this.request<{ web: WebConfiguration; webProviders?: Providers }>('/configuration');
    if (web.type === 'auto') this.note(`当前网页服务 · 搜索：${label(webRouteLabel(webProviders?.search))} · 读取：${label(webRouteLabel(webProviders?.extract))}`);
    const options = [...(web.type === 'auto' || webProviders?.catalog ? [{ value: 'auto', label: '自动与多服务设置' }] : []), { value: 'none', label: '停用搜索' }, { value: 'brave', label: 'Brave Search' }, { value: 'searxng', label: 'SearXNG' }];
    options.sort((a, b) => Number(b.value === web.type) - Number(a.value === web.type));
    const type = await this.choose('网页搜索设置', options); if (!type) return;
    let config: WebConfiguration;
    if (type === 'auto') {
      const cached = this.automaticWebDraft?.storageId === this.storageId ? this.automaticWebDraft?.config : undefined;
      const edited = await editAutomaticWeb({ choose: (title, items) => this.choose(title, items), prompt: (title, initial) => this.prompt(title, initial), note: text => this.note(text) }, cached ?? (web.type === 'auto' ? web : automaticWebDefaults()), webProviders?.catalog ?? []);
      if (!edited) { this.automaticWebDraft = undefined; return; }
      config = edited; this.automaticWebDraft = { storageId: this.storageId, config };
    }
    else if (type === 'brave') { const ref = await this.prompt('凭据名称（不是密钥）', web.type === 'brave' ? web.apiKeyEnv : ''); if (!ref?.trim()) return; config = { type, apiKeyEnv: ref.trim() }; }
    else if (type === 'searxng') { const url = await this.prompt('SearXNG 服务地址', web.type === 'searxng' ? web.baseURL : ''); if (!url?.trim()) return; config = { type, baseURL: url.trim() }; }
    else if (type === 'none') config = { type };
    else throw new AppError('invalid_web_configuration');
    const confirmation = await this.choose('确认保存网页搜索设置？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '保存' }]);
    if (confirmation === 'yes') {
      await this.write('/configuration/web', config);
      if (config.type === 'auto') { const saved = await this.request<{ webProviders?: Providers }>('/configuration'); this.note(`网页服务设置已更新 · 搜索：${label(webRouteLabel(saved.webProviders?.search))} · 读取：${label(webRouteLabel(saved.webProviders?.extract))}`); }
      else this.note('网页搜索设置已更新。');
      this.automaticWebDraft = undefined;
    }
  }
  private queueEditingControls(){
    const capabilities=JSON.stringify(['logical-input','queue-entry-attachment-parts'].map(capability=>this.capabilities.has(capability)));
    if(capabilities!==this.queueEditingCapabilities){this.queueEditing=undefined;this.queueEditingCapabilities=capabilities;}
    return this.queueEditing??=new QueueEditingControls({
      attachmentParts:this.capabilities.has('queue-entry-attachment-parts'),
      retainedVersions:this.capabilities.has('logical-input'),
      createEditor:()=>this.createEditor(),rows:()=>this.ui.terminal.rows,render:()=>this.ui.requestRender(),
      request:<T>(route:string)=>this.request<T>(route),write:(route,body,method,operationId)=>this.queueDraftWrite(route,body,method,operationId),localEdits:this.queueEdits,storageId:()=>this.storageId,
      select:<T>(build:(done:(value?:T)=>void)=>Component&{dispose?():void})=>this.showSessionSelector<T>(done=>build(done)),
      choose:(title,items)=>this.choose(title,items),note:text=>this.note(text),
      submitted:async draft=>{
        const storageId=this.storageId,generation=this.storageGeneration,validate=()=>{if(this.storageId!==storageId||this.storageGeneration!==generation||this.contextId!==draft.contextId||this.stopped)throw new AppError('core_context_changed',409);},candidates=this.queueEdits.captures(storageId,draft.contextId).filter(row=>row.directInput&&(draft.captures?.some(capture=>capture.draftId===row.entryId)||draft.capturedDraftId===row.entryId));
        if(!candidates.length)return;if(!logicalInputAdmitted(draft))throw new AppError(draft.errorCode??'logical_input_admission_unconfirmed',409);
        const entries:QueueEditEntry[]=[];let cursor:number|null=0;do{const page:QueueEditPage=await this.request<QueueEditPage>(`/contexts/${routeId(draft.contextId)}/message-queue/drafts/${routeId(draft.id)}?cursor=${cursor}&limit=50`,{headers:{'X-ShittimChest-Storage-Id':storageId}});validate();entries.push(...page.entries);cursor=page.nextCursor;}while(cursor!==null);
        for(const local of candidates){const capture=draft.captures?.find(row=>row.draftId===local.entryId),entry=entries.find(row=>row.id===(capture?.entryId??draft.capturedEntryId));if(!local.directInput||local.publicationPending||!entry||entry.content!==local.content||JSON.stringify(entry.attachments)!==JSON.stringify(local.attachments))continue;const intent:LogicalInputIntent={id:local.entryId,storageId,contextId:local.contextId,content:local.content,attachments:local.attachments,...(local.localContext?{localContext:local.localContext}:{}),...(local.selectedSkillName?{selectedSkillName:local.selectedSkillName}:{}),...(local.shellCaptureIds?.length?{shellCaptureIds:local.shellCaptureIds}:{}),...(local.shellObservations?{shellObservations:local.shellObservations}:{}),...(local.restoredFromSignalIds?.length?{restoredFromSignalIds:local.restoredFromSignalIds}:{}),...(local.expectedSource?{expectedSource:local.expectedSource}:{}),...local.directInput};acknowledgeLogicalInput(this.logicalInputHost(local.contextId,storageId,validate),intent,draft);}
      },
      currentRunId:()=>this.currentRunId,
      ...(this.capabilities.has('logical-input')?{rebase:async(draft:QueueEditDocument)=>{const storageId=this.storageId,generation=this.storageGeneration,contextId=draft.contextId,validate=()=>{if(this.stopped||this.storageId!==storageId||this.storageGeneration!==generation||this.contextId!==contextId)throw new AppError('core_context_changed',409);};const project=await this.request<ProjectDirectory>(`/contexts/${routeId(contextId)}/project-directory`,{headers:{'X-ShittimChest-Storage-Id':storageId}});validate();if(await this.choose(`将尚未执行的输入和资料移到当前项目的草稿中？旧来源只作为历史资料，不带入旧执行权限。\n${terminalTarget(project.directory.path)}`,[{value:'back',label:'返回并保留'},{value:'current',label:'移到当前项目并审查'}])!=='current')return;validate();const route=`/contexts/${routeId(contextId)}/message-queue/drafts/${routeId(draft.id)}`;if(draft.submission)draft=await this.queueDraftWrite(`${route}/reopen`,{expectedRevision:draft.revision},'POST') as QueueEditDocument;validate();const expectedSource={workspaceId:project.workspaceId,directory:project.directory},operationId='queue-rebase.'+createHash('sha256').update(JSON.stringify([storageId,draft.id,draft.revision,expectedSource])).digest('hex'),page=await this.queueDraftWrite(`${route}/rebase`,{expectedRevision:draft.revision,expectedSource},'POST',operationId) as QueueEditPage;validate();this.note('已打开资料草稿；请核对内容与当前受理状态。');return page;}}:{}),
      ...(this.capabilities.has('logical-input')?{skill:async(entry:QueueEditEntry)=>{const {skills}=await this.request<{skills:Array<{name:string;description:string;enabled:boolean;'user-invocable'?:boolean}>}>(`/contexts/${routeId(this.contextId)}/skills`),choice=await this.choose('选择本条输入的 Skill',[{value:'__inherit__',label:'沿用原来源的 Skill'},{value:'__none__',label:'不带入 Skill'},...skills.filter(row=>row.enabled&&row['user-invocable']!==false).map(row=>({value:`skill:${row.name}`,label:label(row.name),description:label(row.description)}))]);if(choice==='__inherit__')return{kind:'inherit' as const};if(choice==='__none__')return{kind:'none' as const};if(choice?.startsWith('skill:'))return{kind:'selected' as const,name:choice.slice(6)};}}:{}),
      attachment:async(entry:QueueEditEntry)=>{
        const items=await Promise.all(entry.attachments.map(assetId=>this.request<AssetInfo>(`/assets/${routeId(assetId)}/metadata`)));
        const action=await this.choose('这条消息的附件',[{value:'add',label:'添加本机文件'},...items.map(item=>({value:item.id,label:`移除 ${label(item.name)} · ${item.bytes} 字节`}))]);
        if(!action)return;
        if(action!=='add')return entry.attachments.filter(assetId=>assetId!==action);
        const file=await this.prompt('本机附件路径');if(!file?.trim())return;
        const local=await this.readLocalAttachment(file.trim());
        const uploaded=await this.uploadAttachment(local);return uploaded?[...entry.attachments,uploaded.id]:undefined;
      },
      external:async(content:string)=>{
        const configured=(process.env.VISUAL||process.env.EDITOR||'').trim();let command:string,args:string[];
        if(configured)[command,...args]=splitCommand(configured) as [string,...string[]];
        else {const chosen=await this.prompt('本机编辑器程序路径',process.platform==='win32'?'notepad':'nano');if(!chosen?.trim())return;const extra=await this.editStrings('编辑器参数',[]);if(!extra)return;command=chosen.trim();args=extra;if(await this.choose('确认启动本机编辑器？',[{value:'no',label:'返回'},{value:'yes',label:'启动'}])!=='yes')return;}
        await this.ui.terminal.drainInput(1000);if(this.stopped)return;this.ui.stop();this.started=false;
        try{const result=await this.editExternal({command,args,content,signal:this.lifetime.signal});if(result.status==='complete')return result.content;this.note(result.message);return;}
        finally{if(!this.stopped){this.started=true;this.ui.start();this.mountEditor();this.ui.requestRender(true);}}
      },
    });
  }
  private async messageQueue() {
    const context = this.contextId;
    if(this.capabilities.has('message-queue-editor')){
      const {drafts}=await this.request<{drafts:QueueEditDocument[]}>(`/contexts/${routeId(context)}/message-queue/drafts${this.capabilities.has('logical-input')?'?includeRetained=1':''}`);
      const pending=await this.request<MessageQueueSummary>(`/contexts/${routeId(context)}/message-queue?view=summary`);
      const local=this.queueEdits.drafts(this.storageId,context).filter(id=>!drafts.some(row=>row.id===id)),choices=[...drafts.map(row=>({value:row.id,label:row.status==='submitted'&&row.retainedVersionCount?`${row.retainedVersionCount} 个已保留版本`: `${row.entryCount} 条消息 · ${row.status}`})),...local.map(id=>({value:id,label:`本机未确认版本 · ${id.slice(0,8)}`}))];
      if(pending.count)choices.push({value:'__native_queue__',label:`取回 ${pending.count} 条排队消息并编辑`});
      if(!choices.length){this.note('没有排队消息或队列草稿。');return;}
      const chosen=choices.length===1?choices[0]!.value:await this.choose('队列草稿',choices);
      if(chosen==='__native_queue__'){await this.restoreQueue(true);const updated=await this.request<{drafts:QueueEditDocument[]}>(`/contexts/${routeId(context)}/message-queue/drafts`);const draft=updated.drafts.at(-1);if(draft)await this.queueEditingControls().open(context,draft.id);return;}
      if(chosen)await this.queueEditingControls().open(context,chosen);return;
    }
    const rows = await this.request<Array<SignalRecord & { revision: number }>>(`/contexts/${routeId(context)}/message-queue`, { signal: this.contextController.signal });
    if (!rows.length) { this.note('没有排队中的消息。'); return; }
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
  private async approvals() { await this.withModalFlow(() => this.approvalsInFlow()); }
  private async approvalsInFlow() {
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
    const originStorage = this.storageId; const originGeneration = this.storageGeneration;
    const { providers } = await this.request<{ providers: Array<{ id: string; name: string; methods: Array<{ type: 'api_key' | 'oauth'; name: string }> }> }>('/auth/providers');
    const match = requested ? providers.find(provider => provider.id === requested || provider.name.toLowerCase() === requested.toLowerCase()) : undefined;
    if (requested && !match) { this.note(`没有名为 ${label(requested)} 的供应商；/login 查看可用供应商。`); return; }
    const id = match?.id ?? await this.pick('供应商登录', providers.map(provider => ({ value: provider.id, label: provider.name, description: provider.id })), '没有可登录的供应商。'); if (!id) return;
    const provider = providers.find(x => x.id === id)!;
    const status = await this.request<{ configured: boolean; source?: string }>(`/auth/status/${routeId(id)}`);
    const actions: SelectItem[] = provider.methods.map(method => ({ value: method.type, label: method.name }));
    if (status.configured) actions.push({ value: 'logout', label: '移除已保存凭据' });
    const method = await this.pick(`${provider.name} · ${status.configured ? `已配置 ${label(status.source)}` : '未配置'}`, actions, `${provider.name} 没有可用的登录方式。`);
    if (!method) return;
    if (method === 'logout') {
      const confirm = await this.choose('确认移除该供应商的已保存凭据？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '移除' }]);
      if (confirm === 'yes') { await this.request(`/auth/providers/${routeId(id)}`, { method: 'DELETE' }); await this.refreshModel(); this.note('已移除保存的凭据。'); }
      return;
    }
    type AuthPrompt = { type: 'text' | 'secret' | 'manual_code'; message: string } | { type: 'select'; message: string; options: Array<{ id: string; label: string; description?: string }> };
    type AuthEvent = { type: string; message?: string; url?: string; instructions?: string; verificationUri?: string; userCode?: string; openBrowserOnConfirm?: boolean; copyCodeOnConfirm?: boolean; links?: Array<{ url: string; label?: string }> };
    type Job = { id: string; state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; prompt?: AuthPrompt; promptId?: string; events?: Array<{ sequence: number; event: AuthEvent }> };
    let job = await this.write(`/auth/${routeId(id)}/start`, { type: method }) as Job;
    let cancelled!: () => void;
    const cancellation = new Promise<{ type: 'cancel' }>(resolve => { cancelled = () => resolve({ type: 'cancel' }); });
    const dialog = new LoginDialogComponent({
      theme, requestRender: () => this.ui.requestRender(),
      openBrowser: url => this.openWebUrl(url),
      copy: async text => { const clipboard = this.clipboard ?? getNativeClipboard(); if (!clipboard?.setText) throw new AppError('clipboard_unavailable'); await clipboard.setText(text); },
    }, provider.name, cancelled);
    const cancel = () => dialog.cancel();
    this.loginDialog = dialog; this.pendingModal = cancel; this.mountEditor();
    let lastSequence = 0; const openedUrls = new Set<string>();
    let promptId: string | undefined;
    let input: Promise<{ type: 'input'; value: string | undefined; promptId: string }> | undefined;
    const showJob = (next: Job) => {
      for (const item of next.events ?? []) {
        if (!Number.isSafeInteger(item.sequence) || item.sequence <= lastSequence) continue;
        lastSequence = item.sequence; const event = item.event;
        if (event.type === 'auth_url' && event.url) {
          // Only this freshly initiated login may open its first occurrence of each URL.
          const open = !openedUrls.has(event.url) && !dialog.signal.aborted && !this.stopped && this.modalScopeCurrent();
          openedUrls.add(event.url); dialog.showAuth(event.url, event.instructions, open);
        } else if (event.type === 'device_code' && event.verificationUri && event.userCode) {
          dialog.showDeviceCode({ verificationUri: event.verificationUri, userCode: event.userCode, ...(event.openBrowserOnConfirm !== undefined ? { openBrowserOnConfirm: event.openBrowserOnConfirm } : {}), ...(event.copyCodeOnConfirm !== undefined ? { copyCodeOnConfirm: event.copyCodeOnConfirm } : {}) });
        } else if (event.type === 'info') dialog.showInfo(event.message ?? '', event.links);
        else if (event.message) dialog.showProgress(event.message);
      }
      if (next.prompt && !next.promptId) throw new AppError('invalid_auth_prompt');
      if (next.promptId !== promptId || next.state !== 'running') {
        dialog.dismissPrompt(); input = undefined; promptId = next.state === 'running' ? next.promptId : undefined;
        if (next.state === 'running' && next.prompt && promptId) {
          const prompt = next.prompt, identity = promptId;
          const answer = prompt.type === 'select' ? dialog.showSelection(prompt.message, prompt.options) : prompt.type === 'manual_code' ? dialog.showManualInput(prompt.message) : dialog.showPrompt(prompt.message, undefined, prompt.type === 'secret');
          input = answer.then(value => ({ type: 'input' as const, value, promptId: identity }));
        }
      }
    };
    try {
      if (job.state === 'running' && !job.events?.length && !job.prompt) dialog.showWaiting('等待供应商授权…');
      showJob(job);
      if (job.state === 'running' && !job.prompt) { job = await this.request<Job>(`/auth/jobs/${routeId(job.id)}`); showJob(job); }
      while (!this.stopped && !dialog.signal.aborted && this.modalScopeCurrent() && job.state === 'running') {
        const outcome = await Promise.race([
          cancellation, ...(input ? [input] : []),
          new Promise<{ type: 'poll' }>(resolve => { const timer = setTimeout(() => resolve({ type: 'poll' }), 500); timer.unref(); }),
        ]);
        if (outcome.type === 'cancel' || this.stopped || dialog.signal.aborted || !this.modalScopeCurrent()) break;
        if (outcome.type === 'input') {
          if (outcome.promptId !== promptId || outcome.value === undefined) continue;
          input = undefined;
          job = await this.write(`/auth/jobs/${routeId(job.id)}/respond`, { value: outcome.value, promptId: outcome.promptId }) as Job;
        } else job = await this.request<Job>(`/auth/jobs/${routeId(job.id)}`);
        showJob(job);
      }
      if (job.state === 'completed') { await this.refreshModel(); this.note('供应商登录已完成。'); }
      else if (job.state === 'failed') this.note('供应商登录失败。');
    } finally {
      dialog.dismissPrompt();
      if (this.pendingModal === cancel) this.pendingModal = undefined;
      if (this.loginDialog === dialog) { this.loginDialog = undefined; this.mountEditor(); this.ui.requestRender(); }
      if ((job.state === 'running' || job.state === 'cancelling') && originStorage === this.storageId && originGeneration === this.storageGeneration && this.modalScopeCurrent()) {
        const scope = this.modalScope.getStore();
        // Cleanup is bound to the original store, including when the client exits.
        const signal = AbortSignal.any([AbortSignal.timeout(1000), ...(!this.stopped && scope ? [scope.controller.signal] : [])]);
        await this.client.request(`/auth/jobs/${routeId(job.id)}`, { method: 'DELETE', timeoutMs: 1000, signal }).catch(() => {});
      }
    }
  }
  private async providerLogout(requested?: string) {
    const { providers } = await this.request<{ providers: Array<{ id: string; name: string }> }>('/auth/providers');
    const match = requested ? providers.find(provider => provider.id === requested || provider.name.toLowerCase() === requested.toLowerCase()) : undefined;
    if (requested && !match) { this.note(`没有名为 ${label(requested)} 的供应商。`); return; }
    const id = match?.id ?? await this.pick('移除供应商登录', providers.map(provider => ({ value: provider.id, label: provider.name, description: provider.id })), '没有可用的供应商。');
    if (!id) return;
    const status = await this.request<{ configured: boolean }>(`/auth/status/${routeId(id)}`);
    if (!status.configured) { this.note('该供应商没有可移除的登录凭据。'); return; }
    const confirm = await this.choose('确认移除该供应商的已保存凭据？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '移除' }]);
    if (confirm !== 'yes') return;
    await this.request(`/auth/providers/${routeId(id)}`, { method: 'DELETE' });
    await this.refreshModel();
    this.note('已移除保存的凭据。环境提供的凭据仍可能有效。');
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
    const contextId = this.contextId;
    const drafts = this.taskCreationDrafts;
    const saved = drafts.get(contextId);
    const draft = saved ?? { title: '', content: '', grants: { write: false, execute: false, mcp: false } };
    drafts.set(contextId, draft);
    const title = await this.prompt('任务名称', draft.title || (initialContent ? initialContent.slice(0, 40) : '')); if (title === undefined) return;
    draft.title = title; if (!title.trim()) return;
    const content = initialContent ?? await this.promptLong('任务内容', draft.content); if (content === undefined) return;
    draft.content = content; if (!content.trim()) return;
    try {
      const { workspaces } = await this.request<{ workspaces: Array<{ id: string; name: string; path: string }> }>('/workspaces');
      const sorted = [...workspaces].sort((a, b) => Number(b.id === draft.workspaceId) - Number(a.id === draft.workspaceId));
      const workspaceId = await this.pick('选择工作区', sorted.map(x => ({ value: x.id, label: x.name, description: x.path })), '没有可用的工作区；/menu → 工作区 可添加。'); if (!workspaceId) return;
      draft.workspaceId = workspaceId;
      const modes = [{ value: 'safe', label: '默认：写入、执行和 MCP 按需审批' }, { value: 'custom', label: '明确授予任务权限' }];
      modes.sort((a, b) => Number(b.value === draft.permissionMode) - Number(a.value === draft.permissionMode));
      const permissionMode = await this.choose('任务权限', modes); if (!permissionMode) return;
      draft.permissionMode = permissionMode;
      const grants = draft.grants;
      if (permissionMode === 'custom') {
        for (;;) {
          const action = await this.choose('可授予的权限', [{ value: 'done', label: '完成' }, { value: 'write', label: `${grants.write ? '[x]' : '[ ]'} 工作区写入` }, { value: 'execute', label: `${grants.execute ? '[x]' : '[ ]'} 执行命令` }, { value: 'mcp', label: `${grants.mcp ? '[x]' : '[ ]'} MCP 工具` }]);
          if (action === undefined) return; if (action === 'done') break;
          if (action === 'write' || action === 'execute' || action === 'mcp') grants[action] = !grants[action];
        }
      }
      const workspace = workspaces.find(item => item.id === workspaceId)!;
      const confirm = await this.choose(`确认提交后台任务？\n工作区：${label(workspace.name)}\n路径：${safeTerminalText(workspace.path)}${permissionMode === 'custom' ? `\n授权：写入 ${grants.write ? '是' : '否'} · 执行 ${grants.execute ? '是' : '否'} · MCP ${grants.mcp ? '是' : '否'}` : ''}`, [{ value: 'yes', label: '提交' }, { value: 'no', label: '返回' }]);
      if (confirm !== 'yes') return;
      const task = await this.write('/tasks', { title: title.trim(), content, workspaceId, returnContextId: contextId, ...(permissionMode === 'custom' ? { grants } : {}) }) as TaskRecord;
      drafts.delete(contextId);
      this.note(`任务已提交：${label(task.title || title)} · ${label(task.status)}`);
    } catch (error) {
      this.note('任务尚未确认提交，表单草稿已保留；再次输入 /task 可继续。请先核对 /tasks，避免重复创建。'); throw error;
    }
  }
  private async workspaces() {
    const { workspaces } = await this.request<{ workspaces: Array<{ id: string; name: string; path: string }> }>('/workspaces');
    const choice = await this.choose('工作区', [{ value: '__add__', label: '添加工作区' }, ...workspaces.map(x => ({ value: `workspace:${x.id}`, label: x.name, description: x.path }))]);
    if (!choice) return;
    if (choice !== '__add__') {
      const workspace = workspaces.find(x => `workspace:${x.id}` === choice); if (!workspace) return;
      const action = await this.choose(workspace.name, [{ value: 'details', label: '查看路径' }, { value: 'edit', label: '修改名称或路径' }, ...(workspace.id !== 'default' ? [{ value: 'remove', label: '移除工作区配置' }] : [])]);
      if (action === 'details') this.note(`工作区：${label(workspace.name)}\n${safeTerminalText(workspace.path)}`);
      else if (action === 'edit') {
        const name = await this.prompt('工作区名称', workspace.name); if (!name?.trim()) return;
        const path = await this.prompt('服务端工作区路径', workspace.path); if (!path?.trim()) return;
        const confirm = await this.choose('确认修改工作区？已有上下文将使用新路径，请确认目录内容对应。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '保存' }]);
        if (confirm === 'yes') { await this.write(`/workspaces/${routeId(workspace.id)}`, { name: name.trim(), path: path.trim(), expectedPath: workspace.path }, 'PATCH'); this.note('工作区已更新。'); }
      } else if (action === 'remove') {
        const confirm = await this.choose('移除工作区配置？目录内的文件会保留。仍有上下文引用时不能移除。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '移除' }]);
        if (confirm === 'yes') { await this.write(`/workspaces/${routeId(workspace.id)}`, {}, 'DELETE'); this.note('工作区配置已移除。'); }
      }
      return;
    }
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
  private async skills() {
    const context = this.contextId; const base = `/contexts/${routeId(context)}`;
    const { skills,diagnostics=[] } = await this.request<{ skills: ProjectSkillSummary[];diagnostics?:Array<{type:'warning'|'collision';path:string;message:string;winnerPath?:string}> }>(`${base}/skills`);
    this.projectSkills.set(context, skills); this.configureCompletions(this.editor);
    const selected = await this.choose('工作区 Skills', [
      ...skills.map(skill => ({ value: `skill:${skill.name}`, label: `${skill.enabled ? '' : '（已停用）'}${skill.name}`, description: skill.description })),
      ...(diagnostics.length?[{value:'diagnostics',label:`查看发现提示（${diagnostics.length}）`}]:[]),
      { value: 'source:add', label: '载入本地 Skill 目录' }, { value: 'source:list', label: '管理已载入的目录' },
    ]);
    if (!selected) return;
    if(selected==='diagnostics'){this.note(diagnostics.map(row=>`${row.type==='collision'?'名称冲突':'发现提示'}：${safeTerminalText(row.message)}\n路径：${safeTerminalText(row.path)}${row.winnerPath?`\n使用：${safeTerminalText(row.winnerPath)}`:''}`).join('\n\n'));return;}
    if (selected === 'source:add') {
      const source = await this.prompt('核心工作区内的 Skill 目录或 SKILL.md 路径'); if (!source?.trim()) return;
      await this.write(`${base}/skill-sources`, { path: source.trim() }); await this.refreshProjectSkills(); this.note('已载入 Skill 目录。'); return;
    }
    if (selected === 'source:list') {
      const { sources } = await this.request<{ sources: string[] }>(`${base}/skill-sources`);
      const source = await this.pick('移除已载入的来源（保留原文件）', sources.map(value => ({ value, label: value })), '没有额外载入的目录；默认工作区目录会自动发现。'); if (!source) return;
      const confirm = await this.choose('确认移除这个来源？不会删除文件。', [{ value: 'no', label: '返回' }, { value: 'yes', label: '移除' }]); if (confirm !== 'yes') return;
      await this.write(`${base}/skill-sources`, { path: source }, 'DELETE'); await this.refreshProjectSkills(); this.note('已移除 Skill 来源。'); return;
    }
    const skill = skills.find(item => `skill:${item.name}` === selected); if (!skill) return;
    const action = await this.choose(skill.name, [
      { value: 'details', label: '查看说明和资源' },
      ...(skill.enabled && skill['user-invocable'] !== false && this.capabilities.has('workspace-skill-invoke') ? [{ value: 'use', label: '使用这个 Skill' }] : []),
      { value: 'toggle', label: skill.enabled ? '停用' : '启用' },
    ]);
    if (action === 'details') {
      const detail = await this.request<ProjectSkillSummary & { instructions: string; references?: string[]; scripts?: string[]; assets?: string[] }>(`${base}/skills/${routeId(skill.name)}`);
      this.note(`Skill：${detail.name}\n${detail.description}\n路径：${detail.path}\n${detail.disableModelInvocation ? '仅在用户明确调用时载入' : '可按需载入'}\n\n${detail.instructions}\n\n参考：${(detail.references ?? []).join('、') || '无'}\n脚本：${(detail.scripts ?? []).join('、') || '无'}\n资源：${(detail.assets ?? []).join('、') || '无'}`);
    } else if (action === 'toggle') {
      await this.write(`${base}/skills/${routeId(skill.name)}`, { enabled: !skill.enabled }, 'PATCH'); await this.refreshProjectSkills(); this.note(skill.enabled ? '已停用 Skill。' : '已启用 Skill。');
    } else if (action === 'use') {
      const content = await this.promptLong('希望使用这个 Skill 做什么（可留空）'); if (content !== undefined) await this.invokeSkill(`${skill.name}${content ? ` ${content}` : ''}`);
    }
  }
  private async invokeSkill(arg: string, sourceText?: string,preset?:'queue'|'steer') {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(arg.trim());
    if (!match) { this.note('用法：/skill <名称> [要求]；/skills 查看可用 Skills。'); return; }
    const context = this.contextId, source = this.editor, runId = this.currentRunId;
    if (source.disableSubmit) return;
    const text = sourceText ?? `/skill ${arg}`;
    source.disableSubmit = true;
    try { await this.submitMessage(text,preset??(this.capabilities.has('logical-input')?undefined:runId?'queue':undefined), source, context, runId, { name: match[1]!, content: match[2] ?? '', sourceText: text }); }
    finally { source.disableSubmit = false; }
  }
  private async mcp() {
    const { servers } = await this.request<{ servers: Array<{ id: string; connected: boolean; transport: string; enabled: boolean; tools?: string[]; error?: string; authState?: 'needs-auth' | 'authorized' }> }>('/mcp');
    const choice = await this.choose('MCP 连接', [{ value: '__add__', label: '配置新连接' }, ...servers.map(x => ({ value: `server:${x.id}`, label: x.id, description: `${x.transport} · ${x.connected ? '已连接' : '未连接'}${x.authState === 'needs-auth' ? ' · 需要登录' : ''}` }))]);
    if (!choice) return;
    if (choice === '__add__') {
      const name = await this.prompt('连接 ID'); if (!name?.trim()) return;
      if (servers.some(server => server.id === name.trim())) throw new AppError('mcp_server_already_exists');
      const transport = await this.choose('连接方式', [{ value: 'http', label: 'HTTP' }, ...(this.capabilities.has('mcp-oauth') ? [{ value: 'http-oauth', label: 'HTTP · OAuth 登录' }] : []), { value: 'stdio', label: '本地进程' }]); if (!transport) return;
      let config: McpConfig = { id: name.trim(), enabled: true, args: [], headersEnv: {}, env: {} };
      if (transport !== 'stdio') {
        const url = await this.prompt('服务地址'); if (!url?.trim()) return;
        const headersEnv = await this.editReferences('请求头凭据引用', {}); if (!headersEnv) return;
        config = { ...config, url: url.trim(), headersEnv };
        if (transport === 'http-oauth') { const oauth = await this.editMcpOAuth(); if (!oauth) return; config.oauth = oauth; }
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
    const server = servers.find(row => row.id === id); if (!server) return;
    const action = await this.choose(id, [{ value: 'details', label: '工具与连接状态' }, { value: 'edit', label: '编辑配置' }, ...(server.connected && this.capabilities.has('mcp-resources') ? [{ value: 'resources', label: '资源与资源模板' }] : []), ...(server.connected && this.capabilities.has('mcp-prompts') ? [{ value: 'prompts', label: '提示模板' }] : []), ...(this.capabilities.has('mcp-oauth') && server.transport !== 'stdio' ? [{ value: 'auth', label: 'OAuth 登录' }, ...(server.authState === 'authorized' ? [{ value: 'logout', label: '注销 OAuth 登录' }] : [])] : []), ...(server.connected ? [{ value: 'reconnect', label: '重新连接' }, { value: 'disconnect', label: '断开' }] : server.enabled ? [{ value: 'connect', label: '连接' }] : []), { value: 'remove', label: '删除连接配置' }]); if (!action) return;
    if (action === 'details') { this.note(`MCP：${label(id)} · ${server.connected ? '已连接' : '未连接'}${server.error ? `\n失败原因：${label(server.error)}` : ''}\n工具：\n${(server.tools ?? []).map(tool => `  ${label(tool)}`).join('\n') || '暂无；连接成功后可发现工具。'}`); return; }
    if (action === 'edit') { await this.editMcp(id); return; }
    if (action === 'resources') { await this.mcpResources(id); return; }
    if (action === 'prompts') { await this.mcpPrompts(id); return; }
    if (action === 'auth') { await this.authenticateMcp(id); return; }
    if (action === 'logout') { const confirm = await this.choose('确认注销并断开该 MCP 连接？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '注销' }]); if (confirm === 'yes') { await this.write(`/mcp/${routeId(id)}/logout`, {}); this.note('已注销 MCP 登录。'); } return; }
    const confirm = await this.choose(action === 'remove' ? '删除配置并断开连接？' : action === 'disconnect' ? '确认断开？' : '连接可能启动服务端配置的本地进程，确认继续？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '确认' }]);
    if (confirm === 'yes') { await this.write(action === 'remove' ? `/mcp/${routeId(id)}` : `/mcp/${routeId(id)}/${action}`, {}, action === 'remove' ? 'DELETE' : 'POST'); this.note('连接操作已完成。'); }
  }
  private async mcpResources(serverId: string) {
    type Resource = { uri: string; name: string; description?: string; mimeType?: string };
    type Template = { uriTemplate: string; name: string; description?: string; variables?: string[] };
    const base = `/mcp/${routeId(serverId)}`;
    const { resources, templates } = await this.request<{ resources: Resource[]; templates: Template[] }>(`${base}/resources`);
    const choice = await this.pick('MCP 资源', [...resources.map((resource, index) => ({ value: `resource:${index}`, label: resource.name || resource.uri, description: resource.description ?? resource.uri })), ...templates.map((template, index) => ({ value: `template:${index}`, label: `${template.name}（模板）`, description: template.uriTemplate }))], '该服务没有公布资源或资源模板。');
    if (!choice) return;
    let result: { contents: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }> };
    if (choice.startsWith('template:')) {
      const template = templates[Number(choice.slice('template:'.length))]; if (!template) return;
      const { templates: detailed } = await this.request<{ templates: Template[] }>(`${base}/resource-templates`);
      const detail = detailed.find(item => item.uriTemplate === template.uriTemplate);
      if (!detail?.variables) throw new AppError('mcp_template_variables_unavailable');
      const variables: Record<string, string> = Object.create(null);
      for (const name of detail.variables) { const value = await this.prompt(`资源模板参数：${label(name)}`); if (value === undefined) return; variables[name] = value; }
      result = await this.write(`${base}/resource-templates/read`, { uriTemplate: template.uriTemplate, variables }) as typeof result;
    } else {
      const resource = resources[Number(choice.slice('resource:'.length))]; if (!resource) return;
      result = await this.write(`${base}/resources/read`, { uri: resource.uri }) as typeof result;
    }
    for (const content of result.contents ?? []) await this.mcpContent(serverId, content);
  }
  private async mcpContent(serverId: string, content: { uri?: string; mimeType?: string; text?: string; blob?: string }) {
    this.note(`MCP ${label(serverId)}${content.uri ? ` · ${label(content.uri)}` : ''}${content.mimeType ? ` · ${label(content.mimeType)}` : ''}`);
    if (typeof content.text === 'string') {
      this.note(content.text.slice(0, 64_000) + (content.text.length > 64_000 ? '\n（预览已截断；完整内容可保存）' : ''));
      if (content.text.length > 64_000 && await this.choose('完整资源内容', [{ value: 'done', label: '返回' }, { value: 'save', label: '保存完整内容到本机' }]) === 'save') await this.saveDownload(async () => Buffer.from(content.text!, 'utf8'));
    } else if (typeof content.blob === 'string') {
      if (content.blob.length > Math.ceil(MAX_ATTACHMENT / 3) * 4 || !isBase64String(content.blob)) throw new AppError('invalid_mcp_resource_blob');
      const bytes = Buffer.from(content.blob, 'base64'); this.note(`二进制资源 · ${bytes.length} 字节`);
      if (await this.choose('资源文件', [{ value: 'done', label: '返回' }, { value: 'save', label: '保存到本机' }]) === 'save') await this.saveDownload(async () => bytes);
    } else this.note('该内容没有可显示的正文。');
  }
  private async mcpPrompts(serverId: string) {
    type Prompt = { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> };
    const base = `/mcp/${routeId(serverId)}`;
    const { prompts } = await this.request<{ prompts: Prompt[] }>(`${base}/prompts`);
    const name = await this.pick('MCP 提示模板', prompts.map(prompt => ({ value: prompt.name, label: prompt.name, description: prompt.description })), '该服务没有公布提示模板。');
    const prompt = prompts.find(item => item.name === name); if (!prompt) return;
    const args: Record<string, string> = Object.create(null);
    for (const argument of prompt.arguments ?? []) {
      const value = await this.prompt(`${label(argument.name)}${argument.required ? '（必填）' : '（可留空）'}${argument.description ? `\n${argument.description}` : ''}`);
      if (value === undefined) return; if (!value && argument.required) { this.note('缺少必填参数，未读取模板。'); return; } if (value) args[argument.name] = value;
    }
    const result = await this.write(`${base}/prompts/${routeId(name!)}`, { args }) as { description?: string; messages: Array<{ role: string; content: { type?: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } } }> };
    this.note(`来自 MCP ${label(serverId)} 的提示模板「${label(name)}」${result.description ? `\n${result.description}` : ''}`);
    for (const message of result.messages ?? []) { this.note(`模板消息 · ${label(message.role)}`); if (message.content.resource) await this.mcpContent(serverId, message.content.resource); else await this.mcpContent(serverId, { text: message.content.text, blob: message.content.data, mimeType: message.content.mimeType }); }
  }
  private async editMcpOAuth(current?: McpConfig['oauth']): Promise<McpConfig['oauth'] | null> {
    const mode = await this.choose('OAuth 客户端', [{ value: 'dynamic', label: '由服务自动注册客户端' }, { value: 'clientId', label: '使用已有 Client ID' }, { value: 'metadata', label: '使用客户端元数据地址' }, { value: 'none', label: '停用 OAuth' }]);
    if (!mode) return undefined; if (mode === 'none') return null;
    const config: NonNullable<McpConfig['oauth']> = {};
    if (mode === 'clientId') {
      const clientId = await this.prompt('Client ID', current?.clientId ?? ''); if (!clientId?.trim()) return undefined; config.clientId = clientId.trim();
      const secret = await this.prompt('Client Secret 的凭据引用名称（不是密钥，可留空）', current?.clientSecretEnv ?? ''); if (secret === undefined) return undefined;
      if (secret.trim()) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.trim())) throw new AppError('invalid_credential_reference'); config.clientSecretEnv = secret.trim(); }
    } else if (mode === 'metadata') {
      const url = await this.prompt('客户端元数据 HTTP(S) 地址', current?.clientMetadataUrl ?? ''); if (!url?.trim()) return undefined;
      const parsed = new URL(url.trim()); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new AppError('invalid_mcp_oauth_url'); config.clientMetadataUrl = parsed.href;
    }
    const scopes = await this.editStrings('OAuth 权限范围（可留空）', current?.scopes ?? []); if (!scopes) return undefined;
    if (scopes.length) config.scopes = scopes;
    const port = await this.prompt('本机回调端口', String(current?.redirectPort ?? 5533)); if (port === undefined) return undefined;
    const value = Number(port); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new AppError('invalid_mcp_oauth_port'); config.redirectPort = value;
    return config;
  }
  private async authenticateMcp(serverId: string) {
    type Job = { id: string; serverId: string; status: 'starting' | 'awaiting-authorization' | 'succeeded' | 'failed' | 'cancelled'; authorizationUrl?: string; error?: string };
    const storage = this.storageId, generation = this.storageGeneration, instance = this.instanceId;
    let job = await this.write(`/mcp/${routeId(serverId)}/auth`, {}) as Job;
    let shown = ''; let close: (() => void) | undefined;
    try {
      while (!this.stopped && ['starting', 'awaiting-authorization'].includes(job.status)) {
        if (job.authorizationUrl && job.authorizationUrl !== shown) {
          const url = new URL(job.authorizationUrl);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError('invalid_mcp_oauth_url');
          shown = job.authorizationUrl; this.note(`MCP 授权链接（在浏览器中打开）：\n${url.href}`);
        }
        const modal = this.choose(`等待 ${label(serverId)} 登录完成${shown ? `\n${shown}` : ''}`, [...(shown ? [{ value: 'open', label: '在浏览器打开授权页面' }] : []), { value: 'cancel', label: '取消登录' }]);
        close = this.pendingModal; const input = modal.then(value => ({ kind: 'input' as const, value })); let cancelled = false;
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const tick = new Promise<{ kind: 'poll' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'poll' }), 500); });
          const outcome = await Promise.race([input, tick]); if (timer) clearTimeout(timer);
          if (outcome.kind === 'input') {
            if (outcome.value === 'open' && shown && this.modalScopeCurrent()) { try { await this.openWebUrl(shown); } catch { this.note('无法打开浏览器，请手动打开授权链接。'); } }
            else cancelled = true;
            break;
          }
          const next = await this.request<Job>(`/mcp-auth/jobs/${routeId(job.id)}`);
          const changed = next.status !== job.status || next.authorizationUrl !== job.authorizationUrl;
          job = next;
          if (changed || this.stopped) { close?.(); await modal; break; }
        }
        if (cancelled) break;
      }
      if (job.status === 'succeeded') this.note('MCP 登录完成，工具已重新连接。');
      else if (job.status === 'failed') this.note(`MCP 登录失败${job.error ? `：${label(job.error)}` : ''}。`);
    } finally {
      if (close && this.pendingModal === close) close();
      if (['starting', 'awaiting-authorization'].includes(job.status) && storage === this.storageId && generation === this.storageGeneration) {
        const headers: Record<string, string> = {};
        if (storage) headers['X-ShittimChest-Storage-Id'] = storage; if (instance) headers['X-ShittimChest-Instance-Id'] = instance;
        await this.client.request(`/mcp-auth/jobs/${routeId(job.id)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(1000), timeoutMs: 1000 }).catch(() => {});
      }
    }
  }
  private async editMcp(id: string) {
    const { mcpConfigurations } = await this.request<{ mcpConfigurations: McpConfig[] }>('/configuration');
    const current = mcpConfigurations.find(row => row.id === id); if (!current) throw new AppError('mcp_server_not_found', 404);
    let config = { ...current, args: [...current.args], env: { ...current.env }, headersEnv: { ...current.headersEnv } };
    const fields: SelectItem[] = [{ value: 'enabled', label: '启用状态' }, { value: 'protocolVersion', label: '协议版本' }];
    if (config.url) { fields.push({ value: 'url', label: '服务地址' }, { value: 'headersEnv', label: '请求头凭据引用' }); if (this.capabilities.has('mcp-oauth')) fields.push({ value: 'oauth', label: 'OAuth 登录设置' }); }
    else fields.push({ value: 'command', label: '程序路径' }, { value: 'args', label: '进程参数' }, { value: 'env', label: '进程环境变量引用' });
    const field = await this.choose(`编辑 ${label(id)}`, fields); if (!field) return;
    if (field === 'enabled') { const value = await this.choose('启用状态', [{ value: 'on', label: '启用' }, { value: 'off', label: '停用' }]); if (!value) return; config.enabled = value === 'on'; }
    else if (field === 'protocolVersion') { const value = await this.choose('协议版本', [{ value: 'default', label: '默认' }, { value: 'legacy', label: 'Legacy' }, { value: '2026-07-28', label: '2026-07-28' }]); if (!value) return; if (value === 'default') delete config.protocolVersion; else config.protocolVersion = value as McpConfig['protocolVersion']; }
    else if (field === 'oauth') { const value = await this.editMcpOAuth(config.oauth); if (value === undefined) return; if (value === null) delete config.oauth; else config.oauth = value; }
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
    if (!items.length) { this.note('当前上下文还没有工具活动。'); return; }
    const key = await this.choose('工具活动（选择以展开或折叠）', items.map(([value, card]) => ({ value, label: card.data.toolName || '工具', description: `${card.data.state} · ${card.data.toolCallId}` }))); if (!key) return;
    this.toolCards.get(key)?.toggle();
  }
  private async memory() {
    const status = await this.request<{ enabled: boolean; version: string; generation: number; jobs: PublicMemoryJob[] }>('/memory');
    const action = await this.choose(`记忆 · ${status.enabled ? '启用' : '停用'} · 版本 ${label(status.version)}`, [{ value: 'resident', label: '查看当前记忆' }, { value: 'jobs', label: '处理记录' }, { value: 'request', label: '请求处理指定运行' }, ...(this.capabilities.has('memory-v1') ? [{ value: 'context', label: '模式、策略与预算' }, { value: 'issues', label: '待处理与资料缺口' }, { value: 'reconcile', label: '重新核对已受理资料' }, { value: 'versions', label: '记忆版本与恢复' }, { value: 'view', label: '本次记忆资料视图' }] : [])]);
    if (action === 'context') { await this.memoryContextSettings(); return; }
    if (action === 'issues') { this.note(safeTerminalText(JSON.stringify(await this.request('/memory/issues'), null, 2))); return; }
    if (action === 'reconcile') { await this.write('/memory/reconcile', {}); this.note('已核对受理资料；缺口和处理记录可分别查看。'); return; }
    if (action === 'versions') { await this.memoryVersions(status.version); return; }
    if (action === 'view') { const snapshot = await this.request<TuiSnapshot>(`/snapshot?contextId=${routeId(this.contextId)}`); const run = await this.choose('选择运行', snapshot.runs.map(row => ({ value: row.id, label: row.status, description: row.id }))); if (run) this.note(safeTerminalText(JSON.stringify(await this.request(`/memory/runs/${routeId(run)}/view`), null, 2))); return; }
    if (action === 'resident') { const resident = await this.request<{ text: string }>('/memory/resident'); this.note(`当前记忆：\n${safeTerminalText(resident.text)}`); }
    else if (action === 'jobs') {
      if (!status.jobs.length) { this.note('还没有记忆处理记录。'); return; }
      const id = await this.choose('记忆处理记录', status.jobs.map(job => ({ value: job.id, label: resolvedMemoryJob(status.jobs,job)?`${job.status} · 已恢复`:job.status, description: `${job.contextId} · ${job.runId}` }))); if (!id) return;
      const job = status.jobs.find(item => item.id === id)!;
      const resolved=resolvedMemoryJob(status.jobs,job);if(resolved){this.note(`原记忆记录：${label(job.id)} · ${label(job.status)}\n已恢复：${label(resolved.id)} · ${label(resolved.status)}`);if(await this.choose('此记录已有成功的后续处理',[{value:'back',label:'返回'},{value:'view',label:'查看恢复记录'}])==='view')this.note(safeTerminalText(JSON.stringify(resolved,null,2)));return;}
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
  private async memoryContextSettings() {
    const state = await this.request<{ mode: string; legacyAvailable?: boolean; policy: { revision: number; recent: { days: number; textTokens: number }; resident: { textTokens: number } } | null }>('/memory/context');
    this.note(safeTerminalText(JSON.stringify(state, null, 2)));
    const action = await this.choose('记忆上下文设置', [{ value: 'mode', label: `模式：${state.mode}` }, ...(state.policy ? [{ value: 'budget', label: '调整近期窗口与正文预算' }] : [])]);
    if (action === 'mode') {
      const mode = await this.choose('记忆模式', [...(state.legacyAvailable === false ? [] : [{ value: 'legacy', label: '兼容模式' }]), { value: 'shadow', label: '观察模式（不注入、不发布）' }, { value: 'v1', label: 'V1（原生后台整理与资料注入）' }]);
      if (mode) { await this.write('/configuration/runtime', { memoryContextMode: mode }); this.note('记忆模式已更新。'); }
    } else if (action === 'budget' && state.policy) {
      const days = await this.prompt('近期窗口天数', String(state.policy.recent.days)); if (!days) return;
      const recent = await this.prompt('近期正文预算', String(state.policy.recent.textTokens)); if (!recent) return;
      const resident = await this.prompt('常驻正文预算', String(state.policy.resident.textTokens)); if (!resident) return;
      if ([days, recent, resident].some(raw => !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0)) throw new AppError('invalid_budget');
      await this.write('/configuration/runtime', { memoryContextPolicy: { ...state.policy, revision: state.policy.revision + 1, recent: { ...state.policy.recent, days: Number(days), textTokens: Number(recent) }, resident: { ...state.policy.resident, textTokens: Number(resident) } } });
      this.note('记忆策略已更新。');
    }
  }
  private async memoryVersions(expectedHead: string) {
    const { versions } = await this.request<{ versions: { id: string; publishedAt: string }[] }>('/memory/versions');
    if (!versions.length) { this.note('还没有已发布的 V1 记忆版本。'); return; }
    const id = await this.choose('记忆版本', versions.map(row => ({ value: row.id, label: row.publishedAt, description: row.id }))); if (!id) return;
    const action = await this.choose('版本操作', [{ value: 'show', label: '查看条目与详细档案' }, { value: 'diff', label: '与当前版本比较' }, { value: 'recover', label: '准备恢复重整计划' }]);
    if (action === 'show') this.note(safeTerminalText(JSON.stringify(await this.request(`/memory/versions/${routeId(id)}`), null, 2)));
    else if (action === 'diff') this.note(safeTerminalText(JSON.stringify(await this.request(`/memory/diff?from=${routeId(id)}&to=${routeId(expectedHead)}`), null, 2)));
    else if (action === 'recover') {
      const plan = await this.write('/memory/recovery/plans', { targetVersionId: id, expectedHead }) as { id: string; pendingRecords: number; pendingRuns: number };
      this.note(`恢复重整保留现行保护基线，并参考所选旧版；不会直接倒拨版本。待补来源：${plan.pendingRecords} 条、${plan.pendingRuns} 次运行。`);
      if (plan.pendingRecords || plan.pendingRuns) return;
      const execute = await this.choose('执行此恢复重整计划？', [{ value: 'yes', label: '执行' }, { value: 'no', label: '暂不执行' }]);
      if (execute === 'yes') { await this.write(`/memory/recovery/plans/${routeId(plan.id)}/execute`, {}); this.note('恢复重整任务已提交。'); }
    }
  }
  private async notifications() {
    const { pending } = await this.request<{ pending: Array<{ id: string; contextId: string; data?: { title?: string; status?: string } }> }>('/notifications');
    if (!pending.length) { this.note('没有待处理的通知。'); return; }
    // Results that have not reached the conversation yet; retrying re-delivers them to the main chat.
    const id = await this.choose('尚未送达对话的结果', pending.map(item => ({ value: item.id, label: item.data?.title ? `${label(item.data.title)} · ${label(item.data.status)}` : item.id, description: `送往 ${item.contextId}` }))); if (!id) return;
    const confirm = await this.choose('重试此通知？', [{ value: 'no', label: '返回' }, { value: 'yes', label: '重试' }]);
    if (confirm === 'yes') { await this.write(`/notifications/${routeId(id)}/retry`, {}); this.note('通知重试已提交。'); }
  }
  private async workflows() {
    const { workflows } = await this.request<{ workflows: Array<{ id: string; description: string; inputSchema: FormSchema }> }>('/workflows');
    const id = await this.pick('工作流', workflows.map(flow => ({ value: flow.id, label: flow.id, description: flow.description })), '没有可用的工作流。'); if (!id) return;
    const workflow = workflows.find(row => row.id === id); if (!workflow?.inputSchema) throw new AppError('workflow_schema_unavailable');
    const { contexts } = await this.request<{ contexts: ContextRecord[] }>('/contexts');
    const contextId = await this.pick('选择工作上下文', contexts.filter(x => x.role === 'work' && !x.archived).map(x => ({ value: x.id, label: x.name, description: x.purpose })), '没有可用的工作上下文；先创建后台任务或工作上下文。'); if (!contextId) return;
    const schema = { ...workflow.inputSchema, properties: Object.fromEntries(Object.entries(workflow.inputSchema.properties ?? {}).filter(([key]) => key !== 'contextId')), required: workflow.inputSchema.required?.filter(key => key !== 'contextId') };
    const input = await collectForm({ prompt: (title, initial) => this.prompt(title, initial), choose: (title, items) => this.choose(title, items), note: text => this.note(text) }, schema, workflow.id);
    if (input === formCancelled) return;
    const confirmation = await this.choose(`确认执行工作流 ${label(id)}？\n${safeTerminalText(workflow.description)}\n${safeValueText(input)}`, [{ value: 'no', label: '返回' }, { value: 'yes', label: '执行' }]); if (confirmation !== 'yes') return;
    const result = await this.write(`/workflows/${routeId(id)}/run`, { contextId, input });
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
      const { revisions } = await this.request<{ revisions: Array<{ revision: number; description: string; updatedAt?: string }> }>(`/methods/${routeId(name)}/revisions`);
      const historical = revisions.filter(row => row.revision !== method.revision);
      if (!historical.length) { this.note('暂无可恢复的历史版本。'); return; }
      const value = await this.choose('选择历史版本', historical.map(row => ({ value: String(row.revision), label: `版本 ${row.revision}`, description: `${row.updatedAt ?? ''} · ${row.description}` }))); if (!value) return;
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
      if (confirm === 'yes') { await this.write('/schedules', { version: 2, name: name.trim(), task, timing, ...(timezone.trim() ? { timezone: timezone.trim() } : {}), output: { kind: outputKind, contextId: this.contextId } }); this.note('定时任务已创建。'); }
      return;
    }
    const schedule = schedules.find(x => x.id === id)!;
    const action = await this.choose(schedule.name, [{ value: 'details', label: '查看详情' }, { value: 'history', label: '执行记录' }, ...(schedule.status !== 'cancelled' ? [{ value: 'edit', label: '编辑定时任务' }, ...(schedule.status === 'active' ? [{ value: 'pause', label: '暂停' }] : []), ...(schedule.status === 'paused' ? [{ value: 'resume', label: '恢复' }] : []), { value: 'cancel', label: '取消' }, { value: 'run', label: '立即执行' }] : [])]);
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
    const selected = await this.choose(`任务交付 · 版本 ${task.revision}`, files.map(({ index, delivery }) => ({ value: String(index), label: delivery.title, description: `${label(delivery.value)} · SHA-256 ${delivery.sha256}` }))); if (selected === undefined) return;
    const entry = files.find(item => String(item.index) === selected); if (!entry) throw new AppError('invalid_selection');
    await this.saveDownload(() => this.client.deliveryBytes(task.id, entry.index, task.revision, entry.delivery.sha256!, this.lifetime.signal));
  }
  private async taskRelations(task: TaskRecord, tasks: TaskRecord[]) {
    const parent = tasks.find(row => row.id === task.parentId);
    const children = tasks.filter(row => row.parentId === task.id);
    if (!parent && !children.length) { this.note('此任务没有父任务或子任务。'); return; }
    const related = [...(parent ? [{ ...parent, relationship: '父任务' }] : []), ...children.map(row => ({ ...row, relationship: '子任务' }))];
    const selected = await this.choose('关联任务', related.map(row => ({ value: row.id, label: `${row.relationship} · ${row.title}`, description: row.status })));
    const target = related.find(row => row.id === selected);
    if (target) { this.note(`任务 ${label(target.title)} · ${label(target.status)}\n${formatReport(target.report)}`); const action = await this.choose(target.title, [{ value: 'open', label: '打开上下文' }, { value: 'history', label: '执行时间线' }]); if (action === 'open') this.switchContext(target.contextId); else if (action === 'history') await this.taskTimeline(target.id); }
  }
  private async taskTimeline(id: string) {
    const detail = await this.request<TaskRecord & { runs?: Array<{ id: string; status: string; createdAt: string; finishedAt?: string; errorCode?: string } | null> }>(`/tasks/${routeId(id)}`);
    this.note(`任务 ${label(detail.title)} · 第 ${detail.attempt ?? 1} 次尝试\n${(detail.runs ?? []).map((run, index) => run ? `  运行 ${index + 1} · ${label(run.status)} · ${label(run.createdAt)}${run.finishedAt ? ` → ${label(run.finishedAt)}` : ''}${run.errorCode ? ` · ${label(run.errorCode)}` : ''}` : `  运行 ${index + 1} · 记录不可用`).join('\n') || '尚无执行记录。'}`);
    let after = 0;
    for (;;) {
      const page = taskLifecyclePageSchema.parse(await this.request(`/tasks/${routeId(id)}/events?after=${after}&limit=40`));
      const names: Record<string, string> = { agent_start: '开始', agent_end: '结束', complete: '完成', aborted: '已中断', error: '失败', suspended: '已挂起' };
      if (page.events.length) this.note(page.events.map(row => `${label(row.createdAt)} · ${names[row.kind] ?? label(row.kind)}${row.reason ? ` · ${names[row.reason] ?? label(row.reason)}` : ''} · ${label(row.runId)}`).join('\n'));
      if (!page.hasMore) return;
      if (page.nextCursor <= after) throw new AppError('history_pagination_stalled');
      if (await this.choose('执行时间线', [{ value: 'more', label: '加载更多' }, { value: 'end', label: '返回' }]) !== 'more') return;
      after = page.nextCursor;
    }
  }
  private async tasks() {
    const { tasks } = await this.request<{ tasks: TaskRecord[] }>('/tasks');
    if (!tasks.length) { this.note('还没有后台任务；/task 可创建任务。'); return; }
    const id = await this.choose('任务', tasks.map(x => ({ value: x.id, label: x.title, description: `${x.status} · ${x.id}` }))); if (!id) return;
    const task = await this.request<TaskRecord>(`/tasks/${routeId(id)}`);
    const messageDrafts = this.taskMessageDrafts;
    const active = ['pending', 'running', 'waiting'].includes(task.status);
    const actions: SelectItem[] = [
      { value: 'details', label: '查看详情和报告' }, { value: 'open', label: '打开上下文' }, { value: 'history', label: '执行时间线' }, { value: 'relations', label: '父任务与子任务' },
      ...(active ? [{ value: 'message', label: '补充消息' }, { value: 'pause', label: '暂停' }] : []),
      ...(['pending', 'running', 'waiting', 'paused', 'pausing'].includes(task.status) ? [{ value: 'cancel', label: '取消' }] : []),
      ...(task.status === 'paused' ? [{ value: 'resume', label: '恢复' }] : []),
      ...(['failed', 'blocked', 'interrupted', 'unreported'].includes(task.status) ? [{ value: 'retry', label: '重试' }] : []),
      ...(messageDrafts.has(id) ? [{ value: 'draft', label: '取回未发送的补充到输入框' }] : []),
    ];
    if (this.capabilities.has('file-deliveries')) actions.push({ value: 'deliveries', label: '下载文件交付' });
    const action = await this.choose(`${label(task.title)} · ${label(task.status)}`, actions);
    if (action === 'history') { await this.taskTimeline(id); }
    else if (action === 'relations') { await this.taskRelations(task, tasks); }
    else if (action === 'deliveries') { await this.taskDeliveries(id); }
    else if (action === 'details') { const detail = await this.request<TaskRecord>(`/tasks/${routeId(id)}`); this.note(`任务 ${label(detail.title)} · ${label(detail.status)}${detail.attempt > 1 ? ` · 第 ${detail.attempt} 次尝试` : ''}\n${safeTerminalText(detail.content)}\n\n${formatReport(detail.report)}`); }
    else if (action === 'open') this.switchContext(task.contextId);
    else if (action === 'draft') {
      const draft = messageDrafts.get(id);
      if (draft) { const current = this.editor.getExpandedText(); this.editor.setText(current ? `${current}\n\n${draft}` : draft); messageDrafts.delete(id); this.note('补充草稿已取回，尚未发送。'); }
    }
    else if (action === 'message' && active) {
      const content = await this.promptLong('补充消息', messageDrafts.get(id) ?? '');
      if (content?.trim()) {
        messageDrafts.set(id, content);
        try {
          const receipt = await this.write(`/tasks/${routeId(id)}/messages`, { content }) as { status: string };
          if (!['accepted', 'queued'].includes(receipt.status)) throw new AppError('task_message_not_accepted', 409);
          messageDrafts.delete(id); this.note('消息已提交。');
        }
        catch (error) { this.note('补充尚未确认接收，草稿已保留；/tasks 可取回。请先核对任务记录，避免重复发送。'); throw error; }
      }
    }
    else if (action && actions.some(item => item.value === action)) {
      const confirm = await this.choose(`确认对任务执行 ${label(action)}？`, [{ value: 'yes', label: '确认' }, { value: 'no', label: '返回' }]);
      if (confirm === 'yes') {
        try { await this.write(`/tasks/${routeId(id)}/${action}`, { revision: task.revision }); this.note('任务操作已提交。'); }
        catch (error) {
          if (error instanceof AppError && error.code === 'task_revision_conflict') {
            const latest = await this.request<TaskRecord>(`/tasks/${routeId(id)}`);
            this.note(`任务状态已更新为 ${label(latest.status)}；本次操作未执行，请重新选择。`); return;
          }
          throw error;
        }
      }
    }
  }
}

export async function runTui(client: Client, contextId = 'main', signal?: AbortSignal, options: { preferencesDirectory?: string; resume?: boolean } = {}): Promise<void> {
  const directory = options.preferencesDirectory ?? path.join(process.env.SHITTIMCHEST_DATA_DIR || process.env.ARONA_DATA_DIR || path.join(os.homedir(), '.arona'), 'client');
  const app = new TerminalApp(client, contextId, new ProcessTerminal(), { ...(typeof client.baseURL === 'string' ? { preferences: new TuiPreferences(directory, client.localStateScope ?? client.baseURL,[client.baseURL]), inputHistory:new TuiInputHistory(directory,client.localStateScope ?? client.baseURL), answerDrafts: new InteractionAnswerDrafts(directory, client.localStateScope ?? client.baseURL, [client.baseURL]),queueEdits:new QueueLocalEdits(directory,client.localStateScope ?? client.baseURL,[client.baseURL]),transferFiles:new SessionTransferFiles(directory,client.localStateScope ?? client.baseURL),shellOutputs:new ShellOutputCaptures(directory,client.localStateScope ?? client.baseURL) } : {}), resume: options.resume ?? (!process.env.SHITTIMCHEST_CONTEXT_ID && !process.env.ARONA_CONTEXT_ID && contextId === 'main') });
  const abort = () => { void app.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  try { if (signal?.aborted) { await app.stop(); return; } await app.run(); }
  finally { signal?.removeEventListener('abort', abort); await app.stop(); }
}
