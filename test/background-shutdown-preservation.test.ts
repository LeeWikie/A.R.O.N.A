import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {Mastra} from '@mastra/core';
import {LibSQLStore} from '@mastra/libsql';
import {until,removeTemp} from './helpers.js';

const cjs=createRequire(import.meta.url)('@mastra/core') as typeof import('@mastra/core');
for(const [entry,NativeMastra]of [['esm',Mastra],['cjs',cjs.Mastra]]as const)test(`native ${entry} shutdown preserves only the named running resource and releases its original lease`,{timeout:15000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-detach-')),storage=new LibSQLStore({id:'native-detach',url:'file:'+path.join(directory,'history.sqlite')});
  const mastra=new NativeMastra({storage,backgroundTasks:{enabled:true,globalConcurrency:2,perAgentConcurrency:2,defaultTimeoutMs:30000,recoverStaleTasksOnStart:false}});
  try{
    await storage.init();await mastra.startWorkers('backgroundTasks');const manager=mastra.backgroundTaskManager!;let started=0;
    const executor={execute:async(_args:Record<string,unknown>,options?:{abortSignal?:AbortSignal})=>{started++;return new Promise<never>((_,reject)=>{const abort=()=>reject(options?.abortSignal?.reason);if(options?.abortSignal?.aborted)abort();else options?.abortSignal?.addEventListener('abort',abort,{once:true});});}};
    const one=await manager.enqueue({runId:'original-a',toolName:'synthetic-parked',toolCallId:'a',agentId:'worker',args:{},maxRetries:0},{executor});
    const two=await manager.enqueue({runId:'original-b',toolName:'synthetic-active',toolCallId:'b',agentId:'worker',args:{},maxRetries:0},{executor});
    await until(()=>started,value=>value===2);assert.equal((await manager.getTask(one.task.id))?.ownerId,manager.ownerId);
    await Promise.all([manager.shutdown({preserveRunningTaskIds:[one.task.id]}),manager.shutdown()]);
    const kept=await manager.getTask(one.task.id),cancelled=await manager.getTask(two.task.id);assert.equal(kept?.status,'running');assert.equal(kept?.runId,'original-a');assert.equal(kept?.ownerId,undefined);assert.equal(kept?.leaseExpiresAt,undefined);assert.equal(kept?.result,undefined);assert.equal(cancelled?.status,'cancelled');assert.equal(started,2);
  }finally{await mastra.shutdown();await storage.close();await removeTemp(directory);}
});
