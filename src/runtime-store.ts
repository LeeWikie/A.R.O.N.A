import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, contextIdSchema } from './domain.js';
import { PublicThinkingProjection } from './public-thinking.js';
import { PublicReplyProjection } from './public-replies.js';
import { SnapshotStorage } from './storage/snapshots.js';

export type ContextRole = 'main' | 'work' | 'memory';
export interface ContextRecord {
  id: string; name: string; role: ContextRole; purpose: string; workspaceId: string;
  parentContextId?:string;parentRunId?:string;workingSet?:{kind:'selected-turn-range';fromRunId:string;throughRunId:string};
  modelProfile: string; archived: boolean; createdAt: string; updatedAt: string;
}
export type TaskStatus = 'pending' | 'running' | 'waiting' | 'pausing' | 'cancelling' | 'paused' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted' | 'unreported';
export interface TaskRecord {
  id: string; title: string; content: string; contextId: string; returnContextId: string;
  parentId: string | null; signalId: string; sourceSignalIds: string[]; occurrenceId: string | null;
  status: TaskStatus; revision: number; attempt: number; toolGrants?: {toolName:string;args:unknown;contextId:string;capabilityKey:string}[]; mcpKeys?:string[]; nativeTaskId: string | null; runIds: string[];
  grants: { write: boolean; execute: boolean; mcp: boolean };
  report: TaskReport | null; createdAt: string; updatedAt: string;
}
export interface TaskReport {
  outcome: 'succeeded' | 'failed' | 'blocked'; summary: string;
  checks: { description: string; passed: boolean }[];
  deliveries: { kind: 'text' | 'json' | 'file' | 'markdown'; title: string; value: unknown; sha256?: string }[];
  unresolved: string[];
}
export interface RuntimeEvent { seq: number; contextId: string; taskId: string | null; runId: string | null; kind: string; data: unknown; createdAt: string }
export interface ApprovalRecord {
  id: string; contextId: string; taskId: string | null; runId: string; toolCallId: string;
  toolName: string; args: unknown; capabilityKey?:string; status: 'pending' | 'approved' | 'declined' | 'interrupted'; createdAt: string;
}
const stamp = () => new Date().toISOString();
type Row = Record<string, unknown>;
export class RuntimeStore {
  private readonly subscribers=new Set<()=>void>();
  private wakeScheduled=false;
  private readonly thinking: PublicThinkingProjection;
  private readonly replies: PublicReplyProjection;
  private readonly snapshots: SnapshotStorage;
  /** Configure before ingesting reasoning; unavailable secrets block that stream without exposing raw data. */
  configurePublicThinkingSecrets(get: () => readonly string[]) { this.thinking.configureSecrets(get); this.replies.configureSecrets(get); }
  publicThinking(seq: number) { return this.thinking.get(seq); }
  publicReply(seq: number) { return this.replies.event(seq); }
  publicOutput(id: string) { return this.replies.output(id); }
  publicLegacyMessage(id: string, content: string) { return this.replies.legacyMessage(id, content); }
  eventHead(){return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS head FROM runtime_events').get()!.head);}
  subscribe(listener:()=>void){this.subscribers.add(listener);return ()=>{this.subscribers.delete(listener);};}
  private wake(){if(this.wakeScheduled)return;this.wakeScheduled=true;queueMicrotask(()=>{this.wakeScheduled=false;for(const listener of this.subscribers)listener();});}

  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_schema(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO runtime_schema VALUES(1);
      CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, context_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_context ON tasks(context_id,status);
      CREATE TABLE IF NOT EXISTS runtime_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL,
        task_id TEXT, run_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, event_key TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS runtime_events_context ON runtime_events(context_id,seq);
      CREATE INDEX IF NOT EXISTS runtime_events_task_seq ON runtime_events(task_id,seq);
      CREATE INDEX IF NOT EXISTS runtime_events_run_seq ON runtime_events(run_id,seq);
      CREATE TABLE IF NOT EXISTS runtime_settings(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_operations(id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_notifications(id TEXT PRIMARY KEY, context_id TEXT NOT NULL, body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_snapshots(run_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, body TEXT NOT NULL);
    `);
    if(!db.prepare('PRAGMA table_info(task_notifications)').all().some(column=>column.name==='cancelled'))db.exec('ALTER TABLE task_notifications ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0');
    this.thinking = new PublicThinkingProjection(db);
    this.replies = new PublicReplyProjection(db);
    this.snapshots = new SnapshotStorage(db);
  }
  context(id: string): ContextRecord | undefined { return this.read<ContextRecord>('contexts', id); }
  contexts(query = '') { return this.all<ContextRecord>('contexts').filter(x => !query || `${x.name} ${x.purpose} ${x.id}`.toLowerCase().includes(query.toLowerCase())); }
  createContext(input: Pick<ContextRecord, 'id' | 'name' | 'role'> & Partial<ContextRecord>) {
    if (!contextIdSchema.safeParse(input.id).success) throw new AppError('invalid_context');
    if (this.context(input.id)) throw new AppError('context_exists', 409);
    const time = stamp();
    const record: ContextRecord = { purpose: '', workspaceId: 'default', modelProfile: 'default', archived: false, createdAt: time, updatedAt: time, ...input };
    this.atomic(()=>{this.put('contexts',record.id,record);this.event({contextId:record.id,kind:'context_state',data:{id:record.id}});});return record;
  }
  updateContext(id: string, patch: Partial<Pick<ContextRecord, 'name' | 'purpose' | 'modelProfile' | 'archived'>>) {
    const old = this.context(id); if (!old) throw new AppError('context_not_found', 404);
    const record = { ...old, ...patch, updatedAt: stamp() }; this.atomic(()=>{this.put('contexts',id,record);this.event({contextId:id,kind:'context_state',data:{id}});});return record;
  }
  task(id: string): TaskRecord { const record = this.read<TaskRecord>('tasks', id); if (!record) throw new AppError('task_not_found', 404); return record; }
  tasks(options: { contextId?: string; status?: string; query?: string } = {}) {
    return this.all<TaskRecord>('tasks').filter(x => (!options.contextId || options.contextId === x.contextId) && (!options.status || options.status === x.status) && (!options.query || `${x.title} ${x.content}`.toLowerCase().includes(options.query.toLowerCase())));
  }
  createTask(input: Pick<TaskRecord, 'title' | 'content' | 'contextId' | 'returnContextId' | 'sourceSignalIds'> & Partial<TaskRecord>) {
    const time = stamp(); const record: TaskRecord = { id: randomUUID(), parentId: null, occurrenceId: null, status: 'pending', revision: 1, attempt:1,
      nativeTaskId: null, signalId: randomUUID(), runIds: [], grants: { write: false, execute: false, mcp: false }, report: null, createdAt: time, updatedAt: time, ...input };
    this.saveTask(record); return record;
  }
  updateTask(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'createdAt' | 'revision'>>, revision?: number) {
    const old = this.task(id); if (revision !== undefined && old.revision !== revision) throw new AppError('task_revision_conflict', 409);
    const record = { ...old, ...patch, revision: old.revision + 1, updatedAt: stamp() }; this.saveTask(record); return record;
  }
  private atomic<T>(action:()=>T):T {
    if(this.db.isTransaction)return action();this.db.exec('BEGIN IMMEDIATE');
    try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private saveTask(record:TaskRecord){
    this.atomic(()=>{
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET context_id=excluded.context_id,status=excluded.status,body=excluded.body').run(record.id,record.contextId,record.status,JSON.stringify(record));
      this.event({contextId:record.contextId,taskId:record.id,kind:'task_state',data:{id:record.id,status:record.status,revision:record.revision}});
    });
  }
  event(input: { contextId: string; taskId?: string | null; runId?: string | null; kind: string; data: unknown; key?: string }) {
    this.atomic(() => {
      const createdAt = stamp();
      const result = this.db.prepare('INSERT OR IGNORE INTO runtime_events(context_id,task_id,run_id,kind,data,created_at,event_key) VALUES(?,?,?,?,?,?,?)')
        .run(input.contextId, input.taskId ?? null, input.runId ?? null, input.kind, JSON.stringify(input.data), createdAt, input.key ?? null);
      if (Number(result.changes) === 0) return;
      this.thinking.observe({ seq: Number(result.lastInsertRowid), contextId: input.contextId, taskId: input.taskId ?? null,
        runId: input.runId ?? null, kind: input.kind, data: input.data, createdAt });
      this.replies.observe({ seq: Number(result.lastInsertRowid), contextId: input.contextId, taskId: input.taskId ?? null,
        runId: input.runId ?? null, kind: input.kind, data: input.data, createdAt });
    });
    this.wake();
  }
  events(contextId?: string, after = 0, limit = 100): RuntimeEvent[] {
    return this.db.prepare('SELECT * FROM runtime_events WHERE seq>? AND (? IS NULL OR context_id=?) ORDER BY seq LIMIT ?')
      .all(after, contextId ?? null, contextId ?? null, Math.min(limit, 1000)).map((x: Row) => ({ seq: Number(x.seq), contextId: x.context_id as string,
        taskId: x.task_id as string | null, runId: x.run_id as string | null, kind: x.kind as string, data: JSON.parse(x.data as string), createdAt: x.created_at as string }));
  }
  taskOwnEvents(id: string, after = 0, limit = 100): RuntimeEvent[] {
    this.task(id);
    return this.db.prepare('SELECT * FROM runtime_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(id, after, Math.min(limit, 1000)).map((x: Row) => ({ seq: Number(x.seq), contextId: x.context_id as string,
        taskId: x.task_id as string | null, runId: x.run_id as string | null, kind: x.kind as string,
        data: JSON.parse(x.data as string), createdAt: x.created_at as string }));
  }
  taskEvents(id: string, after = 0, limit = 100, lifecycleOnly = false, includeRuns = true): RuntimeEvent[] {
    const task = this.task(id);
    const rows = this.db.prepare(`SELECT * FROM runtime_events WHERE seq IN (
      SELECT seq FROM runtime_events WHERE task_id=? AND seq>?
      UNION
      SELECT seq FROM runtime_events WHERE run_id IN (SELECT value FROM json_each(?)) AND seq>?
    ) AND context_id=? ${lifecycleOnly ? "AND kind IN ('agent_start','agent_end')" : ''} ORDER BY seq LIMIT ?`).all(id, after, JSON.stringify(includeRuns ? task.runIds : []), after, task.contextId, Math.min(limit, 1000));
    return rows.map((x: Row) => ({ seq: Number(x.seq), contextId: x.context_id as string,
      taskId: x.task_id as string | null, runId: x.run_id as string | null, kind: x.kind as string,
      data: JSON.parse(x.data as string), createdAt: x.created_at as string }));
  }
  setting<T>(id: string, fallback: T): T { return this.read<T>('runtime_settings', id) ?? fallback; }
  queueEditDocuments<T>():T[]{return this.db.prepare("SELECT body FROM runtime_settings WHERE id LIKE 'queue-edit:%' ORDER BY rowid").all().map(row=>JSON.parse(String(row.body)) as T);}
  setSetting(id: string,value:unknown){this.atomic(()=>{this.put('runtime_settings',id,value);if(['models','workspaces','mcp','memory-enabled','memory-context-mode','memory-context-policy','max-steps','default-work-model','memory-model','web','context-overflow','auto-compaction'].includes(id))this.event({contextId:'main',kind:'configuration_state',data:{key:id}});});}
  operation<T>(key: string, request: unknown, action: () => T): T {
    const encoded = JSON.stringify(request); const previous = this.db.prepare('SELECT * FROM runtime_operations WHERE id=?').get(key);
    if (previous) { if (previous.request !== encoded) throw new AppError('operation_id_conflict', 409); return JSON.parse(previous.result as string) as T; }
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.prepare('INSERT INTO runtime_operations VALUES(?,?,?)').run(key, encoded, JSON.stringify(result)); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addApproval(record:ApprovalRecord){this.atomic(()=>{this.db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?)').run(record.id,record.status,JSON.stringify(record));this.event({contextId:record.contextId,runId:record.runId,taskId:record.taskId,kind:'approval_state',data:{id:record.id,status:record.status}});});}
  approvals() { return this.all<ApprovalRecord>('approvals'); }
  approval(id: string) { const record = this.read<ApprovalRecord>('approvals', id); if (!record) throw new AppError('approval_not_found', 404); return record; }
  decideApproval(id: string, status: ApprovalRecord['status']) {
    const record={...this.approval(id),status};this.atomic(()=>{this.db.prepare('UPDATE approvals SET status=?,body=? WHERE id=?').run(status,JSON.stringify(record),id);this.event({contextId:record.contextId,runId:record.runId,taskId:record.taskId,kind:'approval_state',data:{id,status}});});return record;
  }
  // Reserved pending state 2 keeps opt-in companion wakes invisible to older
  // clients whose outbox query only understands pending 0 and acknowledged 1.
  notify(id: string, contextId: string, data: unknown) { const pending=data&&typeof data==='object'&&'kind'in data&&data.kind==='companion-wake'?2:0;this.db.prepare('INSERT OR IGNORE INTO task_notifications(id,context_id,body,delivered) VALUES(?,?,?,?)').run(id, contextId, JSON.stringify(data),pending); }
  pendingNotifications() { return this.db.prepare('SELECT * FROM task_notifications WHERE delivered IN (0,2) AND cancelled=0').all().map(x => ({ id: x.id as string, contextId: x.context_id as string, data: JSON.parse(x.body as string) as unknown })); }
  cancelNotification(id:string){this.db.prepare('UPDATE task_notifications SET cancelled=1 WHERE id=? AND delivered IN (0,2)').run(id);}
  notified(id: string) { this.db.prepare('UPDATE task_notifications SET delivered=1 WHERE id=?').run(id); }
  snapshot(contextId: string, runId: string, body: unknown) { this.snapshots.put(contextId, runId, body); }
  archiveSnapshot(contextId: string, runId: string, body: unknown, evidence: { sequence: number; sha256: string }) {
    this.atomic(() => {
      this.snapshot(contextId, runId, body);
      this.event({ contextId, runId, kind: 'context_snapshot', data: evidence, key: `snapshot:${runId}` });
    });
  }
  getSnapshot(runId: string): { contextId: string; body: unknown } | undefined {
    const row = this.db.prepare('SELECT * FROM model_snapshots WHERE run_id=?').get(runId);
    if (!row) return;
    let body: unknown; try { body = JSON.parse(row.body as string); } catch { throw new AppError('context_snapshot_corrupt', 409); }
    return { contextId: row.context_id as string, body: this.snapshots.materialize(body) };
  }
  recover(preservedRuns: ReadonlySet<string> = new Set(), preservedApprovals: ReadonlySet<string> = new Set()) {
    for (const task of this.tasks()) if (['running', 'waiting', 'pausing','cancelling'].includes(task.status) && !task.runIds.some(id => preservedRuns.has(id))) this.updateTask(task.id, { status: 'interrupted' });
    for (const approval of this.approvals()) if (approval.status === 'pending' && !preservedApprovals.has(approval.id)) this.decideApproval(approval.id, 'interrupted');
  }
  private read<T>(table: 'contexts' | 'tasks' | 'runtime_settings' | 'approvals', id: string): T | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.body as string) as T : undefined;
  }
  private all<T>(table: 'contexts' | 'tasks' | 'approvals'): T[] { return this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all().map(x => JSON.parse(x.body as string) as T); }
  private put(table: 'contexts' | 'runtime_settings', id: string, body: unknown) { this.db.prepare(`INSERT INTO ${table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id, JSON.stringify(body)); }
}
