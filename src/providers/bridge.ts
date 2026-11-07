import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, JsonObject, Model, Models, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai';

export type PiRequestObserver=(request:{model:Model<Api>;context:Context;options:SimpleStreamOptions})=>void|((usage:Usage)=>void);

/** The registry remains responsible for provider selection and authentication. */
export function createPiLanguageModel(models: Pick<Models, 'streamSimple'>, model: Model<Api>, observer?:PiRequestObserver): LanguageModelV4 {
  async function doStream(options: LanguageModelV4CallOptions) {
    const context = convertPrompt(options, model);
    const settings = convertOptions(options);
    const reportUsage=observer?.({model,context,options:settings});
    const abort = new AbortController();
    const onAbort = () => abort.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) onAbort();
    else options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    settings.signal = abort.signal;
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    let cancelled = false;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        void (async () => {
        const emit = (part: LanguageModelV4StreamPart) => controller.enqueue(part);
        let rejectAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(abort.signal.reason ?? abortError());
          abort.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        try {
          abort.signal.throwIfAborted();
          emit({ type: 'stream-start', warnings: [] });
          try { iterator = models.streamSimple(model, context, settings)[Symbol.asyncIterator](); }
          catch { throw new Error('Pi provider error'); }
          let finished = false;
          const active = new Map<number, { kind: 'text' | 'reasoning' | 'tool'; id: string }>();
          while (true) {
            abort.signal.throwIfAborted();
            const next = await Promise.race([iterator.next().catch(() => { throw new Error('Pi provider error'); }), aborted]);
            abort.signal.throwIfAborted();
            if (next.done) break;
            const event = next.value;
            if (event.type === 'start') {
              emit({ type: 'response-metadata', id: event.partial.responseId, modelId: event.partial.responseModel, timestamp: new Date(event.partial.timestamp) });
            } else if (event.type === 'text_start' || event.type === 'thinking_start' || event.type === 'toolcall_start') {
              const kind = event.type === 'text_start' ? 'text' : event.type === 'thinking_start' ? 'reasoning' : 'tool';
              if (active.has(event.contentIndex)) throw new Error('Duplicate Pi content start');
              const block = event.partial.content[event.contentIndex];
              if (!block || (kind === 'text' && block.type !== 'text') || (kind === 'reasoning' && block.type !== 'thinking') || (kind === 'tool' && block.type !== 'toolCall')) throw new Error('Invalid Pi content start');
              if (block.type === 'thinking' && block.redacted) throw new Error('Unsupported Pi redacted reasoning');
              const id = kind === 'tool' && block.type === 'toolCall' ? block.id : String(event.contentIndex);
              active.set(event.contentIndex, { kind, id });
              if (kind === 'text') emit({ type: 'text-start', id });
              else if (kind === 'reasoning') emit({ type: 'reasoning-start', id });
            } else if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
              const part = active.get(event.contentIndex);
              const kind = event.type === 'text_delta' ? 'text' : event.type === 'thinking_delta' ? 'reasoning' : 'tool';
              if (!part || part.kind !== kind) throw new Error('Invalid Pi content delta');
              // Pi may start with provider-specific pre-populated arguments; emit authoritative JSON at end.
              if (kind === 'text') emit({ type: 'text-delta', id: part.id, delta: event.delta });
              else if (kind === 'reasoning') emit({ type: 'reasoning-delta', id: part.id, delta: event.delta });
            } else if (event.type === 'text_end' || event.type === 'thinking_end' || event.type === 'toolcall_end') {
              const part = active.get(event.contentIndex);
              const kind = event.type === 'text_end' ? 'text' : event.type === 'thinking_end' ? 'reasoning' : 'tool';
              if (!part || part.kind !== kind) throw new Error('Invalid Pi content end');
              active.delete(event.contentIndex);
              if (event.type === 'toolcall_end') {
                const call = event.toolCall;
                if (!call.id || !call.name || call.namespace || call.argumentsError) throw new Error('Unsupported or invalid Pi tool call');
                const input = JSON.stringify(call.arguments);
                part.id = call.id;
                emit({ type: 'tool-input-start', id: part.id, toolName: call.name });
                emit({ type: 'tool-input-delta', id: part.id, delta: input });
                emit({ type: 'tool-input-end', id: part.id });
                emit({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input, providerMetadata: signature('thoughtSignature', call.thoughtSignature) });
              } else {
                const block = event.partial.content[event.contentIndex];
                if (event.type === 'text_end' && block?.type === 'text') emit({ type: 'text-end', id: part.id, providerMetadata: signature('textSignature', block.textSignature) });
                else if (event.type === 'thinking_end' && block?.type === 'thinking' && !block.redacted) emit({ type: 'reasoning-end', id: part.id, providerMetadata: signature('thinkingSignature', block.thinkingSignature) });
                else throw new Error('Unsupported Pi content end');
              }
            } else if (event.type === 'error') {
              if (event.reason === 'aborted') throw abortError();
              throw new Error('Pi provider error');
            } else if (event.type === 'done') {
              if (event.reason === 'deferred') throw new Error('Unsupported Pi deferred response');
              if (active.size) throw new Error('Pi stream ended with open content');
              reportUsage?.(event.message.usage);
              emit({ type: 'finish', finishReason: { unified: event.reason === 'toolUse' ? 'tool-calls' : event.reason, raw: event.message.rawStopReason }, usage: usage(event.message.usage) });
              finished = true;
              break;
            } else {
              throw new Error('Unsupported Pi stream event');
            }
          }
          if (!finished) throw new Error('Pi stream ended without completion');
          controller.close();
        } catch (error) {
          if (!cancelled) controller.error(options.abortSignal?.aborted ? options.abortSignal.reason ?? abortError() : error);
        } finally {
          if (rejectAbort) abort.signal.removeEventListener('abort', rejectAbort);
          options.abortSignal?.removeEventListener('abort', onAbort);
          if (iterator?.return) void iterator.return().catch(() => {});
        }
        })();
      },
      cancel(reason) { cancelled = true; abort.abort(reason); },
    });
    return { stream };
  }
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.id, supportedUrls: {}, doStream,
    async doGenerate(options) {
      const { stream } = await doStream(options);
      const content: LanguageModelV4Content[] = [];
      const blocks = new Map<string, { type: 'text' | 'reasoning'; text: string }>();
      let finish: Extract<LanguageModelV4StreamPart, { type: 'finish' }> | undefined;
      let response: { id?: string; modelId?: string; timestamp?: Date } | undefined;
      for await (const part of stream) {
        if (part.type === 'text-start' || part.type === 'reasoning-start') { const block = { type: part.type === 'text-start' ? 'text' as const : 'reasoning' as const, text: '' }; blocks.set(part.id, block); content.push(block); }
        else if (part.type === 'text-delta' || part.type === 'reasoning-delta') { const block = blocks.get(part.id); if (!block) throw new Error('Missing content block'); block.text += part.delta; }
        else if (part.type === 'text-end' || part.type === 'reasoning-end') { const block = blocks.get(part.id); if (block && part.providerMetadata) Object.assign(block, { providerMetadata: part.providerMetadata }); blocks.delete(part.id); }
        else if (part.type === 'tool-call') content.push(part);
        else if (part.type === 'finish') finish = part;
        else if (part.type === 'response-metadata') response = part;
        else if (part.type === 'error') throw part.error;
      }
      if (!finish) throw new Error('Pi stream ended without completion');
      return { content, finishReason: finish.finishReason, usage: finish.usage, warnings: [], response };
    },
  };
}

