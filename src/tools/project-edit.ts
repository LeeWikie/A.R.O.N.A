import {createEditTool} from '@earendil-works/pi-coding-agent';
import {createTool,type Tool} from '@mastra/core/tools';
import {requireFilesystem} from '@mastra/core/workspace';
import {z} from 'zod';
import {AppError} from '../domain.js';
import {workspaceRelativePath} from './workspace-filesystem.js';

const replacement=z.object({oldText:z.string().min(1),newText:z.string()}).strict();
const editInput=z.object({path:z.string(),edits:z.union([z.array(replacement).min(1),replacement,z.string()]).optional(),old_string:z.string().min(1).optional(),new_string:z.string().optional(),oldText:z.string().min(1).optional(),newText:z.string().optional(),replace_all:z.boolean().optional()}).strict();
const preparedInput=z.object({path:z.string(),edits:z.array(replacement).min(1)});

/** Replace the edit primitive while leaving native approval, read tracking and locking in place. */
export function projectEditTool(original:Tool<any,any,any,any,any>,root:string,currentRoot:()=>string){
  return createTool({
    id:original.id,
    description:'Edit one file with one or more unique, non-overlapping replacements matched against the original file. Use edits:[{oldText,newText}] for disjoint changes. Existing old_string/new_string calls remain accepted. BOM and original line endings are preserved; safe textual normalization handles model formatting differences. Read the file first. replace_all is available only for the existing single exact replacement form.',
    inputSchema:editInput,outputSchema:z.unknown(),
    execute:async(input,context)=>{
      const {workspace,filesystem}=requireFilesystem(context!);
      const metadata=await workspace.getInfo({requestContext:context?.requestContext,resolveDynamicProviders:false});
      await context?.writer?.custom({type:'data-workspace-metadata',data:{toolName:original.id,toolCallId:context?.agent?.toolCallId,...metadata}});
      if(filesystem.readOnly)throw new AppError('workspace_read_only',403);
      const relative=(absolute:string)=>{if(currentRoot()!==root)throw new AppError('workspace_changed',409);return workspaceRelativePath(root,absolute);};
      const read=async(absolute:string)=>{
        const content=await filesystem.readFile(relative(absolute));const bytes=typeof content==='string'?Buffer.from(content):content;
        try{new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{throw new AppError('binary_file_requires_format_writer',415);}
        if(bytes.includes(0))throw new AppError('binary_file_requires_format_writer',415);return bytes;
      };
      if(input.replace_all){
        if(input.edits!==undefined||typeof input.old_string!=='string'||!input.old_string||typeof input.new_string!=='string')throw new AppError('invalid_edit');
        const content=(await read(input.path)).toString('utf8');if(!content.includes(input.old_string))throw new AppError('edit_text_not_found',409);
        if(!original.execute)throw new AppError('workspace_edit_unavailable',409);const result=await original.execute(input,context);
        if((await read(input.path)).toString('utf8')!==content.split(input.old_string).join(input.new_string))throw new AppError('edit_result_unconfirmed',409);
        return result;
      }
      const definition=createEditTool(root,{operations:{
        access:async absolute=>{const stat=await filesystem.stat(relative(absolute));if(stat.type!=='file')throw new AppError('edit_requires_file',409);},
        readFile:read,
        writeFile:async(absolute,content)=>{await filesystem.writeFile(relative(absolute),content,{overwrite:true,...(context&&'__expectedMtime'in context&&context.__expectedMtime instanceof Date?{expectedMtime:context.__expectedMtime}:{})});},
      }});
      const oldText=input.oldText??input.old_string,newText=input.newText??input.new_string;
      if(input.oldText!==undefined&&input.old_string!==undefined&&input.oldText!==input.old_string||input.newText!==undefined&&input.new_string!==undefined&&input.newText!==input.new_string)throw new AppError('invalid_edit');
      const value=definition.prepareArguments?.({path:input.path,edits:input.edits,...(oldText!==undefined?{oldText}:{}),...(newText!==undefined?{newText}:{})});
      const parsed=preparedInput.safeParse(value);if(!parsed.success)throw new AppError('invalid_edit');
      return definition.execute(context?.agent?.toolCallId??'workspace-edit',parsed.data,context?.abortSignal);
    },
  });
}
