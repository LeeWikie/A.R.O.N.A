import fs from 'node:fs';
import path from 'node:path';
import {spawn,fork,type ChildProcess,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AppError} from '../domain.js';
import {terminalSupervisorScript} from './terminal-supervisor-script.js';
import {terminalSupervisorWindows} from './terminal-supervisor-windows.js';

/** Warm registrations cover only process groups owned by this still-live native handle. */
export class TerminalSupervisor {
  private readonly child:ChildProcessWithoutNullStreams;
  private readonly waiters=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private closed=false;
  private observer?:ChildProcess;
  readonly exited:Promise<void>;
  private constructor(directory:string,lost:()=>void){
    let observer=new URL('./terminal-observer.js',import.meta.url);if(!fs.existsSync(observer))observer=new URL('./terminal-observer.ts',import.meta.url);
    const option=observer.pathname.endsWith('.ts')?'--import=tsx':'--no-warnings';
    this.child=process.platform==='win32'
      ?spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',terminalSupervisorWindows],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ARONA_TERMINAL_OBSERVER_NODE:process.execPath,ARONA_TERMINAL_OBSERVER_OPTION:option,ARONA_TERMINAL_OBSERVER_FILE:fileURLToPath(observer),ARONA_TERMINAL_OBSERVER_DIRECTORY:directory}})
      :spawn('/bin/sh',['-c',terminalSupervisorScript,'arona-terminal-owner',String(process.pid),process.execPath,option,fileURLToPath(observer),directory],{detached:true,stdio:['pipe','pipe','pipe']});
    let pending='';this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>{pending+=chunk;for(;;){const index=pending.indexOf('\n');if(index<0)break;const line=pending.slice(0,index).replace(/\r$/,'');pending=pending.slice(index+1);const waiter=this.waiters.get(line);if(waiter){clearTimeout(waiter.timer);this.waiters.delete(line);waiter.resolve();}}});
    let errorBytes=0;this.child.stderr.on('data',(data:Buffer)=>{if(errorBytes>32768)return;errorBytes+=data.length;const file=fs.openSync(path.join(directory,'supervisor-errors.log'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);try{if(fs.fstatSync(file).nlink!==1)throw new AppError('process_storage_redirected',409);fs.writeSync(file,data);}finally{fs.closeSync(file);}});this.child.stdin.on('error',()=>{});
    this.exited=new Promise(resolve=>{this.child.once('exit',()=>{for(const waiter of this.waiters.values()){clearTimeout(waiter.timer);waiter.reject(new AppError('process_supervisor_lost',409));}this.waiters.clear();if(!this.closed)lost();resolve();});});
    this.child.once('error',(error:NodeJS.ErrnoException)=>{fs.writeFileSync(path.join(directory,'supervisor-error.json'),JSON.stringify({stage:'spawn',code:error.code??'spawn_failed'}),{mode:0o600,flag:'wx'});for(const waiter of this.waiters.values()){clearTimeout(waiter.timer);waiter.reject(new AppError('process_supervisor_unavailable',409));}this.waiters.clear();});
  }
  private wait(line:string){return new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(line);reject(new AppError('process_supervisor_unavailable',409));},process.platform==='win32'?10000:3000);this.waiters.set(line,{resolve,reject,timer});});}
  static async open(directory:string,lost:()=>void){const supervisor=new TerminalSupervisor(directory,lost);try{await supervisor.wait('ready');if(process.platform==='win32')await supervisor.watchWorker(directory);return supervisor;}catch(error){supervisor.close();throw error;}}
  private async watchWorker(directory:string){
    let script=new URL('./terminal-observer.js',import.meta.url);if(!fs.existsSync(script))script=new URL('./terminal-observer.ts',import.meta.url);
    const observer=this.observer=fork(fileURLToPath(script),['--watch-worker',directory],{execArgv:script.pathname.endsWith('.ts')?['--import','tsx']:[],detached:true,stdio:['ignore','ignore','ignore','ipc']});
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new AppError('process_observer_unavailable',409)),10000);observer.once('error',()=>{clearTimeout(timer);reject(new AppError('process_observer_unavailable',409));});observer.once('message',value=>{clearTimeout(timer);if(value&&typeof value==='object'&&'type'in value&&value.type==='ready')resolve();else reject(new AppError('process_observer_unavailable',409));});});
  }
  async register(group:number){if(!Number.isSafeInteger(group)||group<=1||this.closed)throw new AppError('process_supervisor_unavailable',409);const registered=this.wait(`registered ${group}`);this.child.stdin.write(`register ${group}\n`);await registered;}
  async terminate(){if(process.platform!=='win32'||this.closed)throw new AppError('process_supervisor_unavailable',409);const terminated=this.wait('terminated');this.child.stdin.write('terminate\n');await terminated;}
  async close(group?:number){if(this.closed)return this.exited;this.closed=true;if(group)this.child.stdin.write(`unregister ${group}\n`);this.child.stdin.end();await this.exited;if(this.observer?.connected)this.observer.disconnect();this.observer?.unref();}
}
