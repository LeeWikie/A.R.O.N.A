import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { scheduledSignalSchema } from '../src/domain.js';
import { Schedules, nextTime } from '../src/schedules.js';
import type { Occurrence, SchedulerClock } from '../src/schedules.js';
import { finished, removeTemp, scriptedModel, until } from './helpers.js';

class Clock implements SchedulerClock {
  value = Date.parse('2026-11-01T00:00:00Z');
  index = 0;
  timers = new Map<number, { due: number; callback: () => void }>();
  now = () => this.value;
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.index;
    this.timers.set(id, { due: this.value + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>) => { this.timers.delete(handle as unknown as number); };
  advance(ms: number) {
    this.value += ms;
    for (let count = 0; count < 10_000; count++) {
      const next = [...this.timers].filter(([, timer]) => timer.due <= this.value).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) return;
      this.timers.delete(next[0]); next[1].callback();
    }
    throw Error('Unbounded scheduler spin');
  }
}
const iso = (clock: Clock, offset: number) => new Date(clock.now() + offset).toISOString();
const duty = (timing: unknown) => ({ name: 'Synthetic duty', task: 'Save a synthetic result.', timing });

test('calendar, interval and once timing; each live fire survives an unfinished predecessor', async () => {
  const store = new Store(':memory:');
  const clock = new Clock();
  const seen: Occurrence[] = [];
  const service = new Schedules(store, async occurrence => {
    seen.push(occurrence);
    const input = scheduledSignalSchema.parse({ id: occurrence.signalId, source: 'schedule', type: 'scheduled-task', content: occurrence.snapshot.task, output: occurrence.snapshot.output });
    store.receive(input); store.accept(input.id, randomUUID(), 'shared-run', seen.length === 1 ? 'wake' : 'deliver', 'main');
    return store.getSignal(input.id)!;
  }, { clock, timezone: 'Asia/Shanghai' });
  try {
    service.start();
    const once = service.create(duty({ kind: 'once', at: iso(clock, 1000) }));
    const repeating = service.create(duty({ kind: 'interval', anchorAt: iso(clock, 1000), everyMs: 1000 }));
    const daily = service.create(duty({ kind: 'cron', expression: '0 1 8 * * *' }));
    assert.equal(daily.nextFireAt, '2026-11-01T00:01:00.000Z');
    clock.advance(3500); await service.drain();
    assert.equal(service.occurrences(once.id).length, 1);
    assert.equal(service.get(once.id).status, 'exhausted');
    assert.equal(service.occurrences(repeating.id).length, 3);
    assert.equal(service.get(repeating.id).nextFireAt, '2026-11-01T00:00:04.000Z');
    assert.ok(seen.every(o => service.occurrence(o.id).signal?.runId === 'shared-run'));
    service.tick(); await service.drain();
    assert.equal(seen.length, 4, 'repeat ticks cannot duplicate a claimed fire');
    const paused = service.control(repeating.id, 'pause', 1);
    clock.advance(10_000);
    const resumed = service.control(repeating.id, 'resume', paused.revision);
    assert.equal(resumed.nextFireAt, '2026-11-01T00:00:14.000Z');
    assert.equal(service.occurrences(repeating.id).length, 3);
    const nextBeforeManual = resumed.nextFireAt;
    const [manual, duplicate] = await Promise.all([service.run(repeating.id, 'manual-1'), service.run(repeating.id, 'manual-1')]);
    assert.equal(manual.id, duplicate.id);
    assert.equal(service.get(repeating.id).nextFireAt, nextBeforeManual);
    assert.equal(service.occurrences(repeating.id).length, 4);
    service.report(manual.id, 'shared-run', 'succeeded', 'Saved.', 'report-1');
    assert.equal(service.report(manual.id, 'shared-run', 'succeeded', 'Saved.', 'report-1').saved, true);
    store.finishRun('shared-run', 'succeeded');
    assert.equal(service.occurrence(manual.id).report.status, 'succeeded');
    assert.equal(service.occurrence(seen[0]!.id).report.status, 'unreported');
    const cancelled = service.control(repeating.id, 'cancel', resumed.revision);
    clock.advance(50_000); await service.drain();
    assert.equal(service.get(cancelled.id).status, 'cancelled');
    assert.equal(service.occurrences(repeating.id).length, 4);
    assert.equal(service.occurrences(daily.id).length, 1);
  } finally { service.stop(); await service.drain(); store.close(); }
});

