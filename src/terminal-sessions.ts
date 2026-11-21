import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './domain.js';
import { coreLocation } from './startup.js';
import { sensitiveFile } from './file-policy.js';
import type { RuntimeStore, ContextRecord } from './runtime-store.js';
import type { Capabilities, WorkspaceRoot } from './capabilities.js';

export interface DirectoryIdentity { path: string; dev: string; ino: string }
export function directoryIdentity(directory: string): DirectoryIdentity {
  try {
    const real = fs.realpathSync(directory), stat = fs.lstatSync(real, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('workspace_not_directory', 409);
    return { path: real, dev: String(stat.dev), ino: String(stat.ino) };
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError('workspace_directory_unavailable', 409); }
}
const identitySchema = z.object({ path: z.string().min(1).max(32768), dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict();
export const terminalSessionRequestSchema = z.object({
  mode: z.enum(['new', 'continue']),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), directory: identitySchema, owner: z.string().uuid(), storageId: z.string().uuid(), instanceId: z.string().uuid() }).strict(),
    z.object({ kind: z.literal('workspace'), workspaceId: z.string().regex(/^[\w.-]{1,80}$/) }).strict(),
  ]),
}).strict();
export type TerminalSessionRequest = z.infer<typeof terminalSessionRequestSchema>;
export interface TerminalSessionReceipt {
  operationId: string; contextId: string; workspaceId: string; directory: DirectoryIdentity;
  mode: 'new' | 'continue'; created: boolean;
}
export interface TerminalSessionResult { receipt: TerminalSessionReceipt; status: 'available' | 'context_unavailable' | 'workspace_changed' | 'directory_changed' }
interface Host {
  runtime: RuntimeStore; capabilities: Capabilities; dataDir: string; storageId: string; instanceId: string;
  createContext(input: { name: string; workspaceId: string }): ContextRecord;
  stopping(): boolean;
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export const sameDirectoryIdentity = (a: DirectoryIdentity, b: DirectoryIdentity) => samePath(a.path, b.path) && a.dev === b.dev && a.ino === b.ino;

/** Terminal project selection is client scoped; it never repoints the shared default workspace. */
export class TerminalSessions {
  private signalRow=0;
  private outputSequence=0;
  private usedContexts=new Set<string>();
  constructor(private readonly host: Host) {}
  private operationKey(id: string) {
    if (!/^[\w.:-]{1,160}$/.test(id)) throw new AppError('operation_id_required');
    return `terminal-session:${id}`;
  }
  get(id: string): TerminalSessionResult {
    const row = this.host.runtime.db.prepare('SELECT result FROM runtime_operations WHERE id=?').get(this.operationKey(id));
    if (!row) throw new AppError('terminal_session_operation_not_found', 404);
    return this.result(JSON.parse(String(row.result)) as TerminalSessionReceipt);
  }
  private result(receipt: TerminalSessionReceipt): TerminalSessionResult {
    const context = this.host.runtime.context(receipt.contextId);
    if (!context || context.archived) return { receipt, status: 'context_unavailable' };
    if (context.workspaceId !== receipt.workspaceId) return { receipt, status: 'workspace_changed' };
    let root: WorkspaceRoot;
    try { root = this.host.capabilities.root(receipt.workspaceId); } catch { return { receipt, status: 'workspace_changed' }; }
    try {
      const current = directoryIdentity(root.path);
      if (!samePath(current.path, receipt.directory.path)) return { receipt, status: 'workspace_changed' };
      return { receipt, status: sameDirectoryIdentity(current, receipt.directory) ? 'available' : 'directory_changed' };
    }
    catch { return { receipt, status: 'directory_changed' }; }
  }
  /** As in Pi, an unused freshly opened editor is absent from the persisted session browser. */
  visibility() {
    const db=this.host.runtime.db,used=db.isTransaction?new Set(this.usedContexts):this.usedContexts;
    let signalRow=this.signalRow,outputSequence=this.outputSequence;
    // Source identities are append-only; status updates do not move a signal to another conversation.
    for(const row of db.prepare("SELECT rowid,json_extract(body,'$.contextId') AS context_id FROM signals WHERE rowid>? AND json_valid(body) ORDER BY rowid").iterate(this.signalRow)){
      if(typeof row.context_id==='string')used.add(row.context_id);signalRow=Number(row.rowid);
    }
    for(const row of db.prepare('SELECT seq,context_id FROM outputs WHERE seq>? ORDER BY seq').iterate(this.outputSequence)){
      used.add(String(row.context_id));outputSequence=Number(row.seq);
    }
    // A rolled-back source must never make an unused editor appear as a saved session.
    if(!db.isTransaction){this.signalRow=signalRow;this.outputSequence=outputSequence;}
    return (contextId:string)=>!this.host.runtime.setting(`terminal-session-origin:${contextId}`,null)||used.has(contextId);
  }
  visible(contextId:string){return this.visibility()(contextId);}
  open(body: unknown, operationId: string): TerminalSessionResult {
    const input = terminalSessionRequestSchema.parse(body), key = this.operationKey(operationId), { runtime, capabilities } = this.host;
    if (this.host.stopping()) throw new AppError('core_stopping', 503);
    const receipt = runtime.operation(key, input, () => {
      let root: WorkspaceRoot, directory: DirectoryIdentity;
      if (input.target.kind === 'local') {
        // The locator nonce is private to this machine/data directory and never appears in HTTP discovery.
        const locator = coreLocation(this.host.dataDir), target = input.target;
        if (!locator?.owner || locator.owner !== target.owner || locator.storageId !== this.host.storageId || locator.instanceId !== this.host.instanceId
          || target.storageId !== this.host.storageId || target.instanceId !== this.host.instanceId) throw new AppError('local_workspace_identity_required', 403);
        if (!path.isAbsolute(target.directory.path)) throw new AppError('invalid_workspace');
        directory = directoryIdentity(target.directory.path);
        if (sensitiveFile(directory.path)) throw new AppError('workspace_directory_protected', 403);
        if (!sameDirectoryIdentity(directory, target.directory)) throw new AppError('workspace_directory_changed', 409);
        const matching = capabilities.roots().filter(candidate => { try { return samePath(directoryIdentity(candidate.path).path, directory.path); } catch { return false; } });
        root = matching.find(candidate => {
          const previous = runtime.setting<DirectoryIdentity | null>(`terminal-workspace-origin:${candidate.id}`, null);
          return !previous || sameDirectoryIdentity(previous, directory);
        }) ?? capabilities.saveRoot({ id: `project.${randomUUID()}`, name: path.basename(directory.path) || directory.path, path: directory.path });
        runtime.setSetting(`terminal-workspace-origin:${root.id}`, directory);
      } else {
        root = capabilities.root(input.target.workspaceId); directory = directoryIdentity(root.path);
      }
      let context: ContextRecord | undefined;
      if (input.mode === 'continue') {
        const visible=this.visibility();
        const recent = runtime.contexts().filter(context => context.role === 'main' && !context.archived && context.workspaceId === root.id && visible(context.id))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        context = recent[0];
        if (context) {
          const origin = runtime.setting<DirectoryIdentity | null>(`terminal-session-origin:${context.id}`, null);
          if (origin && !sameDirectoryIdentity(origin, directory)) throw new AppError('workspace_directory_changed', 409);
        }
      }
      const created = !context;
      if (!context) {
        context = this.host.createContext({ name: path.basename(directory.path) || root.name, workspaceId: root.id });
        runtime.setSetting(`terminal-session-origin:${context.id}`, directory);
      }
      if (!sameDirectoryIdentity(directoryIdentity(root.path), directory)) throw new AppError('workspace_directory_changed', 409);
      const result: TerminalSessionReceipt = { operationId, contextId: context.id, workspaceId: root.id, directory, mode: input.mode, created };
      runtime.event({ contextId: context.id, kind: 'terminal_session_opened', data: { operationId, workspaceId: root.id, mode: input.mode, created }, key });
      return result;
    });
    return this.result(receipt);
  }
}
