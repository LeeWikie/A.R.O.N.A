import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import { AppError } from './domain.js';

const resourceName='core.lock.sqlite';
type FileIdentity={dev:number;ino:number};
interface LockRecord {pid:number;owner?:string;version?:number;resource?:string;resourceIdentity?:FileIdentity;}
interface LockSnapshot {value:LockRecord;raw:string;identity:FileIdentity;mtimeMs:number;}
const sameFile=(left:FileIdentity,right:FileIdentity)=>left.dev===right.dev&&left.ino===right.ino;

export function privateDataDirectory(directory:string){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const resolved=fs.realpathSync.native(directory),stat=fs.statSync(resolved);
  if(!stat.isDirectory()||process.getuid&&stat.uid!==process.getuid())throw new AppError('data_directory_not_owned',403);
  if(process.platform!=='win32'&&(stat.mode&0o777)!==0o700)fs.chmodSync(resolved,0o700);
  return resolved;
}
/** Keep existing bytes and validate the opened inode before narrowing its permissions. */
export function privateCoreFile(file:string,create=true){
  const descriptor=fs.openSync(file,fs.constants.O_RDWR|(create?fs.constants.O_CREAT:0)|fs.constants.O_NOFOLLOW,0o600);
  try{const stat=fs.fstatSync(descriptor),visible=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||!sameFile(stat,visible)||visible.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid())throw new AppError('core_file_redirected',403);if(process.platform!=='win32')fs.fchmodSync(descriptor,0o600);return {dev:stat.dev,ino:stat.ino};}finally{fs.closeSync(descriptor);}
}
export function preparePrivateCoreFiles(directory:string){for(const name of ['records.sqlite','history.sqlite'])privateCoreFile(path.join(directory,name));}
export function validateExistingPrivateCoreFiles(directory:string){for(const name of ['records.sqlite','history.sqlite']){const file=path.join(directory,name);try{fs.lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}privateCoreFile(file,false);}}
export function privateCoreDirectory(directory:string,name:string){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))throw new AppError('invalid_core_directory');
  const root=privateDataDirectory(directory),target=path.join(root,name);try{fs.mkdirSync(target,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const visible=fs.lstatSync(target);if(!visible.isDirectory()||visible.isSymbolicLink()||process.getuid&&visible.uid!==process.getuid())throw new AppError('core_directory_redirected',403);
  if(process.platform!=='win32'){const descriptor=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const opened=fs.fstatSync(descriptor);if(!opened.isDirectory()||!sameFile(opened,visible)||!sameFile(opened,fs.lstatSync(target)))throw new AppError('core_directory_redirected',403);fs.fchmodSync(descriptor,0o700);}finally{fs.closeSync(descriptor);}}
  return target;
}
function readLock(file:string):LockSnapshot|undefined{
  let descriptor:number;
  try{descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new AppError('data_directory_lock_unavailable',409);}
  try{const stat=fs.fstatSync(descriptor),visible=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>4096||!sameFile(stat,visible)||visible.isSymbolicLink())throw new AppError('data_directory_lock_unavailable',409);const raw=fs.readFileSync(descriptor,'utf8'),value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||!('pid'in value)||typeof value.pid!=='number'||!Number.isInteger(value.pid)||value.pid<=0)throw new AppError('data_directory_lock_unavailable',409);return {value:value as LockRecord,raw,identity:{dev:stat.dev,ino:stat.ino},mtimeMs:stat.mtimeMs};}catch(error){throw error instanceof AppError?error:new AppError('data_directory_lock_unavailable',409);}finally{fs.closeSync(descriptor);}
}
function processStartLowerBound(pid:number):number|undefined{
  if(pid===process.pid)return performance.timeOrigin;
  try{
    if(process.platform==='darwin'){const value=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C',LANG:'C'}}).trim(),date=Date.parse(value);return Number.isFinite(date)?date:undefined;}
    if(process.platform==='linux'){const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' '),ticks=Number(parts[19]),boot=/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat','utf8'))?.[1];if(!Number.isFinite(ticks)||!boot)return;const rate=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}));return rate>0?Number(boot)*1000+ticks/rate*1000:undefined;}
  }catch{}return;
}
function legacyOwnerAlive(snapshot:LockSnapshot){
  try{process.kill(snapshot.value.pid,0);}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
  const started=processStartLowerBound(snapshot.value.pid);return started===undefined||started<=snapshot.mtimeMs;
}
function currentFormat(snapshot:LockSnapshot,identity:FileIdentity){return snapshot.value.version===2&&snapshot.value.resource===resourceName&&snapshot.value.resourceIdentity&&sameFile(snapshot.value.resourceIdentity,identity);}
function kernelOwnership(directory:string){
  const resource=path.join(directory,resourceName),identity=privateCoreFile(resource);let database:DatabaseSync|undefined;
  try{
    database=new DatabaseSync(resource);database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');if(!sameFile(identity,fs.lstatSync(resource)))throw new AppError('core_file_redirected',403);
    let released=false;return {identity,release:()=>{if(released)return;released=true;try{database!.exec('ROLLBACK');}finally{database!.close();}}};
  }catch(error){try{database?.close();}catch{}if(error&&typeof error==='object'&&'errcode'in error&&[5,6].includes(Number(error.errcode)))throw new AppError('data_directory_locked',409);throw error;}
}
/** Probe only the ownership resource; PID metadata is advisory for version-two owners. */
export function coreLockHeld(directory:string){
  if(!fs.existsSync(directory))return false;const resolved=privateDataDirectory(directory);let held:ReturnType<typeof kernelOwnership>;
  try{held=kernelOwnership(resolved);}catch(error){if(error instanceof AppError&&error.code==='data_directory_locked')return true;throw error;}
  try{const snapshot=readLock(path.join(resolved,'core.lock'));return Boolean(snapshot&&!currentFormat(snapshot,held.identity)&&legacyOwnerAlive(snapshot));}finally{held.release();}
}
export function acquireLock(directory: string): () => void {
  const resolved=privateDataDirectory(directory),held=kernelOwnership(resolved),file=path.join(resolved,'core.lock'),owner=randomUUID();
  try{
    for(let attempt=0;attempt<3;attempt++){
      const previous=readLock(file);if(previous){if(!currentFormat(previous,held.identity)&&legacyOwnerAlive(previous))throw new AppError('data_directory_locked',409);const current=readLock(file);if(!current||!sameFile(previous.identity,current.identity)||current.raw!==previous.raw)continue;fs.unlinkSync(file);}
      try{fs.writeFileSync(file,JSON.stringify({version:2,pid:process.pid,owner,resource:resourceName,resourceIdentity:held.identity}),{flag:'wx',mode:0o600});let released=false;return ()=>{if(released)return;released=true;try{const current=readLock(file);if(current?.value.owner===owner)fs.unlinkSync(file);}catch{}finally{held.release();}};}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    }
    throw new AppError('data_directory_locked',409);
  }catch(error){held.release();throw error;}
}
