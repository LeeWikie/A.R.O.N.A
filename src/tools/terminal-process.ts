import fs from 'node:fs';
import path from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import net,{type Socket} from 'node:net';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {MastraSandbox,SandboxProcessManager,ProcessHandle,type CommandResult,type SpawnProcessOptions,type ProcessInfo} from '@mastra/core/workspace';
import {AppError} from '../domain.js';
import {ProcessOutputArchive,terminalStatus,type ProcessBinding,type ProcessObservation} from './process-output.js';
import {sendTerminalFrame,terminalFrames,terminalProof,matchesTerminalProof} from './terminal-transport.js';

export interface TerminalSpawnOptions extends SpawnProcessOptions {interactive?:boolean;pty?:boolean;notify?:boolean;cols?:number;rows?:number;retainOnDisconnect?:boolean;persistOnRelease?:boolean}
interface TerminalHost {archive:ProcessOutputArchive;workingDirectory:string;executeAllowed:()=>boolean;observed:(binding:ProcessBinding,state:ProcessObservation)=>void;check:()=>void;foreground?:()=>boolean}
class TerminalHandle extends ProcessHandle {
  readonly pid:string;readonly command:string;exitCode:number|undefined;
  private readonly requests=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private readonly result:Promise<CommandResult>;private resolveResult!:(value:CommandResult)=>void;private rejectResult!:(error:Error)=>void;
  private readonly ready:Promise<void>;private resolveReady!:()=>void;private rejectReady!:(error:Error)=>void;
  private completed=false;private readonly started=Date.now();readonly child?:ChildProcess;private socket?:Socket;private disconnected=false;
  get attached(){return !this.disconnected;}
  constructor(readonly binding:ProcessBinding,private readonly host:TerminalHost,options:TerminalSpawnOptions={},private readonly adopted=false,cleanup=false){
    super(options);this.pid=binding.id;this.command=binding.command;
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    this.result=new Promise((resolve,reject)=>{this.resolveResult=resolve;this.rejectResult=reject;});void this.result.catch(()=>{});
    const connection=cleanup?host.archive.cleanupConnection(binding.id):host.archive.connection(binding.id);
    const connect=()=>{
      const socket=this.socket=net.createConnection(connection.endpoint),nonce=randomBytes(32).toString('hex');const timeout=setTimeout(()=>{socket.destroy();this.lost();},10000);
      socket.on('connect',()=>sendTerminalFrame(socket,{type:'hello',nonce}));socket.on('error',()=>this.lost());socket.on('close',()=>this.lost());
      terminalFrames(socket,value=>{
        if(value.type==='challenge'){if(typeof value.nonce!=='string'||!/^[a-f0-9]{64}$/.test(value.nonce)||!matchesTerminalProof(value.proof,terminalProof(connection.secret,'worker',nonce,value.nonce))){socket.destroy();return;}sendTerminalFrame(socket,{type:'authenticate',proof:terminalProof(connection.secret,'host',nonce,value.nonce)});return;}
        if(value.type==='attached')clearTimeout(timeout);
        if(value.type==='ready')this.resolveReady();
        if(value.type==='output'&&typeof value.text==='string'){if(value.stream==='stdout')this.emitStdout(value.text);else if(value.stream==='stderr')this.emitStderr(value.text);}
        if(value.type==='reply'&&typeof value.requestId==='string'){const pending=this.requests.get(value.requestId);if(pending){clearTimeout(pending.timer);this.requests.delete(value.requestId);if(value.ok===true)pending.resolve();else pending.reject(new AppError('process_input_failed',409));}}
        if(value.type==='exit')this.end(this.host.archive.observation(this.pid));
      });socket.once('close',()=>clearTimeout(timeout));
    };
    if(adopted){connect();return;}
    let worker=new URL('./terminal-worker.js',import.meta.url);if(!fs.existsSync(worker))worker=new URL('./terminal-worker.ts',import.meta.url);
    const env={PATH:process.env.PATH,...options.env,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{} )};
    this.child=fork(fileURLToPath(worker),[],{execArgv:worker.pathname.endsWith('.ts')?['--import','tsx']:[],stdio:['ignore','ignore','ignore','ipc'],env,detached:true});
    this.child.once('message',value=>{if(value&&typeof value==='object'&&'type'in value&&value.type==='listening')connect();});
    this.child.once('error',()=>this.lost());this.child.once('exit',()=>{if(!this.completed)this.lost();});
    this.child.send({type:'start',directory:host.archive.path(binding.id),command:binding.command,cwd:binding.cwd,timeout:options.timeout,interactive:binding.interactive,pty:binding.pty,cols:options.cols??100,rows:options.rows??30,...connection,retainOnDisconnect:binding.retainOnDisconnect===true});
  }
  private lost(){this.disconnected=true;if(this.completed)return;try{const state=this.host.archive.observation(this.pid);if(terminalStatus(state.status)){this.end(state);return;}}catch{}this.completed=true;const error=new AppError('process_worker_lost',409);this.rejectReady(error);this.rejectResult(error);for(const request of this.requests.values()){clearTimeout(request.timer);request.reject(error);}this.requests.clear();}
  private end(state:ProcessObservation){if(this.completed)return;this.completed=true;this.exitCode=state.exitCode;this.resolveReady();
    try{if(state.exitCode===undefined)this.rejectResult(new AppError('process_exit_unavailable',409));else this.resolveResult({exitCode:state.exitCode,success:state.status==='completed'&&state.exitCode===0,stdout:this.stdout,stderr:this.stderr,stdoutTruncated:this.stdoutTruncated,stderrTruncated:this.stderrTruncated,stdoutDroppedBytes:this.stdoutDroppedBytes,stderrDroppedBytes:this.stderrDroppedBytes,executionTimeMs:Date.now()-this.started,timedOut:state.status==='timed_out',killed:['cancelled','interrupted'].includes(state.status)});}catch(error){this.rejectResult(error instanceof AppError?error:new AppError('process_output_unavailable',409));}
    for(const request of this.requests.values()){clearTimeout(request.timer);request.reject(new AppError('process_input_unconfirmed',409));}this.requests.clear();try{this.host.observed(this.binding,state);}catch{/* The durable observation is reconciled by the core. */}this.detach();
  }
  async initialized(){await this.ready;return this;}
  override get stdout(){if(this.adopted)return this.host.archive.retainedText(this.pid,'stdout');const text=super.stdout,state=this.host.archive.observation(this.pid);return state.stdoutBytes>32768||state.stdoutEncoding==='binary'?`${text}\n[Full output: ${this.pid}; use terminal_process action=log with ${state.stdoutEncoding==='binary'?'encoding=base64 byte pagination':'line or byte pagination'}.]`:text;}
  override get stderr(){if(this.adopted)return this.host.archive.retainedText(this.pid,'stderr');const text=super.stderr,state=this.host.archive.observation(this.pid);return state.stderrBytes>32768||state.stderrEncoding==='binary'?`${text}\n[Full output: ${this.pid}; use terminal_process action=log with stream=stderr and ${state.stderrEncoding==='binary'?'encoding=base64 byte pagination':'line or byte pagination'}.]`:text;}
  async request(action:'write'|'submit'|'close'|'resize'|'kill',data?:string,cols?:number,rows?:number,ownedCleanup=false){if(!ownedCleanup)this.host.archive.binding(this.pid,true);if(this.completed)throw new AppError('process_already_ended',409);const requestId=randomUUID();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(requestId);reject(new AppError('process_input_timeout',504));},10000);this.requests.set(requestId,{resolve,reject,timer});if(!this.socket||this.socket.destroyed){clearTimeout(timer);this.requests.delete(requestId);reject(new AppError('process_worker_lost',409));return;}sendTerminalFrame(this.socket,{type:'input',requestId,action,data,cols,rows});});}
  async sendStdin(data:string){if(!this.binding.interactive)throw new AppError('process_stdin_closed',409);await this.request('write',data);}
  override async closeStdin(){if(!this.binding.interactive)throw new AppError('process_stdin_closed',409);if(this.binding.pty&&process.platform==='win32')throw new AppError('process_pty_eof_unsupported',409);await this.request('close');}
  async kill(){if(this.completed){if(this.exitCode===undefined)throw new AppError('process_termination_unconfirmed',504);return false;}await this.request('kill',undefined,undefined,undefined,true);let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([this.result,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('process_termination_unconfirmed',504)),5000);})]);return true;}finally{clearTimeout(timer);}}
  async wait(){return this.result;}
  detach(){this.socket?.end();this.child?.unref();if(this.child?.connected)this.child.disconnect();}
}

