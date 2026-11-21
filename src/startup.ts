import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Client} from './client.js';
import {readConfig} from './config.js';
import {AppError} from './domain.js';
import {protocolHandshakeSchema} from './protocol.js';
import {coreLockHeld,privateDataDirectory,privateCoreFile} from './lock.js';

export interface CoreLocation {pid:number;baseURL:string;startedAt:string;owner?:string;storageId?:string;instanceId?:string}
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
export function writeCoreLocation(directory:string,baseURL:string,identity?:{storageId:string;instanceId:string}){
  const file=path.join(directory,'core-endpoint.json'),owner=randomUUID(),temporary=file+'.'+owner+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify({pid:process.pid,baseURL,startedAt:new Date().toISOString(),owner,...identity}),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return ()=>{try{const value=readPrivateJSON(file) as CoreLocation;if(value.owner===owner)fs.unlinkSync(file);}catch{}};
}
function live(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
function recordedStorageIdentity(directory:string):string|undefined{
  const file=path.join(directory,'records.sqlite');let fd:number;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new AppError('core_storage_identity_unavailable',409);}
  let database:DatabaseSync|undefined;
  try{const stat=fs.fstatSync(fd),visible=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||visible.isSymbolicLink()||stat.dev!==visible.dev||stat.ino!==visible.ino||process.getuid&&stat.uid!==process.getuid())throw Error();
    database=new DatabaseSync(file,{readOnly:true});const opened=fs.lstatSync(file);if(stat.dev!==opened.dev||stat.ino!==opened.ino)throw Error();
    if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_settings'").get())return;
    const row=database.prepare("SELECT body FROM runtime_settings WHERE id='protocol-storage-id'").get();if(!row)return;
    const value:unknown=JSON.parse(String(row.body));if(typeof value!=='string'||!value.length)throw Error();return value;
  }catch{throw new AppError('core_storage_identity_unavailable',409);}finally{database?.close();fs.closeSync(fd);}
}
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
    try{const handshake=protocolHandshakeSchema.parse(await client.handshake(AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(1200)])));
      if(!explicit){const owner=coreLocation(directory),recorded=recordedStorageIdentity(directory),expected=recorded??owner?.storageId;
        if(expected&&handshake.storageId!==expected||owner?.storageId&&handshake.storageId!==owner.storageId)throw new AppError('core_storage_mismatch',409);
        if(owner?.instanceId&&handshake.instanceId!==owner.instanceId)throw new AppError('core_instance_changed',409);
        if(!expected&&!owner)throw new AppError('core_storage_identity_unavailable',409);
      }return client;}
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
  const otherStarting=coreLockHeld(directory);
  let child:ReturnType<typeof spawn>|undefined;let spawnError:Error|undefined;let exited:number|null|undefined;
  if(!otherStarting){
    privateDataDirectory(directory);
    const here=path.dirname(fileURLToPath(import.meta.url));const compiled=path.join(here,'server.js');const source=path.join(here,'server.ts');
    const args=fs.existsSync(compiled)?[compiled]:['--import',new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url).href,source];
    if(withoutModel)args.push('--without-startup-model');
    const logfile=path.join(directory,'core.log');
    if(fs.existsSync(logfile)){const stat=fs.lstatSync(logfile);if(stat.isSymbolicLink()||stat.nlink>1)throw new AppError('core_log_redirected');}
    privateCoreFile(logfile);const output=fs.openSync(logfile,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
    try{
      child=spawn(process.execPath,args,{cwd:path.resolve(here,'..'),env:{...(withoutModel?noModelEnvironment(env):env),SHITTIMCHEST_DATA_DIR:directory,SHITTIMCHEST_PORT:String(port)},detached:true,windowsHide:true,stdio:['ignore',output,output]});
      child.on('error',error=>{spawnError=error;});child.on('exit',code=>{exited=code;});child.unref();
    }finally{fs.closeSync(output);}
  }
  let attached = false;
  try {
    const deadline=Date.now()+(options.timeoutMs??20000);
    while(Date.now()<deadline){
      options.signal?.throwIfAborted();if(spawnError)throw new AppError('core_start_failed',503);
      const ready=await probe();options.signal?.throwIfAborted();
      if(ready){attached=true;return {client:ready,started:child?.pid!==undefined&&coreLocation(directory)?.pid===child.pid,diagnostics};}
      if(exited!==undefined&&!coreLockHeld(directory))throw new AppError('core_start_failed',503);
      await new Promise<void>(resolve=>{const timer=setTimeout(done,100);function done(){clearTimeout(timer);options.signal?.removeEventListener('abort',done);resolve();}options.signal?.addEventListener('abort',done,{once:true});});
    }
    throw new AppError('core_start_timeout',503);
  } finally {
    // A cancelled or failed attach owns only the child it spawned, never another core.
    let serving=false;
    if(!attached&&child?.pid&&exited===undefined&&!spawnError){const own=coreLocation(directory);if(own?.pid===child.pid)try{const state=protocolHandshakeSchema.parse(await new Client(own.baseURL,token,2,directory).handshake(AbortSignal.timeout(1000)));serving=!own.instanceId||state.instanceId===own.instanceId;}catch{}}
    if(!attached&&!serving&&child?.pid&&exited===undefined&&!spawnError){
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

/** Keep startup failures actionable without printing provider responses or credentials. */
export function startupFailureMessage(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (error instanceof Error && error.name === 'AbortError') return '已取消。';
  const code = error instanceof AppError ? error.code : 'client_failed';
  const hints: Record<string, string> = {
    core_unavailable: '无法连接核心。请确认核心正在运行，并检查 SHITTIMCHEST_CORE_URL；本机可运行 arona core start。',
    connection_failed: '连接失败。请检查核心地址与网络，再运行 arona core status。',
    core_start_failed: `核心启动失败。请查看 ${path.join(dataDirectory(env), 'core.log')}，修复后运行 arona core start。`,
    core_start_timeout: `等待核心启动超时。请查看 ${path.join(dataDirectory(env), 'core.log')}，并检查配置端口是否被占用。`,
    core_protocol_unsupported: '核心与客户端版本不兼容。请使用同一版本的核心和客户端。',
    core_storage_mismatch: '该端口上的核心使用另一个数据目录。请检查数据目录与端口，或明确指定核心地址。',
    core_storage_identity_unavailable: '无法确认核心属于当前数据目录。请检查数据目录与核心地址。',
    core_instance_changed: '核心已重新启动，但连接记录尚未更新。请重新连接或检查核心运行状态。',
    node_24_required: '需要 Node.js 24。请切换到 Node.js 24 后重新启动。',
    invalid_port: '端口必须是 1 到 65535 的整数。请检查 SHITTIMCHEST_PORT。',
    invalid_core_url: '核心地址无效。请将 SHITTIMCHEST_CORE_URL 设置为有效的 HTTP 或 HTTPS 地址。',
    control_token_required: '缺少核心访问凭据。请使用核心对应的数据目录，或设置 SHITTIMCHEST_CONTROL_TOKEN。',
    unauthorized: '核心访问凭据不正确。请检查数据目录或 SHITTIMCHEST_CONTROL_TOKEN。',
    invalid_control_token: '核心访问凭据不正确。请检查数据目录或 SHITTIMCHEST_CONTROL_TOKEN。',
    terminal_projects_unsupported: '当前核心不支持终端项目会话。请更新核心，或用 --context 明确打开已有会话。',
    local_workspace_identity_required: '无法确认本机目录属于当前核心。请检查数据目录；连接远端核心时请用 --workspace 选择服务端工作区。',
    workspace_directory_changed: '项目目录已经变化。请核对目录后重新打开新会话。',
    workspace_directory_unavailable: '无法访问项目目录。请检查目录是否存在以及当前账号的访问权限。',
    workspace_directory_protected: '该目录用于私有资料，不能自动作为项目打开。请从项目目录启动。',
    terminal_session_directory_changed: '原会话的项目目录已经变化。请核对目录后打开新会话。',
    terminal_session_workspace_changed: '原会话的工作区已经变化。请核对工作区后重新打开。',
    terminal_session_context_unavailable: '该会话已归档或不可用。可从会话列表选择其它会话。',
    conflicting_session_options: '会话选项互相冲突。请分别使用 --continue、--workspace 或 --context。',
    session_option_value_required: '会话选项缺少值。--context / --session 后填写会话 ID，--workspace 后填写工作区 ID。',
    session_options_require_chat: '这些会话选项用于 chat、tui 或 send。',
    unknown_core_command: '用法：arona core start、arona core status 或 arona core stop。',
  };
  const hint = hints[code] ?? (error instanceof AppError && [401, 403].includes(error.status) ? '核心访问被拒绝。请检查数据目录和核心访问凭据。' : '操作失败，请检查参数与核心连接后重试。');
  return `${hint}（${code}）`;
}
