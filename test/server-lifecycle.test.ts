import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Core} from '../src/core.js';
import {coreLockHeld} from '../src/lock.js';
import {removeTemp} from './helpers.js';

async function port(){const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const address=listener.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>listener.close(()=>resolve()));return address.port;}
function launch(directory:string,port:number){const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/server.ts',import.meta.url)),'--without-startup-model'],{env:{...process.env,SHITTIMCHEST_DATA_DIR:directory,SHITTIMCHEST_PORT:String(port),SHITTIMCHEST_MEMORY_ENABLED:'false',SHITTIMCHEST_CONTROL_TOKEN:'SYNTHETIC_SERVER_LIFECYCLE_TOKEN_0123456789'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);return {child,output:()=>output};}
async function close(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const stopped=once(child,'close');child.kill('SIGKILL');await stopped;}
for(const fault of ['occupied-port','endpoint-write'] as const)test(`the standalone core naturally exits and releases storage after ${fault} startup failure`,{timeout:25000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-server-failure-')),listenPort=await port();let blocker:ReturnType<typeof createServer>|undefined,worker:ReturnType<typeof launch>|undefined,reopened:Core|undefined;
 try{if(fault==='occupied-port'){blocker=createServer();blocker.listen(listenPort,'127.0.0.1');await once(blocker,'listening');}else fs.mkdirSync(path.join(directory,'core-endpoint.json'));
  worker=launch(directory,listenPort);const deadline=setTimeout(()=>worker!.child.kill('SIGKILL'),15000);try{const [code,signal]=await once(worker.child,'close');assert.equal(signal,null,worker.output());assert.equal(code,1,worker.output());}finally{clearTimeout(deadline);}
  assert.match(worker.output(),new RegExp(fault==='occupied-port'?'listen_failed':'core_endpoint_write_failed'));assert.doesNotMatch(worker.output(),/\n\s+at\s|UnhandledPromiseRejection/);assert.equal(coreLockHeld(directory),false);
  reopened=await Core.open({dataDir:directory,memoryEnabled:false});await reopened.close();reopened=undefined;
 }finally{if(worker)await close(worker.child);if(blocker)await new Promise<void>(resolve=>blocker!.close(()=>resolve()));await reopened?.close();await removeTemp(directory);}
});