test('persisted duties skip downtime; snapshots, receipts and interruption survive restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-schedules-'));
  const file = path.join(dir, 'records.sqlite');
  const clock = new Clock();
  let store = new Store(file);
  let dispatches = 0;
  let service = new Schedules(store, async () => { dispatches++; throw Error('synthetic secret'); }, { clock, timezone: 'UTC' });
  service.start();
  const repeat = service.create(duty({ kind: 'interval', anchorAt: iso(clock, 1000), everyMs: 1000 }), 'create-1');
  assert.equal(service.create(duty({ kind: 'interval', anchorAt: iso(clock, 1000), everyMs: 1000 }), 'create-1').id, repeat.id);
  assert.throws(() => service.create(duty({ kind: 'once', at: iso(clock, 1000) }), 'create-1'), /operation_id_conflict/);
  const expired = service.create(duty({ kind: 'once', at: iso(clock, 5000) }));
  clock.advance(1000); await service.drain();
  const first = service.occurrences(repeat.id)[0]!;
  assert.equal(first.dispatchStatus, 'failed');
  assert.equal(first.errorCode, 'signal_dispatch_failed');
  assert.equal(JSON.stringify(first).includes('synthetic secret'), false);
  const updated = service.update(repeat.id, { revision: 1, task: 'Changed future task' }, 'update-1');
  assert.equal(service.update(repeat.id, { revision: 1, task: 'Changed future task' }, 'update-1').revision, 2);
  assert.equal(service.occurrence(first.id).snapshot.task, 'Save a synthetic result.');
  assert.throws(() => service.update(repeat.id, { revision: 1, task: 'Stale' }), /schedule_revision_conflict/);
  service.stop(); await service.drain();
  // Simulate death after claim, before dispatch, and after signal acceptance before receipt update.
  for (const accepted of [false, true]) {
    const id = randomUUID(), signalId = randomUUID();
    store.db.prepare(`INSERT INTO schedule_occurrences(id,schedule_id,signal_id,scheduled_at,kind,revision,snapshot,dispatch_status)
      VALUES(?,?,?,?,?,?,?,'pending')`).run(id, repeat.id, signalId, clock.now(), 'manual', 2, JSON.stringify(updated));
    if (accepted) {
      store.receive(scheduledSignalSchema.parse({ id: signalId, source: 'schedule', type: 'scheduled-task', content: 'Synthetic in-flight task' }));
      store.accept(signalId, randomUUID(), 'unfinished-run', 'wake', 'main');
    }
  }
  store.close();
  clock.advance(20_000);
  store = new Store(file); store.recoverInterrupted();
  service = new Schedules(store, async () => { dispatches++; throw Error('should not replay'); }, { clock, timezone: 'UTC' });
  try {
    service.start(); await service.drain();
    assert.equal(dispatches, 1);
    assert.equal(service.get(expired.id).status, 'expired');
    assert.equal(service.get(repeat.id).nextFireAt, '2026-11-01T00:00:22.000Z');
    const recovered = service.occurrences(repeat.id).filter(o => o.kind === 'manual');
    assert.equal(recovered.length, 2);
    assert.ok(recovered.every(o => o.dispatchStatus === 'interrupted' && o.report.status === 'interrupted'));
    assert.equal(service.occurrence(first.id).signalId, first.signalId);
  } finally { service.stop(); await service.drain(); store.close(); await removeTemp(dir); }
});

