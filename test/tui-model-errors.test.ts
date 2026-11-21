import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { Client } from '../src/client.js';
import { TerminalApp } from '../src/tui/index.js';

const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } as Terminal;

test('model failures have safe actionable messages and never display unknown provider details or contradictory retry advice', async () => {
  const cases = [
    ['model_authentication_failed', /登录失效[\s\S]*\/login/], ['model_access_denied', /无权[\s\S]*账号/], ['model_not_found', /没有这个模型[\s\S]*模型 ID/],
    ['model_rate_limited', /限流[\s\S]*稍后重试/], ['model_quota_exhausted', /额度不足[\s\S]*重复发送不会/], ['model_timeout', /超时[\s\S]*检查网络/], ['model_service_unavailable', /暂时不可用[\s\S]*稍后重试/],
    ['model_protocol_error', /无法安全处理[\s\S]*\/model[\s\S]*接口设置/],
    ['model_thinking_output_capacity',/输出上限不足以容纳思考预算[\s\S]*提高输出上限或降低思考设置/],
  ] as const;
  for (const [code, expected] of cases) {
    const app = new TerminalApp({} as Client, 'main', terminal);
    const ui = app as unknown as { event(value: unknown): void; transcript: { children: Array<{ text?: string }> } };
    try {
      ui.event({ kind: 'error', contextId: 'main', runId: 'fixture', data: { code, retryable: true, message: 'PRIVATE_PROVIDER_BODY' } });
      const shown = ui.transcript.children.map(child => child.text ?? '').join('\n'); assert.match(shown, expected); assert.doesNotMatch(shown, /PRIVATE_PROVIDER_BODY/);
      if (['model_authentication_failed', 'model_access_denied', 'model_not_found', 'model_quota_exhausted', 'model_protocol_error','model_thinking_output_capacity'].includes(code)) assert.doesNotMatch(shown, /暂时性错误，可以直接重发/);
    } finally { await app.stop(); }
  }
  const app = new TerminalApp({} as Client, 'main', terminal), ui = app as unknown as { event(value: unknown): void; transcript: { children: Array<{ text?: string }> } };
  try {
    ui.event({ kind: 'error', contextId: 'main', runId: 'fixture', data: { code: 'PRIVATE_UNKNOWN_ERROR_WITH_CREDENTIAL' } });
    const shown = ui.transcript.children.map(child => child.text ?? '').join('\n'); assert.match(shown, /模型请求未完成/); assert.doesNotMatch(shown, /PRIVATE_UNKNOWN_ERROR/);
  } finally { await app.stop(); }
});

test('a specific error upgrades a generic run-end row in place regardless of event ordering', async () => {
  const ended = { kind: 'run', contextId: 'main', runId: 'fixture', data: { state: 'ended', reason: 'error' } };
  const classified = { kind: 'error', contextId: 'main', runId: 'fixture', data: { code: 'model_authentication_failed', retryable: false } };
  for (const events of [[ended, classified], [classified, ended]]) {
    const app = new TerminalApp({} as Client, 'main', terminal), ui = app as unknown as { event(value: unknown): void; transcript: { children: Array<{ text?: string }> } };
    try {
      for (const event of events) ui.event(event);
      const shown = ui.transcript.children.map(child => child.text ?? '').join('\n'); assert.equal((shown.match(/运行失败：/g) ?? []).length, 1); assert.match(shown, /模型登录失效[\s\S]*\/login/); assert.doesNotMatch(shown, /运行失败：模型请求未完成/);
    } finally { await app.stop(); }
  }
});
