import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from '@ai-sdk/provider';
import { modelFailure } from '../src/model-errors.js';
import { AppError } from '../src/domain.js';

test('a local thinking capacity failure is actionable without automatic retry',()=>{
 const error=new AppError('model_thinking_output_capacity',409);
 assert.deepEqual(modelFailure(new Error('wrapper',{cause:error})),{code:'model_thinking_output_capacity',retryable:false});
 assert.deepEqual(modelFailure({code:'model_thinking_output_capacity',data:{private:'synthetic-private'}}),{code:'model_execution_failed',retryable:false});
});

test('provider recovery categories survive wrapped SDK failures without exposing private payloads', () => {
  for (const [statusCode, expected, retryable] of [[401, 'model_authentication_failed', false], [403, 'model_access_denied', false], [404, 'model_not_found', false], [429, 'model_rate_limited', true], [500, 'model_service_unavailable', true], [504, 'model_timeout', true]] as const) {
    const upstream = new APICallError({ statusCode, message: 'private response', url: 'https://private.invalid/?token=private', requestBodyValues: { private: true }, responseBody: 'private response', isRetryable: retryable });
    assert.deepEqual(modelFailure(new Error('wrapper', { cause: upstream })), { code: expected, retryable, statusCode });
    assert.equal(JSON.stringify(modelFailure(upstream)).includes('private'), false);
  }
});

test('quota exhaustion is not retryable and cyclic unknown errors remain bounded', () => {
  const upstream = new APICallError({ statusCode: 429, message: 'private', url: 'private', requestBodyValues: undefined, data: { error: { code: 'insufficient_quota' } }, isRetryable: false });
  assert.deepEqual(modelFailure(upstream), { code: 'model_quota_exhausted', retryable: false, statusCode: 429 });
  assert.deepEqual(modelFailure(new Error('Pi provider error: context_length_exceeded')), { code: 'context_capacity_exceeded', retryable: false });
  const unknown: { cause?: unknown } = {}; unknown.cause = unknown;
  assert.deepEqual(modelFailure(unknown), { code: 'model_execution_failed', retryable: false });
});

test('ambiguous native tool identity has a safe non-retryable protocol failure through cause wrappers',()=>{
  const ambiguous=Object.assign(new Error('private tool arguments and URL'),{name:'ToolCallIdentityError',code:'tool_call_identity_ambiguous'});
  for(const error of [ambiguous,new Error('private wrapper',{cause:ambiguous})])assert.deepEqual(modelFailure(error),{code:'model_protocol_error',retryable:false});
  const upstream=new APICallError({statusCode:503,message:'private provider text',url:'https://private.invalid',requestBodyValues:undefined,data:{error:{code:'tool_call_identity_ambiguous'}},isRetryable:true});
  assert.deepEqual(modelFailure(upstream),{code:'model_service_unavailable',retryable:true,statusCode:503});
});
