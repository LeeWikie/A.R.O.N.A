import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { APICallError } from '@ai-sdk/provider';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, JsonObject, Model, Models, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { isResponsesApi, responsesReplayMetadata } from './replay-metadata.js';

type Provenance = Pick<AssistantMessage, 'api' | 'provider' | 'model'>;
export type PiHistoryMetadata = { provenance?: Provenance; textSignature?: string; thinkingSignature?: string; thoughtSignature?: string; redacted?: boolean };
type StreamBlock = { kind: 'text' | 'reasoning' | 'tool'; id: string; initial: string; deltas: string; emitted: string; opaque: boolean; summarySeparator: boolean };
type CompletedBlock = { part: StreamBlock; content: string; tool?: Extract<AssistantMessage['content'][number], { type: 'toolCall' }> };

function publicContent(part: StreamBlock, content: string): string {
  if (!content.startsWith(part.emitted)) throw new Error(`Conflicting Pi ${part.kind} completion`);
  const suffix = content.slice(part.emitted.length);
  part.emitted = content;
  return suffix;
}
function streamingContent(part: StreamBlock, content: string): string {
  // Responses exposes summary_part.done separators as ordinary thinking deltas;
  // their source is indistinguishable from body LF at this boundary. Buffer only
  // the last pair until the authoritative *_end: retain it if the end does, never
  // retract published bytes or normalize other whitespace. Internal LF still stream.
  return part.summarySeparator && content.endsWith('\n\n') ? content.slice(0, -2) : content;
}
function completePublicContent(part: StreamBlock, content: string): string {
  // A queued start can already include later deltas through a shared partial.
  // Their original offset is therefore only known to lie within that first
  // snapshot. Validate the ordered delta evidence, never append it a second time.
  const offset = content.indexOf(part.deltas);
  const separatedOffset = part.summarySeparator && part.deltas.endsWith('\n\n')
    ? (content + '\n\n').indexOf(part.deltas) : -1;
  if ((offset < 0 || offset > part.initial.length) && (separatedOffset < 0 || separatedOffset > part.initial.length)) throw new Error(`Conflicting Pi ${part.kind} completion`);
  return publicContent(part, content);
}

export type PiRequestObserver=(request:{model:Model<Api>;context:Context;options:SimpleStreamOptions})=>void|((usage:Usage)=>void);

function providerFailure(model: Model<Api>, source: unknown): APICallError {
  const message: AssistantMessage = source && typeof source === 'object' && 'stopReason' in source
    ? source as AssistantMessage
    : { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], usage: emptyUsage(), stopReason: 'error', timestamp: Date.now(), errorMessage: source instanceof Error ? source.message : '' };
  const overflow = isContextOverflow(message);
  const retryable = !overflow && isRetryableAssistantError(message);
  const prefix = /^(?:Error:\s*)?(401|403|404|408|429|5\d\d)\b/.exec(message.errorMessage ?? '');
  const statusCode = APICallError.isInstance(source) ? source.statusCode : prefix ? Number(prefix[1]) : undefined;
  // Keep the recovery classification, not provider response bodies or embedded credentials.
  return new APICallError({ message: overflow ? 'Pi provider error: context_length_exceeded' : retryable ? 'Pi provider error: temporarily_unavailable' : 'Pi provider error', url: 'pi-provider', requestBodyValues: undefined, isRetryable: retryable, statusCode });
}