export async function stopArchivedTerminalProcess(archive:ProcessOutputArchive,id:string,observed:(binding:ProcessBinding,state:ProcessObservation)=>void):Promise<void>{
  const binding=archive.cleanupBinding(id),state=archive.observation(id);if(state.status==='unknown')throw new AppError('process_termination_unconfirmed',504);if(terminalStatus(state.status))return;
  const handle=new TerminalHandle(binding,{archive,workingDirectory:binding.root.path,executeAllowed:()=>false,check:()=>{},observed},{},true,true);
  await handle.initialized();await handle.kill();
}

class ArchivedTerminalHandle extends ProcessHandle {
  readonly pid:string;readonly command:string;readonly exitCode:number|undefined;
  constructor(private readonly archive:ProcessOutputArchive,binding:ProcessBinding){super();this.pid=binding.id;this.command=binding.command;const state=archive.observation(this.pid);this.exitCode=state.exitCode;}
  override get stdout(){return this.archive.retainedText(this.pid,'stdout');}
  override get stderr(){return this.archive.retainedText(this.pid,'stderr');}
  async kill():Promise<boolean>{throw new AppError('process_not_live',409);}
  async sendStdin(_data:string){throw new AppError('process_not_live',409);}
  override async closeStdin(){throw new AppError('process_not_live',409);}
  async wait(){const state=this.archive.observation(this.pid);if(state.exitCode===undefined)throw new AppError('process_exit_unavailable',409);return {exitCode:state.exitCode,success:state.status==='completed'&&state.exitCode===0,stdout:this.stdout,stderr:this.stderr,executionTimeMs:0,timedOut:state.status==='timed_out',killed:['cancelled','interrupted'].includes(state.status)};}
}

