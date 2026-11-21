import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {acquireLock,coreLockHeld} from '../src/lock.js';
import {Core} from '../src/core.js';
import {backupLegacyData} from '../src/migration.js';
import {DatabaseSync} from 'node:sqlite';

async function wait<T>(read:()=>T,ready:(value:T)=>boolean){const deadline=Date.now()+10000;for(;;){const value=read();if(ready(value))return value;if(Date.now()>deadline)throw Error('fixture_timeout');await new Promise(resolve=>setTimeout(resolve,10));}}
function launch(directory:string,mode='hold'){
  const process=fork(fileURLToPath(new URL('./core-lock-fixture.ts',import.meta.url)),[directory,mode],{stdio:['ignore','ignore','pipe','ipc']}),events:Array<{stage:string;code?:string;pid?:number}>=[];let error='';process.stderr!.on('data',chunk=>error+=chunk);
  process.on('message',value=>{if(value&&typeof value==='object'&&'stage'in value&&typeof value.stage==='string')events.push(value as {stage:string;code?:string;pid?:number});});
  return {process,events,error:()=>error,wait:(stage:string)=>wait(()=>events.find(event=>event.stage===stage),Boolean)};
}
async function close(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const stopped=once(child,'exit');if(child.connected)child.send('release');else child.kill('SIGKILL');await stopped;}
async function remove(directory:string){await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}

test('kernel ownership prevents a second stale reader deleting a replacement owner',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-lock-race-')),children:ReturnType<typeof launch>[]=[];
  try{
    fs.writeFileSync(path.join(directory,'core.lock'),JSON.stringify({pid:2147483000,owner:'synthetic-dead-owner'}));
    const first=launch(directory,'stale-reader');children.push(first);await first.wait('before-unlink');
    const second=launch(directory);children.push(second);assert.equal((await second.wait('rejected'))?.code,'data_directory_locked');assert.equal(coreLockHeld(directory),true);
    fs.writeFileSync(path.join(directory,'release-stale-reader'),'release');await first.wait('acquired');assert.equal(children.flatMap(child=>child.events).filter(event=>event.stage==='acquired').length,1);
  }finally{fs.writeFileSync(path.join(directory,'release-stale-reader'),'release');await Promise.all(children.map(child=>close(child.process)));await remove(directory);}
});

test('SIGKILL releases the kernel resource and a recycled PID hint cannot block the next owner',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-lock-crash-')),holder=launch(directory);let release:(()=>void)|undefined;
  try{
    await holder.wait('acquired');const file=path.join(directory,'core.lock'),old=JSON.parse(fs.readFileSync(file,'utf8')) as {pid:number;owner:string};const stopped=once(holder.process,'exit');holder.process.kill('SIGKILL');await stopped;
    old.pid=process.pid;fs.writeFileSync(file,JSON.stringify(old));assert.equal(coreLockHeld(directory),false);release=acquireLock(directory);assert.notEqual((JSON.parse(fs.readFileSync(file,'utf8')) as {owner:string}).owner,old.owner);assert.equal(coreLockHeld(directory),true);
  }finally{release?.();await close(holder.process);await remove(directory);}
});

test('an active legacy owner is refused and its original lock bytes remain untouched',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-lock-legacy-')),legacy=launch(directory,'legacy');let release:(()=>void)|undefined;
  try{await legacy.wait('acquired');const bytes=fs.readFileSync(path.join(directory,'core.lock'));assert.equal(coreLockHeld(directory),true);assert.throws(()=>acquireLock(directory),/data_directory_locked/);assert.deepEqual(fs.readFileSync(path.join(directory,'core.lock')),bytes);await close(legacy.process);release=acquireLock(directory);assert.equal(coreLockHeld(directory),true);}
  finally{release?.();await close(legacy.process);await remove(directory);}
});

