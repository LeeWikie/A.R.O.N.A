import fs from 'node:fs';
import path from 'node:path';
import { hashFile } from './files.js';
import { z } from 'zod';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import type { RuntimeStore } from './runtime-store.js';
import type { Capabilities } from './capabilities.js';
import { sensitiveFile } from './capabilities.js';
import { AppError } from './domain.js';

// Only trusted host code can bind a request context; workflow input cannot supply this authority.
const scopes = new WeakMap<object, {id:string;signal?:AbortSignal}>();
export function bindWorkflowContext(requestContext: RequestContext, contextId: string,signal?:AbortSignal) { scopes.set(requestContext,{id:contextId,signal}); }

export const verifyFilesInputSchema=z.object({contextId:z.string().optional(),paths:z.array(z.string().min(1)).min(1).max(100)}).strict();
export const workflowInvocationSchema=z.object({id:z.literal('verify-files'),input:verifyFilesInputSchema}).strict();
export const workflowCatalog=[{id:'verify-files',description:'Read existing workspace files and return their byte lengths and SHA-256 hashes. Does not create or copy files.',inputSchema:z.toJSONSchema(verifyFilesInputSchema)}];

export function createWorkflows(store: RuntimeStore, capabilities: Capabilities) {
  const inputSchema=verifyFilesInputSchema;
  const outputSchema = z.object({ files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })) });
  const verify = createStep({ id: 'verify-files-step', inputSchema, outputSchema, execute: async ({ inputData, requestContext }) => {
    const scope=scopes.get(requestContext);const authorizedId=scope?.id;
    if (!authorizedId || (inputData.contextId !== undefined && inputData.contextId !== authorizedId)) throw new AppError('workflow_context_not_available', 403);
    const context = store.context(authorizedId); if (!context || context.role !== 'work' || context.archived) throw new AppError('workflow_context_not_available', 403);
    const root = fs.realpathSync(capabilities.root(context.workspaceId).path);
    const files: {path:string;bytes:number;sha256:string}[]=[];
    for(const relative of inputData.paths){
      if (path.isAbsolute(relative) || relative.includes(String.fromCharCode(92)) || relative.includes(':') || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..') || sensitiveFile(relative)) throw new AppError('workflow_path_not_allowed', 403);
      const file = fs.realpathSync(path.resolve(root, relative)); const boundary = path.relative(root, file);
      if (!boundary || boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary) || sensitiveFile(boundary)) throw new AppError('workflow_path_not_allowed', 403);
      files.push({path:relative,...await hashFile(file,scope?.signal)});
    }
    return { files };
  } });
  return { 'verify-files': createWorkflow({ id: 'verify-files', inputSchema, outputSchema }).then(verify).commit() };
}
