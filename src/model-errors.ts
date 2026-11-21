import { APICallError } from '@ai-sdk/provider';
import { AppError } from './domain.js';

export interface ModelFailure { code: string; retryable: boolean; statusCode?: number }

/** Public recovery hints contain no provider response text, URLs or request data. */
export function modelFailure(error: unknown): ModelFailure {
  const seen = new Set<unknown>();
  let value = error;
  for (let depth = 0; depth < 8 && value && typeof value === 'object' && !seen.has(value); depth++) {
    seen.add(value);
    if(value instanceof AppError && value.code === 'model_thinking_output_capacity')return{code:'model_thinking_output_capacity',retryable:false};
    const item = value as { name?: unknown; code?: unknown; message?: unknown; statusCode?: unknown; status?: unknown; cause?: unknown; data?: unknown };
    if(item.name==='ToolCallIdentityError'&&item.code==='tool_call_identity_ambiguous')return{code:'model_protocol_error',retryable:false};
    if (item.code === 'context_length_exceeded' || item.message === 'Pi provider error: context_length_exceeded') return { code: 'context_capacity_exceeded', retryable: false };
    const status = typeof item.statusCode === 'number' ? item.statusCode : typeof item.status === 'number' ? item.status : undefined;
    let code = item.code;
    if (item.data && typeof item.data === 'object') {
      const data = item.data as { error?: { code?: unknown; type?: unknown } };
      code = data.error?.code ?? data.error?.type ?? code;
    }
    if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return { code: 'model_quota_exhausted', retryable: false, statusCode: status };
    if (code === 'context_length_exceeded') return { code: 'context_capacity_exceeded', retryable: false, statusCode: status };
    if (item.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return { code: 'model_timeout', retryable: true };
    if (status === 401) return { code: 'model_authentication_failed', retryable: false, statusCode: status };
    if (status === 403) return { code: 'model_access_denied', retryable: false, statusCode: status };
    if (status === 404) return { code: 'model_not_found', retryable: false, statusCode: status };
    if (status === 429) return { code: 'model_rate_limited', retryable: APICallError.isInstance(value) ? value.isRetryable : true, statusCode: status };
    if (status === 408 || status === 504) return { code: 'model_timeout', retryable: true, statusCode: status };
    if (status !== undefined && status >= 500 && status <= 599) return { code: 'model_service_unavailable', retryable: true, statusCode: status };
    value = item.cause;
  }
  return { code: 'model_execution_failed', retryable: APICallError.isInstance(error) && error.isRetryable };
}