class TerminalProcessManager extends SandboxProcessManager<TerminalSandbox> {
  constructor(private readonly host:TerminalHost){super();const nativeGet=this.get.bind(this);this.get=(pid,options)=>nativeGet(pid,{...options,release:false});}
  async spawn(command:string,options:TerminalSpawnOptions={}){this.host.check();options.abortSignal?.throwIfAborted();const cwd=path.resolve(this.host.workingDirectory,options.cwd??'.');
    const relative=path.relative(this.host.workingDirectory,cwd);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new AppError('process_cwd_outside_workspace',403);
    let part=this.host.workingDirectory;for(const component of relative.split(path.sep).filter(Boolean)){part=path.join(part,component);const stat=fs.lstatSync(part);if(stat.isSymbolicLink()||!stat.isDirectory())throw new AppError('process_cwd_not_allowed',403);}
    const binding=this.host.archive.create({command,cwd,interactive:options.interactive===true||options.pty===true,pty:options.pty===true,notify:options.notify===true,retainOnDisconnect:options.retainOnDisconnect??!this.host.foreground?.(),persistOnRelease:options.persistOnRelease===true});
    const handle=new TerminalHandle(binding,this.host,options);this._tracked.set(handle.pid,handle);await handle.initialized();return handle;
  }
  async get(pid:string,_options?:{release?:boolean}):Promise<ProcessHandle|undefined>{this.host.check();const binding=this.host.archive.binding(pid),state=this.host.archive.observation(pid);if(terminalStatus(state.status))return new ArchivedTerminalHandle(this.host.archive,binding);const live=this._tracked.get(pid);if(live instanceof TerminalHandle&&live.attached)return live;if(!binding.retainOnDisconnect)throw new AppError('process_recovery_pending',409);const handle=new TerminalHandle(binding,this.host,{},true);this._tracked.set(pid,handle);await handle.initialized();return handle;}
  async list():Promise<ProcessInfo[]>{this.host.check();return this.host.archive.list().map(row=>({pid:row.id,command:row.command,running:!terminalStatus(row.status),exitCode:row.exitCode}));}
  override release(pid:string){const handle=this._tracked.get(pid);if(handle?.exitCode!==undefined)this._tracked.delete(pid);}
  override async kill(pid:string){this.host.archive.binding(pid,true);const handle=await this.get(pid);if(handle instanceof TerminalHandle)this.host.archive.recordAdoption(pid);return super.kill(pid);}
  async shutdown(){const results=await Promise.allSettled([...this._tracked.values()].map(handle=>handle instanceof TerminalHandle&&handle.binding.persistOnRelease?handle.detach():handle.kill())),errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'terminal_cleanup_incomplete');}
}

export class TerminalSandbox extends MastraSandbox {
  readonly id:string;readonly name='TerminalSandbox';readonly provider='local';status:MastraSandbox['status']='pending';declare readonly processes:TerminalProcessManager;readonly archive:ProcessOutputArchive;
  constructor(private readonly host:TerminalHost){const foreground=new AsyncLocalStorage<boolean>(),processes=new TerminalProcessManager({...host,foreground:()=>foreground.getStore()===true});super({name:'TerminalSandbox',processes,workingDirectory:host.workingDirectory});const execute=this.executeCommand!.bind(this);this.executeCommand=(...args)=>foreground.run(true,()=>execute(...args));this.id=`terminal-${randomUUID()}`;this.archive=host.archive;this.defaultCommandTimeout=60000;}
  executeAllowed(){return this.host.executeAllowed();}
  async start(){this.host.check();}
  async stop(){await this.processes.shutdown();}
  async destroy(){await this.processes.shutdown();}
  async getInfo(){return {id:this.id,name:this.name,provider:this.provider,status:this.status,createdAt:new Date()};}
  getInstructions(){return `Commands execute in ${this.workingDirectory}. Every command retains its full output under a scoped process identifier. Use terminal_process for interactive input, PTY sessions and repeatable output pagination.`;}
  async input(id:string,action:'write'|'submit'|'close'|'resize'|'kill',data?:string,cols?:number,rows?:number){const binding=this.archive.binding(id,true);if(action==='close'&&binding.pty&&process.platform==='win32')throw new AppError('process_pty_eof_unsupported',409);const handle=await this.processes.get(id);if(!(handle instanceof TerminalHandle))throw new AppError('process_not_live',409);this.archive.recordAdoption(id);if(action==='kill'){await handle.kill();return;}await handle.request(action,data,cols,rows);}
}
