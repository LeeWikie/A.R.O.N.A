// Heartbeat timing adapted from Cortico bots/cormini/persona/heartbeat.ts.
// Copyright (c) 2026 Phantivia, MIT; see companion/LICENSE.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, contextIdSchema } from './domain.js';

const MAX_TIMER_MS = 2_147_483_647;
const IDLE_TICKS_MAX = 3;
export const companionConfigurationSchema = z.object({
  target: z.enum(['latest', 'fixed']).default('latest'),
  contextId: contextIdSchema.default('main'),
  intervalMinutes: z.number().finite().min(1).max(525600).nullable().default(null),
}).strict();
export type CompanionConfiguration = z.infer<typeof companionConfigurationSchema>;
export interface CompanionRhythmState {
  version: 1; revision: number; configuration: CompanionConfiguration;
  lastExternalAt: number; lastExternalSeq: number; lastFireAt: number | null;
  idleTicks: number; nextDueAt: number | null;
  lastConversationContextId?: string;
}
export interface CompanionWake {
  kind: 'companion-wake'; id: string; contextId: string; revision: number; scheduledAt: string;
}
export interface CompanionRhythmView {
  revision: number; configuration: CompanionConfiguration;
  lastExternalAt: string; lastFireAt: string | null; nextDueAt: string | null; backoff: number;
  effectiveContextId: string;
  status: 'disabled' | 'running' | 'stopped' | 'blocked'; errorCode?: 'companion_activity_unavailable' | 'companion_context_not_available';
}
export interface CompanionClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface CompanionRhythmHost {
  read(): CompanionRhythmState | null;
  /** Commit timing and an optional durable notification in the same Core transaction. */
  commit(state: CompanionRhythmState, options?: { wake?: CompanionWake; cancelRevision?: number }): void;
  validateContext(contextId: string): void;
  onError?(): void;
}
const realClock: CompanionClock = { now: Date.now, setTimeout, clearTimeout };
const date = (time: number | null) => time === null ? null : new Date(time).toISOString();
export function companionQuietLine(seconds: number): string {
  return seconds < 60 ? `[system] 已安静 ${seconds} 秒。` : `[system] 已安静 ${Math.floor(seconds / 60)} 分钟。`;
}
export function isCompanionWake(value: unknown): value is CompanionWake {
  return z.object({ kind: z.literal('companion-wake'), id: z.string().uuid(), contextId: contextIdSchema, revision: z.number().int().nonnegative(), scheduledAt: z.string().datetime() }).strict().safeParse(value).success;
}

