import fs from 'node:fs';
import path from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import { z } from 'zod';
import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace';
import { MCPClient } from '@mastra/mcp';
import type { ToolsInput } from '@mastra/core/agent';
import type { WorkspaceToolsConfig } from '@mastra/core/workspace';
import type { RuntimeStore, ContextRecord, TaskRecord } from './runtime-store.js';
import { AppError } from './domain.js';

export const rootSchema = z.object({ id: z.string().regex(/^[\w.-]{1,80}$/), path: z.string().min(1), name: z.string().min(1).max(200) }).strict();
export const mcpSchema = z.object({ id: z.string().regex(/^[\w-]{1,60}$/), enabled: z.boolean().default(true),
  command: z.string().min(1).optional(), args: z.array(z.string()).default([]), url: z.url().optional(),
  protocolVersion: z.enum(['legacy','2026-07-28']).optional(),
  headersEnv: z.record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
}).strict().refine(x => Boolean(x.command) !== Boolean(x.url));
export type WorkspaceRoot = z.infer<typeof rootSchema>;
export type MCPConfig = z.infer<typeof mcpSchema>;
export function sensitiveFile(value: unknown): boolean {
  return typeof value === 'string' && /(^|[\\/])(?:\.env(?:\..*)?|\.ssh|\.private|\.codex|\.claude|\.arona|\.pi|\.aws|\.kube|credentials[^\\/]*|auth\.json|control-token|records\.sqlite(?:-wal|-shm)?|history\.sqlite(?:-wal|-shm)?|.*\.pem|.*\.key|id_rsa|id_ed25519)(?:$|[\\/])/i.test(value);
}
export class Capabilities {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly clients = new Map<string, MCPClient>();
  private readonly discovered = new Map<string, ToolsInput>();
  private readonly health = new Map<string, { connected: boolean; tools: string[]; error?: string }>();
  private readonly operations = new Map<string, Promise<void>>();
  private closing = false;
  private async serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(action);
    const done = run.then(() => {}, () => {});
    this.operations.set(id, done);
    try { return await run; } finally { if (this.operations.get(id) === done) this.operations.delete(id); }
  }
  constructor(private readonly store: RuntimeStore, private readonly dataDir: string, private readonly credential: (name:string)=>string|undefined = name=>process.env[name],private readonly scopeSalt:string=randomBytes(32).toString('hex')) {
    const directory = path.join(dataDir, 'workspace'); fs.mkdirSync(directory, { recursive: true });
    if (!this.roots().length) this.store.setSetting('workspaces', [{ id: 'default', name: 'Local workspace', path: directory }]);
  }
  roots(): WorkspaceRoot[] { return this.store.setting('workspaces', []); }
  saveRoot(body: unknown) {
    const parsed = rootSchema.safeParse(body); if (!parsed.success) throw new AppError('invalid_workspace');
    const resolved = fs.realpathSync(path.resolve(parsed.data.path));
    if (!fs.statSync(resolved).isDirectory()) throw new AppError('workspace_not_directory');
    if (this.roots().some(x => x.id === parsed.data.id)) throw new AppError('workspace_id_exists', 409);
    const record = { ...parsed.data, path: resolved }; this.store.setSetting('workspaces', [...this.roots(), record]); return record;
  }
  root(id: string) { const root = this.roots().find(x => x.id === id); if (!root) throw new AppError('workspace_not_found', 404); return root; }
  workspace(record: ContextRecord, grant: () => TaskRecord['grants']): Workspace {
    const found = this.workspaces.get(record.id); if (found) return found;
    const root = this.root(record.workspaceId);
    const approved = (write: boolean) => !grant()[write ? 'write' : 'execute'];
    const readTools = ['mastra_workspace_read_file', 'mastra_workspace_list_files', 'mastra_workspace_file_stat', 'mastra_workspace_grep'] as const;
    const writeTools = ['mastra_workspace_write_file', 'mastra_workspace_edit_file', 'mastra_workspace_delete', 'mastra_workspace_mkdir', 'mastra_workspace_apply_patch'] as const;
    const tools: WorkspaceToolsConfig = { enabled: false, requireApproval: true };
    const sensitivePath = (value: unknown) => {
      if (typeof value !== 'string' || sensitiveFile(value)) return true;
      try { const target = path.resolve(root.path, value); const stat = fs.statSync(target); return (!stat.isDirectory()&&stat.nlink>1)||sensitiveFile(path.relative(root.path,fs.realpathSync(target))); }
      catch { return true; }
    };
    for (const name of readTools) tools[name] = { enabled: true, requireApproval: ({ args }) => name === 'mastra_workspace_grep' || name === 'mastra_workspace_list_files' || sensitivePath(args.path), maxOutputTokens: 12000 };
    for (const name of writeTools) tools[name] = { enabled: true, requireApproval: ({ args }) => name === 'mastra_workspace_apply_patch' || sensitivePath(args.path) || approved(true), requireReadBeforeWrite: true };
    tools.mastra_workspace_execute_command = { enabled: true, requireApproval: () => approved(false), requireDescription: true };
    tools.mastra_workspace_get_process_output = { enabled: true, requireApproval: false };
    tools.mastra_workspace_kill_process = { enabled: true, requireApproval: () => approved(false) };
    const workspace = new Workspace({ id: `workspace-${record.id}`, filesystem: new LocalFilesystem({ basePath: root.path, contained: true }),
      sandbox: new LocalSandbox({ workingDirectory: root.path, env: { PATH: process.env.PATH }, timeout: 60_000 }), tools });
    this.workspaces.set(record.id, workspace); return workspace;
  }
  private connectionKey(id:string){
    const config=this.mcpConfigs().find(row=>row.id===id);if(!config)return '';
    const references=[...Object.values(config.env),...Object.values(config.headersEnv)];
    return createHmac('sha256',this.scopeSalt).update(JSON.stringify({config,credentials:references.map(name=>[name,this.credential(name)])})).digest('hex');
  }
  approvalKey(context:ContextRecord,name:string){
    const server=[...this.discovered.entries()].find(([,tools])=>Object.hasOwn(tools,name))?.[0];
    return server?this.connectionKey(server):createHmac('sha256',this.scopeSalt).update(JSON.stringify({workspace:this.root(context.workspaceId),tool:name})).digest('hex');
  }
  connectionScope(id:string){return this.connectionKey(id);}
  mcpKeys(){return [...this.discovered.keys()].map(id=>this.connectionKey(id));}
  approvalCapability(context:ContextRecord,name:string,args:unknown):'read'|'write'|'execute'|'mcp'|null {
    if(name.startsWith('ext_'))return Object.hasOwn(this.tools(true),name)?'mcp':null;
    const aliases:Record<string,string>={view:'read_file',read_file:'read_file',write_file:'write_file',edit_file:'edit_file',execute_command:'execute_command'};
    const operation=name.startsWith('mastra_workspace_')?name.slice('mastra_workspace_'.length):aliases[name];
    if(!operation)return null;
    if(['execute_command','kill_process'].includes(operation))return 'execute';
    if(operation==='get_process_output')return 'read';
    if(!['read_file','file_stat','write_file','edit_file','delete','mkdir'].includes(operation))return null;
    const relative=(args as {path?:unknown})?.path;
    if(typeof relative!=='string'||sensitiveFile(relative))return null;
    const root=fs.realpathSync(this.root(context.workspaceId).path);const file=path.resolve(root,relative);const boundary=path.relative(root,file);
    if(!boundary||boundary.startsWith('..')||path.isAbsolute(boundary))return null;
    let check=file;
    for(;;){
      try{const stat=fs.lstatSync(check);const real=fs.realpathSync(check);const relative=path.relative(root,real);if(stat.isSymbolicLink()||(!stat.isDirectory()&&stat.nlink>1)||sensitiveFile(relative)||relative.startsWith('..')||path.isAbsolute(relative))return null;break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return null;check=path.dirname(check);if(check===root)break;}
    }
    return ['read_file','file_stat'].includes(operation)?'read':'write';
  }
  mcpConfigs(): MCPConfig[] { return this.store.setting('mcp', []); }
  async saveMCP(body: unknown) {
    const parsed = mcpSchema.safeParse(body); if (!parsed.success) throw new AppError('invalid_mcp_configuration');
    if (parsed.data.url) { const url = new URL(parsed.data.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new AppError('invalid_mcp_url'); }
    if (parsed.data.url && (parsed.data.args.length || Object.keys(parsed.data.env).length)) throw new AppError('invalid_mcp_configuration');
    if (parsed.data.command && Object.keys(parsed.data.headersEnv).length) throw new AppError('invalid_mcp_configuration');
    return this.serialized(parsed.data.id, async () => {
      if (this.closing) throw new AppError('capabilities_closing', 409);
      await this.disconnectClient(parsed.data.id);
      this.store.setSetting('mcp', [...this.mcpConfigs().filter(x => x.id !== parsed.data.id), parsed.data]); return this.mcpStatus();
    });
  }
  mcpStatus() { return this.mcpConfigs().map(x => ({ id: x.id, enabled: x.enabled, transport: x.url ? 'http' : 'stdio', ...(this.health.get(x.id) ?? { connected: false, tools: [] }) })); }
  async connect(id: string) {
    return this.serialized(id, async () => {
      if (this.closing) throw new AppError('capabilities_closing', 409);
      const config = this.mcpConfigs().find(x => x.id === id); if (!config) throw new AppError('mcp_server_not_found', 404);
      if (!config.enabled) throw new AppError('mcp_server_disabled', 409);
      if (this.clients.has(id)) return this.mcpStatus();
      const headers: Record<string, string> = {}, env: Record<string, string> = {};
      for (const [key, variable] of Object.entries(config.headersEnv)) { const value = this.credential(variable); if (!value) throw new AppError('mcp_credentials_unavailable'); headers[key] = value; }
      for (const [key, variable] of Object.entries(config.env)) { const value = this.credential(variable); if (!value) throw new AppError('mcp_credentials_unavailable'); env[key] = value; }
      const client = new MCPClient({ id: `shittim-${id}`, registerProcessHooks: false, timeout: 20_000,
        servers: { [`ext_${id}`]: config.url ? { url: new URL(config.url), requestInit: { headers }, protocolVersion: config.protocolVersion }
          : { command: config.command!, args: config.args, env, protocolVersion: config.protocolVersion } } });
      try {
        const result = await client.listToolsWithErrors({ perServerTimeoutMs: 20_000 });
        if (Object.keys(result.errors).length) throw new Error('MCP discovery failed');
        const existing = new Set([...this.discovered.values()].flatMap(tools => Object.keys(tools)));
        if (Object.keys(result.tools).some(name => existing.has(name))) throw new Error('MCP tool name collision');
        const connectionKey=this.connectionKey(id);
        const guarded=Object.fromEntries(Object.entries(result.tools).map(([name,tool])=>{
          const execute=tool.execute;
          return [name,{...tool,execute:typeof execute==='function'?async(...args:unknown[])=>{
            if(this.clients.get(id)!==client||this.connectionKey(id)!==connectionKey)throw new AppError('mcp_connection_changed',409);
            return (execute as (...args:unknown[])=>unknown)(...args);
          }:undefined}];
        })) as ToolsInput;
        this.clients.set(id, client); this.discovered.set(id, guarded); this.health.set(id, { connected: true, tools: Object.keys(result.tools) });
      } catch { await client.disconnect().catch(() => {}); this.health.set(id, { connected: false, tools: [], error: 'mcp_connection_failed' }); throw new AppError('mcp_connection_failed', 502); }
      return this.mcpStatus();
    });
  }
  private async disconnectClient(id: string) {
    const client = this.clients.get(id); this.clients.delete(id); this.discovered.delete(id); this.health.delete(id); await client?.disconnect();
  }
  async disconnect(id: string) { await this.serialized(id, () => this.disconnectClient(id)); }
  tools(allowed: boolean): ToolsInput {
    // Session permission rules gate MCP calls; connection discovery does not grant execution.
    return allowed ? Object.assign({}, ...this.discovered.values()) as ToolsInput : {};
  }
  async close() { this.closing = true; await Promise.allSettled([...this.operations.values()]); await Promise.allSettled([...this.clients.keys()].map(id => this.disconnect(id))); await Promise.allSettled([...this.workspaces.values()].map(x => x.destroy())); }
}