test('removing advisory PID metadata cannot create a second owner while its kernel resource is held',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-lock-projection-')),holder=launch(directory);let release:(()=>void)|undefined;
  try{await holder.wait('acquired');holder.process.send('remove-projection');await holder.wait('projection-removed');assert.equal(coreLockHeld(directory),true);assert.throws(()=>acquireLock(directory),/data_directory_locked/);await close(holder.process);release=acquireLock(directory);assert.equal(coreLockHeld(directory),true);}
  finally{release?.();await close(holder.process);await remove(directory);}
});

test('same-process release is idempotent and immediately permits reacquisition and removal',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-lock-release-'));const first=acquireLock(directory);assert.throws(()=>acquireLock(directory),/data_directory_locked/);first();first();const second=acquireLock(directory);second();await remove(directory);assert.equal(fs.existsSync(directory),false);
});

test('lock resources reject symbolic and hard-linked files before modifying their target',{skip:process.platform==='win32'},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-lock-links-'));try{
    const target=path.join(directory,'unrelated'),resource=path.join(directory,'core.lock.sqlite');fs.writeFileSync(target,'SYNTHETIC_UNRELATED_BYTES');fs.symlinkSync(target,resource);assert.throws(()=>acquireLock(directory));assert.equal(fs.readFileSync(target,'utf8'),'SYNTHETIC_UNRELATED_BYTES');fs.unlinkSync(resource);fs.linkSync(target,resource);assert.throws(()=>acquireLock(directory),/core_file_redirected/);assert.equal(fs.readFileSync(target,'utf8'),'SYNTHETIC_UNRELATED_BYTES');
  }finally{await remove(directory);}
});

test('database redirects are rejected before any backup or migration opens the target',{skip:process.platform==='win32'},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-database-links-'));
  try{for(const name of ['records.sqlite','history.sqlite'])for(const link of ['symbolic','hard']){
    const data=path.join(directory,name+'-'+link);fs.mkdirSync(data);const target=path.join(directory,'unrelated-'+name+'-'+link);fs.writeFileSync(target,'SYNTHETIC_UNRELATED_DATABASE_BYTES',{mode:0o644});const before=fs.readFileSync(target);
    if(link==='symbolic')fs.symlinkSync(target,path.join(data,name));else fs.linkSync(target,path.join(data,name));
    await assert.rejects(Core.open({dataDir:data,memoryEnabled:false}));assert.deepEqual(fs.readFileSync(target),before);assert.equal(fs.statSync(target).mode&0o777,0o644);assert.equal(fs.existsSync(path.join(data,'backups')),false);assert.equal(coreLockHeld(data),false);
  }}finally{await remove(directory);}
});

test('first installation creates private databases without producing a fictitious legacy backup',{skip:process.platform==='win32'},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-private-'));fs.chmodSync(directory,0o755);const core=await Core.open({dataDir:directory,memoryEnabled:false});
  try{assert.equal(fs.statSync(directory).mode&0o777,0o700);for(const file of ['records.sqlite','history.sqlite','core.lock.sqlite','core.lock','control-token'])assert.equal(fs.statSync(path.join(directory,file)).mode&0o777,0o600,file);assert.equal(fs.existsSync(path.join(directory,'backups')),false);}
  finally{await core.close();await remove(directory);}
});

test('a redirected migration parent cannot copy private databases outside the owned data directory',{skip:process.platform==='win32'},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-backup-redirect-')),data=path.join(directory,'data'),outside=path.join(directory,'outside');fs.mkdirSync(data);fs.mkdirSync(outside);
 const file=path.join(data,'records.sqlite'),database=new DatabaseSync(file);database.exec("CREATE TABLE synthetic_private_body(value TEXT); INSERT INTO synthetic_private_body VALUES('SYNTHETIC_PRIVATE_BACKUP_BODY')");database.close();const before=fs.readFileSync(file);fs.symlinkSync(outside,path.join(data,'migration-backups'));
 try{await assert.rejects(backupLegacyData(data),/core_directory_redirected/);assert.deepEqual(fs.readdirSync(outside),[]);assert.deepEqual(fs.readFileSync(file),before);}
 finally{await remove(directory);}
});
