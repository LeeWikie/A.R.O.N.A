import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import type {RuntimeStore} from '../runtime-store.js';
import {AppError} from '../domain.js';
import {terminalEndpoint} from './terminal-transport.js';
import {readProcessOutput,type ProcessReadOptions} from './process-output-read.js';
import {z} from 'zod';

export interface TerminalSourceProof {signalIds:string[];digest:string;toolGrants:unknown[];mcpKeys:string[]}
export interface TerminalOwner {contextId:string;taskId:string|null;runId:string|null;attempt:number;root:{id:string;path:string;dev:number;ino:number};returnContextId:string;sourceProof?:TerminalSourceProof}
export interface ProcessBinding extends TerminalOwner {version:1;id:string;createdAt:string;command:string;cwd:string;interactive:boolean;pty:boolean;notify:boolean;retainOnDisconnect?:boolean;persistOnRelease?:boolean;digest:string}
export type ProcessStatus='starting'|'running'|'completed'|'failed'|'cancelled'|'timed_out'|'interrupted'|'unknown';
export interface ProcessObservation {status:ProcessStatus;startedAt?:string;finishedAt?:string;exitCode?:number;stdoutBytes:number;stderrBytes:number;stdoutSha256?:string;stderrSha256?:string;stdoutEncoding?:'utf8'|'binary';stderrEncoding?:'utf8'|'binary';reason?:string}
export interface RetainedProcessStream {bytes:number;sha256:string;complete:boolean;encoding:'utf8'|'binary'|'unknown'}
export interface RetainedProcessSnapshot {metadata:{id:string;capturedAt:string;origin:{contextId:string;runId:string|null;taskId:string|null};observation:ProcessObservation;streams:Record<'stdout'|'stderr',RetainedProcessStream>};read:(stream:'stdout'|'stderr',signal?:AbortSignal)=>AsyncGenerator<Uint8Array>}
export interface RetainedProcessStreamSnapshot {metadata:{id:string;capturedAt:string;origin:{contextId:string;runId:string|null;taskId:string|null};observation:ProcessObservation;stream:'stdout'|'stderr';source:RetainedProcessStream};read:(signal?:AbortSignal)=>AsyncGenerator<Uint8Array>}
export const terminalStatus=(status:ProcessStatus)=>!['starting','running'].includes(status);
export const PROCESS_OUTPUT_LIMIT=256*1024*1024;
const observationSchema=z.object({status:z.enum(['starting','running','completed','failed','cancelled','timed_out','interrupted','unknown']),startedAt:z.string().max(256).optional(),finishedAt:z.string().max(256).optional(),exitCode:z.number().int().safe().optional(),stdoutBytes:z.number().int().min(0).max(PROCESS_OUTPUT_LIMIT),stderrBytes:z.number().int().min(0).max(PROCESS_OUTPUT_LIMIT),stdoutSha256:z.string().regex(/^[0-9a-f]{64}$/).optional(),stderrSha256:z.string().regex(/^[0-9a-f]{64}$/).optional(),stdoutEncoding:z.enum(['utf8','binary']).optional(),stderrEncoding:z.enum(['utf8','binary']).optional(),reason:z.string().max(8192).optional()});
const processId=/^process\.[0-9a-f-]{36}$/;
const empty=():ProcessObservation=>({status:'starting',stdoutBytes:0,stderrBytes:0});
export function writeProcessObservation(directory:string,value:ProcessObservation){const pending=path.join(directory,'state.pending');fs.writeFileSync(pending,JSON.stringify(value),{mode:0o600});fs.renameSync(pending,path.join(directory,'state.json'));}