/** The registry remains responsible for provider selection and authentication. */
export function createPiLanguageModel(models: Pick<Models, 'streamSimple'>, model: Model<Api>, observer?:PiRequestObserver): LanguageModelV4 {
  async function doStream(options: LanguageModelV4CallOptions, onContent?: (content: LanguageModelV4Content[]) => void) {
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
        // A tool's final ID can arrive at toolcall_end. Keep later block starts
        // behind that slot until its input is known, while already opened text
        // and reasoning continue streaming. Completion order is not content order.
        const publication = new Map<number, { ready: boolean; parts: LanguageModelV4StreamPart[] }>();
        let nextPublication = 0;
        const publish = (index: number, parts: LanguageModelV4StreamPart[], ready = false) => {
          if (index < nextPublication) { for (const part of parts) emit(part); return; }
          const slot = publication.get(index) ?? { ready: false, parts: [] };
          slot.parts.push(...parts); slot.ready ||= ready; publication.set(index, slot);
          while (publication.get(nextPublication)?.ready) {
            const current = publication.get(nextPublication)!;
            publication.delete(nextPublication++);
            for (const part of current.parts) emit(part);
          }
        };
        const toolInputMetadata = (index: number) => ({ mastra: { toolCallInputId: `pi-content:${index}` } });
        let rejectAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(abort.signal.reason ?? abortError());
          abort.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        try {
          abort.signal.throwIfAborted();
          emit({ type: 'stream-start', warnings: [] });
          try { iterator = models.streamSimple(model, context, settings)[Symbol.asyncIterator](); }
          catch (error) { throw providerFailure(model, error); }
          let finished = false;
          const active = new Map<number, StreamBlock>();
          const completed = new Map<number, CompletedBlock>();
          while (true) {
            abort.signal.throwIfAborted();
            const next = await Promise.race([iterator.next().catch(error => { throw providerFailure(model, error); }), aborted]);
            abort.signal.throwIfAborted();
            if (next.done) break;
            const event = next.value;
            if (event.type === 'start') {
              emit({ type: 'response-metadata', id: event.partial.responseId, modelId: event.partial.responseModel, timestamp: new Date(event.partial.timestamp) });
            } else if (event.type === 'text_start' || event.type === 'thinking_start' || event.type === 'toolcall_start') {
              const kind = event.type === 'text_start' ? 'text' : event.type === 'thinking_start' ? 'reasoning' : 'tool';
              if (!Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0) throw new Error('Invalid Pi content index');
              if (active.has(event.contentIndex) || completed.has(event.contentIndex)) throw new Error('Duplicate Pi content start');
              const block = event.partial.content[event.contentIndex];
              if (!block || (kind === 'text' && block.type !== 'text') || (kind === 'reasoning' && block.type !== 'thinking') || (kind === 'tool' && block.type !== 'toolCall')) throw new Error('Invalid Pi content start');
              const id = kind === 'tool' && block.type === 'toolCall' ? block.id : String(event.contentIndex);
              const opaque = block.type === 'thinking' && block.redacted === true;
              const initial = block.type === 'text' ? block.text : block.type === 'thinking' && !opaque ? block.thinking : '';
              const part: StreamBlock = { kind, id, initial, deltas: '', emitted: '', opaque, summarySeparator: kind === 'reasoning' && isResponsesApi(model.api) };
              part.emitted = streamingContent(part, initial);
              active.set(event.contentIndex, part);
              if (kind === 'tool') publish(event.contentIndex, []);
              else publish(event.contentIndex, [
                { type: kind === 'text' ? 'text-start' : 'reasoning-start', id },
                // Empty spans still occupy their original position in native
                // history. Opaque reasoning never publishes its private bytes.
                { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id, delta: part.emitted },
              ], true);
            } else if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
              const part = active.get(event.contentIndex);
              const kind = event.type === 'text_delta' ? 'text' : event.type === 'thinking_delta' ? 'reasoning' : 'tool';
              if (!part || part.kind !== kind) throw new Error('Invalid Pi content delta');
              // Pi may start with provider-specific pre-populated arguments; emit authoritative JSON at end.
              if (kind === 'text' || (kind === 'reasoning' && !part.opaque)) {
                part.deltas += event.delta;
                const block = event.partial.content[event.contentIndex];
                if (!block || (kind === 'text' && block.type !== 'text') || (kind === 'reasoning' && block.type !== 'thinking')) throw new Error('Invalid Pi content delta');
                if (block.type === 'thinking' && part.opaque !== (block.redacted === true)) throw new Error('Conflicting Pi reasoning visibility');
                const current = streamingContent(part, block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '');
                // Authoritative partial text grows monotonically. Shared mutable
                // partials may be ahead of this event; stale prefixes add nothing.
                if (!part.emitted.startsWith(current)) {
                  const delta = publicContent(part, current);
                  if (delta) publish(event.contentIndex, [{ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: part.id, delta }]);
                }
              }
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
                const providerMetadata = toolInputMetadata(event.contentIndex);
                publish(event.contentIndex, [
                  { type: 'tool-input-start', id: part.id, toolName: call.name, providerMetadata },
                  { type: 'tool-input-delta', id: part.id, delta: input, providerMetadata },
                  { type: 'tool-input-end', id: part.id, providerMetadata },
                ], true);
                completed.set(event.contentIndex, { part, content: input, tool: structuredClone(call) });
              } else {
                const block = event.partial.content[event.contentIndex];
                if (event.type === 'text_end' && block?.type === 'text') {
                  const suffix = completePublicContent(part, event.content);
                  if (suffix) publish(event.contentIndex, [{ type: 'text-delta', id: part.id, delta: suffix }]);
                  completed.set(event.contentIndex, { part, content: event.content });
                } else if (event.type === 'thinking_end' && block?.type === 'thinking') {
                  if (part.opaque !== (block.redacted === true)) throw new Error('Conflicting Pi reasoning visibility');
                  if (!part.opaque) {
                    const suffix = completePublicContent(part, event.content);
                    if (suffix) publish(event.contentIndex, [{ type: 'reasoning-delta', id: part.id, delta: suffix }]);
                  }
                  completed.set(event.contentIndex, { part, content: part.opaque ? '' : event.content });
                } else throw new Error('Unsupported Pi content end');
              }
            } else if (event.type === 'error') {
              if (event.reason === 'aborted') throw abortError();
              throw providerFailure(model, event.error);
            } else if (event.type === 'done') {
              if (event.reason === 'deferred') throw new Error('Unsupported Pi deferred response');
              if (active.size) throw new Error('Pi stream ended with open content');
              if (completed.size !== event.message.content.length) throw new Error('Conflicting Pi final content');
              // Only the terminal message is authoritative for replay metadata. In
              // particular Responses can backfill encrypted reasoning after thinking_end.
              const finalized = new Map<number, LanguageModelV4StreamPart>();
              const finalContent: LanguageModelV4Content[] = [];
              for (let index = 0; index < event.message.content.length; index++) {
                const complete = completed.get(index);
                if (!complete) throw new Error('Missing Pi final content');
                const { part, content, tool } = complete;
                const block = event.message.content[index];
                if (part.kind === 'text' && block?.type === 'text') {
                  if (block.text !== content) throw new Error('Conflicting Pi final text');
                  const providerMetadata = historyMetadata(event.message, { textSignature: block.textSignature });
                  finalized.set(index, { type: 'text-end', id: part.id, providerMetadata });
                  finalContent.push({ type: 'text', text: content, providerMetadata });
                } else if (part.kind === 'reasoning' && block?.type === 'thinking') {
                  if (part.opaque !== (block.redacted === true)) throw new Error('Conflicting Pi reasoning visibility');
                  if (!part.opaque && block.thinking !== content) throw new Error('Conflicting Pi final reasoning');
                  const providerMetadata = historyMetadata(event.message, { thinkingSignature: block.thinkingSignature, ...(part.opaque ? { redacted: true } : {}) });
                  finalized.set(index, { type: 'reasoning-end', id: part.id, providerMetadata });
                  finalContent.push({ type: 'reasoning', text: content, providerMetadata });
                } else if (part.kind === 'tool' && block?.type === 'toolCall' && tool) {
                  if (block.id !== tool.id || block.name !== tool.name || JSON.stringify(block.arguments) !== content || block.namespace || block.argumentsError) throw new Error('Conflicting Pi final tool call');
                  const output = { type: 'tool-call' as const, toolCallId: block.id, toolName: block.name, input: content, providerMetadata: { ...historyMetadata(event.message, { thoughtSignature: block.thoughtSignature }), ...toolInputMetadata(index) } };
                  finalized.set(index, output);
                  finalContent.push(output);
                } else throw new Error('Conflicting Pi final content');
              }
              if (publication.size || nextPublication !== event.message.content.length) throw new Error('Unpublished Pi content');
              onContent?.(finalContent);
              for (let index = 0; index < event.message.content.length; index++) {
                const output = finalized.get(index);
                if (!output) throw new Error('Missing Pi final content');
                emit(output);
              }
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
      let content: LanguageModelV4Content[] | undefined;
      const { stream } = await doStream(options, value => { content = value; });
      let finish: Extract<LanguageModelV4StreamPart, { type: 'finish' }> | undefined;
      let response: { id?: string; modelId?: string; timestamp?: Date } | undefined;
      for await (const part of stream) {
        if (part.type === 'finish') finish = part;
        else if (part.type === 'response-metadata') response = part;
        else if (part.type === 'error') throw part.error;
      }
      if (!finish || !content) throw new Error('Pi stream ended without completion');
      return { content, finishReason: finish.finishReason, usage: finish.usage, warnings: [], response };
    },
  };
}

