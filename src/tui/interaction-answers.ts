import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../domain.js';
import type { InteractionAnswer, InteractionAnswerPage, InteractionAnswerReceipt } from '../interactions.js';
import { MAX_INTERACTION_ANSWER_REQUEST_BYTES } from '../interactions.js';

export interface AnswerAddress {
  id: string; contextId: string; runId: string; toolCallId: string;
  kind: 'question' | 'plan'; payload: unknown;
}
export interface UnconfirmedAnswer {
  localId?: string;
  storageId: string; interactionId: string; contextId: string; runId: string; toolCallId: string;
  questionHash: string; answer: InteractionAnswer; updatedAt: string;
  receiptId?: string; cancelRequestedAt?: string; cancelAcknowledgedAt?: string; blockedCode?: string;
}
const answerSchema = z.union([
  z.string().min(1).max(64000),
  z.array(z.string().min(1).max(64000)).min(1).max(101),
  z.object({ action: z.enum(['approved', 'rejected']), feedback: z.string().max(64000).optional() }).strict(),
]);
const draftSchema = z.object({
  localId: z.string().uuid().optional(),
  storageId: z.string().min(1), interactionId: z.string().min(1), contextId: z.string().min(1), runId: z.string().min(1), toolCallId: z.string().min(1),
  questionHash: z.string().regex(/^[a-f0-9]{64}$/), answer: answerSchema, updatedAt: z.string().datetime(),
  receiptId: z.string().min(1).optional(), cancelRequestedAt: z.string().datetime().optional(), cancelAcknowledgedAt: z.string().datetime().optional(), blockedCode: z.string().optional(),
}).strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function questionHash(item: AnswerAddress): string { return digest(canonical([item.id, item.contextId, item.runId, item.toolCallId, item.kind, item.payload])); }
export function answerReviewId(draft: UnconfirmedAnswer): string {
  const bytes = createHash('sha256').update(JSON.stringify(canonical(['answer-review-v1', draft.storageId, draft.interactionId, draft.contextId, draft.runId, draft.toolCallId, draft.questionHash, draft.answer]))).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function unconfirmedAnswer(storageId: string, item: AnswerAddress, answer: InteractionAnswer): UnconfirmedAnswer {
  return { storageId, interactionId: item.id, contextId: item.contextId, runId: item.runId, toolCallId: item.toolCallId, questionHash: questionHash(item), answer: structuredClone(answer), updatedAt: new Date().toISOString() };
}
export function matchesQuestion(draft: UnconfirmedAnswer, item: AnswerAddress): boolean {
  return draft.interactionId === item.id && draft.contextId === item.contextId && draft.runId === item.runId && draft.toolCallId === item.toolCallId && draft.questionHash === questionHash(item);
}

/** Local editor input and operation references. Core receipts own saving, delivery and cancellation. */
export class InteractionAnswerDrafts {
  private readonly endpoint: string;
  private readonly legacyEndpoints: string[];
  constructor(private readonly directory: string, baseURL: string, legacyBaseURLs: string[] = []) { this.endpoint = digest(baseURL); this.legacyEndpoints = [...new Set([this.endpoint, ...legacyBaseURLs.map(digest)])]; }
  private legacyPrefixes(storageId: string): string[] { return this.legacyEndpoints.flatMap(endpoint => [`interaction-answer-${digest([endpoint, storageId])}-`, `interaction-answer-${endpoint}-${digest(storageId)}-`]); }
  private checkDirectory(create = false): boolean {
    if (create) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('answer_draft_directory_redirected');
    return true;
  }
  private readFile(file: string): UnconfirmedAnswer {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new AppError('answer_draft_redirected');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_INTERACTION_ANSWER_REQUEST_BYTES + 8192) throw new AppError('invalid_answer_draft');
      let value: UnconfirmedAnswer;
      try { value = draftSchema.parse(JSON.parse(fs.readFileSync(fd, 'utf8'))); }
      catch { throw new AppError('invalid_answer_draft'); }
      if (!this.legacyPrefixes(value.storageId).some(prefix => file === path.join(this.directory, prefix + digest(value.interactionId) + '.json'))) throw new AppError('invalid_answer_draft');
      return value;
    } finally { fs.closeSync(fd); }
  }
  private database<T>(storageId: string, action: (db: DatabaseSync) => T): T {
    this.checkDirectory(true);
    const file = path.join(this.directory, `interaction-answers-${this.endpoint}.sqlite`);
    // Create with private permissions before SQLite opens it. Never follow a redirected cache.
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new AppError('answer_draft_redirected');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { const stat = fs.lstatSync(file + suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AppError('answer_draft_redirected'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const db = new DatabaseSync(file);
    try {
      const after = fs.lstatSync(file);
      if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) throw new AppError('answer_draft_redirected');
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, storage TEXT NOT NULL, gate TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS drafts_gate ON drafts(storage,gate);
        CREATE TABLE IF NOT EXISTS gates (storage TEXT NOT NULL, gate TEXT NOT NULL, selected TEXT, cancel_at TEXT, PRIMARY KEY(storage,gate));
        CREATE TABLE IF NOT EXISTS cancellation_acknowledgements (storage TEXT NOT NULL, gate TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(storage,gate));
        CREATE TABLE IF NOT EXISTS imports (file TEXT PRIMARY KEY);`);
      db.exec('BEGIN IMMEDIATE');
      try {
        // The old file is retained byte for byte; an import marker prevents resurrection after ACK.
        for (const name of fs.readdirSync(this.directory).filter(name => this.legacyPrefixes(storageId).some(prefix => name.startsWith(prefix)) && name.endsWith('.json'))) {
          if (db.prepare('SELECT 1 FROM imports WHERE file=?').get(name)) continue;
          const value = this.readFile(path.join(this.directory, name)); value.localId = randomUUID();
          db.prepare('INSERT INTO drafts VALUES(?,?,?,?)').run(value.localId, value.storageId, value.interactionId, JSON.stringify(value));
          db.prepare('INSERT INTO imports VALUES(?)').run(name);
        }
        const result = action(db); db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
  private rows(db: DatabaseSync, storageId: string, interactionId?: string): UnconfirmedAnswer[] {
    const records = interactionId === undefined ? db.prepare('SELECT body FROM drafts WHERE storage=? ORDER BY rowid').all(storageId) : db.prepare('SELECT body FROM drafts WHERE storage=? AND gate=? ORDER BY rowid').all(storageId, interactionId);
    return records.map(row => draftSchema.parse(JSON.parse(String(row.body))));
  }
  list(storageId: string): UnconfirmedAnswer[] {
    if (!this.checkDirectory()) return [];
    return this.database(storageId, db => this.rows(db, storageId).map(row => {
      const gate = db.prepare('SELECT cancel_at FROM gates WHERE storage=? AND gate=?').get(storageId, row.interactionId);
      const acknowledgement = db.prepare('SELECT at FROM cancellation_acknowledgements WHERE storage=? AND gate=?').get(storageId, row.interactionId);
      return { ...row, ...(gate?.cancel_at ? { cancelRequestedAt: String(gate.cancel_at) } : {}), ...(acknowledgement ? { cancelAcknowledgedAt: String(acknowledgement.at) } : {}) };
    }));
  }
  save(input: UnconfirmedAnswer): UnconfirmedAnswer {
    const value = draftSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_INTERACTION_ANSWER_REQUEST_BYTES + 8192) throw new AppError('answer_draft_too_large');
    return this.database(value.storageId, db => {
      const old = value.localId ? this.rows(db, value.storageId, value.interactionId).find(row => row.localId === value.localId) : this.rows(db, value.storageId, value.interactionId).find(row => row.questionHash === value.questionHash && digest(canonical(row.answer)) === digest(canonical(value.answer)));
      if (value.localId && !old) throw new AppError('answer_draft_version_changed', 409);
      if (old && (old.questionHash !== value.questionHash || digest(canonical(old.answer)) !== digest(canonical(value.answer)) || old.runId !== value.runId || old.toolCallId !== value.toolCallId || old.contextId !== value.contextId)) throw new AppError('answer_draft_immutable', 409);
      const saved = { ...value, localId: old?.localId ?? randomUUID(), ...(old?.cancelRequestedAt ? { cancelRequestedAt: old.cancelRequestedAt } : {}), ...(old?.receiptId ? { receiptId: old.receiptId } : {}) };
      if (old?.receiptId && value.receiptId && old.receiptId !== value.receiptId) throw new AppError('interaction_answer_receipt_mismatch');
      db.prepare('INSERT INTO drafts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(saved.localId, saved.storageId, saved.interactionId, JSON.stringify(saved));
      if (saved.receiptId) db.prepare('INSERT INTO gates(storage,gate,selected) VALUES(?,?,?) ON CONFLICT(storage,gate) DO UPDATE SET selected=excluded.selected').run(saved.storageId, saved.interactionId, saved.localId);
      if (saved.cancelRequestedAt) db.prepare('INSERT INTO gates(storage,gate,cancel_at) VALUES(?,?,?) ON CONFLICT(storage,gate) DO UPDATE SET cancel_at=COALESCE(gates.cancel_at,excluded.cancel_at)').run(saved.storageId, saved.interactionId, saved.cancelRequestedAt);
      if (saved.cancelAcknowledgedAt) db.prepare('INSERT OR IGNORE INTO cancellation_acknowledgements VALUES(?,?,?)').run(saved.storageId, saved.interactionId, saved.cancelAcknowledgedAt);
      return saved;
    });
  }
  selected(storageId: string, interactionId: string): string | undefined {
    return this.database(storageId, db => { const row = db.prepare('SELECT selected FROM gates WHERE storage=? AND gate=?').get(storageId, interactionId); return row?.selected ? String(row.selected) : undefined; });
  }
  choose(storageId: string, interactionId: string, localId: string, expected: string[]): void {
    this.database(storageId, db => {
      const rows = this.rows(db, storageId, interactionId);
      if (JSON.stringify(rows.map(row => row.localId).sort()) !== JSON.stringify([...expected].sort()) || !rows.some(row => row.localId === localId)) throw new AppError('answer_draft_versions_changed', 409);
      const gate = db.prepare('SELECT cancel_at FROM gates WHERE storage=? AND gate=?').get(storageId, interactionId);
      if (gate?.cancel_at || rows.some(row => row.receiptId)) throw new AppError('interaction_answer_already_saved', 409);
      db.prepare('INSERT INTO gates(storage,gate,selected) VALUES(?,?,?) ON CONFLICT(storage,gate) DO UPDATE SET selected=excluded.selected').run(storageId, interactionId, localId);
    });
  }
  requestCancel(storageId: string, interactionId: string, at: string): void {
    this.database(storageId, db => { db.prepare('INSERT INTO gates(storage,gate,cancel_at) VALUES(?,?,?) ON CONFLICT(storage,gate) DO UPDATE SET cancel_at=COALESCE(gates.cancel_at,excluded.cancel_at)').run(storageId, interactionId, at); });
  }
  acknowledgeCancel(storageId: string, interactionId: string, at: string): void {
    this.database(storageId, db => { db.prepare('INSERT OR IGNORE INTO cancellation_acknowledgements VALUES(?,?,?)').run(storageId, interactionId, at); });
  }
  acknowledgeAnswer(storageId: string, interactionId: string, localId: string): void {
    this.database(storageId, db => {
      db.prepare('INSERT INTO gates(storage,gate,selected) VALUES(?,?,?) ON CONFLICT(storage,gate) DO UPDATE SET selected=excluded.selected').run(storageId, interactionId, localId);
      db.prepare('DELETE FROM drafts WHERE storage=? AND gate=? AND id=?').run(storageId, interactionId, localId);
    });
  }
  remove(storageId: string, interactionId: string, localIds: string[]): void {
    this.database(storageId, db => { for (const id of localIds) db.prepare('DELETE FROM drafts WHERE storage=? AND gate=? AND id=?').run(storageId, interactionId, id); });
  }
}

export function answerReceiptLabel(receipt: InteractionAnswerReceipt): string {
  if (receipt.cancelRequestedAt && !['delivered', 'cancelled'].includes(receipt.status)) return '取消处理中';
  if (receipt.status === 'pending') return '已保存，等待送达';
  if (receipt.status === 'delivering') return '正在送达';
  if (receipt.status === 'delivered') return '已送达';
  if (receipt.status === 'cancelled') return '已取消';
  if (receipt.status === 'unknown') return '已保存，送达未确认';
  return receipt.retryable ? '已保存，等待连接恢复' : '已保存，需要处理后继续';
}

type QuestionState = AnswerAddress & { status: string };
export interface AnswerDeliveryEntry {
  interactionId: string; contextId: string; runId: string;
  receipt?: InteractionAnswerReceipt; draft?: UnconfirmedAnswer; drafts?: UnconfirmedAnswer[]; selectionRequired?: boolean; errorCode?: string;
}
const terminalReceipt = (receipt: InteractionAnswerReceipt) => receipt.status === 'delivered' || receipt.status === 'cancelled';
export function boundAnswerReceipt(entry: AnswerDeliveryEntry): InteractionAnswerReceipt | undefined {
  return !entry.draft || entry.draft.receiptId === entry.receipt?.id ? entry.receipt : undefined;
}
export function answerDeliveryLabel(entry: AnswerDeliveryEntry): string {
  const receipt = boundAnswerReceipt(entry);
  if (entry.draft?.cancelAcknowledgedAt && !receipt) return '停止请求已确认，回答保留在本机';
  if (entry.draft?.cancelRequestedAt && !receipt) return '取消尚未确认';
  if (receipt) return answerReceiptLabel(receipt);
  if (entry.selectionRequired) return '本机保留了不同回答，请选择要送达的版本';
  if (entry.draft?.blockedCode === 'interaction_already_answered') return '本机回答未送达，该问题已有其他回答';
  return entry.draft?.blockedCode ? '回答保留在本机，需要核对' : '回答保留在本机，保存尚未确认';
}

/** Retries only saving an immutable answer; native execution and delivery belong to Core. */
export class InteractionAnswerDelivery {
  private readonly drafts = new Map<string, UnconfirmedAnswer>();
  private readonly dirty = new Set<string>();
  private readonly unpersisted = new Set<string>();
  private readonly selections = new Map<string, string>();
  private readonly receipts = new Map<string, InteractionAnswerReceipt>();
  private readonly errors = new Map<string, string>();
  private readonly saving = new Set<string>();
  constructor(readonly storageId: string, private readonly request: <T>(route: string, body?: unknown) => Promise<T>, private readonly cache?: InteractionAnswerDrafts, private readonly options: { receiptLookup?: boolean } = {}) {
    this.load();
  }
  private load(): void {
    if (!this.cache) return;
    const rows = this.cache.list(this.storageId), retained = [...this.drafts.values()].filter(row => this.dirty.has(row.localId!));
    this.drafts.clear();
    for (const draft of [...rows, ...retained]) this.drafts.set(draft.localId!, draft);
    for (const id of new Set([...this.drafts.values()].map(row => row.interactionId))) {
      const selected = this.cache.selected(this.storageId, id);
      if (selected) this.selections.set(id, selected); else this.selections.delete(id);
    }
  }
  private versions(id: string): UnconfirmedAnswer[] { return [...this.drafts.values()].filter(row => row.interactionId === id); }
  private selected(id: string): UnconfirmedAnswer | undefined {
    const rows = this.versions(id), selected = this.selections.get(id);
    return selected ? rows.find(row => row.localId === selected) : rows.length === 1 ? rows[0] : undefined;
  }
  private persist(draft: UnconfirmedAnswer): UnconfirmedAnswer {
    const value = { ...draft, localId: draft.localId ?? randomUUID() };
    if (!draft.localId) this.unpersisted.add(value.localId);
    // Keep confirmed editor input in this window even if the local disk is unavailable.
    this.drafts.set(value.localId, value);
    let saved: UnconfirmedAnswer;
    try { saved = this.cache?.save(this.unpersisted.has(value.localId) ? { ...value, localId: undefined } : value) ?? value; }
    catch (error) { this.dirty.add(value.localId); throw error; }
    this.dirty.delete(value.localId); this.unpersisted.delete(value.localId);
    if (saved.localId !== value.localId) this.drafts.delete(value.localId);
    this.drafts.set(saved.localId!, saved); return saved;
  }
  entries(): AnswerDeliveryEntry[] {
    const entries = new Map<string, AnswerDeliveryEntry>();
    for (const receipt of this.receipts.values()) entries.set(receipt.interactionId, { interactionId: receipt.interactionId, contextId: receipt.contextId, runId: receipt.runId, receipt });
    for (const id of new Set([...this.drafts.values()].map(row => row.interactionId))) {
      const rows = this.versions(id), selected = this.selected(id), draft = selected ?? rows[0]!;
      const entry = entries.get(id) ?? { interactionId: id, contextId: draft.contextId, runId: draft.runId };
      entry.draft = draft; entry.drafts = rows; entry.selectionRequired = rows.length > 1 && !selected && !rows.some(row => row.cancelRequestedAt || row.cancelAcknowledgedAt) && !rows.every(row => row.blockedCode);
      entry.errorCode = this.errors.get(id); entries.set(id, entry);
    }
    return [...entries.values()];
  }
  hasAnswer(id: string): boolean { return this.versions(id).length > 0 || [...this.receipts.values()].some(receipt => receipt.interactionId === id); }
  needsRefresh(): boolean { return [...this.drafts.values()].some(row => !row.cancelAcknowledgedAt && (!row.blockedCode || row.cancelRequestedAt)) || [...this.receipts.values()].some(receipt => !terminalReceipt(receipt)); }
  async stage(item: AnswerAddress, answer: InteractionAnswer): Promise<AnswerDeliveryEntry> {
    // The modal can outlive another client's answer. Preserve the newly confirmed text first.
    this.persist(draftSchema.parse(unconfirmedAnswer(this.storageId, item, answer))); this.load();
    const draft = this.selected(item.id);
    if (draft) await this.save(draft, item);
    return this.entries().find(entry => entry.interactionId === item.id)!;
  }
  async choose(id: string, localId: string, questions: QuestionState[]): Promise<void> {
    const rows = this.versions(id);
    if (!rows.some(row => row.localId === localId)) throw new AppError('answer_draft_versions_changed', 409);
    this.cache?.choose(this.storageId, id, localId, rows.map(row => row.localId!));
    this.selections.set(id, localId); this.load();
    await this.refresh(questions);
  }
  private remember(receipt: InteractionAnswerReceipt): void {
    this.receipts.set(receipt.id, receipt);
    if (!terminalReceipt(receipt)) return;
    const rows = this.versions(receipt.interactionId).filter(row => row.receiptId === receipt.id);
    if (!rows.length) return;
    for (const row of rows) this.cache?.acknowledgeAnswer(this.storageId, receipt.interactionId, row.localId!);
    for (const row of rows) { this.drafts.delete(row.localId!); this.dirty.delete(row.localId!); this.unpersisted.delete(row.localId!); }
    this.errors.delete(receipt.interactionId);
  }
  private bind(draft: UnconfirmedAnswer, answer: InteractionAnswerReceipt): void {
    if (answer.interactionId !== draft.interactionId || answer.runId !== draft.runId || answer.contextId !== draft.contextId || answer.toolCallId !== draft.toolCallId) throw new AppError('interaction_answer_receipt_mismatch');
    if (!this.drafts.has(draft.localId!)) return;
    draft.receiptId = answer.id; draft.updatedAt = new Date().toISOString(); delete draft.blockedCode;
    if (terminalReceipt(answer)) {
      this.receipts.set(answer.id, answer); this.selections.set(draft.interactionId, draft.localId!);
      this.drafts.set(draft.localId!, draft);
      try { this.cache?.acknowledgeAnswer(this.storageId, draft.interactionId, draft.localId!); }
      catch (error) { this.dirty.add(draft.localId!); throw error; }
      this.drafts.delete(draft.localId!); this.dirty.delete(draft.localId!); this.unpersisted.delete(draft.localId!); this.errors.delete(draft.interactionId); return;
    }
    this.persist(draft); this.selections.set(draft.interactionId, draft.localId!); this.errors.delete(draft.interactionId); this.remember(answer);
  }
  private async save(draft: UnconfirmedAnswer, item: QuestionState | AnswerAddress): Promise<void> {
    if (this.saving.has(draft.interactionId) || draft.receiptId || draft.blockedCode || draft.cancelRequestedAt) return;
    if (!matchesQuestion(draft, item)) { draft.blockedCode = 'interaction_question_changed'; this.persist(draft); return; }
    this.load();
    draft = this.drafts.get(draft.localId!)!;
    if (!draft || this.selected(draft.interactionId)?.localId !== draft.localId || draft.cancelRequestedAt) return;
    this.saving.add(draft.interactionId);
    try {
      this.persist(draft);
      const { answer } = await this.request<{ answer: InteractionAnswerReceipt }>(`/interactions/${encodeURIComponent(draft.interactionId)}/answer-outbox`, { expectedRunId: draft.runId, answer: draft.answer });
      this.bind(draft, answer);
    } catch (error) {
      this.errors.set(draft.interactionId, error instanceof AppError ? error.code : 'request_failed');
      if (error instanceof AppError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        draft.blockedCode = error.code; this.persist(draft);
      }
      throw error;
    } finally { this.saving.delete(draft.interactionId); }
  }
  async refresh(questions: QuestionState[]): Promise<void> {
    this.load();
    let after = 0;
    const active = new Set<string>();
    for (;;) {
      const page = await this.request<InteractionAnswerPage>(`/interaction-answers?active=1&after=${after}&limit=100`);
      for (const receipt of page.answers) { active.add(receipt.id); this.remember(receipt); }
      if (!page.hasMore) break;
      if (page.nextCursor <= after) throw new AppError('interaction_answer_cursor_invalid');
      after = page.nextCursor;
    }
    const known = new Set([...this.receipts.keys(), ...[...this.drafts.values()].flatMap(draft => draft.receiptId ? [draft.receiptId] : [])]);
    for (const id of known) if (!active.has(id)) {
      const { answer } = await this.request<{ answer: InteractionAnswerReceipt }>(`/interaction-answers/${encodeURIComponent(id)}`); this.remember(answer);
    }
    for (let draft of [...this.drafts.values()]) {
      if (this.dirty.has(draft.localId!)) {
        try { draft = this.persist(draft); }
        catch { this.errors.set(draft.interactionId, 'local_answer_save_failed'); }
      }
      if (!draft.receiptId && this.options.receiptLookup) {
        try {
          const { answer } = await this.request<{ answer: InteractionAnswerReceipt }>(`/interactions/${encodeURIComponent(draft.interactionId)}/answer-receipt`, { expectedRunId: draft.runId, answer: draft.answer });
          this.bind(draft, answer);
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 404) {
            this.errors.set(draft.interactionId, error instanceof AppError ? error.code : 'request_failed');
            if (!(error instanceof AppError) || error.status >= 500) continue;
            draft.blockedCode = error.code; this.persist(draft);
          }
        }
        if (!this.drafts.has(draft.localId!)) continue;
      }
      if (draft.cancelAcknowledgedAt) continue;
      if (draft.cancelRequestedAt) { await this.cancel(draft.interactionId, draft.runId).catch(() => {}); continue; }
      if (draft.receiptId || draft.blockedCode || this.selected(draft.interactionId)?.localId !== draft.localId) continue;
      const item = questions.find(question => question.id === draft.interactionId);
      if (item) await this.save(draft, item).catch(() => {});
    }
    for (const [id, receipt] of this.receipts) if (terminalReceipt(receipt) && !this.versions(receipt.interactionId).length && !questions.some(question => question.id === receipt.interactionId && question.status === 'pending')) this.receipts.delete(id);
  }
  async retry(id: string): Promise<void> {
    const entry = this.entries().find(row => row.interactionId === id); if (!entry) return;
    if (entry.draft?.cancelRequestedAt) { await this.cancel(id, entry.runId); return; }
    const receipt = boundAnswerReceipt(entry); if (!receipt) return;
    const { answer } = await this.request<{ answer: InteractionAnswerReceipt }>(`/interaction-answers/${encodeURIComponent(receipt.id)}/retry`, { expectedRunId: entry.runId }); this.remember(answer);
  }
  async cancel(id: string, runId: string): Promise<void> {
    try { this.load(); } catch { this.errors.set(id, 'local_answer_save_failed'); }
    const rows = this.versions(id), at = new Date().toISOString();
    if (rows.length && rows.every(row => row.cancelAcknowledgedAt)) return;
    try { this.cache?.requestCancel(this.storageId, id, at); } catch { this.errors.set(id, 'local_answer_save_failed'); }
    for (const draft of rows) { draft.cancelRequestedAt ??= at; try { this.persist(draft); } catch { this.errors.set(id, 'local_answer_save_failed'); } }
    await this.request(`/interactions/${encodeURIComponent(id)}/cancel`, { expectedRunId: runId });
    // A successful cancellation response is Core's durable decision; a lost response retains the intent.
    try { this.cache?.acknowledgeCancel(this.storageId, id, at); } catch { this.errors.set(id, 'local_answer_save_failed'); }
    for (const draft of rows) { draft.cancelAcknowledgedAt = at; try { this.persist(draft); } catch { this.errors.set(id, 'local_answer_save_failed'); } }
    if (!rows.some(row => this.dirty.has(row.localId!))) this.errors.delete(id);
    for (const [receiptId, receipt] of this.receipts) if (receipt.interactionId === id) {
      try { const result = await this.request<{ answer: InteractionAnswerReceipt }>(`/interaction-answers/${encodeURIComponent(receiptId)}`); this.remember(result.answer); }
      catch { /* The confirmed stop decision remains valid while receipt polling reconnects. */ }
    }
  }
}
