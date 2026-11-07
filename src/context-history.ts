import type { ProcessInputArgs } from '@mastra/core/processors';
import type { Memory } from '@mastra/memory';
import { controllerIdentity } from './models.js';

/** SDK history recall is disabled on the Memory instance; this processor loads every page. */
export function completeHistory(memory: Memory) {
  return {
    id: 'complete-context-history',
    async processInput(args: ProcessInputArgs) {
      const id = controllerIdentity(args.requestContext).threadId;
      if (!id || !await memory.getThreadById({ threadId: id })) return args.messageList;
      const current = args.messageList.get.all.db();
      const sources = args.messageList.makeMessageSourceChecker();
      const currentIds = new Set(current.map(message => message.id));
      const remembered = new Set<string>();
      const history: typeof current = [];
      for (let page = 0; ; page++) {
        const result = await memory.recall({ threadId: id, page, perPage: 100, hideSignals: false, orderBy: { field: 'createdAt', direction: 'ASC' } });
        for (const message of result.messages) if (!currentIds.has(message.id) && !remembered.has(message.id)) {
          remembered.add(message.id); history.push(message);
        }
        if (!result.hasMore) break;
        if (!result.messages.length) throw new Error('context_history_pagination_stalled');
      }
      if (!history.length) return args.messageList;
      // Retain the original MessageList and its tagged system messages. Preserve original IDs,
      // input/response origins and native tool-pair metadata instead of reconstructing text.
      const originalSources = current.map(message => ({ message, source: sources.getSource(message) ?? 'input' as const }));
      args.messageList.clear.all.db();
      args.messageList.add(history, 'memory');
      for (const { message, source } of originalSources) args.messageList.add([message], source);
      return args.messageList;
    },
  };
}
