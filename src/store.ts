import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { OutputRecord, RunRecord, RunStatus, SignalInput, SignalRecord } from './domain.js';
import { AppError } from './domain.js';
import type { TaskRecord } from './runtime-store.js';

export interface ExecutionBinding {
  sourceSignalId: string; bodyHash: string; output: SignalInput['output'];
  taskId: string; contextId: string; attempt: number; signalId: string; runId: string | null; occurrenceId: string | null;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export interface AcceptedSignal { signal: SignalRecord; run: RunRecord }

export class Store {
  /** 同步资料观察者；异常与受理事务一起回滚，默认不产生行为。 */
  acceptanceObserver?: (receipt: AcceptedSignal) => void;
  private observeAcceptance(id: string) {
    if (!this.acceptanceObserver) return;
    const signal = this.getSignal(id); const run = signal?.runId ? this.getRun(signal.runId) : undefined;
    if (!signal || signal.status !== 'accepted' || !signal.nativeSignalId || !run || !['wake','deliver'].includes(signal.action ?? '')) throw new AppError('signal_not_accepted', 409);
    this.acceptanceObserver({ signal, run });
  }
  readonly db: DatabaseSync;
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
      CREATE TABLE IF NOT EXISTS execution_bindings (source_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, context_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_intents (seq INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 1, replaces TEXT, replaced_by TEXT);
      CREATE INDEX IF NOT EXISTS outputs_context ON outputs(context_id, seq);
      CREATE INDEX IF NOT EXISTS signals_run ON signals(run_id);
    `);
  }

  transaction<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  executionBinding(sourceId: string): ExecutionBinding | undefined {
    const row = this.db.prepare('SELECT body FROM execution_bindings WHERE source_id=?').get(sourceId);
    return row ? JSON.parse(row.body as string) as ExecutionBinding : undefined;
  }
  taskBinding(taskId: string): ExecutionBinding | undefined {
    const row = this.db.prepare('SELECT body FROM execution_bindings WHERE task_id=?').get(taskId);
    return row ? JSON.parse(row.body as string) as ExecutionBinding : undefined;
  }
  contextBinding(contextId: string): ExecutionBinding | undefined {
    const row = this.db.prepare('SELECT body FROM execution_bindings WHERE context_id=?').get(contextId);
    return row ? JSON.parse(row.body as string) as ExecutionBinding : undefined;
  }
  bindExecution(sourceId: string, task: TaskRecord, occurrenceId?: string) {
    const row = this.db.prepare('SELECT body FROM signals WHERE id=?').get(sourceId);
    if (!row || task.parentId || task.sourceSignalIds.length !== 1 || task.sourceSignalIds[0] !== sourceId) throw new AppError('invalid_execution_binding', 403);
    const source = JSON.parse(row.body as string) as SignalInput;
    const binding: ExecutionBinding = { sourceSignalId: sourceId, bodyHash: createHash('sha256').update(row.body as string).digest('hex'),
      output: source.output, taskId: task.id, contextId: task.contextId, attempt: task.attempt ?? 1, signalId: task.signalId, runId: null, occurrenceId: occurrenceId ?? null };
    this.db.prepare('INSERT INTO execution_bindings VALUES(?,?,?,?)').run(sourceId, task.id, task.contextId, JSON.stringify(binding));
  }
  prepareExecution(task: TaskRecord) {
    const binding = this.taskBinding(task.id); if (!binding) return;
    if (binding.contextId !== task.contextId || (task.attempt ?? 1) < binding.attempt) throw new AppError('invalid_execution_binding', 403);
    if (binding.attempt !== (task.attempt ?? 1) || binding.signalId !== task.signalId) {
      this.db.prepare('UPDATE execution_bindings SET body=? WHERE task_id=?').run(JSON.stringify({ ...binding, attempt: task.attempt ?? 1, signalId: task.signalId, runId: null }), task.id);
    }
  }
  acceptExecution(task: TaskRecord, runId: string, nativeId: string, action: 'wake' | 'deliver') {
    this.transaction(() => {
      const binding = this.taskBinding(task.id); if (!binding) return;
      if (binding.attempt !== (task.attempt ?? 1) || binding.signalId !== task.signalId || binding.contextId !== task.contextId) throw new AppError('invalid_execution_binding', 403);
      this.db.prepare('UPDATE execution_bindings SET body=? WHERE task_id=?').run(JSON.stringify({ ...binding, runId }), task.id);
      this.db.prepare("UPDATE signals SET status='accepted',native_id=?,run_id=?,action=?,error_code=NULL WHERE id=?").run(nativeId, runId, action, binding.sourceSignalId);
      this.observeAcceptance(binding.sourceSignalId);
    });
  }
  executionPolicy(contextId: string): ExecutionBinding {
    const binding = this.contextBinding(contextId);
    const row = binding && this.db.prepare('SELECT body FROM tasks WHERE id=?').get(binding.taskId);
    const task = row && JSON.parse(row.body as string) as TaskRecord;
    const sourceRow = binding && this.db.prepare('SELECT body FROM signals WHERE id=?').get(binding.sourceSignalId);
    const source = sourceRow && JSON.parse(sourceRow.body as string) as SignalInput;
    if (!binding || !task || task.parentId || task.contextId !== contextId || task.signalId !== binding.signalId ||
      task.occurrenceId !== binding.occurrenceId || task.returnContextId !== binding.output.contextId || task.sourceSignalIds.length !== 1 || task.sourceSignalIds[0] !== binding.sourceSignalId ||
      !['running', 'waiting'].includes(task.status) || (task.attempt ?? 1) !== binding.attempt || !sourceRow || !source ||
      createHash('sha256').update(sourceRow.body as string).digest('hex') !== binding.bodyHash ||
      source.output.kind !== binding.output.kind || source.output.contextId !== binding.output.contextId) throw new AppError('execution_binding_not_active', 403);
    return binding;
  }
  validateExecution(contextId: string, runId: string): ExecutionBinding {
    const binding = this.executionPolicy(contextId);
    const row = binding && this.db.prepare('SELECT body FROM tasks WHERE id=?').get(binding.taskId);
    const task = row && JSON.parse(row.body as string) as TaskRecord;
    const execution = this.getSignal(binding.signalId);
    const source = this.getSignal(binding.sourceSignalId);
    const attemptsRow = this.db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(`task-run-attempts:${binding.taskId}`);
    const attempts = attemptsRow ? JSON.parse(attemptsRow.body as string) as Record<string, number> : {};
    if (!task || task.runIds.at(-1) !== runId || attempts[runId] !== binding.attempt ||
      binding.runId !== runId || this.getRun(runId)?.contextId !== contextId || this.getRun(runId)?.status !== 'running' ||
      execution?.contextId !== contextId || execution.status !== 'accepted' || execution.runId !== runId ||
      source?.status !== 'accepted' || source.runId !== runId) throw new AppError('execution_binding_not_active', 403);
    return binding;
  }
  publishExecution(input: { kind: OutputRecord['kind']; runId: string; contextId: string; signalIds: string[]; toolCallId: string; title?: string; content: string }): OutputRecord {
    const binding = this.validateExecution(input.contextId, input.runId);
    const ids = [...new Set(input.signalIds)];
    if (ids.length !== 1 || ![binding.sourceSignalId, binding.signalId].includes(ids[0]!)) throw new AppError('output_source_not_in_run', 403);
    return this.publish({ ...input, signalIds: [binding.sourceSignalId] });
  }

  recoverInterrupted(preservedRuns: ReadonlySet<string> = new Set(),preservedSignals:ReadonlySet<string>=new Set()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const preserved = [...preservedRuns];
      this.db.prepare(`UPDATE runs SET status='interrupted', error_code='process_interrupted', finished_at=? WHERE status='running'${preserved.length ? ` AND id NOT IN (${preserved.map(() => '?').join(',')})` : ''}`).run(now(), ...preserved);
      const signalIds=[...preservedSignals];
      this.db.prepare(`UPDATE signals SET status='interrupted', error_code='process_interrupted' WHERE (status IN ('received','queued') OR (status='accepted' AND run_id IN (SELECT id FROM runs WHERE status='interrupted')))${signalIds.length?` AND id NOT IN (${signalIds.map(()=>'?').join(',')})`:''}`).run(...signalIds);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reopenNotification(id:string){
    const record=this.getSignal(id);if(!record||!['task-result','terminal-process'].includes(record.source)||record.type!=='external-event')throw new AppError('not_a_notification');
    this.db.prepare("UPDATE signals SET status='received',error_code=NULL WHERE id=? AND status IN ('rejected','interrupted','accepted')").run(id);
  }
  reopenUnadmitted(id:string){this.db.prepare("UPDATE signals SET status='received',error_code=NULL WHERE id=? AND native_id IS NULL AND run_id IS NULL AND status='interrupted'").run(id);}
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

  queue(id:string,nativeId:string,runId:string) {
    this.db.prepare("UPDATE signals SET status='queued',native_id=?,run_id=?,action=NULL WHERE id=? AND status='received'").run(nativeId,runId,id);
  }
  cancelQueued(id:string,status:'cancelled'|'interrupted'='cancelled') {
    this.db.prepare("UPDATE signals SET status=?,error_code=? WHERE id=? AND status='queued'").run(status,status==='interrupted'?'process_interrupted':null,id);
    this.db.prepare('UPDATE message_intents SET revision=revision+1 WHERE signal_id=?').run(id);
  }
  accept(id: string, nativeId: string, runId: string, action: 'wake' | 'deliver', contextId: string) {
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO runs(id,context_id,status,created_at) VALUES(?,?,'running',?)").run(runId, contextId, now());
      this.db.prepare("UPDATE signals SET status='accepted', native_id=?,run_id=?,action=? WHERE id=?").run(nativeId, runId, action, id);
      this.observeAcceptance(id);
    });
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
      if (signal.output.kind !== 'both' && signal.output.kind !== input.kind) throw new AppError('output_kind_not_allowed');
      if (destination && destination !== signal.output.contextId) throw new AppError('output_target_conflict');
      destination = signal.output.contextId;
    }
    const previous = this.db.prepare('SELECT * FROM outputs WHERE run_id=? AND tool_call_id=?').get(input.runId, input.toolCallId);
    if (previous) return this.output(previous);
    if(input.kind==='message'&&ids.every(id=>this.getSignal(id)?.source==='task-result')){
      const delivered=ids.map(id=>this.outputsForSignal(id).find(output=>output.kind==='message'));
      if(delivered.every(Boolean))return delivered[0]!;
    }
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

  outputsForSignal(signalId: string): OutputRecord[] {
    return this.db.prepare('SELECT * FROM outputs WHERE EXISTS(SELECT 1 FROM json_each(signal_ids) WHERE value=?) ORDER BY seq')
      .all(signalId).map(row => this.output(row));
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