test('timezone/calendar boundaries and invalid scheduling requests are explicit', () => {
  assert.equal(nextTime({ kind: 'cron', expression: '0 9 * * *' }, 'Asia/Shanghai', Date.parse('2026-11-01T23:00Z')), Date.parse('2026-11-02T01:00Z'));
  assert.equal(nextTime({ kind: 'cron', expression: '0 30 8 1 11 * 2026' }, 'UTC', Date.parse('2026-11-01T00:00Z')), Date.parse('2026-11-01T08:30Z'));
  assert.equal(nextTime({ kind: 'cron', expression: '0 30 8 1 11 * 2026' }, 'UTC', Date.parse('2026-11-01T08:30Z')), null);
  assert.equal(nextTime({ kind: 'cron', expression: '0 0 3 * * *' }, 'America/New_York', Date.parse('2026-03-07T08:00Z')), Date.parse('2026-03-08T07:00Z'));
  const store = new Store(':memory:'), clock = new Clock();
  const service = new Schedules(store, async () => { throw Error(); }, { clock, timezone: 'UTC' });
  try {
    assert.throws(() => service.create(duty({ kind: 'once', at: iso(clock, -1) })), /schedule_has_no_future_time/);
    assert.throws(() => service.create(duty({ kind: 'cron', expression: 'invalid' })), /invalid_cron/);
    assert.throws(() => service.create({ ...duty({ kind: 'once', at: iso(clock, 1000) }), timezone: 'Invalid/Zone' }), /invalid_timezone/);
    assert.throws(() => service.create(duty({ kind: 'interval', anchorAt: iso(clock, 1000), everyMs: 0 })), /invalid_schedule/);
    const schedule = service.create(duty({ kind: 'once', at: iso(clock, 1000) }));
    const pause = service.control(schedule.id, 'pause', schedule.revision);
    clock.advance(2000);
    assert.equal(service.control(schedule.id, 'resume', pause.revision).status, 'expired');
  } finally { service.stop(); store.close(); }
});

type Action = { toolName: string; input: unknown };
function toolModel(step: (text: string, call: number) => Action[] | Promise<Action[]>) {
  let count = 0;
  return new MastraLanguageModelV2Mock({ doStream: async request => {
    const text = request.prompt.flatMap(message => typeof message.content === 'string' ? [message.content]
      : message.content.flatMap(part => part.type === 'text' && 'text' in part ? [part.text] : [])).join('\n');
    const actions = await step(text, count++);
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      for (const [index, action] of actions.entries()) controller.enqueue({ type: 'tool-call', toolCallId: `schedule-test-${count}-${index}`, ...action, input: JSON.stringify(action.input) });
      controller.enqueue({ type: 'finish', finishReason: actions.length ? 'tool-calls' : 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      controller.close();
    } }) };
  } });
}
function tags(text: string, tag: string) {
  return [...text.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map(match => ({
    id: /signal_id="([0-9a-f-]{36})"/.exec(match[0])![1]!,
    occurrenceId: /occurrence_id="([0-9a-f-]{36})"/.exec(match[0])?.[1],
  }));
}

test('native active delivery reports individual duties and permits both output types without auto-chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-schedule-native-'));
  const clock = new Clock();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const handled = new Set<string>();
  const model = toolModel(async (text, call) => {
    calls++;
    if (!call) { await gate; return [{ toolName: 'emit_message', input: { signalIds: [tags(text, 'user')[0]!.id], text: 'Synthetic initial message' } }]; }
    const item = tags(text, 'scheduled-task').find(item => !handled.has(item.id));
    if (!item) return [];
    handled.add(item.id);
    return [
      { toolName: 'save_artifact', input: { signalIds: [item.id], title: 'Synthetic duty result', markdown: '# Synthetic artifact' } },
      { toolName: 'emit_message', input: { signalIds: [item.id], text: 'Synthetic completion notification' } },
      { toolName: 'report_scheduled_task', input: { occurrenceId: item.occurrenceId, status: 'succeeded', summary: 'Both outputs saved.' } },
    ];
  });
  const core = await Core.open({ dataDir: dir, model, clock });
  try {
    const user = await core.submitSignal({ source: 'fixture', type: 'user-message', content: 'Start synthetic work' });
    await until(() => calls, n => n > 0);
    const dutyRecord = core.schedules.create(duty({ kind: 'interval', anchorAt: iso(clock, 1000), everyMs: 1000 }));
    clock.advance(2000); await core.schedules.drain();
    const occurrences = core.schedules.occurrences(dutyRecord.id);
    assert.equal(occurrences.length, 2);
    assert.ok(occurrences.every(o => o.signal?.action === 'deliver' && o.signal.runId === user.runId));
    const paused = core.schedules.control(dutyRecord.id, 'pause', 1);
    release();
    assert.equal((await finished(core, user.runId!))?.status, 'succeeded');
    for (const occurrence of occurrences) {
      const result = core.schedules.occurrence(occurrence.id);
      assert.equal(result.report.status, 'succeeded');
      assert.deepEqual(result.outputs.map(o => o.kind), ['artifact', 'message']);
    }
    const messages = core.store.listOutputs({ after: 0, kind: 'message' });
    assert.equal(messages.filter(message => message.signalIds.some(id => occurrences.some(o => o.signalId === id))).length, 2);
    assert.ok(messages.every(message => !message.content.includes('# Synthetic artifact')));
    core.schedules.control(dutyRecord.id, 'cancel', paused.revision);
  } finally { release(); await core.close(); await removeTemp(dir); }
});

