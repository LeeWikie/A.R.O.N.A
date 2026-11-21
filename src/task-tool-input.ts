import {z}from'zod';
import{taskInputSchema}from'./tasks.js';
import type{ContextRecord}from'./runtime-store.js';
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Generated work identifiers keep the model contract independent of history size. */
export function taskToolInputSchema(options:{source:ContextRecord;legacyWorkIds:string[];legacyOverflow:boolean;workspaceIds:string[];context:(id:string)=>ContextRecord|undefined}){
 const source=options.source,workPattern=new RegExp(`^(?!${escape(source.id)}$)work\\.[A-Za-z0-9._-]+$`),generated=z.string().min(1).max(128).regex(workPattern,'task_context_not_available'),legacy=options.legacyWorkIds.filter(id=>id!==source.id);
 const id=options.legacyOverflow?z.string().min(1).max(128).regex(new RegExp(`^(?!(?:main|${escape(source.id)})$)[A-Za-z0-9._-]+$`),'task_context_not_available'):legacy.length?z.union([generated,z.enum(legacy)]):generated;
 const contextId=id.refine(id=>{const record=options.context(id);return Boolean(record&&record.role==='work'&&!record.archived&&record.id!==source.id&&(source.role!=='work'||record.workspaceId===source.workspaceId));},'task_context_not_available');
 const workspaceIds=[...new Set(source.role==='work'?[source.workspaceId]:options.workspaceIds)];
 const workspace=workspaceIds.length&&workspaceIds.length<=128?z.enum(workspaceIds):z.string().refine(id=>workspaceIds.includes(id),'Select a configured workspace.');
 return taskInputSchema.extend({
  contextId:contextId.optional().describe('Omit or use null for a new isolated work context. To reuse work, use its existing work identifier from context_list or a task receipt. The host creates and binds new context identifiers.'),
  workspaceId:workspace.optional().describe('Omit or use null to inherit the originating project. To select another configured workspace, specify its identifier explicitly; a reused work context must belong to that workspace.'),
  parentId:taskInputSchema.shape.parentId.describe('Normally omit or use null. The host binds the actual parent task from the active execution; an explicit value must be that same parent.'),
 });
}
