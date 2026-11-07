import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Cron } from 'croner';
import { z } from 'zod';
import { AppError, contextIdSchema } from './domain.js';
import type { SignalRecord, OutputRecord } from './domain.js';
import type { Store } from './store.js';

const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const timingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: instant }).strict(),
  z.object({ kind: z.literal('interval'), anchorAt: instant, everyMs: z.number().int().min(1000).max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(256) }).strict(),
]);
const fields = {
  name: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(64_000),
  timing: timingSchema,
  timezone: z.string().min(1).max(128),
  contextId: contextIdSchema,
  output: z.object({ kind: z.enum(['message', 'artifact', 'both', 'none']), contextId: contextIdSchema.optional() }).strict(),
};
export const createScheduleSchema = z.object({
  ...fields, version: z.literal(2).optional(), timezone: fields.timezone.optional(), contextId: fields.contextId.default('main'), output: fields.output.optional(),
}).strict();
export const updateScheduleSchema = z.object(fields).partial().extend({
  revision: z.number().int().positive(),
}).strict();

export type Timing = z.infer<typeof timingSchema>;
export type ScheduleStatus = 'active' | 'paused' | 'cancelled' | 'exhausted' | 'expired';
export interface Schedule {
  version?: 2; id: string; name: string; task: string; timing: Timing; timezone: string; contextId: string;
  output: { kind: 'message' | 'artifact' | 'both' | 'none'; contextId: string };
  status: ScheduleStatus; revision: number; nextFireAt: string | null; createdAt: string; updatedAt: string;
}
export interface Occurrence {
  id: string; scheduleId: string; signalId: string; scheduledAt: string; kind: 'automatic' | 'manual';
  snapshot: Schedule; dispatchStatus: 'pending' | 'queued' | 'accepted' | 'failed' | 'interrupted'; errorCode: string | null;
  report: { status: 'pending' | 'succeeded' | 'failed' | 'unreported' | 'interrupted' | 'blocked' | 'cancelled'; summary: string | null };
  signal?: SignalRecord; run: ReturnType<Store['getRun']> | null; outputs: OutputRecord[];
}
export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
const realClock: SchedulerClock = { now: Date.now, setTimeout, clearTimeout };
type Row = Record<string, unknown>;
export function validateTimezone(timezone: string) {
  try {
    if (/^[+-]/.test(timezone)) throw new Error('IANA timezone required');
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  }
  catch { throw new AppError('invalid_timezone'); }
  return timezone;
}

export function nextTime(timing: Timing, timezone: string, after: number): number | null {
  if (timing.kind === 'once') return Date.parse(timing.at) > after ? Date.parse(timing.at) : null;
  if (timing.kind === 'interval') {
    const anchor = Date.parse(timing.anchorAt);
    const next = anchor + Math.max(0, Math.floor((after - anchor) / timing.everyMs) + 1) * timing.everyMs;
    if (!Number.isSafeInteger(next) || !Number.isFinite(new Date(next).getTime())) throw new AppError('invalid_schedule_time');
    return next;
  }
  try {
    const cron = new Cron(timing.expression, { timezone, paused: true });
    try { return cron.nextRun(new Date(after))?.getTime() ?? null; }
    finally { cron.stop(); }
  } catch { throw new AppError('invalid_cron'); }
}