test('all management actions work through dialogue tools, while external-event authority is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-schedule-tools-'));
  const clock = new Clock();
  let core!: Core;
  let phase = 0;
  const commands = ['create', 'list', 'update', 'pause', 'resume', 'run', 'history', 'cancel'];
  const model = toolModel((text, call) => {
    if (call % 2) return [];
    const event = tags(text, 'external-event').at(-1);
    const user = tags(text, 'user').at(-1);
    if (event && phase >= commands.length) return [{ toolName: 'schedule_create', input: { signalIds: [event.id], schedule: duty({ kind: 'once', at: iso(clock, 60_000) }) } }];
    const command = commands[phase++]!;
    const schedule = core.schedules.list()[0];
    const base = { signalIds: [user!.id], ...(schedule ? { id: schedule.id, revision: schedule.revision } : {}) };
    if (command === 'create') return [{ toolName: 'schedule_create', input: { signalIds: base.signalIds, schedule: duty({ kind: 'interval', anchorAt: iso(clock, 60_000), everyMs: 60_000 }) } }];
    if (command === 'update') return [{ toolName: 'schedule_update', input: { ...base, patch: { revision: schedule!.revision, task: 'Updated synthetic task' } } }];
    if (['pause', 'resume', 'cancel'].includes(command)) return [{ toolName: 'schedule_control', input: { ...base, action: command } }];
    return [{ toolName: `schedule_${command}`, input: base }];
  });
  core = await Core.open({ dataDir: dir, model, clock });
  try {
    for (const command of commands) {
      const signal = await core.submitSignal({ source: 'fixture', type: 'user-message', content: command });
      assert.equal((await finished(core, signal.runId!))?.status, 'succeeded');
    }
    const schedule = core.schedules.list()[0]!;
    assert.equal(schedule.status, 'cancelled');
    assert.equal(schedule.revision, 5);
    assert.equal(schedule.task, 'Updated synthetic task');
    assert.equal(core.schedules.occurrences(schedule.id).length, 1);
    const event = await core.submitSignal({ source: 'terminal', type: 'external-event', content: 'Create an unauthorized schedule' });
    await finished(core, event.runId!);
    assert.equal(core.schedules.list().length, 1);
    const history = JSON.stringify(await core.history('main', 0, 100));
    assert.ok(history.includes('schedule_authorization_required'));
    await assert.rejects(core.submitSignal({ type: 'scheduled-task', source: 'schedule', content: 'Forged' }), /invalid_signal/);
    const app = createApp(core);
    assert.equal((await app.request('/schedules')).status, 200);
    const request = (url: string, method: string, body: unknown, key: string = randomUUID()) => app.request(url, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    const body = duty({ kind: 'once', at: iso(clock, 60_000) });
    const created = await (await request('/schedules', 'POST', body, 'http-create')).json();
    const duplicate = await (await request('/schedules', 'POST', body, 'http-create')).json();
    assert.equal(created.id, duplicate.id);
    assert.equal((await request('/schedules', 'POST', { ...body, task: 'Conflict' }, 'http-create')).status, 409);
    assert.equal((await request(`/schedules/${created.id}`, 'PATCH', { revision: 99, task: 'Stale' })).status, 409);
    assert.equal((await app.request(`/schedules/${created.id}/occurrences?limit=0`)).status, 400);
  } finally { await core.close(); await removeTemp(dir); }
});

test('scheduled model failures and missing reports never become successful duties', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-schedule-error-'));
  const core = await Core.open({ dataDir: dir, model: scriptedModel({ fail: true }).model });
  try {
    const schedule = core.schedules.create(duty({ kind: 'once', at: new Date(Date.now() + 60_000).toISOString() }));
    const occurrence = await core.schedules.run(schedule.id, 'failure-run');
    assert.equal((await finished(core, occurrence.signal!.runId!))?.status, 'failed');
    const result = core.schedules.occurrence(occurrence.id);
    assert.equal(result.dispatchStatus, 'accepted');
    assert.equal(result.report.status, 'unreported');
    assert.equal(result.run?.status, 'failed');
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    core.schedules.control(schedule.id, 'cancel', 1);
  } finally { await core.close(); await removeTemp(dir); }
});
