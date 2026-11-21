// Pi coding-agent 1.5.1, modes/interactive/chat-viewport.ts.
// Copyright (c) 2025 Mario Zechner; MIT license in LICENSE.
// Adaptation: reuse the existing transcript and reduce chrome on very short screens.
import { VStack, type Component, type ScrollView, type Terminal } from '@earendil-works/pi-tui';
import { LAYOUT_NODE, type StackLayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js';

class InputDock extends VStack {
  constructor(private readonly editor: Component, private readonly terminal: Pick<Terminal, 'rows'>, entries: ConstructorParameters<typeof VStack>[0]) { super(entries); }
  override [LAYOUT_NODE](): StackLayoutNode {
    const node = super[LAYOUT_NODE]();
    return { ...node, entries: node.entries.map(entry => entry.component === this.editor ? { ...entry, minSize: Math.max(1, Math.min(3, this.terminal.rows)) } : entry) };
  }
}

/** The input dock yields optional rows while Pi's layout keeps the focused cursor visible. */
export function createChatViewport(options: { header: Component; transcript: ScrollView; pendingMessages: Component; status: Component; editor: Component; footer: Component; terminal: Pick<Terminal, 'rows'> }): Component {
  const dock = new InputDock(options.editor, options.terminal, [
    { component: options.pendingMessages, shrink: 1, minSize: 0 },
    { component: options.status, shrink: 1, minSize: 0 },
    { component: options.editor, shrink: 1, minSize: 3 },
    { component: options.footer, shrink: 1, minSize: 0 },
  ]);
  return new VStack([
    { component: options.header, shrink: 1, minSize: 0, visible: viewport => viewport.height >= 6 },
    { component: options.transcript, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: viewport => viewport.height >= 4 },
    { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
  ]);
}