function abortError(message = 'The operation was aborted'): Error { const error = new Error(message); error.name = 'AbortError'; return error; }
function historyMetadata(message: Pick<AssistantMessage, 'api' | 'provider' | 'model'>, values: Omit<PiHistoryMetadata, 'provenance'>) {
  const pi = { provenance: { api: message.api, provider: message.provider, model: message.model }, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) };
  // Mastra keeps reasoning-only turns only when native replay identity is present.
  // Mirror actual terminal identity, while Pi retains the complete item/provenance
  // for its own same-model replay. Do not substitute JSON for encrypted content.
  const anthropic = message.api === 'anthropic-messages' && values.thinkingSignature !== undefined
    ? { [values.redacted ? 'redactedData' : 'signature']: values.thinkingSignature } : undefined;
  const responses = responsesReplayMetadata(message.api, values.thinkingSignature);
  return { pi, ...(anthropic ? { anthropic } : {}), ...(responses ? { [responses.namespace]: responses.value } : {}) };
}
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
function readHistoryMetadata(options: unknown, key?: 'textSignature' | 'thinkingSignature' | 'thoughtSignature'): PiHistoryMetadata {
  const obj = metadataOptions(options);
  // Other namespaces describe historical SDK output, not options for this request.
  if (obj.pi === undefined) return {};
  if (!obj.pi || typeof obj.pi !== 'object' || Array.isArray(obj.pi)) throw new Error('Unsupported Pi provider options');
  const pi = obj.pi as Record<string, unknown>;
  if (Object.keys(pi).some(k => k !== 'provenance' && k !== key && !(key === 'thinkingSignature' && k === 'redacted'))
    || (key && pi[key] !== undefined && typeof pi[key] !== 'string')
    || (pi.redacted !== undefined && typeof pi.redacted !== 'boolean')) throw new Error('Unsupported Pi provider options');
  if (pi.provenance !== undefined) {
    const origin = pi.provenance;
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) throw new Error('Unsupported Pi provenance');
    const fields = origin as Record<string, unknown>;
    if (Object.keys(fields).some(k => !['api', 'provider', 'model'].includes(k))
      || ['api', 'provider', 'model'].some(k => typeof fields[k] !== 'string' || !fields[k])) throw new Error('Unsupported Pi provenance');
  }
  if (pi.redacted === true && (typeof pi.thinkingSignature !== 'string' || !pi.thinkingSignature)) throw new Error('Unsupported Pi redacted reasoning metadata');
  return pi as PiHistoryMetadata;
}
function noOptions(options: unknown) { if (Object.keys(metadataOptions(options)).some(k => k !== 'mastra')) throw new Error('Unsupported provider options'); }
function historyOnly(options: unknown) { readHistoryMetadata(options); }
function readToolResultMetadata(options: unknown): { isError?: boolean } {
  const obj = metadataOptions(options);
  if (obj.pi === undefined) { readHistoryMetadata(options, 'thoughtSignature'); return {}; }
  if (!obj.pi || typeof obj.pi !== 'object' || Array.isArray(obj.pi)) throw new Error('Unsupported Pi provider options');
  const pi = obj.pi as Record<string, unknown>;
  if (pi.isError !== undefined && typeof pi.isError !== 'boolean') throw new Error('Unsupported Pi tool result metadata');
  readHistoryMetadata({ ...obj, pi: Object.fromEntries(Object.entries(pi).filter(([key]) => key !== 'isError')) }, 'thoughtSignature');
  return { isError: pi.isError as boolean | undefined };
}
export function piToolResultMetadata(isError: boolean) { return { pi: { isError } }; }
function usage(value: Usage): LanguageModelV4Usage {
  return { inputTokens: { total: value.input + value.cacheRead + value.cacheWrite, noCache: value.input, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite }, outputTokens: { total: value.output, reasoning: value.reasoning, text: value.reasoning === undefined ? undefined : value.output - value.reasoning } };
}
function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function convertOptions(options: LanguageModelV4CallOptions): SimpleStreamOptions {
  for (const key of ['stopSequences', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'includeRawChunks'] as const) if (options[key] !== undefined && options[key] !== false) throw new Error(`Unsupported option: ${key}`);
  if (options.responseFormat && options.responseFormat.type !== 'text') throw new Error('Unsupported response format');
  let reasoning: SimpleStreamOptions['reasoning'];
  const sessionOptions: Pick<SimpleStreamOptions, 'sessionId' | 'cacheRetention' | 'transport' | 'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs'> = {};
  if (options.providerOptions && Object.keys(options.providerOptions).length) {
    const providers = options.providerOptions;
    const allowed = ['reasoning', 'sessionId', 'cacheRetention', 'transport', 'timeoutMs', 'maxRetries', 'maxRetryDelayMs'];
    if (Object.keys(providers).some(key => key !== 'pi') || !providers.pi || typeof providers.pi !== 'object' || Array.isArray(providers.pi) || Object.keys(providers.pi).some(key => !allowed.includes(key))) throw new Error('Unsupported provider options');
    const value = providers.pi.reasoning;
    if (value !== undefined) {
      if (typeof value !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('Unsupported Pi reasoning');
      reasoning = value as SimpleStreamOptions['reasoning'];
    }
    const pi = providers.pi;
    if (pi.sessionId !== undefined) {
      if (typeof pi.sessionId !== 'string' || !pi.sessionId.trim() || pi.sessionId.length > 200 || /[\x00-\x1f\x7f]/.test(pi.sessionId)) throw new Error('Invalid Pi session ID');
      sessionOptions.sessionId = pi.sessionId;
    }
    if (pi.cacheRetention !== undefined) {
      if (typeof pi.cacheRetention !== 'string' || !['none', 'short', 'long'].includes(pi.cacheRetention)) throw new Error('Invalid Pi cache retention');
      sessionOptions.cacheRetention = pi.cacheRetention as SimpleStreamOptions['cacheRetention'];
    }
    if (pi.transport !== undefined) {
      if (typeof pi.transport !== 'string' || !['sse', 'websocket', 'websocket-cached', 'auto'].includes(pi.transport)) throw new Error('Invalid Pi transport');
      sessionOptions.transport = pi.transport as SimpleStreamOptions['transport'];
    }
    for (const key of ['timeoutMs', 'maxRetries', 'maxRetryDelayMs'] as const) {
      const value = pi[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'timeoutMs' ? 1 : 0)) throw new Error(`Invalid Pi ${key}`);
      sessionOptions[key] = value;
    }
  }
  if (options.toolChoice && options.toolChoice.type !== 'auto' && options.toolChoice.type !== 'none') throw new Error('Unsupported tool choice');
  if (options.reasoning && options.reasoning !== 'provider-default') throw new Error('Unsupported reasoning setting');
  return { ...sessionOptions, reasoning, maxTokens: options.maxOutputTokens, temperature: options.temperature, headers: options.headers && Object.fromEntries(Object.entries(options.headers).filter((entry): entry is [string, string] => entry[1] !== undefined)), toolChoice: options.toolChoice?.type };
}
function convertPrompt(options: LanguageModelV4CallOptions, model: Model<Api>, conversion: { transform?: boolean } = {}): Context {
  const messages: Context['messages'] = [];
  const now = Date.now();
  const tools = options.tools?.map(tool => {
    if (tool.type !== 'function' || tool.strict === true || tool.inputExamples !== undefined) throw new Error('Unsupported tool definition');
    noOptions(tool.providerOptions);
    return { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema };
  });
  for (const message of options.prompt) {
    historyOnly(message.providerOptions);
    if (message.role === 'system') messages.push({ role: 'system', content: message.content, timestamp: now });
    else if (message.role === 'user') {
      const content = message.content.flatMap(part => {
        historyOnly(part.providerOptions);
        if (part.type === 'text') return [{ type: 'text' as const, text: part.text }];
        if (part.data.type !== 'data' || !part.mediaType.startsWith('image/') || part.mediaType.endsWith('/*') || !model.input.includes('image')) throw new Error('Unsupported user file');
        return [...(part.filename?[{type:'text' as const,text:`Image attachment ${JSON.stringify(part.filename)}`}]:[]),{ type: 'image' as const, data: typeof part.data.data === 'string' ? part.data.data : Buffer.from(part.data.data).toString('base64'), mimeType: part.mediaType }];
      });
      messages.push({ role: 'user', content, timestamp: now });
    } else if (message.role === 'assistant') {
      let origin = readHistoryMetadata(message.providerOptions).provenance;
      const content: AssistantMessage['content'] = message.content.map(part => {
        const key = part.type === 'text' ? 'textSignature' : part.type === 'reasoning' ? 'thinkingSignature' : part.type === 'tool-call' ? 'thoughtSignature' : undefined;
        const meta = readHistoryMetadata(part.providerOptions, key);
        if (meta.provenance) {
          if (origin && (origin.api !== meta.provenance.api || origin.provider !== meta.provenance.provider || origin.model !== meta.provenance.model)) throw new Error('Conflicting Pi provenance');
          origin = meta.provenance;
        }
        if (part.type === 'text') return { type: 'text', text: part.text, textSignature: meta.textSignature };
        if (part.type === 'reasoning') return { type: 'thinking', thinking: meta.redacted ? '' : part.text, thinkingSignature: meta.thinkingSignature, ...(meta.redacted ? { redacted: true } : {}) };
        if (part.type === 'tool-call') {
          if (part.providerExecuted || !part.input || typeof part.input !== 'object' || Array.isArray(part.input)) throw new Error('Unsupported tool call input');
          const serialized = JSON.stringify(part.input);
          if (!serialized) throw new Error('Invalid tool call input');
          return { type: 'toolCall', id: part.toolCallId, name: part.toolName, arguments: JSON.parse(serialized) as JsonObject, thoughtSignature: meta.thoughtSignature };
        }
        throw new Error(`Unsupported assistant content: ${part.type}`);
      });
      // Empty identity denotes unknown legacy provenance, never the current target. Pi then
      // removes untrusted signatures/reasoning using the same cross-model rules as its APIs.
      messages.push({ role: 'assistant', content, ...(origin ?? { api: '', provider: '', model: '' }), usage: emptyUsage(), stopReason: 'stop', timestamp: now });
    } else {
      for (const part of message.content) {
        if (part.type !== 'tool-result') throw new Error('Unsupported tool approval');
        // Mastra carries the originating tool-call metadata onto its tool result.
        const meta = readToolResultMetadata(part.providerOptions); if ('providerOptions' in part.output) historyOnly(part.output.providerOptions);
        const output = part.output;
        const content = output.type === 'execution-denied'
          ? [{ type: 'text' as const, text: output.reason || 'Tool execution was blocked' }]
          : output.type === 'content' ? output.value.map(item => {
          historyOnly(item.providerOptions);
          if (item.type === 'text') return { type: 'text' as const, text: item.text };
          if (item.type !== 'file' || item.data.type !== 'data' || !item.mediaType.startsWith('image/') || item.mediaType.endsWith('/*') || item.filename) throw new Error('Unsupported tool result content');
          return { type: 'image' as const, data: typeof item.data.data === 'string' ? item.data.data : Buffer.from(item.data.data).toString('base64'), mimeType: item.mediaType };
        }) : [{ type: 'text' as const, text: typeof output.value === 'string' && (output.type === 'text' || output.type === 'error-text') ? output.value : JSON.stringify(output.value) }];
        messages.push({ role: 'toolResult', toolCallId: part.toolCallId, toolName: part.toolName, content, isError: meta.isError === true || output.type === 'execution-denied' || output.type === 'error-text' || output.type === 'error-json', timestamp: now });
      }
    }
  }
  return { messages: conversion.transform === false ? messages : transformMessages(messages, model), tools };
}

export { convertPrompt as convertModelPromptToPi, historyMetadata as piHistoryMetadata };