function abortError(message = 'The operation was aborted'): Error { const error = new Error(message); error.name = 'AbortError'; return error; }
function signature(key: string, value?: string) { return value === undefined ? undefined : { pi: { [key]: value } }; }
function metadataOptions(options: unknown): Record<string, unknown> {
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Unsupported provider options');
  const obj = options as Record<string, unknown>;
  if (obj.mastra !== undefined) {
    const meta = obj.mastra;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Unsupported Mastra metadata');
  }
  return obj;
}
function readSignature(options: unknown, key: string): string | undefined {
  const obj = metadataOptions(options);
  if (Object.keys(obj).some(k => k !== 'pi' && k !== 'mastra')) throw new Error('Unsupported provider options');
  if (obj.pi === undefined) return undefined;
  if (!obj.pi || typeof obj.pi !== 'object' || Array.isArray(obj.pi)) throw new Error('Unsupported Pi provider options');
  const pi = obj.pi as Record<string, unknown>;
  if (Object.keys(pi).some(k => k !== key) || (pi[key] !== undefined && typeof pi[key] !== 'string')) throw new Error('Unsupported Pi provider options');
  return pi[key] as string | undefined;
}
function noOptions(options: unknown) { if (Object.keys(metadataOptions(options)).some(k => k !== 'mastra')) throw new Error('Unsupported provider options'); }
function usage(value: Usage): LanguageModelV4Usage {
  return { inputTokens: { total: value.input + value.cacheRead + value.cacheWrite, noCache: value.input, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite }, outputTokens: { total: value.output, reasoning: value.reasoning, text: value.reasoning === undefined ? undefined : value.output - value.reasoning } };
}
function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function convertOptions(options: LanguageModelV4CallOptions): SimpleStreamOptions {
  for (const key of ['stopSequences', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'includeRawChunks'] as const) if (options[key] !== undefined && options[key] !== false) throw new Error(`Unsupported option: ${key}`);
  if (options.responseFormat && options.responseFormat.type !== 'text') throw new Error('Unsupported response format');
  let reasoning: SimpleStreamOptions['reasoning'];
  if (options.providerOptions && Object.keys(options.providerOptions).length) {
    const providers = options.providerOptions;
    if (Object.keys(providers).some(key => key !== 'pi') || !providers.pi || Object.keys(providers.pi).some(key => key !== 'reasoning')) throw new Error('Unsupported provider options');
    const value = providers.pi.reasoning;
    if (value !== undefined) {
      if (typeof value !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('Unsupported Pi reasoning');
      reasoning = value as SimpleStreamOptions['reasoning'];
    }
  }
  if (options.toolChoice && options.toolChoice.type !== 'auto' && options.toolChoice.type !== 'none') throw new Error('Unsupported tool choice');
  if (options.reasoning && options.reasoning !== 'provider-default') throw new Error('Unsupported reasoning setting');
  return { reasoning, maxTokens: options.maxOutputTokens, temperature: options.temperature, headers: options.headers && Object.fromEntries(Object.entries(options.headers).filter((entry): entry is [string, string] => entry[1] !== undefined)), toolChoice: options.toolChoice?.type };
}
function convertPrompt(options: LanguageModelV4CallOptions, model: Model<Api>): Context {
  const messages: Context['messages'] = [];
  const now = Date.now();
  const tools = options.tools?.map(tool => {
    if (tool.type !== 'function' || tool.strict === true || tool.inputExamples !== undefined) throw new Error('Unsupported tool definition');
    noOptions(tool.providerOptions);
    return { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema };
  });
  for (const message of options.prompt) {
    noOptions(message.providerOptions);
    if (message.role === 'system') messages.push({ role: 'system', content: message.content, timestamp: now });
    else if (message.role === 'user') {
      const content = message.content.flatMap(part => {
        noOptions(part.providerOptions);
        if (part.type === 'text') return [{ type: 'text' as const, text: part.text }];
        if (part.data.type !== 'data' || !part.mediaType.startsWith('image/') || part.mediaType.endsWith('/*') || !model.input.includes('image')) throw new Error('Unsupported user file');
        return [...(part.filename?[{type:'text' as const,text:`Image attachment ${JSON.stringify(part.filename)}`}]:[]),{ type: 'image' as const, data: typeof part.data.data === 'string' ? part.data.data : Buffer.from(part.data.data).toString('base64'), mimeType: part.mediaType }];
      });
      messages.push({ role: 'user', content, timestamp: now });
    } else if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = message.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text, textSignature: readSignature(part.providerOptions, 'textSignature') };
        if (part.type === 'reasoning') return { type: 'thinking', thinking: part.text, thinkingSignature: readSignature(part.providerOptions, 'thinkingSignature') };
        if (part.type === 'tool-call') {
          if (part.providerExecuted || !part.input || typeof part.input !== 'object' || Array.isArray(part.input)) throw new Error('Unsupported tool call input');
          const serialized = JSON.stringify(part.input);
          if (!serialized) throw new Error('Invalid tool call input');
          return { type: 'toolCall', id: part.toolCallId, name: part.toolName, arguments: JSON.parse(serialized) as JsonObject, thoughtSignature: readSignature(part.providerOptions, 'thoughtSignature') };
        }
        throw new Error(`Unsupported assistant content: ${part.type}`);
      });
      messages.push({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: now });
    } else {
      for (const part of message.content) {
        if (part.type !== 'tool-result') throw new Error('Unsupported tool approval');
        noOptions(part.providerOptions); if ('providerOptions' in part.output) noOptions(part.output.providerOptions);
        const output = part.output;
        if (output.type === 'execution-denied') throw new Error('Unsupported tool result');
        const content = output.type === 'content' ? output.value.map(item => {
          noOptions(item.providerOptions);
          if (item.type === 'text') return { type: 'text' as const, text: item.text };
          if (item.type !== 'file' || item.data.type !== 'data' || !item.mediaType.startsWith('image/') || item.mediaType.endsWith('/*') || item.filename) throw new Error('Unsupported tool result content');
          return { type: 'image' as const, data: typeof item.data.data === 'string' ? item.data.data : Buffer.from(item.data.data).toString('base64'), mimeType: item.mediaType };
        }) : [{ type: 'text' as const, text: typeof output.value === 'string' && (output.type === 'text' || output.type === 'error-text') ? output.value : JSON.stringify(output.value) }];
        messages.push({ role: 'toolResult', toolCallId: part.toolCallId, toolName: part.toolName, content, isError: output.type === 'error-text' || output.type === 'error-json', timestamp: now });
      }
    }
  }
  return { messages, tools };
}
