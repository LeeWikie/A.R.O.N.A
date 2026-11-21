import type { Component } from '@earendil-works/pi-tui';
import type { ClientRequestInit } from '../client.js';
import { AppError } from '../domain.js';
import type { ContextRecord } from '../runtime-store.js';
import type { SessionTreeView, SessionBrowserPage, SessionNavigationResult } from '../protocol.js';
import { safeTerminalText } from '../terminal-format.js';
import { SessionSelectorComponent } from './upstream/session-selector.js';
import { TreeSelectorComponent, type FilterMode } from './upstream/tree-selector.js';
import { UserMessageSelectorComponent } from './upstream/user-message-selector.js';
import type { SessionInfo, SessionTreeNode } from './upstream/session-types.js';
import { setSessionTheme } from './upstream/session-theme.js';
import type { Theme } from './upstream/theme.js';
import { terminalSessionView } from './session-view.js';

interface TreeSelection { entryId: string; refresh?: boolean }
export interface SessionControlsHost {
  contextId(): string;
  theme(): Theme;
  rows(): number;
  render(): void;
  request<T>(route: string, init?: ClientRequestInit): Promise<T>;
  write(route: string, body: unknown, method?: string, signal?: AbortSignal): Promise<unknown>;
  select<T>(build: (done: (value?: T) => void, signal: AbortSignal) => Component & { dispose?(): void }): Promise<T | undefined>;
  choose(title: string, items: Array<{ value: string; label: string }>): Promise<string | undefined>;
  edit(title: string): Promise<string | undefined>;
  copy(text: string): Promise<void>;
  note(text: string): void;
  open(contextId: string, draft?: string): void;
  navigate(route: string, body: unknown): Promise<SessionNavigationResult>;
  fork(route: string, body: unknown): Promise<{ context: ContextRecord; draft: string }>;
  filter(): FilterMode;
  saveFilter(filter: FilterMode): void;
}

const idPath = (value: string) => encodeURIComponent(value);

/** Session selection operates on Core records; the components own only their visible selection. */
export class SessionControls {
  constructor(private readonly host: SessionControlsHost) {}