/** Only timing lives here. The existing Core outbox and native controller own delivery and execution. */
export class CompanionRhythm {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private errorCode?: 'companion_activity_unavailable';
  constructor(private readonly host: CompanionRhythmHost, private readonly clock: CompanionClock = realClock) {}
  private state(): CompanionRhythmState {
    return this.host.read() ?? { version: 1, revision: 0, configuration: { target: 'latest', contextId: 'main', intervalMinutes: null }, lastExternalAt: this.clock.now(), lastExternalSeq: 0, lastFireAt: null, idleTicks: 0, nextDueAt: null };
  }
  private target(state: CompanionRhythmState): string {
    if (state.configuration.target !== 'fixed' && state.lastConversationContextId) {
      try { this.host.validateContext(state.lastConversationContextId); return state.lastConversationContextId; } catch {}
    }
    return state.configuration.contextId;
  }
  view(): CompanionRhythmView {
    const state = this.state();
    const effectiveContextId = this.target(state); let available = true;
    try { this.host.validateContext(effectiveContextId); } catch { available = false; }
    const errorCode = this.errorCode ?? (available ? undefined : 'companion_context_not_available');
    return { revision: state.revision, configuration: structuredClone(state.configuration), lastExternalAt: date(state.lastExternalAt)!, lastFireAt: date(state.lastFireAt), nextDueAt: date(state.nextDueAt), backoff: 2 ** state.idleTicks,
      effectiveContextId, status: state.configuration.intervalMinutes === null ? 'disabled' : errorCode ? 'blocked' : this.running ? 'running' : 'stopped', ...(errorCode ? { errorCode } : {}) };
  }
  configure(value: unknown, expectedRevision: number): CompanionRhythmView {
    const parsed = companionConfigurationSchema.safeParse(value);
    if (!parsed.success) throw new AppError('invalid_companion_configuration');
    const previous = this.state();
    if (expectedRevision !== previous.revision) throw new AppError('companion_revision_changed', 409);
    this.host.validateContext(parsed.data.contextId);
    if (JSON.stringify(parsed.data) === JSON.stringify(previous.configuration)) return this.view();
    const now = this.clock.now(), next: CompanionRhythmState = { ...previous, revision: previous.revision + 1, configuration: parsed.data, idleTicks: 0,
      ...(parsed.data.contextId !== previous.configuration.contextId ? { lastExternalAt: now } : {}),
      nextDueAt: parsed.data.intervalMinutes === null ? null : now + parsed.data.intervalMinutes * 60000 };
    this.host.commit(next, { cancelRevision: previous.revision });
    if (this.running) this.arm();
    return this.view();
  }
  start(): void {
    if (this.running) return;
    let state = this.state();
    if (!this.host.read()) this.host.commit(state);
    if (state.configuration.intervalMinutes !== null && state.nextDueAt === null) {
      state = { ...state, nextDueAt: this.clock.now() + state.configuration.intervalMinutes * 60000 }; this.host.commit(state);
    }
    this.errorCode = undefined; this.running = true; this.arm();
  }
  stop(errorCode?: 'companion_activity_unavailable'): void { this.running = false; this.errorCode = errorCode; if (this.timer) this.clock.clearTimeout(this.timer); this.timer = undefined; }
  noteExternal(contextId: string, sequence: number, deliveredAt = this.clock.now(), userMessage = false): void {
    const state = this.state();
    if (!Number.isSafeInteger(sequence) || sequence <= state.lastExternalSeq || !Number.isFinite(deliveredAt)) return;
    this.host.commit({ ...state, lastExternalAt: Math.max(state.lastExternalAt, deliveredAt), lastExternalSeq: sequence, idleTicks: 0, ...(userMessage ? { lastConversationContextId: contextId } : {}) });
    // Activity resets backoff without changing a timer that is already armed, as Cormini does.
  }
  allows(wake: CompanionWake): boolean {
    const state = this.state();
    return state.configuration.intervalMinutes !== null && wake.revision === state.revision && wake.contextId === this.target(state);
  }
  render(wake: CompanionWake): string | null {
    if (!this.allows(wake)) return null;
    const seconds = Math.max(0, Math.round((this.clock.now() - this.state().lastExternalAt) / 1000));
    return companionQuietLine(seconds);
  }
  private arm(minimumDelay = 0): void {
    if (this.timer) this.clock.clearTimeout(this.timer); this.timer = undefined;
    if (!this.running) return;
    const state = this.state(); if (state.configuration.intervalMinutes === null || state.nextDueAt === null) return;
    this.timer = this.clock.setTimeout(() => this.fire(), Math.max(minimumDelay, Math.min(MAX_TIMER_MS, Math.max(0, state.nextDueAt - this.clock.now()))));
    this.timer.unref?.();
  }
  private fire(): void {
    if (!this.running) return;
    const state = this.state(), now = this.clock.now();
    if (state.configuration.intervalMinutes === null || state.nextDueAt === null || now < state.nextDueAt) { this.arm(); return; }
    const idleTicks = state.lastFireAt === null || state.lastExternalAt > state.lastFireAt ? 0 : Math.min(IDLE_TICKS_MAX, state.idleTicks + 1);
    const contextId = this.target(state);
    try { this.host.validateContext(contextId); } catch {
      try { this.host.commit({ ...state, nextDueAt: now + state.configuration.intervalMinutes * 60000 * 2 ** state.idleTicks }); this.arm(); }
      catch { try { this.host.onError?.(); } catch {} this.arm(1000); }
      return;
    }
    const wake: CompanionWake = { kind: 'companion-wake', id: randomUUID(), contextId, revision: state.revision, scheduledAt: date(state.nextDueAt)! };
    const next = { ...state, idleTicks, lastFireAt: now, nextDueAt: now + state.configuration.intervalMinutes * 60000 * 2 ** idleTicks };
    try { this.host.commit(next, { wake }); this.arm(); }
    catch { try { this.host.onError?.(); } catch {} this.arm(1000); }
  }
}
