import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionRhythm, companionQuietLine, type CompanionClock, type CompanionRhythmHost, type CompanionRhythmState, type CompanionWake } from '../src/companion-rhythm.js';

class Clock implements CompanionClock {
  time = Date.parse('2026-01-01T00:00:00Z'); sequence = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  setTimeout(run: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = ++this.sequence; this.timers.set(id, { at: this.time + delay, run });
    return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>) { this.timers.delete((timer as unknown as { id: number }).id); }
  advance(ms: number) {
    const end = this.time + ms; let turns = 0;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      if (++turns > 10000) throw new Error('timer did not yield');
      this.time = next[1].at; this.timers.delete(next[0]); next[1].run();
    }
    this.time = end;
  }
}
function fixture() {
  const clock = new Clock(), wakes: CompanionWake[] = [], cancelled: number[] = [];
  let state: CompanionRhythmState | null = null, fail = false, errors = 0;
  const host: CompanionRhythmHost = {
    read: () => state && structuredClone(state),
    validateContext(context) { if (!['main', 'other'].includes(context)) throw new Error('unavailable context'); },
    commit(next, options) { if (fail) throw new Error('synthetic persistence failure'); state = structuredClone(next); if (options?.wake) wakes.push(structuredClone(options.wake)); if (options?.cancelRevision !== undefined) cancelled.push(options.cancelRevision); },
    onError() { errors++; },
  };
  const rhythm = new CompanionRhythm(host, clock);
  return { clock, host, rhythm, wakes, cancelled, get state() { return state; }, set fail(value: boolean) { fail = value; }, get errors() { return errors; } };
}

test('the passive default and stop create no wake or execution', () => {
  const f = fixture(); f.rhythm.start(); f.clock.advance(86400000); assert.deepEqual(f.wakes, []); assert.equal(f.rhythm.view().configuration.intervalMinutes, null);
  f.rhythm.configure({ intervalMinutes: 1 }, 0); f.rhythm.stop(); f.clock.advance(86400000); assert.deepEqual(f.wakes, []);
});

test('Cormini baseline/backoff is 1,1,2,4,8 and stays bounded at eight', () => {
  const f = fixture(); f.rhythm.configure({ intervalMinutes: 1 }, 0); f.rhythm.start();
  for (const [index, minutes] of [1, 1, 2, 4, 8, 8, 8].entries()) {
    f.clock.advance(minutes * 60000 - 1); assert.equal(f.wakes.length, index);
    f.clock.advance(1); assert.equal(f.wakes.length, index + 1);
  }
  assert.equal(f.rhythm.view().backoff, 8); f.rhythm.stop();
});

test('new external delivery resets quiet across main conversations without moving an armed deadline or replaying old activity', () => {
  const f = fixture(); f.rhythm.configure({ intervalMinutes: 1 }, 0); f.rhythm.start();
  f.clock.advance(160000); assert.equal(f.wakes.length, 2);
  const due = f.rhythm.view().nextDueAt;
  f.rhythm.noteExternal('other', 10); assert.equal(f.rhythm.view().backoff, 1);
  f.rhythm.noteExternal('main', 12); assert.equal(f.rhythm.view().backoff, 1); assert.equal(f.rhythm.view().nextDueAt, due);
  f.clock.advance(80000); assert.equal(f.wakes.length, 3); assert.equal(f.rhythm.view().backoff, 1);
  const before = f.rhythm.view().lastExternalAt; f.clock.advance(20000); f.rhythm.noteExternal('main', 12); f.rhythm.noteExternal('main', 11); assert.equal(f.rhythm.view().lastExternalAt, before);
  f.rhythm.stop();
});

