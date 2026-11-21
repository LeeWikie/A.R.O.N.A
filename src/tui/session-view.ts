import { AppError } from '../domain.js';
import type { SessionTreeView } from '../protocol.js';
import { safeTerminalText } from '../terminal-format.js';

function terminalValue(value: unknown): unknown {
  if (typeof value === 'string') return safeTerminalText(value);
  if (value === null || typeof value !== 'object') return value;
  const root: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : Object.create(null);
  const stack = [{ source: value, target: root }];
  while (stack.length) {
    const { source, target } = stack.pop()!;
    for (const [key, item] of Object.entries(source)) {
      if (item !== null && typeof item === 'object') {
        const child: unknown[] | Record<string, unknown> = Array.isArray(item) ? [] : Object.create(null);
        (target as Record<string, unknown>)[key] = child; stack.push({ source: item, target: child });
      } else (target as Record<string, unknown>)[key] = typeof item === 'string' ? safeTerminalText(item) : item;
    }
  }
  return root;
}

/** Display projection only: Core identifiers and topology stay unchanged. */
export function terminalSessionView(view: SessionTreeView): SessionTreeView {
  const tree: SessionTreeView['tree'] = [], ids = new Set<string>();
  const stack = [...view.tree].reverse().map(node => ({ node, parentId: null as string | null, output: tree }));
  while (stack.length) {
    const { node, parentId, output } = stack.pop()!;
    if (!node.entry.id || safeTerminalText(node.entry.id) !== node.entry.id || ids.has(node.entry.id) || node.entry.parentId !== parentId) throw new AppError('invalid_session_tree');
    ids.add(node.entry.id);
    const projected = { entry: terminalValue(node.entry) as typeof node.entry, children: [] as SessionTreeView['tree'], ...(node.label !== undefined ? { label: safeTerminalText(node.label) } : {}), ...(node.labelTimestamp ? { labelTimestamp: node.labelTimestamp } : {}) };
    output.push(projected);
    for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index]!, parentId: node.entry.id, output: projected.children });
  }
  if (view.leafId !== null && !ids.has(view.leafId)) throw new AppError('invalid_session_tree');
  return { ...view, tree };
}
