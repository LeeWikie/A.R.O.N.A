import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOAuthFailure } from '../src/providers/auth-failures.js';

test('OAuth failure classes distinguish service, transport, revoked grants, cancellation and unknown errors', () => {
  for (const failure of [
    new Error('OpenAI Codex token refresh failed (503): synthetic provider body'),
    new Error('OpenAI OAuth token request failed (429): synthetic provider body'),
    Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }),
    { response: { status: 500 } }, { statusCode: 408 }, new DOMException('synthetic timeout', 'TimeoutError'),
  ]) assert.deepEqual(classifyOAuthFailure(new Error('wrapped', { cause: failure })), { code: 'oauth_temporarily_unavailable', retryable: true });
  for (const failure of [new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'), { status: 401 }, { code: 'invalid_grant' }, new Error('consent_required')]) {
    assert.deepEqual(classifyOAuthFailure(failure), { code: 'oauth_authentication_required', retryable: false });
  }
  assert.deepEqual(classifyOAuthFailure(new DOMException('synthetic cancellation', 'AbortError')), { code: 'oauth_cancelled', retryable: false });
  assert.deepEqual(classifyOAuthFailure(new Error('malformed provider response')), { code: 'oauth_failed', retryable: false });
  assert.deepEqual(classifyOAuthFailure(new Error('token refresh failed (503): invalid_grant')), { code: 'oauth_temporarily_unavailable', retryable: true });
});

test('OAuth classification never publishes embedded provider data and tolerates cyclic causes', () => {
  const secret = 'SYNTHETIC-PRIVATE-PROVIDER-DATA';
  const failure = new Error(`token refresh failed (401): ${secret}`);
  Object.defineProperty(failure, 'cause', { value: failure });
  assert.deepEqual(classifyOAuthFailure(failure), { code: 'oauth_authentication_required', retryable: false });
  assert.ok(!JSON.stringify(classifyOAuthFailure(failure)).includes(secret));
  const controller = new AbortController(); controller.abort(new DOMException('late', 'TimeoutError'));
  assert.deepEqual(classifyOAuthFailure(undefined, controller.signal), { code: 'oauth_temporarily_unavailable', retryable: true });
});