  async fork(): Promise<void> {
    const host = this.host, contextId = host.contextId();
    const view = terminalSessionView(await host.request<SessionTreeView>(`/contexts/${idPath(contextId)}/tree`));
    const nodes = new Map<string, SessionTreeNode>(), stack = [...view.tree].reverse();
    while (stack.length) { const node = stack.pop()!; nodes.set(node.entry.id, node); for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!); }
    const entryOrder = (view as SessionTreeView & { entryOrder?: string[] }).entryOrder;
    const ordered = entryOrder ? entryOrder.flatMap(id => nodes.has(id) ? [nodes.get(id)!] : []) : [...nodes.values()].sort((left, right) => left.entry.timestamp.localeCompare(right.entry.timestamp));
    const messages = ordered.flatMap(node => {
      const entry = node.entry;
      if (entry.type !== 'message' || entry.message.role !== 'user') return [];
      const content = entry.message.content;
      const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      return text ? [{ id: entry.id, text, timestamp: entry.timestamp }] : [];
    });
    if (!messages.length) { host.note('没有可重新编辑的用户消息。'); return; }
    setSessionTheme(host.theme());
    const entryId = await host.select<string>(done => {
      const selector = new UserMessageSelectorComponent(messages, done, () => done()); selector.setViewportProvider(() => host.rows()); return selector;
    });
    if (!entryId || host.contextId() !== contextId) return;
    const result = await host.fork(`/contexts/${idPath(contextId)}/fork`, { sourceEntryId: entryId });
    host.open(result.context.id, result.draft);
  }

  async browse(): Promise<void> {
    const host = this.host, contextId = host.contextId();
    const { contexts } = await host.request<{ contexts: ContextRecord[] }>('/contexts');
    const workspaceId = contexts.find(context => context.id === contextId)?.workspaceId;
    setSessionTheme(host.theme());
    const selected = await host.select<string>((done, signal) => {
      const load = (scope: 'current' | 'all') => async (progress?: (loaded: number, total: number, partial?: SessionInfo[]) => void, cancelled?: AbortSignal) => {
        const items: SessionInfo[] = [], cursors = new Set<string>(); let cursor: string | undefined;
        for (;;) {
          const query = new URLSearchParams({ scope, limit: '100', ...(workspaceId ? { workspaceId } : {}), ...(cursor ? { cursor } : {}) });
          const page = await host.request<SessionBrowserPage>(`/sessions?${query}`, { signal: AbortSignal.any([signal, ...(cancelled ? [cancelled] : [])]) });
          items.push(...page.sessions.map(session => ({ id: session.id, path: session.id, name: session.name ? safeTerminalText(session.name) : undefined, cwd: safeTerminalText(session.cwd), created: new Date(session.createdAt), modified: new Date(session.updatedAt), messageCount: session.messageCount, firstMessage: safeTerminalText(session.firstMessage), allMessagesText: safeTerminalText(session.allMessagesText), ...(session.parentContextId ? { parentSessionPath: session.parentContextId } : {}) })));
          progress?.(items.length, page.total, [...items]);
          if (!page.hasMore) return items;
          if (!page.nextCursor || cursors.has(page.nextCursor)) throw new AppError('session_pagination_stalled');
          cursor = page.nextCursor; cursors.add(cursor);
        }
      };
      const selector = new SessionSelectorComponent(load('current'), load('all'), done, () => done(), () => done(), () => host.render(), {
        renameSession: async (id, name) => { if (!name) return; await host.write(`/contexts/${idPath(id)}`, { name }, 'PATCH', signal); },
        removeSession: async id => { try { await host.write(`/contexts/${idPath(id)}`, { archived: true }, 'PATCH', signal); return { ok: true }; } catch (error) { return { ok: false, error: error instanceof AppError ? error.code : 'session_archive_failed' }; } },
      }, contextId);
      selector.setViewportProvider(() => host.rows());
      return selector;
    });
    if (selected && host.contextId() === contextId) host.open(selected);
  }

  async tree(initialSelectedId?: string): Promise<void> {
    const host = this.host, contextId = host.contextId();
    let selectedId = initialSelectedId;
    while (host.contextId() === contextId) {
      let view = terminalSessionView(await host.request<SessionTreeView>(`/contexts/${idPath(contextId)}/tree`));
      if (!view.tree.length) { host.note('当前会话还没有可浏览的记录。'); return; }
      setSessionTheme(host.theme());
      const choice = await host.select<TreeSelection>((done, signal) => {
        const selector = new TreeSelectorComponent(view.tree, view.leafId, host.rows(), entryId => done({ entryId }), () => done(), async (entryId, label) => {
          view = terminalSessionView(await host.write(`/contexts/${idPath(contextId)}/tree/${idPath(entryId)}/label`, { label: label ?? null, expectedRevision: view.revision }, 'PATCH', signal) as SessionTreeView);
          return findTreeNode(view.tree, entryId);
        }, selectedId, host.filter());
        selector.onCopy = text => { if (text) void host.copy(text).catch(() => host.note('复制失败。')); else host.note('所选记录没有可复制的文字。'); };
        selector.onLabelError = entryId => { host.note('标签结果未确认，正在重新读取会话。'); done({ entryId, refresh: true }); };
        selector.onDispose = () => host.saveFilter(selector.getTreeList().getFilterMode());
        selector.onUpdate = () => host.render();
        selector.setViewportProvider(() => host.rows());
        return selector;
      });
      if (!choice) return;
      selectedId = choice.entryId;
      if (choice.refresh) continue;
      if (choice.entryId === view.leafId) { host.note('当前已位于所选记录。'); return; }
      let summarize = false, customInstructions: string | undefined;
      let returnToTree = false;
      for (;;) {
        const action = await host.choose('为离开的分支生成摘要？', [{ value: 'none', label: '不生成摘要' }, { value: 'summary', label: '生成摘要' }, { value: 'custom', label: '自定义摘要要求' }]);
        if (!action) { returnToTree = true; break; }
        summarize = action !== 'none';
        if (action === 'custom') { customInstructions = await host.edit('摘要要求'); if (customInstructions === undefined) continue; }
        break;
      }
      if (returnToTree) continue;
      try {
        const result = await host.navigate(`/contexts/${idPath(contextId)}/tree/navigate`, { targetId: choice.entryId, summarize, ...(customInstructions !== undefined ? { customInstructions } : {}), expectedRevision: view.revision, expectedLeafId: view.leafId });
        host.open(result.context.id, result.draft); host.note('已导航到所选记录。'); return;
      } catch (error) {
        if (host.contextId() !== contextId) return;
        host.note(error instanceof Error && error.name === 'AbortError' ? '已取消分支摘要。' : `会话导航未完成：${error instanceof AppError ? error.code : 'request_failed'}。`);
      }
    }
  }
}

export function findTreeNode(nodes: readonly SessionTreeNode[], id: string): SessionTreeNode | undefined {
  const stack = [...nodes]; while (stack.length) { const node = stack.pop()!; if (node.entry.id === id) return node; stack.push(...node.children); } return undefined;
}
