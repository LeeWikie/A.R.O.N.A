import { createHash } from 'node:crypto';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { AppError } from './domain.js';
import { ProjectResources } from './tools/project-resources.js';
import { workspaceRelativePath } from './tools/workspace-filesystem.js';
import { findFd } from './tools/fd.js';
import { redactPublicText, terminalTextChunk } from './public-text.js';
import { directoryIdentity, type DirectoryIdentity } from './terminal-sessions.js';
import type { RuntimeStore } from './runtime-store.js';
import type { Capabilities } from './capabilities.js';

export interface ProjectDirectory { contextId: string; workspaceId: string; directory: DirectoryIdentity; revision: string }
export const projectPathRequestSchema = z.object({ prefix: z.string().max(131072).refine(value=>!value.includes('\0')), force: z.boolean().default(false), workspaceId: z.string().regex(/^[\w.-]{1,80}$/), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ProjectPathRequest = z.infer<typeof projectPathRequestSchema>;
export interface ProjectPathSuggestions {
  project: ProjectDirectory;
  suggestions: { prefix: string; items: Array<{ value: string; label: string; description?: string }> } | null;
}
export interface ProjectPathHost { runtime: RuntimeStore; capabilities: Capabilities; storageId:string; instanceId:string; redactionValues?:(minLength?:number)=>readonly string[] }
export function projectDirectory(host: ProjectPathHost, contextId: string): ProjectDirectory {
  const context=host.runtime.context(contextId);if(!context)throw new AppError('context_not_found',404);
  const root=host.capabilities.root(context.workspaceId),directory=directoryIdentity(root.path);
  return { contextId,workspaceId:root.id,directory,revision:createHash('sha256').update(JSON.stringify([host.storageId,host.instanceId,contextId,root.id,directory.path,directory.dev,directory.ino])).digest('hex') };
}
export function assertProjectDirectory(host:ProjectPathHost,contextId:string,expected:{workspaceId:string;revision:string}) {
  const current=projectDirectory(host,contextId);
  if(current.workspaceId!==expected.workspaceId||current.revision!==expected.revision)throw new AppError('project_directory_changed',409);
  return current;
}
// Discovery pruning is an optimization; the existing ProjectResources boundary authorizes every result.
const foldGlob=(value:string)=>value.replace(/[a-z]/gi,char=>`[${char.toLowerCase()}${char.toUpperCase()}]`);
const privateGlobs=['.env','.env.*','.ssh','.private','.codex','.claude','.arona','.pi','.aws','.kube','credentials*','auth.json','control-token','records.sqlite','records.sqlite-wal','records.sqlite-shm','history.sqlite','history.sqlite-wal','history.sqlite-shm','*.pem','*.key','id_rsa','id_ed25519'].map(foldGlob);
export async function completeProjectPath(host:ProjectPathHost,contextId:string,body:unknown,options:{signal:AbortSignal;fdPath?:string|null}):Promise<ProjectPathSuggestions>{
  options.signal.throwIfAborted();const input=projectPathRequestSchema.parse(body),project=assertProjectDirectory(host,contextId,input),source=new ProjectResources(project.directory.path);
  const ioAbort=new AbortController(),signal=AbortSignal.any([options.signal,ioAbort.signal]);let pathFailure:unknown;
  const allowPath=(absolute:string)=>{
    try{assertProjectDirectory(host,contextId,input);source.checkPath(workspaceRelativePath(project.directory.path,absolute));return true;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof AppError&&error.status===403)return false;pathFailure??=error;ioAbort.abort();return false;}
  };
  const provider=new CombinedAutocompleteProvider([],project.directory.path,options.fdPath===undefined?findFd()??null:options.fdPath,
    {allowPath,followSymlinks:false,fdExclude:privateGlobs});
  // The original recognizer already identified the complete prefix. A neutral preceding token keeps
  // absolute paths out of slash-command handling and preserves natural empty-prefix completion.
  const line=`x ${input.prefix}`;
  const suggestions=await provider.getSuggestions([line],0,line.length,{signal,force:input.force});
  if(pathFailure)throw pathFailure;
  if(suggestions&&suggestions.prefix!==input.prefix)throw new AppError('invalid_completion_prefix');
  options.signal.throwIfAborted();source.checkRoot();const current=assertProjectDirectory(host,contextId,input);
  const secrets=host.redactionValues?.(1)??[];
  const items=suggestions?.items.filter(item=>{
    const candidate=item.description??item.value.replace(/^@/,'').replace(/^"|"$/g,'');
    const expanded=candidate.startsWith('~/')||candidate.startsWith('~\\')?path.join(os.homedir(),candidate.slice(2)):candidate;
    if(!allowPath(path.resolve(project.directory.path,expanded)))return false;
    return [item.value,item.label,item.description??''].every(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value)
      &&!secrets.some(secret=>secret.length>0&&value.includes(secret))&&redactPublicText(value,secrets)===terminalTextChunk(value).text);
  });
  if(pathFailure)throw pathFailure;options.signal.throwIfAborted();
  return {project:current,suggestions:items?.length?{prefix:input.prefix,items}:null};
}
