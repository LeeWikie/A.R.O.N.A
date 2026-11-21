import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {LibSQLStore} from '@mastra/libsql';
import {removeTemp} from './helpers.js';

const cjs=createRequire(import.meta.url)('@mastra/libsql') as typeof import('@mastra/libsql');
for(const [entry,Store]of [['esm',LibSQLStore],['cjs',cjs.LibSQLStore]] as const)test(`native ${entry} background-task deadline updates persist with original owner/status/lease fences`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-deadline-'));
  let store=new Store({id:'native-deadline',url:'file:'+path.join(directory,'history.sqlite')});
  const startedAt=new Date(),leaseExpiresAt=new Date(startedAt.getTime()+60000);
  try{
    await store.init();const tasks=await store.getStore('backgroundTasks');assert.ok(tasks);
    await tasks.createTask({id:'resource',status:'running',toolName:'synthetic-safe-tool',toolCallId:'call',args:{},agentId:'worker',threadId:'work.deadline',resourceId:'local',runId:'original-run',createdAt:startedAt,startedAt,ownerId:'original-owner',leaseExpiresAt,retryCount:0,maxRetries:0,timeoutMs:30000});
    assert.equal(await tasks.updateTask('resource',{timeoutMs:9000},{expectedStatus:'running',expectedOwnerId:'original-owner',expectedLeaseExpiresAt:leaseExpiresAt}),true);
    for(const fence of [{expectedOwnerId:'another-owner'},{expectedStatus:'completed' as const},{expectedLeaseExpiresAt:new Date(leaseExpiresAt.getTime()+1)}])assert.equal(await tasks.updateTask('resource',{timeoutMs:30000},fence),false);
    assert.equal((await tasks.getTask('resource'))?.timeoutMs,9000);
    await store.close();store=new Store({id:'native-deadline-reopen',url:'file:'+path.join(directory,'history.sqlite')});await store.init();
    const reopened=await(await store.getStore('backgroundTasks'))!.getTask('resource');assert.equal(reopened?.timeoutMs,9000);assert.equal(reopened?.runId,'original-run');assert.equal(reopened?.ownerId,'original-owner');assert.equal(reopened?.startedAt?.getTime(),startedAt.getTime());assert.equal(reopened?.status,'running');
  }finally{await store.close();await removeTemp(directory);}
});
