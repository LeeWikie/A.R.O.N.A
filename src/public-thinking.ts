import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from './runtime-store.js';
import { HIDDEN, secretSpans, redactPublicFragment, safeThinkingCutoff, terminalTextDelta, initialTerminalTextState, publicTextSecrets, trailingSecretPrefixStart, type TerminalTextState } from './public-text.js';
import { PrivateTextTail } from './private-text-tail.js';

export interface PublicThinkingDelta { messageId: string; index: number; delta: string }
interface Stream {
  key: string; contextId: string; runId: string | null; messageId: string; index: number;
  pending: string; spilled: boolean; terminal: TerminalTextState; lastSource: number; knownBoundary: boolean;
}

/** Private in-memory tails never become public rows; only irrevocably safe deltas are persisted. */
export class PublicThinkingProjection {
  private secrets: readonly string[] = [];
  private getSecrets?: () => readonly string[];
  private streams = new Map<string, Stream>();
  private readonly tails: PrivateTextTail;

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS public_thinking_events(
        seq INTEGER PRIMARY KEY, source_seq INTEGER NOT NULL, stream_key TEXT NOT NULL,
        message_id TEXT NOT NULL, part_index INTEGER NOT NULL, delta TEXT NOT NULL,
        UNIQUE(source_seq,stream_key));
      CREATE TABLE IF NOT EXISTS public_thinking_streams(
        stream_key TEXT PRIMARY KEY, context_id TEXT NOT NULL, run_id TEXT, message_id TEXT NOT NULL,
        part_index INTEGER NOT NULL, source_seq INTEGER NOT NULL, status TEXT NOT NULL);
      UPDATE public_thinking_streams SET status='blocked:restart' WHERE status='open';
    `);
    this.tails = new PrivateTextTail(db, 'thinking');
  }

  configureSecrets(get: () => readonly string[]) { this.getSecrets = get; }

  get(seq: number): PublicThinkingDelta | undefined {
    const row = this.db.prepare('SELECT message_id,part_index,delta FROM public_thinking_events WHERE seq=?').get(seq);
    return row ? { messageId: String(row.message_id), index: Number(row.part_index), delta: String(row.delta) } : undefined;
  }

  /** Called inside the transaction that inserts the private source event. */
  observe(event: RuntimeEvent) {
    if (!['message_update', 'message_end', 'agent_end'].includes(event.kind)) return;
    const previous = new Map([...this.streams].map(([key, stream]) => [key, { ...stream }]));
    try { this.apply(event); }
    catch (error) { this.streams = previous; throw error; }
  }

  private apply(event: RuntimeEvent) {
    const data = event.data as { id?: unknown; event?: { type?: string; delta?: unknown; index?: unknown } } | null;
    if (event.kind === 'message_update' && data?.event?.type === 'reasoning-delta' && typeof data.event.delta === 'string' && data.event.delta) {
      const messageId = typeof data.id === 'string' ? data.id : '';
      const index = typeof data.event.index === 'number' && Number.isSafeInteger(data.event.index) ? data.event.index : 0;
      const key = JSON.stringify([event.contextId, event.runId, messageId, index]);
      let stream = this.streams.get(key);
      const saved = this.db.prepare('SELECT status,source_seq FROM public_thinking_streams WHERE stream_key=?').get(key);
      if (saved && saved.status !== 'open') return;
      if (saved && (!stream || stream.lastSource !== Number(saved.source_seq))) {
        this.db.prepare("UPDATE public_thinking_streams SET status='blocked:state_mismatch' WHERE stream_key=?").run(key);
        this.streams.delete(key); this.tails.clear(key); return;
      }
      if (!saved) {
        // Never reconstruct legacy/private history using today's credential set.
        const legacy = this.db.prepare(`SELECT 1 FROM runtime_events WHERE seq<? AND context_id=? AND run_id IS ?
          AND kind='message_update' AND json_extract(data,'$.event.type')='reasoning-delta'
          AND json_type(data,'$.event.delta')='text' AND length(json_extract(data,'$.event.delta'))>0
          AND COALESCE(json_extract(data,'$.id'),'')=? AND COALESCE(json_extract(data,'$.event.index'),0)=? LIMIT 1`)
          .get(event.seq, event.contextId, event.runId, messageId, index);
        this.db.prepare('INSERT INTO public_thinking_streams VALUES(?,?,?,?,?,?,?)')
          .run(key, event.contextId, event.runId, messageId, index, event.seq, legacy ? 'blocked:legacy' : 'open');
        if (legacy) return;
        stream = { key, contextId: event.contextId, runId: event.runId, messageId, index, pending: '', spilled: false, terminal: initialTerminalTextState(), lastSource: event.seq, knownBoundary: false };
        this.streams.set(key, stream);
      }
      if (!stream) return;
      const unavailable = this.refreshSecrets();
      if (unavailable) { this.block(stream, event.seq, unavailable); return; }
      const normalized = terminalTextDelta(data.event.delta, stream.terminal); stream.terminal = normalized.state;
      const pending = this.tails.take(key, stream, normalized.text);
      if (pending !== undefined) {
        const cutoff = safeThinkingCutoff(pending, this.secrets);
        const projected = redactPublicFragment(pending.slice(0, cutoff), this.secrets, stream.knownBoundary);
        this.publish(event, stream, projected.text); stream.knownBoundary = projected.knownBoundary;
        Object.assign(stream, this.tails.keep(key, pending.slice(cutoff)));
      }
      stream.lastSource = event.seq;
      this.db.prepare('UPDATE public_thinking_streams SET source_seq=? WHERE stream_key=?').run(event.seq, key);
      return;
    }
    if (event.kind !== 'message_end' && event.kind !== 'agent_end') return;
    for (const stream of this.streams.values()) {
      if (stream.contextId !== event.contextId || stream.runId !== event.runId || (event.kind === 'message_end' && stream.messageId !== data?.id)) continue;
      const saved = this.db.prepare('SELECT status,source_seq FROM public_thinking_streams WHERE stream_key=?').get(stream.key);
      if (!saved || saved.status !== 'open' || Number(saved.source_seq) !== stream.lastSource) { this.block(stream, event.seq, 'state_mismatch'); continue; }
      const unavailable = this.refreshSecrets();
      if (unavailable) { this.block(stream, event.seq, unavailable); continue; }
      // A cancelled/incomplete credential prefix must not be flushed as plaintext either.
      const final = terminalTextDelta('', stream.terminal, true);
      let pending = this.tails.take(stream.key, stream, final.text) ?? this.tails.all(stream.key, stream);
      let prefixStart = trailingSecretPrefixStart(pending, this.secrets);
      for (const span of secretSpans(pending, this.secrets)) {
        if (span.start < prefixStart && span.end > prefixStart) prefixStart = span.start;
      }
      const projected = redactPublicFragment(pending.slice(0, prefixStart), this.secrets, stream.knownBoundary);
      this.publish(event, stream, projected.text + (prefixStart < pending.length && !projected.knownBoundary ? HIDDEN : ''));
      this.db.prepare("UPDATE public_thinking_streams SET status='closed',source_seq=? WHERE stream_key=?").run(event.seq, stream.key);
      this.streams.delete(stream.key);
      this.tails.clear(stream.key);
    }
  }

  private refreshSecrets(): 'secrets_unconfigured' | 'secrets_unavailable' | undefined {
    if (!this.getSecrets) return 'secrets_unconfigured';
    try {
      const current = this.getSecrets();
      if (!Array.isArray(current) || current.some(value => typeof value !== 'string')) return 'secrets_unavailable';
      // Keep retired credentials in memory until this runtime closes; never store them in public tables.
      this.secrets = [...new Set([...this.secrets, ...publicTextSecrets(current)])].sort((a, b) => b.length - a.length);
      return undefined;
    } catch { return 'secrets_unavailable'; }
  }

  private block(stream: Stream, source: number, reason: string) {
    this.db.prepare('UPDATE public_thinking_streams SET status=?,source_seq=? WHERE stream_key=?').run(`blocked:${reason}`, source, stream.key);
    this.streams.delete(stream.key);
    this.tails.clear(stream.key);
  }

  private publish(source: RuntimeEvent, stream: Stream, delta: string) {
    if (!delta) return;
    const result = this.db.prepare(`INSERT INTO runtime_events(context_id,task_id,run_id,kind,data,created_at,event_key)
      VALUES(?,?,?,'public_thinking','{}',?,?)`)
      .run(source.contextId, source.taskId, source.runId, source.createdAt, `thinking.public:${source.seq}:${stream.key}`);
    this.db.prepare('INSERT INTO public_thinking_events VALUES(?,?,?,?,?,?)')
      .run(result.lastInsertRowid, source.seq, stream.key, stream.messageId, stream.index, delta);
  }
}
