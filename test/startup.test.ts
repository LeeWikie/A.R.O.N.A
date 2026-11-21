import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {ensureCore,coreLocation,startupFailureMessage,writeCoreLocation} from '../src/startup.js';
import {AppError} from '../src/domain.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {until,removeTemp} from './helpers.js';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {serve} from '@hono/node-server';

function environment(directory:string,port:number):NodeJS.ProcessEnv{
 const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
 return {...env,SHITTIMCHEST_DATA_DIR:directory,SHITTIMCHEST_PORT:String(port),SHITTIMCHEST_MEMORY_ENABLED:'false'};
}
async function freePort(){const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const address=listener.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>listener.close(()=>resolve()));return address.port;}
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}

test('single entry starts and attaches an authenticated independent core in a Unicode directory', {timeout:40000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-startup-中文 空格-'));const port=await freePort();const env=environment(dir,port);let pid:number|undefined;
 try{
  const first=await ensureCore({env});pid=coreLocation(dir)?.pid;assert.ok(pid);assert.equal(first.started,true);assert.equal((await first.client.handshake()).protocolVersion,1);
  const second=await ensureCore({env});assert.equal(second.started,false);assert.equal((await second.client.handshake()).instanceId,(await first.client.handshake()).instanceId);
  assert.equal((await fetch(`http://127.0.0.1:${port}/snapshot`)).status,401);
  const cli=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'core','stop'],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let output='';cli.stdout.on('data',chunk=>{output+=chunk;});cli.stderr.on('data',chunk=>{output+=chunk;});
  const code=await new Promise<number|null>((resolve,reject)=>{cli.once('error',reject);cli.once('close',resolve);});
  assert.equal(code,0,output);assert.equal(JSON.parse(output).stopping,true);
  await until(()=>alive(pid!),value=>!value,15000);assert.equal(coreLocation(dir),undefined);
 }catch(error){const log=path.join(dir,'core.log');if(fs.existsSync(log))console.error(fs.readFileSync(log,'utf8'));throw error;}finally{if(pid&&alive(pid))process.kill(pid);await removeTemp(dir);}
});

test('startup diagnostics give recovery actions without exposing arbitrary error text',()=>{
 const env={SHITTIMCHEST_DATA_DIR:path.join(os.tmpdir(),'arona-diagnostics')};
 assert.match(startupFailureMessage(new AppError('core_unavailable'),env),/arona core start/);
 assert.match(startupFailureMessage(new AppError('core_start_failed'),env),/core\.log/);
 assert.match(startupFailureMessage(new AppError('node_24_required'),env),/Node\.js 24/);
 assert.doesNotMatch(startupFailureMessage(new Error('secret-provider-response'),env),/secret-provider-response/);
});

test('invalid startup model configuration opens management mode rather than blocking repair', {timeout:40000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-startup-repair-'));const env={...environment(dir,await freePort()),SHITTIMCHEST_MODEL_PROTOCOL:'responses'};let pid:number|undefined;
 try{
  const result=await ensureCore({env});pid=coreLocation(dir)?.pid;assert.deepEqual(result.diagnostics,['invalid_model_configuration']);
  const configuration=await result.client.request<{models:unknown[]}>('/configuration');assert.deepEqual(configuration.models,[]);
  await result.client.request('/core/stop',{method:'POST'});await until(()=>alive(pid!),value=>!value,15000);
 }catch(error){const log=path.join(dir,'core.log');if(fs.existsSync(log))console.error(fs.readFileSync(log,'utf8'));throw error;}finally{if(pid&&alive(pid))process.kill(pid);await removeTemp(dir);}
});