/** Process records contain observations; the native process manager owns live execution. */
export class ProcessOutputArchive {
  readonly directory:string;
  constructor(private readonly store:RuntimeStore,dataDir:string,private readonly owner:()=>TerminalOwner,private readonly salt:string,private readonly sourceCheck?:(binding:ProcessBinding,control:boolean,current:TerminalOwner)=>void){
    this.directory=path.join(fs.realpathSync(dataDir),'process-output');fs.mkdirSync(this.directory,{recursive:true,mode:0o700});this.assertDirectory(this.directory);
  }
  private assertDirectory(directory:string){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new AppError('process_storage_redirected',409);}
  path(id:string){if(!processId.test(id))throw new AppError('invalid_process_id');this.assertDirectory(this.directory);const directory=path.join(this.directory,id);this.assertDirectory(directory);return directory;}
  private digest(value:Omit<ProcessBinding,'digest'>){return createHmac('sha256',this.salt).update(JSON.stringify(value)).digest('hex');}
  create(input:{command:string;cwd:string;interactive:boolean;pty:boolean;notify:boolean;retainOnDisconnect?:boolean;persistOnRelease?:boolean}){
    const owner=this.owner(),id=`process.${randomUUID()}`;const value:Omit<ProcessBinding,'digest'>={version:1,id,...owner,createdAt:new Date().toISOString(),...input};
    const binding:ProcessBinding={...value,digest:this.digest(value)};const directory=path.join(this.directory,id);fs.mkdirSync(directory,{mode:0o700});
    for(const name of ['stdout','stderr'])fs.closeSync(fs.openSync(path.join(directory,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600));
    writeProcessObservation(directory,empty());this.store.setSetting(`terminal-process:${id}`,binding);return binding;
  }
  private connectionFor(binding:ProcessBinding){return {endpoint:terminalEndpoint(this.directory,binding.id),secret:createHmac('sha256',this.salt).update(`terminal-connection:${binding.digest}`).digest('hex')};}
  connection(id:string){return this.connectionFor(this.binding(id));}
  cleanupBinding(id:string){
    if(!processId.test(id))throw new AppError('invalid_process_id');const binding=this.store.setting<ProcessBinding|null>(`terminal-process:${id}`,null);if(!binding)throw new AppError('process_not_found',404);
    const {digest,...value}=binding,current=this.owner();if(value.version!==1||value.id!==id||this.digest(value)!==digest)throw new AppError('process_source_changed',409);
    if(binding.contextId!==current.contextId||binding.taskId!==current.taskId)throw new AppError('process_not_authorized',403);
    this.path(id);return binding;
  }
  cleanupConnection(id:string){return this.connectionFor(this.cleanupBinding(id));}
  binding(id:string,control=false):ProcessBinding{
    if(!processId.test(id))throw new AppError('invalid_process_id');const binding=this.store.setting<ProcessBinding|null>(`terminal-process:${id}`,null);if(!binding)throw new AppError('process_not_found',404);
    const {digest,...value}=binding;if(value.version!==1||value.id!==id||this.digest(value)!==digest)throw new AppError('process_source_changed',409);
    const current=this.owner();if(binding.contextId!==current.contextId||binding.taskId!==current.taskId||JSON.stringify(binding.root)!==JSON.stringify(current.root))throw new AppError('process_not_authorized',403);
    const stat=fs.lstatSync(binding.root.path);if(stat.isSymbolicLink()||stat.dev!==binding.root.dev||stat.ino!==binding.root.ino)throw new AppError('workspace_changed',409);
    if(control&&!this.sourceCheck&&(binding.runId!==current.runId||binding.attempt!==current.attempt))throw new AppError('process_execution_changed',409);
    this.sourceCheck?.(binding,control,current);
    this.path(id);return binding;
  }
  recordAdoption(id:string){
    const binding=this.binding(id,true),current=this.owner();if(binding.runId===current.runId&&binding.attempt===current.attempt)return;
    const relation={processId:id,original:{contextId:binding.contextId,taskId:binding.taskId,runId:binding.runId,attempt:binding.attempt},current:{contextId:current.contextId,taskId:current.taskId,runId:current.runId,attempt:current.attempt},bindingDigest:binding.digest};
    this.store.operation(`terminal-adoption:${id}:${current.runId}`,relation,()=>{this.store.setSetting(`terminal-adoption:${id}:${current.runId}`,{...relation,createdAt:new Date().toISOString()});this.store.event({contextId:current.contextId,taskId:current.taskId,runId:current.runId,kind:'terminal_process_adopted',data:{id,originalRunId:binding.runId,originalAttempt:binding.attempt,attempt:current.attempt},key:`terminal-adopted:${id}:${current.runId}`});return {adopted:true};});
  }
  observation(id:string):ProcessObservation{
    const directory=this.path(id),file=path.join(directory,'state.json');
    for(let attempt=0;attempt<3;attempt++){
      const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw new AppError('process_state_invalid',409);
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{
        const stat=fs.fstatSync(fd);if(stat.dev!==before.dev||stat.ino!==before.ino)continue;
        // Atomic replacement may unlink this already-open, complete snapshot.
        if(!stat.isFile()||stat.nlink>1||stat.size>32768)throw new AppError('process_state_invalid',409);
        let raw:unknown;try{raw=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw new AppError('process_state_invalid',409);}const value=observationSchema.safeParse(raw);if(!value.success)throw new AppError('process_state_invalid',409);return value.data;
      }finally{fs.closeSync(fd);}
    }
    throw new AppError('process_state_changing',409);
  }
  list(){const rows: Array<{id:string;command:string;createdAt:string}&ProcessObservation>=[];for(const item of this.store.db.prepare("SELECT body FROM runtime_settings WHERE id LIKE 'terminal-process:%' ORDER BY rowid DESC").all()){const binding=JSON.parse(String(item.body)) as ProcessBinding;try{this.binding(binding.id);rows.push({id:binding.id,command:binding.command,createdAt:binding.createdAt,...this.observation(binding.id)});}catch(error){if(!(error instanceof AppError)||!['process_not_authorized','workspace_changed'].includes(error.code))throw error;}}return rows;}
  private retainedBinding(id:string,contextId:string,checkDirectory=true){
    if(!processId.test(id))throw new AppError('invalid_process_id');const binding=this.store.setting<ProcessBinding|null>(`terminal-process:${id}`,null);if(!binding)throw new AppError('process_not_found',404);const {digest,...value}=binding;
    if(value.version!==1||value.id!==id||this.digest(value)!==digest)throw new AppError('process_source_changed',409);if(binding.contextId!==contextId)throw new AppError('process_not_authorized',403);if(checkDirectory)this.path(id);return binding;
  }
  describeRetained(id:string,contextId:string){const binding=this.retainedBinding(id,contextId,false),origin={contextId:binding.contextId,runId:binding.runId,taskId:binding.taskId};try{return {id,origin,observation:this.observation(id),issue:undefined};}catch(error){return {id,origin,observation:null,issue:error instanceof AppError?error.code:'process_state_unavailable'};}}
  /** Data export for a host-authorized history entry; no connection secret, command or execution grants leave this adapter. */
  async exportRetained(id:string,contextId:string,signal?:AbortSignal):Promise<RetainedProcessSnapshot>{
    const captured=await this.exportStreams(id,contextId,['stdout','stderr'],signal),stdout=captured.metadata.streams.stdout,stderr=captured.metadata.streams.stderr;if(!stdout||!stderr)throw new AppError('process_output_changed',409);return {metadata:{...captured.metadata,streams:{stdout,stderr}},read:captured.read};
  }
  async exportStream(id:string,contextId:string,stream:'stdout'|'stderr',signal?:AbortSignal):Promise<RetainedProcessStreamSnapshot>{
    if(!['stdout','stderr'].includes(stream))throw new AppError('invalid_process_stream');const captured=await this.exportStreams(id,contextId,[stream],signal),source=captured.metadata.streams[stream];if(!source)throw new AppError('process_output_changed',409);const {streams,...metadata}=captured.metadata;return {metadata:{...metadata,stream,source},read:readSignal=>captured.read(stream,readSignal)};
  }
  private async exportStreams(id:string,contextId:string,selected:readonly ('stdout'|'stderr')[],signal?:AbortSignal){
    signal?.throwIfAborted();const binding=this.retainedBinding(id,contextId),observation=this.observation(id),streams:Partial<Record<'stdout'|'stderr',RetainedProcessStream>>={};
    for(const stream of selected){
      const bytes=observation[`${stream}Bytes`],file=path.join(this.path(id),stream),visible=await fs.promises.lstat(file),handle=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      try{const before=await handle.stat();if(!before.isFile()||before.nlink!==1||visible.isSymbolicLink()||before.dev!==visible.dev||before.ino!==visible.ino||before.size<bytes)throw new AppError('process_output_changed',409);const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
        while(position<bytes){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,bytes-position),position);if(!bytesRead)throw new AppError('process_output_changed',409);hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
        const sha256=hash.digest('hex'),expected=observation[`${stream}Sha256`];if(expected&&sha256!==expected)throw new AppError('process_output_changed',409);const after=await handle.stat(),current=await fs.promises.lstat(file);if(after.nlink!==1||current.isSymbolicLink()||after.dev!==current.dev||after.ino!==current.ino||after.size<bytes)throw new AppError('process_output_changed',409);
        streams[stream]={bytes,sha256,complete:terminalStatus(observation.status)&&observation.status!=='unknown'&&Boolean(expected),encoding:observation[`${stream}Encoding`]??'unknown'};
      }finally{await handle.close();}
    }
    signal?.throwIfAborted();const archive=this,originalDigest=binding.digest,captured=structuredClone(streams);
    return {metadata:{id,capturedAt:new Date().toISOString(),origin:{contextId:binding.contextId,runId:binding.runId,taskId:binding.taskId},observation,streams:structuredClone(captured)},read:async function*(stream:'stdout'|'stderr',readSignal?:AbortSignal){if(!['stdout','stderr'].includes(stream))throw new AppError('invalid_process_stream');const active=readSignal??signal;active?.throwIfAborted();if(archive.retainedBinding(id,contextId).digest!==originalDigest)throw new AppError('process_source_changed',409);const descriptor=captured[stream];if(!descriptor)throw new AppError('invalid_process_stream');const file=path.join(archive.path(id),stream),visible=await fs.promises.lstat(file),handle=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      try{const before=await handle.stat();if(!before.isFile()||before.nlink!==1||visible.isSymbolicLink()||before.ino!==visible.ino||before.dev!==visible.dev||before.size<descriptor.bytes)throw new AppError('process_output_changed',409);const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
        while(position<descriptor.bytes){active?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,descriptor.bytes-position),position);active?.throwIfAborted();if(!bytesRead)throw new AppError('process_output_changed',409);const bytes=Buffer.from(buffer.subarray(0,bytesRead));hash.update(bytes);position+=bytesRead;yield bytes;}
        const after=await handle.stat(),current=await fs.promises.lstat(file);if(hash.digest('hex')!==descriptor.sha256||after.nlink!==1||current.isSymbolicLink()||after.ino!==current.ino||after.dev!==current.dev||after.size<descriptor.bytes||archive.retainedBinding(id,contextId).digest!==originalDigest)throw new AppError('process_output_changed',409);
      }finally{await handle.close();}
    }};
  }
  read(id:string,options:ProcessReadOptions={}){
    this.binding(id);const state=this.observation(id),stream=options.stream??'stdout',bytes=stream==='stdout'?state.stdoutBytes:state.stderrBytes;
    const file=path.join(this.path(id),stream),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const before=fs.fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size<bytes)throw new AppError('process_output_changed',409);
      const expected=stream==='stdout'?state.stdoutSha256:state.stderrSha256,hash=terminalStatus(state.status)?expected:undefined;
      let result:ReturnType<typeof readProcessOutput>&{textUnavailable?:'not-utf8'};
      try{result=readProcessOutput(fd,bytes,hash,options,!terminalStatus(state.status));}
      catch(error){if(!(error instanceof AppError)||error.code!=='process_output_not_utf8'||options.encoding==='base64')throw error;result={...readProcessOutput(fd,bytes,hash,{...options,encoding:'base64'}),textUnavailable:'not-utf8'};}
      const after=fs.fstatSync(fd),visible=fs.lstatSync(file);if(after.ino!==visible.ino||after.dev!==visible.dev||after.nlink!==1)throw new AppError('process_output_changed',409);
      return {id,stream,...state,...result};
    }finally{fs.closeSync(fd);}
  }
  retainedText(id:string,stream:'stdout'|'stderr'){
    const state=this.observation(id),bytes=stream==='stdout'?state.stdoutBytes:state.stderrBytes;const result=this.read(id,{stream,encoding:'base64',byteOffset:Math.max(0,bytes-1048576),maxBytes:1048576});const body=Buffer.from(result.content,'base64');let start=0;while(start<body.length&&(body[start]!&0xc0)===0x80)start++;
    let text:string,binary=false;try{text=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(body.subarray(start),{stream:!terminalStatus(state.status)});}catch{binary=true;text=new TextDecoder('utf8',{ignoreBOM:true}).decode(body.subarray(start),{stream:!terminalStatus(state.status)});}
    return bytes>32768||binary?`${text}\n[Full output: ${id}; use terminal_process action=log with ${binary?'encoding=base64 byte pagination':'line or byte pagination'}.]`:text;
  }
}