export class Schedules {
  readonly timezone: string;
  private readonly db: DatabaseSync;
  private readonly clock: SchedulerClock;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly store: Store, private readonly dispatch: (occurrence: Occurrence) => Promise<SignalRecord>,
    options: { timezone?: string; clock?: SchedulerClock } = {}) {
    this.db = store.db;
    this.clock = options.clock ?? realClock;
    this.timezone = validateTimezone(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, next_fire_at INTEGER);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_fire_at);
      CREATE TABLE IF NOT EXISTS schedule_occurrences(
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, signal_id TEXT NOT NULL UNIQUE,
        scheduled_at INTEGER NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
        dispatch_status TEXT NOT NULL, error_code TEXT, report_status TEXT NOT NULL DEFAULT 'pending', summary TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_automatic_fire ON schedule_occurrences(schedule_id,revision,scheduled_at) WHERE kind='automatic';
      CREATE INDEX IF NOT EXISTS schedule_occurrences_parent ON schedule_occurrences(schedule_id,scheduled_at,id);
      CREATE TABLE IF NOT EXISTS schedule_operations(id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL);
    `);
  }

  start() {
    if (this.started) return;
    const now = this.clock.now();
    this.transaction(() => {
      this.db.exec("UPDATE schedule_occurrences SET dispatch_status='interrupted',error_code='process_interrupted' WHERE dispatch_status='pending'");
      this.db.exec(`UPDATE schedule_occurrences SET report_status='interrupted' WHERE report_status='pending'
        AND (dispatch_status='interrupted' OR signal_id IN (SELECT id FROM signals WHERE status='interrupted'))`);
      for (const schedule of this.list()) {
        if (schedule.status !== 'active' || !schedule.nextFireAt || Date.parse(schedule.nextFireAt) > now) continue;
        const next = nextTime(schedule.timing, schedule.timezone, now);
        this.save({ ...schedule, nextFireAt: next === null ? null : new Date(next).toISOString(),
          status: next === null ? (schedule.timing.kind === 'once' ? 'expired' : 'exhausted') : 'active' });
      }
    });
    this.started = true;
    this.arm();
  }

  now() { return { now: new Date(this.clock.now()).toISOString(), timezone: this.timezone }; }
  list(contextId?: string): Schedule[] {
    return this.db.prepare('SELECT body FROM schedules ORDER BY id').all().map(row => JSON.parse(row.body as string) as Schedule)
      .filter(schedule => contextId === undefined || schedule.contextId === contextId);
  }
  get(id: string): Schedule {
    const row = this.db.prepare('SELECT body FROM schedules WHERE id=?').get(id);
    if (!row) throw new AppError('schedule_not_found', 404);
    return JSON.parse(row.body as string) as Schedule;
  }
  private save(schedule: Schedule) {
    this.db.prepare(`INSERT INTO schedules(id,body,status,revision,next_fire_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body,status=excluded.status,revision=excluded.revision,next_fire_at=excluded.next_fire_at`)
      .run(schedule.id, JSON.stringify(schedule), schedule.status, schedule.revision, schedule.nextFireAt ? Date.parse(schedule.nextFireAt) : null);
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private operation<T>(key: string | undefined, request: unknown, action: () => T): T {
    const result = this.transaction(() => {
      const body = JSON.stringify(request);
      const previous = key && this.db.prepare('SELECT * FROM schedule_operations WHERE id=?').get(key);
      if (previous) {
        if (previous.request !== body) throw new AppError('operation_id_conflict', 409);
        return JSON.parse(previous.result as string) as T;
      }
      const result = action();
      if (key) this.db.prepare('INSERT INTO schedule_operations VALUES(?,?,?)').run(key, body, JSON.stringify(result));
      return result;
    });
    this.arm();
    return result;
  }
  create(body: unknown, key?: string): Schedule {
    const parsed = createScheduleSchema.safeParse(body);
    if (!parsed.success) throw new AppError('invalid_schedule');
    return this.operation(key, ['create', parsed.data], () => {
      const input = parsed.data;
      const timezone = validateTimezone(input.timezone ?? this.timezone);
      const now = this.clock.now();
      const next = nextTime(input.timing, timezone, now);
      if (next === null) throw new AppError('schedule_has_no_future_time');
      const stamp = new Date(now).toISOString();
      const schedule: Schedule = { ...input, id: randomUUID(), timezone,
        output: { kind: input.output?.kind ?? (input.version === 2 ? 'none' : 'both'), contextId: input.output?.contextId ?? input.contextId },
        status: 'active', revision: 1, nextFireAt: new Date(next).toISOString(), createdAt: stamp, updatedAt: stamp };
      this.save(schedule);
      return schedule;
    });
  }
  update(id: string, body: unknown, key?: string): Schedule {
    const parsed = updateScheduleSchema.safeParse(body);
    if (!parsed.success) throw new AppError('invalid_schedule_update');
    return this.operation(key, ['update', id, parsed.data], () => {
      const old = this.get(id);
      if (old.status === 'cancelled') throw new AppError('schedule_cancelled', 409);
      if (old.revision !== parsed.data.revision) throw new AppError('schedule_revision_conflict', 409);
      const { revision: _, ...patch } = parsed.data;
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const schedule = { ...old, ...defined, revision: old.revision + 1, updatedAt: new Date(this.clock.now()).toISOString() } as Schedule;
      schedule.timezone = validateTimezone(schedule.timezone);
      if (patch.output) schedule.output = { ...patch.output, contextId: patch.output.contextId ?? schedule.contextId };
      if (patch.timing || patch.timezone) {
        const next = nextTime(schedule.timing, schedule.timezone, this.clock.now());
        if (next === null) throw new AppError('schedule_has_no_future_time');
        schedule.nextFireAt = new Date(next).toISOString();
        if (schedule.status !== 'paused') schedule.status = 'active';
      }
      this.save(schedule);
      return schedule;
    });
  }
  control(id: string, action: 'pause' | 'resume' | 'cancel', revision: number, key?: string): Schedule {
    return this.operation(key, [action, id, revision], () => {
      const schedule = this.get(id);
      if (schedule.revision !== revision) throw new AppError('schedule_revision_conflict', 409);
      if (schedule.status === 'cancelled' && action !== 'cancel') throw new AppError('schedule_cancelled', 409);
      if (action === 'resume' && schedule.status !== 'paused') throw new AppError('schedule_not_paused', 409);
      if (action === 'pause' && !['active', 'paused'].includes(schedule.status)) throw new AppError('schedule_not_active', 409);
      if (action === 'resume') {
        const next = nextTime(schedule.timing, schedule.timezone, this.clock.now());
        schedule.nextFireAt = next === null ? null : new Date(next).toISOString();
        schedule.status = next !== null ? 'active' : schedule.timing.kind === 'once' ? 'expired' : 'exhausted';
      } else { schedule.status = action === 'pause' ? 'paused' : 'cancelled'; }
      schedule.revision++;
      schedule.updatedAt = new Date(this.clock.now()).toISOString();
      this.save(schedule);
      return schedule;
    });
  }

  private insertOccurrence(schedule: Schedule, at: number, kind: 'automatic' | 'manual') {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO schedule_occurrences(id,schedule_id,signal_id,scheduled_at,kind,revision,snapshot,dispatch_status)
      VALUES(?,?,?,?,?,?,?,'pending')`).run(id, schedule.id, randomUUID(), at, kind, schedule.revision, JSON.stringify(schedule));
    return id;
  }
  async run(id: string, key?: string): Promise<Occurrence> {
    const occurrenceId = this.operation(key, ['run', id], () => {
      const schedule = this.get(id);
      if (schedule.status === 'cancelled') throw new AppError('schedule_cancelled', 409);
      return this.insertOccurrence(schedule, this.clock.now(), 'manual');
    });
    await this.deliver(occurrenceId);
    return this.occurrence(occurrenceId);
  }
  private deliver(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const occurrence = this.occurrence(id);
    if (occurrence.dispatchStatus !== 'pending') return Promise.resolve();
    const task = (async () => {
      try {
        const signal = await this.dispatch(occurrence);
        const accepted = signal.status === 'accepted';
        this.db.prepare('UPDATE schedule_occurrences SET dispatch_status=?,error_code=? WHERE id=? AND dispatch_status=\'pending\'')
          .run(accepted ? 'accepted' : signal.status === 'received' ? 'queued' : 'failed', signal.errorCode, id);
      } catch (error) {
        this.db.prepare("UPDATE schedule_occurrences SET dispatch_status='failed',error_code=? WHERE id=? AND dispatch_status='pending'")
          .run(error instanceof AppError ? error.code : 'signal_dispatch_failed', id);
      }
    })();
    this.pending.set(id, task);
    void task.finally(() => this.pending.delete(id));
    return task;
  }
  tick() {
    if (!this.started) return;
    const now = this.clock.now();
    const ids = this.transaction(() => {
      const rows = this.db.prepare("SELECT body FROM schedules WHERE status='active' AND next_fire_at<=? ORDER BY next_fire_at,id LIMIT 100").all(now);
      const ids: string[] = [];
      for (const row of rows) {
        const schedule = JSON.parse(row.body as string) as Schedule;
        const at = Date.parse(schedule.nextFireAt!);
        ids.push(this.insertOccurrence(schedule, at, 'automatic'));
        const next = nextTime(schedule.timing, schedule.timezone, at);
        this.save({ ...schedule, nextFireAt: next === null ? null : new Date(next).toISOString(), status: next === null ? 'exhausted' : 'active' });
      }
      return ids;
    });
    for (const id of ids) void this.deliver(id);
    this.arm();
  }
  private arm() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started) return;
    const row = this.db.prepare("SELECT MIN(next_fire_at) AS due FROM schedules WHERE status='active'").get();
    if (typeof row?.due !== 'number') return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      try { this.tick(); }
      catch { console.error('schedule_tick_failed'); this.timer = this.clock.setTimeout(() => this.arm(), 1000); }
    }, Math.min(60_000, Math.max(0, row.due - this.clock.now())));
  }
  stop() {
    this.started = false;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
  async drain() { await Promise.allSettled(this.pending.values()); }
  isSignal(id: string) { return !!this.db.prepare('SELECT id FROM schedule_occurrences WHERE signal_id=?').get(id); }
  bySignal(id: string): Occurrence | undefined {
    const row = this.db.prepare('SELECT id FROM schedule_occurrences WHERE signal_id=?').get(id);
    return row ? this.occurrence(row.id as string) : undefined;
  }
  occurrence(id: string): Occurrence {
    const row = this.db.prepare('SELECT * FROM schedule_occurrences WHERE id=?').get(id);
    if (!row) throw new AppError('occurrence_not_found', 404);
    const signal = this.store.getSignal(row.signal_id as string);
    const run = signal?.runId ? this.store.getRun(signal.runId) ?? null : null;
    let status = row.report_status as Occurrence['report']['status'];
    const snapshot=JSON.parse(row.snapshot as string) as Schedule;
    const taskRow=snapshot.version===2?this.db.prepare("SELECT body FROM tasks WHERE json_extract(body,'$.occurrenceId')=? ORDER BY rowid DESC LIMIT 1").get(id):undefined;
    const task=taskRow?JSON.parse(taskRow.body as string) as {status:string}:undefined;
    if(task)status=['succeeded','failed','blocked','cancelled','interrupted','unreported'].includes(task.status)?task.status as typeof status:'pending';
    if (status === 'pending'&&!task) {
      if (row.dispatch_status === 'interrupted' || run?.status === 'interrupted') status = 'interrupted';
      else if (row.dispatch_status === 'failed' || (run && run.status !== 'running')) status = 'unreported';
    }
    return {
      id: row.id as string, scheduleId: row.schedule_id as string, signalId: row.signal_id as string,
      scheduledAt: new Date(row.scheduled_at as number).toISOString(), kind: row.kind as Occurrence['kind'],
      snapshot: JSON.parse(row.snapshot as string) as Schedule,
      dispatchStatus: signal?.status === 'accepted' && row.dispatch_status === 'queued' ? 'accepted' : row.dispatch_status as Occurrence['dispatchStatus'], errorCode: row.error_code as string | null,
      report: { status, summary: row.summary as string | null }, signal, run,
      outputs: this.store.outputsForSignal(row.signal_id as string),
    };
  }
  occurrences(id: string, offset = 0, limit = 40) {
    this.get(id);
    return this.db.prepare('SELECT id FROM schedule_occurrences WHERE schedule_id=? ORDER BY scheduled_at DESC,id DESC LIMIT ? OFFSET ?')
      .all(id, limit, offset).map(row => this.occurrence(row.id as string));
  }

  reportTask(id: string, taskId: string, runId: string, status: 'succeeded' | 'failed' | 'interrupted' | 'unreported' | 'blocked' | 'cancelled', summary: string, key: string) {
    return this.operation(key, ['task-report', id, taskId, runId, status, summary], () => {
      const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId);
      const task = row && JSON.parse(row.body as string) as { occurrenceId: string; runIds: string[];status:string };
      const occurrence = this.occurrence(id);
      if (!task || task.occurrenceId !== id || task.runIds.at(-1)!==runId || !['succeeded','failed','interrupted'].includes(this.store.getRun(runId)?.status??'') || (status==='succeeded'&&task.status!=='succeeded')) throw new AppError('occurrence_not_in_active_run', 403);
      this.db.prepare('UPDATE schedule_occurrences SET report_status=?,summary=? WHERE id=?').run(status, summary, id);
      return { id: occurrence.id, status, summary, saved: true };
    });
  }
  report(id: string, runId: string, status: 'succeeded' | 'failed', summary: string, key: string) {
    return this.operation(key, ['report', id, status, summary], () => {
      const occurrence = this.occurrence(id);
      if (occurrence.signal?.runId !== runId || occurrence.run?.status !== 'running' || occurrence.signal?.status !== 'accepted') {
        throw new AppError('occurrence_not_in_active_run', 403);
      }
      if (occurrence.report.status !== 'pending') throw new AppError('occurrence_already_reported', 409);
      this.db.prepare('UPDATE schedule_occurrences SET report_status=?,summary=? WHERE id=?').run(status, summary, id);
      return { id, status, summary, saved: true };
    });
  }
}
