import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createSkill } from '@mastra/core/skills';
import type { RuntimeStore } from './runtime-store.js';
import { AppError } from './domain.js';

const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const revisionSchema = z.number().int().positive().safe();
const methodSchema = z.object({
  name: nameSchema, description: z.string().min(1).max(1024),
  instructions: z.string().min(1).max(100_000), references: z.record(z.string(), z.string()).default({}),
  evidenceTaskIds: z.array(z.string().uuid()).min(1).max(32),
}).strict();
const recordSchema = methodSchema.extend({ revision: revisionSchema, enabled: z.boolean(), updatedAt: z.string() }).strict();
export interface MethodRecord extends z.infer<typeof methodSchema> { revision: number; enabled: boolean; updatedAt: string }

function validateReferences(references: Record<string, string>) {
  for (const ref of Object.keys(references)) {
    if (!ref || ref.includes(String.fromCharCode(92)) || ref.includes(':') || ref.includes('\0') || ref.split('/').some(part => !part || part === '.' || part === '..')) throw new AppError('invalid_method_reference');
  }
}

export class Methods {
  constructor(private readonly store: RuntimeStore, private readonly directory: string) {
    this.store.db.exec('CREATE TABLE IF NOT EXISTS method_revisions(name TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(name, revision))');
  }
  list() { return this.store.setting<MethodRecord[]>('methods', []); }
  get(name: string) { const found = this.list().find(x => x.name === name); if (!found) throw new AppError('method_not_found', 404); return found; }
  skills() { return this.list().filter(x => x.enabled).map(x => createSkill({ name: x.name, description: x.description, instructions: x.instructions, references: x.references, metadata: { revision: x.revision } })); }
  save(body: unknown, expectedRevision?: number) {
    const parsed = methodSchema.safeParse(body); if (!parsed.success) throw new AppError('invalid_method');
    validateReferences(parsed.data.references);
    if (expectedRevision !== undefined && !revisionSchema.safeParse(expectedRevision).success) throw new AppError('invalid_method_revision');
    return this.transaction(() => {
      this.requireEvidence(parsed.data.evidenceTaskIds);
      const rows = this.list(); const old = rows.find(x => x.name === parsed.data.name);
      if (old ? expectedRevision !== old.revision : expectedRevision !== undefined) throw new AppError('method_revision_conflict', 409);
      const next: MethodRecord = { ...parsed.data, revision: (old?.revision ?? 0) + 1, enabled: old?.enabled ?? true, updatedAt: new Date().toISOString() };
      createSkill({ name: next.name, description: next.description, instructions: next.instructions, references: next.references });
      return this.commit(rows, next);
    });
  }
  propose(body:unknown,expectedRevision:number|undefined,contextId:string,runId:string,key:string) {
    const parsed=methodSchema.safeParse(body);if(!parsed.success)throw new AppError('invalid_method');validateReferences(parsed.data.references);
    createSkill({name:parsed.data.name,description:parsed.data.description,instructions:parsed.data.instructions,references:parsed.data.references});
    const evidence=parsed.data.evidenceTaskIds.map(id=>this.store.task(id));
    if(evidence.every(task=>task.status==='succeeded'))return this.save(parsed.data,expectedRevision);
    if(evidence.some(task=>task.status!=='succeeded'&&(task.contextId!==contextId||!task.runIds.includes(runId)||!['running','waiting'].includes(task.status)||task.report?.outcome!=='succeeded'||task.report.checks.some(x=>!x.passed)||task.report.unresolved.length)))throw new AppError('method_requires_verified_work',409);
    const rows=this.pending();const existing=rows.find(row=>row.id===key);if(existing)return existing;
    const proposal={id:key,body:parsed.data,expectedRevision,runId,status:'pending' as const,error:null as string|null};
    this.store.setSetting('method-proposals',[...rows,proposal]);return proposal;
  }
  pending(){return this.store.setting<{id:string;body:z.infer<typeof methodSchema>;expectedRevision?:number;runId:string;status:'pending'|'published'|'rejected';error:string|null}[]>('method-proposals',[]);}
  finalizePending(){
    for(const proposal of this.pending().filter(x=>x.status==='pending'))this.transaction(()=>{
      const tasks=proposal.body.evidenceTaskIds.map(id=>this.store.task(id));
      if(tasks.some(task=>['pending','running','waiting','pausing','cancelling'].includes(task.status)))return;
      let status:'published'|'rejected'='published';let error:string|null=null;
      try{this.save(proposal.body,proposal.expectedRevision);}catch(cause){status='rejected';error=cause instanceof AppError?cause.code:'method_publication_failed';}
      this.store.setSetting('method-proposals',this.pending().map(x=>x.id===proposal.id?{...x,status,error}:x));
      this.store.event({contextId:tasks[0]!.contextId,runId:proposal.runId,kind:'method_publication',data:{name:proposal.body.name,status,error}});
    });
  }
  control(name: string, enabled: boolean, revision: number) {
    if (typeof enabled !== 'boolean' || !revisionSchema.safeParse(revision).success) throw new AppError('invalid_method_revision');
    return this.transaction(() => {
      const rows = this.list(); const old = rows.find(x => x.name === name); if (!old) throw new AppError('method_not_found', 404);
      if (old.revision !== revision) throw new AppError('method_revision_conflict', 409);
      if (enabled) this.requireEvidence(old.evidenceTaskIds);
      return this.commit(rows, { ...old, enabled, revision: old.revision + 1, updatedAt: new Date().toISOString() });
    });
  }
  rollback(name: string, revision: number, expectedRevision: number) {
    if (!nameSchema.safeParse(name).success || !revisionSchema.safeParse(revision).success || !revisionSchema.safeParse(expectedRevision).success) throw new AppError('invalid_method_revision');
    return this.transaction(() => {
      const rows = this.list(); const old = rows.find(x => x.name === name); if (!old) throw new AppError('method_not_found', 404);
      if (old.revision !== expectedRevision) throw new AppError('method_revision_conflict', 409);
      if (revision > old.revision) throw new AppError('method_revision_not_found', 404);
      const row = this.store.db.prepare('SELECT body FROM method_revisions WHERE name=? AND revision=?').get(name, revision);
      const body = row ? String(row.body) : this.legacyRevision(name, revision);
      if (!body) throw new AppError('method_revision_not_found', 404);
      let value: unknown; try { value = JSON.parse(body); } catch { throw new AppError('invalid_method_archive', 409); }
      const parsed = recordSchema.safeParse(value);
      if (!parsed.success || parsed.data.name !== name || parsed.data.revision !== revision) throw new AppError('invalid_method_archive', 409);
      const historic = parsed.data; validateReferences(historic.references);
      if (historic.enabled) this.requireEvidence(historic.evidenceTaskIds);
      createSkill({ name: historic.name, description: historic.description, instructions: historic.instructions, references: historic.references });
      return this.commit(rows, { ...historic, revision: old.revision + 1, updatedAt: new Date().toISOString() });
    });
  }
  private requireEvidence(ids: string[]) {
    for (const id of ids) {
      const task = this.store.task(id);
      if (task.status !== 'succeeded' || task.report?.outcome !== 'succeeded' || !task.report.checks.length || task.report.checks.some(x => !x.passed) || task.report.unresolved.length) throw new AppError('method_requires_verified_work', 409);
    }
  }
  private transaction<T>(action: () => T): T {
    const nested=this.store.db.isTransaction;this.store.db.exec(nested?'SAVEPOINT method_change':'BEGIN IMMEDIATE');
    try{const result=action();this.store.db.exec(nested?'RELEASE method_change':'COMMIT');return result;}
    catch(error){this.store.db.exec(nested?'ROLLBACK TO method_change':'ROLLBACK');if(nested)this.store.db.exec('RELEASE method_change');throw error;}
  }
  private commit(rows: MethodRecord[], next: MethodRecord) {
    this.store.db.prepare('INSERT INTO method_revisions(name,revision,body) VALUES(?,?,?)').run(next.name, next.revision, JSON.stringify(next));
    this.store.setSetting('methods', [...rows.filter(x => x.name !== next.name), next]); return next;
  }
  private legacyRevision(name: string, revision: number): string | undefined {
    const directory = path.join(this.directory, name); const file = path.join(directory, `${revision}.json`);
    try {
      for (const component of [this.directory, directory]) { const stat = fs.lstatSync(component); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('invalid_method_archive', 409); }
      const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AppError('invalid_method_archive', 409);
      return fs.readFileSync(file, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}