test('the default follows the latest real user conversation and fixed routing remains available', () => {
  const f = fixture(); f.rhythm.configure({ intervalMinutes: 1 }, 0); f.rhythm.start(); f.clock.advance(60000);
  const original = f.wakes[0]!; f.rhythm.noteExternal('other', 1, f.clock.now(), true);
  assert.equal(f.rhythm.view().effectiveContextId, 'other'); assert.equal(f.rhythm.render(original), null);
  f.clock.advance(60000); assert.equal(f.wakes[1]!.contextId, 'other');
  f.rhythm.noteExternal('main', 2); assert.equal(f.rhythm.view().effectiveContextId, 'other');
  f.rhythm.configure({ target: 'fixed', contextId: 'main', intervalMinutes: 1 }, 1); assert.equal(f.rhythm.view().effectiveContextId, 'main');
  f.rhythm.noteExternal('other', 3, f.clock.now(), true); assert.equal(f.rhythm.view().effectiveContextId, 'main'); f.rhythm.stop();
});

test('wake text is rendered at actual delivery time and the persisted wake never pretends that delivery happened', () => {
  const f = fixture(); f.rhythm.configure({ intervalMinutes: 1 }, 0); f.rhythm.start(); f.clock.advance(60000);
  const wake = structuredClone(f.wakes[0]!); f.clock.advance(15000); f.rhythm.noteExternal('main', 1); f.clock.advance(17000);
  assert.equal(f.rhythm.render(wake), '[system] 已安静 17 秒。'); assert.deepEqual(f.wakes[0], wake);
  f.rhythm.configure({ intervalMinutes: null }, 1); assert.equal(f.rhythm.render(wake), null); assert.deepEqual(f.cancelled, [0, 1]);
  assert.deepEqual(f.wakes[0], wake); f.rhythm.stop();
});

test('hot changes use CAS, revoke old pending wakes and rearm immediately from a disabled policy', () => {
  const f = fixture(); f.rhythm.start(); f.rhythm.configure({ contextId: 'other', intervalMinutes: 2 }, 0);
  assert.throws(() => f.rhythm.configure({ intervalMinutes: 1 }, 0), /companion_revision_changed/);
  assert.throws(() => f.rhythm.configure({ intervalMinutes: 0 }, 1), /invalid_companion_configuration/);
  assert.equal(f.rhythm.view().configuration.contextId, 'other'); f.clock.advance(120000); assert.equal(f.wakes[0]!.contextId, 'other');
  f.rhythm.configure({ contextId: 'other', intervalMinutes: null }, 1); f.clock.advance(86400000); assert.equal(f.wakes.length, 1); f.rhythm.stop();
});

test('restart retains quiet/deadline/backoff and emits only one overdue wake before scheduling forward', () => {
  const f = fixture(); f.rhythm.configure({ intervalMinutes: 1 }, 0); f.rhythm.start(); f.clock.advance(120000); f.rhythm.stop();
  const before = f.rhythm.view(); f.clock.advance(3600000);
  const restarted = new CompanionRhythm(f.host, f.clock); restarted.start(); assert.equal(restarted.view().lastExternalAt, before.lastExternalAt); f.clock.advance(0);
  assert.equal(f.wakes.length, 3); assert.equal(restarted.view().backoff, 4); assert.ok(Date.parse(restarted.view().nextDueAt!) > f.clock.now()); restarted.stop();
});

test('an atomic persistence failure retains the original slot and retries without claiming a wake', () => {
  const f = fixture(); f.rhythm.configure({ intervalMinutes: 1 }, 0); f.rhythm.start(); const due = f.rhythm.view().nextDueAt;
  f.fail = true; f.clock.advance(60000); assert.equal(f.wakes.length, 0); assert.equal(f.rhythm.view().nextDueAt, due); assert.equal(f.errors, 1);
  f.fail = false; f.clock.advance(1000); assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0]!.scheduledAt, due); f.rhythm.stop();
});

test('long intervals never overflow Node timers and quiet text follows the native rounding units', () => {
  const f = fixture(); f.rhythm.configure({ intervalMinutes: 50000 }, 0); f.rhythm.start();
  assert.equal([...f.clock.timers.values()][0]!.at - f.clock.now(), 2147483647); f.clock.advance(3000000000); assert.equal(f.wakes.length, 1); f.rhythm.stop();
  for (const [seconds, expected] of [[0, '0 秒'], [59, '59 秒'], [60, '1 分钟'], [119, '1 分钟'], [2700, '45 分钟']] as const) assert.ok(companionQuietLine(seconds).includes(expected));
});
