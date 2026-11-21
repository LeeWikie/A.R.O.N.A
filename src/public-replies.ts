import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from './runtime-store.js';
import type { OutputRecord } from './domain.js';
import { publicTextSecrets, redactPublicText, redactPublicFragment, safeTextCutoff, terminalTextDelta, initialTerminalTextState, lastTokenStart, type TerminalTextState } from './public-text.js';
import { PrivateTextTail } from './private-text-tail.js';

interface Draft { pending: string; spilled: boolean; terminal: TerminalTextState; lastSource: number; startSource: number; secretRevision: number; syntaxTail: string; publishedLexeme: boolean; pendingPublished: string; knownBoundary: boolean }
const UNAVAILABLE = '[unavailable]';
/** Persist only display text; original replies and outputs remain in their own records. */
export class PublicReplyProjection {
  private getSecrets?: () => readonly string[];
  private secrets: readonly string[] = [];
  private secretRevision = 0;
  private drafts = new Map<string, Draft>();
  private readonly tails: PrivateTextTail;
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS public_reply_events(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS public_reply_streams(id TEXT PRIMARY KEY,source_seq INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS public_output_text(id TEXT PRIMARY KEY,content TEXT NOT NULL,title TEXT);
      UPDATE public_reply_streams SET status='blocked:restart' WHERE status='open';`);
    this.tails = new PrivateTextTail(db, 'reply');
  }
  configureSecrets(get: () => readonly string[]) { this.getSecrets = get; }
  event(seq: number): { kind: string; data: Record<string, unknown> } | undefined {
    const row = this.db.prepare('SELECT kind,data FROM public_reply_events WHERE seq=?').get(seq);
    return row ? { kind: String(row.kind), data: JSON.parse(String(row.data)) as Record<string, unknown> } : undefined;
  }
  output(id: string): { content: string; title: string | null } {
    let row = this.db.prepare('SELECT content,title FROM public_output_text WHERE id=?').get(id);
    if (!row && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outputs'").get()) {
      const original = this.db.prepare('SELECT content,title FROM outputs WHERE id=?').get(id);
      if (original && this.refresh()) {
        this.db.prepare('INSERT OR IGNORE INTO public_output_text VALUES(?,?,?)').run(id, redactPublicText(String(original.content), this.secrets), typeof original.title === 'string' ? redactPublicText(original.title, this.secrets) : null);
        row = this.db.prepare('SELECT content,title FROM public_output_text WHERE id=?').get(id);
      }
    }
    return row ? { content: String(row.content), title: row.title as string | null } : { content: UNAVAILABLE, title: null };
  }
  legacyMessage(id: string, content: string) {
    const key = `transcript:${id}`;
    const row = this.db.prepare('SELECT content FROM public_output_text WHERE id=?').get(key);
    if (row) return String(row.content);
    if (!this.refresh()) return UNAVAILABLE;
    const safe = redactPublicText(content, this.secrets);
    this.db.prepare('INSERT OR IGNORE INTO public_output_text VALUES(?,?,NULL)').run(key, safe); return safe;
  }
  private refresh() {
    if (!this.getSecrets) return false;
    try {
      const values = this.getSecrets();
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) return false;
      const next = publicTextSecrets([...this.secrets, ...values]);
      if (next.length !== this.secrets.length || next.some((value, index) => value !== this.secrets[index])) this.secretRevision++;
      this.secrets = next; return true;
    } catch { return false; }
  }
  private publish(event: RuntimeEvent, kind: string, data: Record<string, unknown>) {
    this.db.prepare('INSERT OR IGNORE INTO public_reply_events VALUES(?,?,?)').run(event.seq, kind, JSON.stringify(data));
  }
  private key(contextId: string, runId: string | null, draftId: string) { return JSON.stringify([contextId, runId, draftId]); }
  private originalDraft(event: RuntimeEvent, draftId: string, from: number) {
    let raw = '';
    for (const row of this.db.prepare("SELECT kind,data FROM runtime_events WHERE seq>=? AND seq<=? AND context_id=? AND run_id=? AND kind IN ('reply.delta','reply.replace') AND json_extract(data,'$.draftId')=? ORDER BY seq").iterate(from, event.seq, event.contextId, event.runId, draftId)) {
      const data = JSON.parse(String(row.data)) as { delta?: unknown; text?: unknown };
      if (row.kind === 'reply.replace' && typeof data.text === 'string') raw = data.text;
      else if (row.kind === 'reply.delta' && typeof data.delta === 'string') raw += data.delta;
    }
    return raw;
  }
  private displayedDraft(event: RuntimeEvent, draftId: string) {
    let text = '';
    for (const row of this.db.prepare("SELECT kind,data FROM public_reply_events WHERE seq<? AND json_extract(data,'$.contextId')=? AND json_extract(data,'$.runId')=? AND json_extract(data,'$.draftId')=? ORDER BY seq").iterate(event.seq, event.contextId, event.runId, draftId)) {
      const data = JSON.parse(String(row.data)) as { delta?: unknown; text?: unknown };
      if (row.kind === 'reply.replace' && typeof data.text === 'string') text = data.text;
      else if (row.kind === 'reply.delta' && typeof data.delta === 'string') text += data.delta;
    }
    return text;
  }
  private resetDraft(event: RuntimeEvent, draft: Draft, key: string, base: Record<string, unknown>, raw: string) {
    const normalized = terminalTextDelta(raw); draft.terminal = normalized.state;
    const cutoff = safeTextCutoff(normalized.text, this.secrets, false);
    const projected = redactPublicFragment(normalized.text.slice(0, cutoff), this.secrets, false), safe = projected.text, published = this.displayedDraft(event, String(base.draftId));
    if (safe !== published) this.publish(event, safe.startsWith(published) ? 'reply.delta' : 'reply.replace', safe.startsWith(published) ? { ...base, delta: safe.slice(published.length) } : { ...base, text: safe });
    Object.assign(draft, this.tails.keep(key, normalized.text.slice(cutoff))); draft.secretRevision = this.secretRevision;
    draft.syntaxTail = normalized.text.slice(-64); draft.publishedLexeme = cutoff > lastTokenStart(normalized.text); draft.pendingPublished = '';
    draft.knownBoundary = projected.knownBoundary;
  }
  private outputView(output: OutputRecord) {
    const saved = this.db.prepare('SELECT 1 FROM public_output_text WHERE id=?').get(output.id);
    if (!saved) {
      const available = this.refresh();
      const content = available ? redactPublicText(output.content, this.secrets) : UNAVAILABLE;
      const title = available && typeof output.title === 'string' ? redactPublicText(output.title, this.secrets) : null;
      this.db.prepare('INSERT INTO public_output_text VALUES(?,?,?)').run(output.id, content, title);
    }
    return { ...output, ...this.output(output.id) };
  }
  observe(event: RuntimeEvent) {
    if (event.kind !== 'delivery' && !event.kind.startsWith('reply.')) return;
    const previous = new Map([...this.drafts].map(([key, value]) => [key, { ...value }]));
    try { this.apply(event); } catch (error) { this.drafts = previous; throw error; }
  }
  private apply(event: RuntimeEvent) {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    if (event.kind === 'delivery') {
      if (typeof data.id !== 'string' || typeof data.content !== 'string') return;
      this.outputView(data as unknown as OutputRecord); return;
    }
    if (typeof data.draftId !== 'string' || typeof data.signalId !== 'string' || !event.runId) return;
    const key = this.key(event.contextId, event.runId, data.draftId);
    const base = { draftId: data.draftId, signalId: data.signalId, contextId: event.contextId, runId: event.runId };
    let saved = this.db.prepare('SELECT status,source_seq FROM public_reply_streams WHERE id=?').get(key);
    if (event.kind === 'reply.start') {
      if (saved) return;
      this.db.prepare("INSERT INTO public_reply_streams VALUES(?,?,'open')").run(key, event.seq);
      this.drafts.set(key, { pending: '', spilled: false, terminal: initialTerminalTextState(), lastSource: event.seq, startSource: event.seq, secretRevision: this.secretRevision, syntaxTail: '', publishedLexeme: false, pendingPublished: '', knownBoundary: false });
      this.publish(event, event.kind, base); return;
    }
    if (event.kind === 'reply.cancel') {
      this.publish(event, event.kind, base);
      this.db.prepare("UPDATE public_reply_streams SET status='closed',source_seq=? WHERE id=?").run(event.seq, key); this.drafts.delete(key); this.tails.clear(key); return;
    }
    const draft = this.drafts.get(key);
    if (saved?.status === 'open' && (!draft || draft.lastSource !== Number(saved.source_seq))) {
      this.db.prepare("UPDATE public_reply_streams SET status='blocked:state_mismatch' WHERE id=?").run(key);
      this.drafts.delete(key); this.tails.clear(key); saved = { ...saved, status: 'blocked:state_mismatch' };
    }
    if (event.kind === 'reply.commit') {
      const output = data.output as OutputRecord | undefined;
      if (output && typeof output.id === 'string' && typeof output.content === 'string') this.publish(event, event.kind, { ...base, output: this.outputView(output) });
      this.db.prepare("UPDATE public_reply_streams SET status='closed',source_seq=? WHERE id=?").run(event.seq, key); this.drafts.delete(key); this.tails.clear(key); return;
    }
    if (!draft || saved?.status !== 'open') return;
    if (!this.refresh()) {
      this.db.prepare("UPDATE public_reply_streams SET status='blocked:secrets' WHERE id=?").run(key); this.drafts.delete(key); this.tails.clear(key); return;
    }
    const replace = event.kind === 'reply.replace' && typeof data.text === 'string';
    if (!replace && !(event.kind === 'reply.delta' && typeof data.delta === 'string')) return;
    const delta = replace ? undefined : terminalTextDelta(data.delta as string, draft.terminal);
    const boundary = delta?.text.search(/\s/u) ?? -1, firstToken = delta?.text.slice(0, boundary < 0 ? undefined : boundary + 1) ?? '';
    // A new delimiter can turn an already displayed word into URL/Bearer/JWT syntax.
    const reconsider = draft.publishedLexeme && !draft.pendingPublished && (!!delta && /[:?&=@%\\/]/u.test(firstToken) || /bearer\s/iu.test(draft.syntaxTail + firstToken) || /eyJ/u.test(draft.pending + firstToken));
    let rewind = replace || draft.secretRevision !== this.secretRevision, seeded: string | undefined;
    if (reconsider && !rewind) {
      const start = lastTokenStart(draft.syntaxTail), word = draft.syntaxTail.slice(start);
      const prefix = !draft.spilled && (start > 0 || draft.syntaxTail.length < 64) && word.endsWith(draft.pending) ? word.slice(0, word.length - draft.pending.length) : '';
      if (prefix && redactPublicText(prefix, this.secrets) === prefix) {
        // Keep the harmless, already visible prefix while its newly introduced syntax resolves.
        // No complete-history replacement is needed for an ordinary label or URL scheme.
        seeded = prefix + draft.pending + delta!.text; draft.pendingPublished = prefix;
      } else rewind = true;
    }
    if (rewind) {
      const raw = replace ? data.text as string : this.originalDraft(event, data.draftId, draft.startSource);
      this.resetDraft(event, draft, key, base, raw);
    } else {
      const normalized = delta!; draft.terminal = normalized.state;
      const text = seeded ?? this.tails.take(key, draft, normalized.text);
      let reset = false;
      if (text !== undefined) {
        const cutoff = safeTextCutoff(text, this.secrets, false), projected = redactPublicFragment(text.slice(0, cutoff), this.secrets, draft.knownBoundary), safe = projected.text;
        if (draft.pendingPublished && !safe.startsWith(draft.pendingPublished)) {
          if (draft.pendingPublished.startsWith(safe)) Object.assign(draft, this.tails.keep(key, text));
          else { this.resetDraft(event, draft, key, base, this.originalDraft(event, data.draftId, draft.startSource)); reset = true; }
        } else {
          const delta = safe.slice(draft.pendingPublished.length); draft.pendingPublished = '';
          if (delta) this.publish(event, 'reply.delta', { ...base, delta });
          Object.assign(draft, this.tails.keep(key, text.slice(cutoff)));
          draft.knownBoundary = projected.knownBoundary;
          const tokenStart = lastTokenStart(text);
          if (cutoff > tokenStart) draft.publishedLexeme = true; else if (tokenStart > 0) draft.publishedLexeme = false;
        }
      }
      if (!reset) draft.syntaxTail = (draft.syntaxTail + normalized.text).slice(-64);
    }
    draft.lastSource = event.seq;
    this.db.prepare('UPDATE public_reply_streams SET source_seq=? WHERE id=?').run(event.seq, key);
  }
}
