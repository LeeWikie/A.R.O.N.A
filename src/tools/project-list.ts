import path from 'node:path';
import {createFindTool,createLsTool} from '@earendil-works/pi-coding-agent';
import {createTool,type Tool} from '@mastra/core/tools';
import {requireFilesystem} from '@mastra/core/workspace';
import {Minimatch} from 'minimatch';
import {z} from 'zod';
import {AppError} from '../domain.js';
import {workspaceRelativePath} from './workspace-filesystem.js';
import type {ProjectResources} from './project-resources.js';
import type {ProjectReadIdentity,ProjectReadLease} from './project-read.js';
import {findFd} from './fd.js';
import {processNullPaths} from './project-process.js';

const inputSchema=z.object({path:z.string().optional(),mode:z.enum(['tree','directory','find']).optional(),limit:z.number().optional(),maxDepth:z.number().optional(),showHidden:z.boolean().optional(),dirsOnly:z.boolean().optional(),exclude:z.string().optional(),extension:z.string().optional(),pattern:z.union([z.string(),z.array(z.string())]).optional(),respectGitignore:z.boolean().optional()}).strict();

/** The native tree stays compatible; directory and recursive find use the complete pinned components. */
export function projectListTool(original:Tool<any,any,any,any,any>,source:ProjectResources,currentRoot:()=>string,leaseFactory?:(signal:AbortSignal|undefined,identity:ProjectReadIdentity)=>ProjectReadLease){
  const configuredRoot=currentRoot();
  return createTool({id:original.id,description:'Inspect workspace paths. mode=directory lists all immediate entries, including dotfiles, in alphabetical order; limit defaults to 500. mode=find searches the full subtree by glob pattern (for example **/*.ts or *.json), including ordinary hidden entries and respecting ignore rules; limit defaults to 1000 and directory depth is unrestricted unless maxDepth is specified. mode=tree retains the existing tree presentation and filters (default). Protected and linked sources are excluded in every mode. Use a higher limit when the result explicitly reports that more entries exist.',inputSchema,outputSchema:z.string(),execute:async(input,context)=>{
    const native=context?.requestContext?.get('shittimchest-native-input-run'),runId=native&&typeof native==='object'&&'runId'in native&&typeof native.runId==='string'?native.runId:undefined,lease=leaseFactory?.(context?.abortSignal,{runId,toolCallId:context?.agent?.toolCallId,agent:Boolean(context?.agent)}),signal=lease?.signal??context?.abortSignal,operations=new Set<Promise<unknown>>();
    const track=<T>(operation:()=>Promise<T>)=>{const pending=operation();operations.add(pending);void pending.finally(()=>operations.delete(pending)).catch(()=>{});return pending;};
    try{
      const mode=input.mode??'tree';if(mode==='tree'){const {mode:_,limit:__,...nativeInput}=input;const output=await original.execute!(nativeInput,context);if(typeof output!=='string')throw new AppError('directory_output_invalid',502);return output;}
      const {workspace,filesystem}=requireFilesystem(context!);const check=()=>{signal?.throwIfAborted();if(currentRoot()!==configuredRoot)throw new AppError('workspace_changed',409);source.checkRoot();},relative=(value:string)=>{check();return workspaceRelativePath(configuredRoot,value);};check();const metadata=await workspace.getInfo({requestContext:context?.requestContext,resolveDynamicProviders:false});await context?.writer?.custom({type:'data-workspace-metadata',data:{toolName:original.id,toolCallId:context?.agent?.toolCallId,...metadata}});
      let result;
      if(mode==='directory'){
        const reader=createLsTool(source.root,{operations:{exists:absolute=>track(async()=>source.exists(relative(absolute))),stat:absolute=>track(async()=>{const stat=await source.stat(relative(absolute));return {isDirectory:()=>stat.type==='directory'};}),readdir:absolute=>track(async()=>{const entries=await filesystem.readdir(relative(absolute));check();return entries.filter(entry=>input.showHidden!==false||!entry.name.startsWith('.')).map(entry=>entry.name);})}});
        result=await reader.execute(context?.agent?.toolCallId??'workspace-directory',{path:input.path,limit:input.limit},signal);
      }else{
        const finder=createFindTool(source.root,{operations:{exists:absolute=>track(async()=>source.exists(relative(absolute))),glob:(pattern,absolute,options)=>track(async()=>{
          const base=relative(absolute),stat=await source.stat(base);if(stat.type!=='directory')throw new AppError('resource_not_directory',400);const fd=findFd();if(!fd)throw new AppError('file_discovery_unavailable',503);
          const args=['--color=never','--print0','--absolute-path','--exclude','.git'];if(input.showHidden!==false)args.push('--hidden');if(input.respectGitignore===false)args.push('--no-ignore');else{let parent=base,git=false;for(;;){if(await source.exists(path.join(parent,'.git'))){git=true;break;}if(parent==='.')break;const next=path.dirname(parent);if(next===parent)break;parent=next;}if(!git)args.push('--no-require-git');}
          if(input.maxDepth!==undefined)args.push('--max-depth',String(Math.max(0,Math.floor(input.maxDepth))));if(input.dirsOnly)args.push('--type','directory');if(input.extension)for(const extension of input.extension.split(',').map(value=>value.trim().replace(/^\./,'')).filter(Boolean))args.push('--extension',extension);
          for(const exclusion of(input.exclude??'').split('|').filter(Boolean))args.push('--exclude',`*${exclusion}*`);
          const patterns=Array.isArray(input.pattern)?input.pattern:[pattern],effective=patterns.map(value=>process.platform==='win32'?value.replaceAll('\\','/'):value),pathPattern=effective.some(value=>value.includes('/')),windowsMatcher=process.platform==='win32'&&pathPattern?effective.map(value=>{const adjusted=value.includes('/')&&!value.startsWith('/')&&!value.startsWith('**/')&&value!=='**'?`**/${value}`:value;return new Minimatch(adjusted.replace(/\/\*\*$/,'/**/*'),{dot:true,noext:true,nocase:adjusted===adjusted.toLowerCase()});}):undefined;
          if(!windowsMatcher&&patterns.length===1){let value=effective[0]!;if(pathPattern){if(!value.startsWith('/')&&!value.startsWith('**/')&&value!=='**')value='**/'+value;args.push('--full-path');}args.push('--glob','--',value,path.join(source.root,base));}else args.push('--','',path.join(source.root,base));
          const multipleMatcher=patterns.length>1&&!windowsMatcher?effective.map(value=>new Minimatch(value,{dot:true,noext:true,matchBase:!value.includes('/'),nocase:value===value.toLowerCase()})):undefined,results:string[]=[];
          for await(const file of processNullPaths(fd,args,source.root,signal)){check();const normalized=file.replaceAll('\\','/');if(windowsMatcher&&!windowsMatcher.some(matcher=>matcher.match(normalized)))continue;const candidate=workspaceRelativePath(source.root,file),local=path.relative(base,candidate).split(path.sep).join('/');if(multipleMatcher&&!multipleMatcher.some(matcher=>matcher.match(local)))continue;let entry;try{entry=await source.stat(candidate);}catch(error){if(error instanceof AppError&&error.status===403)continue;throw error;}results.push(path.join(source.root,candidate)+(entry.type==='directory'?path.sep:''));if(results.length>=options.limit)break;}
          return results;
        })}});
        result=await finder.execute(context?.agent?.toolCallId??'workspace-find',{path:input.path,pattern:Array.isArray(input.pattern)?'*':input.pattern??'*',limit:input.limit},signal);
      }
      check();return result.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n');
    }finally{await Promise.allSettled([...operations]);lease?.finish();}
  }});
}
