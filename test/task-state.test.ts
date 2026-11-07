import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import { taskReportSchema, Tasks } from '../src/tasks.js';
import { RuntimeStore } from '../src/runtime-store.js';

test('resuming during an outstanding admission enqueues the new attempt independently', async () => {
  const db=new DatabaseSync(':memory:');const store=new RuntimeStore(db);
  const acknowledgements:((value:unknown)=>void)[]=[];const payloads:{toolCallId:string}[]=[];
  const manager={enqueue:async(payload:{toolCallId:string})=>{payloads.push(payload);return new Promise(resolve=>acknowledgements.push(resolve));},cancel:async()=>{}} as unknown as BackgroundTaskManager;
  const tasks=new Tasks(store,{manager:()=>manager,createContext:input=>store.createContext(input),dispatch:async()=>({runId:'synthetic'}),wait:async()=>'complete',abort:()=>{},settle:async()=>{},changed:async()=>{}});
  try{
    const task=tasks.create({title:'Fixture',content:'Fixture'},{sourceSignalIds:[],returnContextId:'main'},'fixture');
    const first=tasks.start(task.id);
    const paused=await tasks.control(task.id,'pause',store.task(task.id).revision);
    assert.equal(paused.status,'paused');
    const resumed=tasks.control(task.id,'resume',paused.revision);
    assert.equal(payloads.length,2);
    assert.notEqual(payloads[0]?.toolCallId,payloads[1]?.toolCallId);
    acknowledgements[0]!({task:{id:'old-native'},fallbackToSync:false});await first;
    assert.notEqual(store.task(task.id).nativeTaskId,'old-native');
    acknowledgements[1]!({task:{id:'new-native'},fallbackToSync:false});
    assert.equal((await resumed).nativeTaskId,'new-native');
    assert.equal(store.task(task.id).attempt,2);
  }finally{db.close();}
});

test('a child cannot expand inherited authorization into a different workspace',()=>{
  const db=new DatabaseSync(':memory:');const store=new RuntimeStore(db);
  store.createContext({id:'parent-work',name:'Parent',role:'work',workspaceId:'first'});
  store.createContext({id:'other-work',name:'Other',role:'work',workspaceId:'second'});
  const parent=store.createTask({title:'Parent',content:'Parent',contextId:'parent-work',returnContextId:'main',sourceSignalIds:[],grants:{write:true,execute:false,mcp:false}});
  const tasks=new Tasks(store,{manager:()=>{throw Error('must not enqueue');},createContext:input=>store.createContext(input),dispatch:async()=>({runId:'synthetic'}),wait:async()=>'complete',abort:()=>{},settle:async()=>{},changed:async()=>{}});
  try{assert.throws(()=>tasks.create({title:'Child',content:'Other workspace',contextId:'other-work'},{sourceSignalIds:[],returnContextId:'parent-work',parentId:parent.id},'child'),/child_workspace_not_authorized/);assert.equal(store.tasks().length,1);const child=tasks.create({title:'Scoped child',content:'Use the parent workspace'},{sourceSignalIds:[],returnContextId:'parent-work',parentId:parent.id},'scoped-child');assert.equal(store.context(child.contextId)?.workspaceId,'first');}
  finally{db.close();}
});

test('waiting parents can be paused or cancelled after their native execution has already ended',async()=>{
  const db=new DatabaseSync(':memory:');const store=new RuntimeStore(db);let settled=0;
  const manager={cancel:async()=>{}} as unknown as BackgroundTaskManager;
  const tasks=new Tasks(store,{manager:()=>manager,createContext:input=>store.createContext(input),dispatch:async()=>({runId:'synthetic'}),wait:async()=>'complete',abort:()=>{},settle:async()=>{settled++;},changed:async()=>{}});
  try{
    for(const action of ['pause','cancel'] as const){const task=store.createTask({title:'Waiting',content:'Waiting for a child',contextId:'worker',returnContextId:'main',sourceSignalIds:[],status:'waiting',nativeTaskId:'ended-native'});const result=await tasks.control(task.id,action,task.revision);assert.equal(result.status,action==='pause'?'paused':'cancelled');}
    assert.equal(settled,2);
  }finally{db.close();}
});


test('file deliveries expose a path string while structured data uses its own kind',()=>{
  const base={outcome:'succeeded',summary:'Verified',checks:[{description:'Checked',passed:true}],unresolved:[]};
  assert.equal(taskReportSchema.safeParse({...base,deliveries:[{kind:'file',title:'File',value:{path:'result.txt'}}]}).success,false);
  assert.equal(taskReportSchema.safeParse({...base,deliveries:[{kind:'file',title:'File',value:'result.txt'},{kind:'json',title:'Metadata',value:{bytes:59}}]}).success,true);
});
