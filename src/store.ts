import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { OutputRecord, RunRecord, RunStatus, SignalInput, SignalRecord } from './domain.js';
import { AppError } from './domain.js';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export class Store {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL,
        native_id TEXT, run_id TEXT, action TEXT, error_code TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, context_id TEXT NOT NULL, status TEXT NOT NULL,
        error_code TEXT, created_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS outputs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, context_id TEXT NOT NULL, run_id TEXT NOT NULL,
        signal_ids TEXT NOT NULL, title TEXT, content TEXT NOT NULL,
        tool_call_id TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id)
      );
      CREATE INDEX IF NOT EXISTS outputs_context ON outputs(context_id, seq);
      CREATE INDEX IF NOT EXISTS signals_run ON signals(run_id);
    `);
  }

  recoverInterrupted() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE runs SET status='interrupted', error_code='process_interrupted', finished_at=? WHERE status='running'").run(now());
      this.db.exec("UPDATE signals SET status='interrupted', error_code='process_interrupted' WHERE status='received' OR (status='accepted' AND run_id IN (SELECT id FROM runs WHERE status='interrupted'))");
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  receive(input: SignalInput): { record: SignalRecord; fresh: boolean } {
    const body = JSON.stringify(input);
    const existing = this.db.prepare('SELECT body FROM signals WHERE id=?').get(input.id);
    if (existing) {
      if (existing.body !== body) throw new AppError('signal_id_conflict', 409);
      return { record: this.getSignal(input.id)!, fresh: false };
    }
    this.db.prepare("INSERT INTO signals(id,body,status,created_at) VALUES(?,?,'received',?)").run(input.id, body, now());
    return { record: this.getSignal(input.id)!, fresh: true };
  }

  accept(id: string, nativeId: string, runId: string, action: 'wake' | 'deliver', contextId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT OR IGNORE INTO runs(id,context_id,status,created_at) VALUES(?,?,'running',?)").run(runId, contextId, now());
      this.db.prepare("UPDATE signals SET status='accepted', native_id=?,run_id=?,action=? WHERE id=?").run(nativeId, runId, action, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reject(id: string, code: string) {
    this.db.prepare("UPDATE signals SET status='rejected',error_code=? WHERE id=? AND status='received'").run(code, id);
  }

  finishRun(id: string, status: Exclude<RunStatus, 'running'>, errorCode: string | null = null) {
    this.db.prepare("UPDATE runs SET status=?,error_code=?,finished_at=? WHERE id=? AND status='running'").run(status, errorCode, now(), id);
    if (status === 'interrupted') {
      this.db.prepare("UPDATE signals SET status='interrupted',error_code=? WHERE run_id=? AND status='accepted'").run(errorCode, id);
    }
  }

  getSignal(id: string): SignalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM signals WHERE id=?').get(id);
    if (!row) return undefined;
    return {
      ...JSON.parse(row.body as string) as SignalInput,
      status: row.status as SignalRecord['status'],
      nativeSignalId: row.native_id as string | null,
      runId: row.run_id as string | null,
      action: row.action as SignalRecord['action'],
      errorCode: row.error_code as string | null,
      createdAt: row.created_at as string,
    };
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    return row && {
      id: row.id as string, contextId: row.context_id as string,
      status: row.status as RunStatus, errorCode: row.error_code as string | null,
      createdAt: row.created_at as string, finishedAt: row.finished_at as string | null,
    };
  }

  publish(input: {
    kind: OutputRecord['kind']; runId: string; signalIds: string[];
    toolCallId: string; title?: string; content: string;
  }): OutputRecord {
    const run = this.getRun(input.runId);
    if (!run || run.status !== 'running') throw new AppError('run_not_active', 409);
    const ids = [...new Set(input.signalIds)];
    if (!ids.length) throw new AppError('output_requires_source');
    let destination: string | undefined;
    for (const id of ids) {
      const signal = this.getSignal(id);
      if (!signal || signal.runId !== input.runId || signal.status !== 'accepted') {
        throw new AppError('output_source_not_in_run');
      }
      if (signal.output.kind !== input.kind) throw new AppError('output_kind_not_allowed');
      if (destination && destination !== signal.output.contextId) throw new AppError('output_target_conflict');
      destination = signal.output.contextId;
    }
    const previous = this.db.prepare('SELECT * FROM outputs WHERE run_id=? AND tool_call_id=?').get(input.runId, input.toolCallId);
    if (previous) return this.output(previous);
    const result = this.db.prepare(`INSERT INTO outputs(id,kind,context_id,run_id,signal_ids,title,content,tool_call_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.kind, destination!, input.runId,
      JSON.stringify(ids), input.title ?? null, input.content, input.toolCallId, now());
    return this.output(this.db.prepare('SELECT * FROM outputs WHERE seq=?').get(result.lastInsertRowid)!);
  }

  listOutputs(options: { after: number; kind?: OutputRecord['kind']; contextId?: string; limit?: number }) {
    const rows = this.db.prepare(`SELECT * FROM outputs WHERE seq > ?
      AND (? IS NULL OR kind=?) AND (? IS NULL OR context_id=?) ORDER BY seq LIMIT ?`)
      .all(options.after, options.kind ?? null, options.kind ?? null,
        options.contextId ?? null, options.contextId ?? null, options.limit ?? 100);
    return rows.map((row) => this.output(row));
  }

  private output(row: Row): OutputRecord {
    return {
      seq: Number(row.seq), id: row.id as string, kind: row.kind as OutputRecord['kind'],
      contextId: row.context_id as string, runId: row.run_id as string,
      signalIds: JSON.parse(row.signal_ids as string) as string[], title: row.title as string | null,
      content: row.content as string, createdAt: row.created_at as string,
    };
  }

  close() { this.db.close(); }
}
