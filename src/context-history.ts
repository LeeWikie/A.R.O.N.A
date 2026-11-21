import { isDeepStrictEqual } from 'node:util';
import type { ProcessInputArgs, ProcessLLMRequestArgs } from '@mastra/core/processors';
import { legacyResponsesMetadata } from './providers/replay-metadata.js';
import type { Memory } from '@mastra/memory';
import { controllerIdentity } from './models.js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import {projectSessionToolMetadata} from './providers/session-replay.js';
import {completeNativeToolRoundTrips} from './session-turn.js';

/** SDK history recall is disabled on the Memory instance; this processor loads every page. */
export function completeHistory(memory: Memory, selectedHistory?: (threadId:string)=>Promise<MastraDBMessage[]|undefined>, observeInput?: (args:ProcessInputArgs)=>void) {
  return {
    id: 'complete-context-history',
    async processLLMRequest(args: ProcessLLMRequestArgs): Promise<{ prompt: ProcessLLMRequestArgs['prompt'] } | undefined> {
      if (!args.messageList) return;
      // Workflow resume/step serialization can reorder object keys. Keep the
      // exact recalled content encoding for semantically unchanged records;
      // saving the transcript must not migrate legacy rows as a side effect.
      let stored = args.state?.storedHistoryContents as Record<string, string> | undefined;
      const threadId = controllerIdentity(args.requestContext).threadId;
      // Some workflow step boundaries reset processor state. Recall the original
      // encoding again rather than trusting a canonicalized workflow copy.
      if (!stored && threadId && args.stepNumber > 0) {
        stored = Object.create(null) as Record<string, string>;
        const selected=await selectedHistory?.(threadId);
        if(selected)for(const message of selected)stored[message.id]=JSON.stringify(message.content);
        else
        for (let page = 0; ; page++) {
          const recalled = await memory.recall({ threadId, page, perPage: 100, hideSignals: false });
          for (const message of recalled.messages) stored[message.id] = JSON.stringify(message.content);
          if (!recalled.hasMore) break;
          if (!recalled.messages.length) throw new Error('context_history_pagination_stalled');
        }
      }
      if (stored) for (const message of args.messageList.get.all.db()) {
        if (!Object.hasOwn(stored, message.id)) continue;
        const original = JSON.parse(stored[message.id]!);
        if (isDeepStrictEqual(message.content, original)) message.content = original;
      }
      const state = args.messageList.serialize();
      let changed = false;
      const messages = state.messages.map(message => {
        if (message.role !== 'assistant') return message;
        const parts = message.content.parts.map(part => {
          if (part.type !== 'reasoning') return part;
          const metadata = legacyResponsesMetadata(part.providerMetadata);
          if (!metadata) return part;
          changed = true;
          return { ...part, providerMetadata: metadata,
            // Mastra's UI adapter also requires a detail entry for empty bodies.
            // This is an empty structural span, not visible replacement content.
            ...(!part.reasoning && !part.details?.length ? { details: [{ type: 'text' as const, text: '' }] } : {}) };
        });
        return { ...message, content: { ...message.content, parts } };
      });
      const completed=await completeNativeToolRoundTrips(messages,{incomplete:'error'});changed||=!isDeepStrictEqual(messages,completed);
      if (!changed) {const prompt=projectSessionToolMetadata(args.prompt);return prompt===args.prompt?undefined:{prompt};}
      // Conversion can drop pi-only reasoning turns before prompt processors run.
      // Reconvert an isolated model view, retaining sources, IDs and tagged system
      // messages. The persistence list and its private snapshots stay untouched.
      const view = args.messageList.clone().deserialize(structuredClone({ ...state, messages:completed }));
      return { prompt: projectSessionToolMetadata(await view.get.all.aiV5.llmPrompt({ targetProvider: args.apiProviderId })) };
    },
    async processInput(args: ProcessInputArgs): Promise<ProcessInputArgs['messageList']> {
      observeInput?.(args);
      const id = controllerIdentity(args.requestContext).threadId;
      if (!id || !await memory.getThreadById({ threadId: id })) return args.messageList;
      const current = args.messageList.get.all.db();
      const sources = args.messageList.makeMessageSourceChecker();
      const currentIds = new Set(current.map(message => message.id));
      const remembered = new Set<string>();
      const history: typeof current = [];
      const storedContents: Record<string, string> = Object.create(null);
      args.state.storedHistoryContents = storedContents;
      const selected=await selectedHistory?.(id);
      if(selected)for(const message of selected){storedContents[message.id]=JSON.stringify(message.content);if(!currentIds.has(message.id)&&!remembered.has(message.id)){remembered.add(message.id);history.push(message);}}
      else
      for (let page = 0; ; page++) {
        const result = await memory.recall({ threadId: id, page, perPage: 100, hideSignals: false, orderBy: { field: 'createdAt', direction: 'ASC' } });
        for (const message of result.messages) {
          storedContents[message.id] = JSON.stringify(message.content);
          if (!currentIds.has(message.id) && !remembered.has(message.id)) {
            remembered.add(message.id); history.push(message);
          }
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
