import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Client} from './client.js';
import {readConfig} from './config.js';
import {AppError} from './domain.js';
import {protocolHandshakeSchema} from './protocol.js';

export interface CoreLocation {pid:number;baseURL:string;startedAt:string}
export interface StartupResult {client:Client;started:boolean;diagnostics:string[]}
const localHost=(hostname:string)=>['127.0.0.1','localhost','[::1]'].includes(hostname);
export function dataDirectory(env:NodeJS.ProcessEnv=process.env){return path.resolve(env.SHITTIMCHEST_DATA_DIR||env.ARONA_DATA_DIR||path.join(os.homedir(),'.arona'));}
function readPrivateJSON(file:string):unknown {
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new AppError('core_locator_redirected');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
export function coreLocation(directory:string):CoreLocation|undefined {
  const file=path.join(directory,'core-endpoint.json');if(!fs.existsSync(file))return undefined;
  try{const value=readPrivateJSON(file) as CoreLocation;const url=new URL(value.baseURL);if(!Number.isInteger(value.pid)||value.pid<=0||url.protocol!=='http:'||!localHost(url.hostname)||url.username||url.password||url.search||url.hash)throw Error();return value;}
  catch(error){if(error instanceof AppError)throw error;return undefined;}
}
export function writeCoreLocation(directory:string,baseURL:string){
  const file=path.join(directory,'core-endpoint.json');const temporary=file+'.'+process.pid+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify({pid:process.pid,baseURL,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return ()=>{try{const value=readPrivateJSON(file) as CoreLocation;if(value.pid===process.pid)fs.unlinkSync(file);}catch{}};
}
function live(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
function noModelEnvironment(env:NodeJS.ProcessEnv){return Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('SHITTIMCHEST_MODEL_')&&!key.startsWith('ARONA_MODEL_')));}

/** Reuse the existing independently running core; the terminal is only its authenticated client. */
export async function ensureCore(options:{env?:NodeJS.ProcessEnv;signal?:AbortSignal;autoStart?:boolean;timeoutMs?:number}={}):Promise<StartupResult>{
  options.signal?.throwIfAborted();
  if(Number(process.versions.node.split('.')[0])!==24)throw new AppError('node_24_required');
  const env=options.env??process.env;const directory=dataDirectory(env);const explicit=env.SHITTIMCHEST_CORE_URL??env.ARONA_CORE_URL;
  const location=coreLocation(directory);const port=Number(env.SHITTIMCHEST_PORT??env.ARONA_PORT??4111);
  if(!Number.isInteger(port)||port<1||port>65535)throw new AppError('invalid_port');
  const baseURL=explicit??(location&&live(location.pid)?location.baseURL:undefined)??`http://127.0.0.1:${port}`;
  const url=new URL(baseURL);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new AppError('invalid_core_url');
  const token=env.SHITTIMCHEST_CONTROL_TOKEN??env.ARONA_CONTROL_TOKEN;
  const makeClient=()=>new Client(baseURL,token,2,directory);
  const probe=async()=>{
    const client=makeClient();
    try{protocolHandshakeSchema.parse(await client.handshake(AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(1200)])));return client;}
    catch(error){if(error instanceof AppError&&[401,403].includes(error.status))throw error;
      if(error instanceof AppError&&error.status===404)throw new AppError('core_protocol_unsupported',409);
      if(error instanceof AppError&&error.status!==502)throw error;
      return undefined;
    }
  };
  const existing=await probe();options.signal?.throwIfAborted();if(existing)return {client:existing,started:false,diagnostics:[]};
  if(explicit||options.autoStart===false||!localHost(url.hostname))throw new AppError('core_unavailable',503);
  const diagnostics:string[]=[];let withoutModel=false;
  try{readConfig(env);}catch(error){
    if(error instanceof AppError&&['invalid_model_configuration','invalid_model_base_url'].includes(error.code)){withoutModel=true;diagnostics.push(error.code);}else throw error;
  }
  const lock=path.join(directory,'core.lock');let otherStarting=false;
  if(fs.existsSync(lock)){try{const value=readPrivateJSON(lock) as {pid:number};otherStarting=Number.isInteger(value.pid)&&live(value.pid);}catch(error){if(error instanceof AppError)throw error;}}
  let child:ReturnType<typeof spawn>|undefined;let spawnError:Error|undefined;let exited:number|null|undefined;
  if(!otherStarting){
    fs.mkdirSync(directory,{recursive:true});
    const here=path.dirname(fileURLToPath(import.meta.url));const compiled=path.join(here,'server.js');const source=path.join(here,'server.ts');
    const args=fs.existsSync(compiled)?[compiled]:['--import',new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url).href,source];
    if(withoutModel)args.push('--without-startup-model');
    const logfile=path.join(directory,'core.log');
    if(fs.existsSync(logfile)){const stat=fs.lstatSync(logfile);if(stat.isSymbolicLink()||stat.nlink>1)throw new AppError('core_log_redirected');}
    const output=fs.openSync(logfile,'a',0o600);
    try{
      child=spawn(process.execPath,args,{cwd:path.resolve(here,'..'),env:{...(withoutModel?noModelEnvironment(env):env),SHITTIMCHEST_DATA_DIR:directory,SHITTIMCHEST_PORT:String(port)},detached:true,windowsHide:true,stdio:['ignore',output,output]});
      child.on('error',error=>{spawnError=error;});child.on('exit',code=>{exited=code;});child.unref();
    }finally{fs.closeSync(output);}
  }
  let attached = false;
  try {
    const deadline=Date.now()+(options.timeoutMs??20000);
    while(Date.now()<deadline){
      options.signal?.throwIfAborted();if(spawnError||exited!==undefined)throw new AppError('core_start_failed',503);
      const ready=await probe();options.signal?.throwIfAborted();
      if(ready){attached=true;return {client:ready,started:Boolean(child),diagnostics};}
      await new Promise<void>(resolve=>{const timer=setTimeout(done,100);function done(){clearTimeout(timer);options.signal?.removeEventListener('abort',done);resolve();}options.signal?.addEventListener('abort',done,{once:true});});
    }
    throw new AppError('core_start_timeout',503);
  } finally {
    // A cancelled or failed attach owns only the child it spawned, never another core.
    if(!attached&&child?.pid&&exited===undefined&&!spawnError){
      const ownChild=child;
      await new Promise<void>(resolve=>{
        const timer=setTimeout(done,5000);
        function done(){clearTimeout(timer);ownChild.removeListener('close',done);resolve();}
        ownChild.once('close',done);
        if(!ownChild.kill())done();
      });
    }
  }
}
