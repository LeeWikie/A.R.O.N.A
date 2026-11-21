export interface OAuthFailure {
  code: 'oauth_authentication_required' | 'oauth_temporarily_unavailable' | 'oauth_cancelled' | 'oauth_failed';
  retryable: boolean;
}

/** Classify provider failures without returning their messages, tokens or response bodies. */
export function classifyOAuthFailure(error: unknown, signal?: AbortSignal): OAuthFailure {
  let current = error, temporary = false, authentication = false, cancelled = false;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    const value = typeof current === 'object' ? current as Record<string, unknown> : undefined;
    if (value) { if (seen.has(value)) break; seen.add(value); }
    let message = '', code = '', name = '', status: unknown;
    try {
      message = typeof current === 'string' ? current : typeof value?.message === 'string' ? value.message.slice(0, 65536) : '';
      code = typeof value?.code === 'string' ? value.code : '';
      name = typeof value?.name === 'string' ? value.name : '';
      const response = value?.response;
      status = value?.statusCode ?? value?.status ?? (response && typeof response === 'object' ? (response as { status?: unknown }).status : undefined);
    } catch { break; }
    if (typeof status !== 'number') {
      const match = /\b(?:HTTP|status(?:\s+code)?)\s*[:=(]?\s*([45]\d{2})\b|\b(?:refresh|request|exchange)(?:\s+failed)?\s*\(([45]\d{2})\)/i.exec(message);
      status = match ? Number(match[1] ?? match[2]) : undefined;
    }
    if (typeof status === 'number') {
      if ([408, 425, 429].includes(status) || status >= 500 && status <= 599) temporary = true;
      else if ([400, 401, 403].includes(status)) authentication = true;
    }
    if (/^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)$/.test(code)
      || name === 'TimeoutError' || /\b(?:fetch failed|network (?:error|unavailable)|connection (?:reset|refused)|timed? out|socket hang up)\b/i.test(message)) temporary = true;
    if (/\b(?:invalid_grant|invalid_token|revoked_token|access_denied|unauthorized_client|login_required|consent_required)\b/i.test(message)
      || /^(?:model_authentication_failed|model_access_denied|invalid_grant|invalid_token)$/.test(code)) authentication = true;
    if (name === 'AbortError' || code === 'ABORT_ERR') cancelled = true;
    try { current = value?.cause; } catch { break; }
  }
  if (signal?.aborted && signal.reason?.name === 'TimeoutError') temporary = true;
  else if (signal?.aborted) cancelled = true;
  if (temporary) return { code: 'oauth_temporarily_unavailable', retryable: true };
  if (authentication) return { code: 'oauth_authentication_required', retryable: false };
  if (cancelled) return { code: 'oauth_cancelled', retryable: false };
  return { code: 'oauth_failed', retryable: false };
}
