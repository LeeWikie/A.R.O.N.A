import { createModel } from './model.js';
import { z } from 'zod';
import { AppError } from './domain.js';
import type { Credentials } from './credentials.js';

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 1000;
const draftSchema = z.object({
  protocol: z.enum(['chat-completions', 'responses', 'messages']),
  baseURL: z.url().max(2048).refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !/[?#\\\s]/.test(value);
  }),
  modelId: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200).optional(),
  apiKey: z.string().min(1).max(64_000).refine(value => !/[\r\n]/.test(value)).optional(),
  authHeader: z.enum(['api-key', 'bearer']).default('api-key'),
  requestAuth: z.enum(['api-key', 'bearer']).optional(),
}).strict();

type Draft = z.infer<typeof draftSchema>;
type CredentialReader = Pick<Credentials, 'get'>;
export interface CatalogModel { id: string; name?: string; contextWindow?: number; inputImages?: boolean }
export interface ModelTestResult { ok: boolean; detail: string; checkedAt: number }

function resolveDraft(input: unknown, credentials: CredentialReader) {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new AppError('invalid_model_probe');
  const draft = parsed.data;
  let apiKey = draft.apiKey;
  if (apiKey === undefined && draft.apiKeyEnv) {
    try { apiKey = credentials.get(draft.apiKeyEnv); }
    catch { throw new AppError('model_credentials_unavailable'); }
  }
  if (!apiKey) throw new AppError('model_credentials_unavailable');
  if (apiKey.length > 64_000 || /[\r\n]/.test(apiKey)) throw new AppError('invalid_model_probe');
  return { draft: { ...draft, baseURL: draft.baseURL.replace(/\/+$/, '') }, apiKey };
}

function probeSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function failure(error: unknown, signal: AbortSignal): AppError {
  if (signal.aborted) return new AppError(signal.reason?.name === 'TimeoutError' ? 'model_probe_timeout' : 'model_probe_cancelled', 504);
  return error instanceof AppError ? error : new AppError('model_probe_failed', 502);
}

// 先限量读完响应，再交给 SDK；错误响应和重定向不交出原始内容。
function boundedFetch(signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AppError('model_probe_redirect_rejected', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(`model_probe_http_${response.status}`, 502);
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new AppError('model_probe_response_too_large', 502);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new AppError('model_probe_response_too_large', 502);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    return new Response(Buffer.concat(chunks, size), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
}

function catalogHeaders(draft: Draft, apiKey: string): Record<string, string> {
  const scheme=draft.requestAuth??(draft.protocol==='messages'?draft.authHeader:'bearer');
  if (draft.protocol === 'messages') {
    return { 'anthropic-version': '2023-06-01', ...(scheme === 'bearer'
      ? { authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey }) };
  }
  return scheme==='api-key'?{'api-key':apiKey}:{authorization:`Bearer ${apiKey}`};
}

function catalogEntry(value: unknown, apiKey: string): CatalogModel | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const safeText = (text: unknown, max: number): text is string => typeof text === 'string'
    && text.trim().length > 0 && text.length <= max && !/[\x00-\x1f\x7f]/.test(text) && !text.includes(apiKey);
  if (!safeText(row.id, 200)) return;
  const model: CatalogModel = { id: row.id };
  const name = row.display_name ?? row.name;
  if (safeText(name, 160)) model.name = name;
  const contextWindow = row.context_window ?? row.contextWindow;
  if (typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0) model.contextWindow = contextWindow;
  const inputImages = row.input_images ?? row.inputImages;
  if (typeof inputImages === 'boolean') model.inputImages = inputImages;
  else if (Array.isArray(row.input) && row.input.every(item => typeof item === 'string')) model.inputImages = row.input.includes('image');
  return model;
}

export async function modelCatalog(input: unknown, credentials: CredentialReader, signal?: AbortSignal): Promise<{ models: CatalogModel[] }> {
  const { draft, apiKey } = resolveDraft(input, credentials);
  const abortSignal = probeSignal(signal);
  const request = boundedFetch(abortSignal);
  const models = new Map<string, CatalogModel>();
  let after: string | undefined;
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${draft.baseURL}/models`);
      if (draft.protocol === 'messages') {
        url.searchParams.set('limit', '100');
        if (after) url.searchParams.set('after_id', after);
      }
      const response = await request(url, { headers: catalogHeaders(draft, apiKey) });
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new AppError('model_catalog_invalid_response', 502); }
      if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) throw new AppError('model_catalog_invalid_response', 502);
      for (const row of body.data) {
        const model = catalogEntry(row, apiKey);
        if (model) models.set(model.id, model);
        if (models.size > MAX_MODELS) throw new AppError('model_catalog_too_large', 502);
      }
      if (!('has_more' in body) || body.has_more !== true) {
        if (!models.size) throw new AppError('model_catalog_empty', 422);
        return { models: [...models.values()] };
      }
      if (draft.protocol !== 'messages' || !('last_id' in body) || typeof body.last_id !== 'string'
        || !body.last_id || body.last_id.length > 200 || cursors.has(body.last_id) || body.last_id.includes(apiKey)) throw new AppError('model_catalog_invalid_response', 502);
      after = body.last_id;
      cursors.add(after);
    }
    throw new AppError('model_catalog_too_large', 502);
  } catch (error) { throw failure(error, abortSignal); }
}

export async function testModel(input: unknown, credentials: CredentialReader, signal?: AbortSignal): Promise<ModelTestResult> {
  const { draft, apiKey } = resolveDraft(input, credentials);
  if (!draft.modelId) throw new AppError('model_probe_model_required');
  const abortSignal = probeSignal(signal);
  const request = boundedFetch(abortSignal);
  try {
    const model = createModel({ ...draft, modelId:draft.modelId, apiKey },request);
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }],
      maxOutputTokens: 16,
      abortSignal,
      ...(draft.protocol === 'responses' ? { providerOptions: { openai: { store: false } } } : {}),
    });
    const ok = result.finishReason.unified !== 'error' && result.finishReason.unified !== 'content-filter'
      && result.content.some(part => part.type === 'text' && part.text.trim().length > 0);
    return { ok, detail: ok ? '最小文本生成试测成功（最多 16 个输出 token，可能产生少量费用）。'
      : '最小文本生成试测未获得有效文本（最多 16 个输出 token，可能产生少量费用）。', checkedAt: Date.now() };
  } catch (error) {
    const code = failure(error, abortSignal).code;
    return { ok: false, detail: `最小文本生成试测失败：${code}（最多 16 个输出 token，可能产生少量费用）。`, checkedAt: Date.now() };
  }
}
