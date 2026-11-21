import{acceptedSourceIds}from'../accepted-sources.js';
import {createTool,type ToolExecutionContext} from '@mastra/core/tools';
import {requireSandbox} from '@mastra/core/workspace';
import {z} from 'zod';
import {AppError} from '../domain.js';
import {TerminalSandbox} from './terminal-process.js';
import type {ProcessOutputArchive} from './process-output.js';

const id=z.string().regex(/^process\.[0-9a-f-]{36}$/),size=z.number().int().min(2).max(1000);
const read=z.object({action:z.enum(['poll','log','wait']),id,stream:z.enum(['stdout','stderr']).optional(),offset:z.number().int().min(1).optional(),limit:z.number().int().min(1).max(2000).optional(),encoding:z.enum(['text','base64']).optional(),byteOffset:z.number().int().nonnegative().optional(),maxBytes:z.number().int().min(1).max(32768).optional(),waitMs:z.number().int().min(0).max(30000).optional()}).strict();
export const terminalProcessSchema=z.union([
  z.object({action:z.literal('start'),command:z.string().min(1).max(131072),description:z.string().min(1).max(500),cwd:z.string().optional(),interactive:z.boolean().optional(),pty:z.boolean().optional(),timeout:z.number().positive().max(86400).optional(),notifyOnComplete:z.boolean().optional(),persistOnRelease:z.boolean().optional(),cols:size.optional(),rows:size.optional()}).strict(),
  z.object({action:z.literal('list')}).strict(),read,
  z.object({action:z.enum(['write','submit']),id,data:z.string().max(65536)}).strict(),
  z.object({action:z.enum(['close','kill']),id}).strict(),z.object({action:z.literal('resize'),id,cols:size,rows:size}).strict(),
]);
export const terminalReadActions=new Set(['list','poll','log','wait']);
export function createTerminalTools(){return {terminal_process:createTool({
  id:'terminal_process',description:'Start background interactive or PTY commands; list, poll, paginate or wait for full retained output; write raw stdin, submit Enter, resize or kill. Output preserves original bytes; non-UTF8 output is returned as bounded base64 pages with byte offsets. close closes pipe stdin; for POSIX PTYs it sends the terminal EOF key. '+(process.platform==='win32'?'This Windows ConPTY backend has no non-terminating stdin half-close: close is unsupported and writes nothing; choose interactive:true without pty when EOF is needed. ':'')+'Background commands retain their original process across a core crash. persistOnRelease also keeps them across normal workspace release; explicit kill still stops them. Process references belong to this task and workspace. Completed output remains readable after the process exits or the core restarts. A process exit is separate from task completion.',
  inputSchema:terminalProcessSchema,requireApproval:(input,context)=>!terminalReadActions.has(input.action)&&!(context?.workspace?.sandbox instanceof TerminalSandbox&&context.workspace.sandbox.executeAllowed()),
  execute:async(input,context)=>{const {sandbox}=requireSandbox(context!);if(!(sandbox instanceof TerminalSandbox))throw new AppError('terminal_process_unavailable',409);
    if(input.action==='start'){const handle=await sandbox.processes.spawn(input.command,{cwd:input.cwd,interactive:input.interactive,pty:input.pty,timeout:input.timeout===undefined?undefined:input.timeout*1000,notify:input.notifyOnComplete,persistOnRelease:input.persistOnRelease,cols:input.cols,rows:input.rows,abortSignal:input.persistOnRelease?undefined:context?.abortSignal});return {id:handle.pid,...sandbox.archive.observation(handle.pid),input:{kind:input.pty?'pty':input.interactive?'pipe':'closed',eof:input.pty?process.platform==='win32'?'unsupported':'terminal-key':input.interactive?'pipe-close':'closed'}};}
    if(input.action==='list')return {processes:sandbox.archive.list()};
    if(input.action==='poll'||input.action==='log'||input.action==='wait'){
      sandbox.archive.binding(input.id);if(input.action==='wait'){const handle=await sandbox.processes.get(input.id);if(handle){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([handle.wait(),new Promise<void>(resolve=>{timer=setTimeout(resolve,input.waitMs??30000);})]);}finally{clearTimeout(timer);}}}
      const {action,id,waitMs,...options}=input;return sandbox.archive.read(id,options);
    }
    if(input.action==='write'||input.action==='submit'){await sandbox.input(input.id,input.action,input.data);return {id:input.id,status:'input-delivered'};}
    if(input.action==='resize'){await sandbox.input(input.id,'resize',undefined,input.cols,input.rows);return {id:input.id,status:'resized'};}
    await sandbox.input(input.id,input.action);return {id:input.id,...sandbox.archive.observation(input.id)};
  },
})};}

export interface TerminalResultHost {
  authorize:(processId:string,signalIds:string[],context:ToolExecutionContext|undefined)=>string|Promise<string>;
  read:(ownerContextId:string,processId:string,options:Parameters<ProcessOutputArchive['read']>[1])=>unknown|Promise<unknown>;
}
export function createTerminalResultTools(host:TerminalResultHost){return {read_terminal_result:createTool({
  id:'read_terminal_result',description:'Read complete output referenced by a terminal completion notification from the current authorized source. This reads historical results and does not grant process control or execution permission.',
  inputSchema:z.object({id,signalIds:acceptedSourceIds,stream:z.enum(['stdout','stderr']).optional(),offset:z.number().int().min(1).optional(),limit:z.number().int().min(1).max(2000).optional(),encoding:z.enum(['text','base64']).optional(),byteOffset:z.number().int().nonnegative().optional(),maxBytes:z.number().int().min(1).max(32768).optional()}).strict(),
  execute:async({id,signalIds,...options},context)=>{const owner=await host.authorize(id,signalIds,context);return host.read(owner,id,options);},
})};}