test('cancelling startup terminates only the newly spawned child before returning', {timeout:20000},async()=>{
 const {default:childProcess}=await import('node:child_process');
 const {syncBuiltinESMExports}=await import('node:module');
 const {mock}=await import('node:test');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-startup-cancel-'));const env=environment(dir,await freePort());
 const abort=new AbortController();const reason=new Error('synthetic startup cancellation');let pid:number|undefined;
 const spawn=childProcess.spawn.bind(childProcess);
 const replacement=mock.method(childProcess,'spawn',(...args:Parameters<typeof childProcess.spawn>)=>{
  const child=spawn(...args);pid=child.pid;queueMicrotask(()=>abort.abort(reason));return child;
 });syncBuiltinESMExports();
 try{
  await assert.rejects(ensureCore({env,signal:abort.signal}),error=>error===reason);
  assert.ok(pid,'startup must have created the child');assert.equal(alive(pid),false,'owned process must be gone when cancellation returns');
 }finally{replacement.mock.restore();syncBuiltinESMExports();if(pid&&alive(pid))process.kill(pid);await removeTemp(dir);}
});

test('simultaneous clients converge on one independently running core instead of failing when a competing starter exits',{timeout:40000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-startup-many-')),env=environment(directory,await freePort());const clients:Array<Awaited<ReturnType<typeof ensureCore>>>=[];let pid:number|undefined;
 try{const attempts=await Promise.allSettled(Array.from({length:4},()=>ensureCore({env})));for(const attempt of attempts)if(attempt.status==='fulfilled')clients.push(attempt.value);pid=coreLocation(directory)?.pid;assert.equal(clients.length,4,JSON.stringify(attempts.map(row=>row.status==='rejected'?{code:(row.reason as AppError).code}:row.status)));assert.equal(clients.filter(row=>row.started).length,1);assert.equal(new Set(await Promise.all(clients.map(async row=>(await row.client.handshake()).instanceId))).size,1);assert.ok(pid);await clients[0]!.client.request('/core/stop',{method:'POST'});await until(()=>alive(pid!),value=>!value,15000);assert.equal(coreLocation(directory),undefined);}
 finally{if(pid&&alive(pid)){await clients[0]?.client.request('/core/stop',{method:'POST'}).catch(()=>{});await until(()=>alive(pid!),value=>!value,15000);}await removeTemp(directory);}
});

test('releasing an older endpoint generation never removes its same-process replacement',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-startup-generation-'));try{const previous=writeCoreLocation(directory,'http://127.0.0.1:30001'),next=writeCoreLocation(directory,'http://127.0.0.1:30002');previous();assert.equal(coreLocation(directory)?.baseURL,'http://127.0.0.1:30002');next();assert.equal(coreLocation(directory),undefined);}finally{await removeTemp(directory);}
});

test('implicit attachment verifies the selected data store even when two stores share an explicit token',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-startup-store-')),token='SYNTHETIC_SHARED_STARTUP_TOKEN_0123456789',first=await Core.open({dataDir:path.join(directory,'A'),memoryEnabled:false,controlToken:token});let second:Core|undefined,server:ReturnType<typeof serve>|undefined,remove:(()=>void)|undefined;
 try{second=await Core.open({dataDir:path.join(directory,'B'),memoryEnabled:false,controlToken:token});const expected=second.storageId;await second.close();second=undefined;server=serve({fetch:createApp(first).fetch,hostname:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`,env={...environment(path.join(directory,'B'),address.port),SHITTIMCHEST_CONTROL_TOKEN:token};
  await assert.rejects(ensureCore({env,autoStart:false}),error=>error instanceof AppError&&error.code==='core_storage_mismatch');
  remove=writeCoreLocation(path.join(directory,'B'),url,{storageId:expected,instanceId:first.instanceId});await assert.rejects(ensureCore({env,autoStart:false}),/core_storage_mismatch/);remove();remove=undefined;
  const explicit=await ensureCore({env:{...env,SHITTIMCHEST_CORE_URL:url},autoStart:false});assert.equal((await explicit.client.handshake()).storageId,first.storageId);
  const own=await ensureCore({env:{...environment(path.join(directory,'A'),address.port),SHITTIMCHEST_CONTROL_TOKEN:token},autoStart:false});assert.equal((await own.client.handshake()).storageId,first.storageId);
 }finally{remove?.();if(server){if('closeAllConnections'in server)server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}await second?.close();await first.close();await removeTemp(directory);}
});
