import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {authenticatedApp,removeTemp} from './helpers.js';

test('file delivery download is bound to task revision, exact bytes and workspace containment',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-delivery-'));const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  const work=core.createWorkContext({name:'fixture work'});const root=core.capabilities.root(work.workspaceId).path;const bytes=Buffer.from('verified result\n007\n');fs.writeFileSync(path.join(root,'result.txt'),bytes);
  let task=core.runtime.createTask({title:'Fixture',content:'Synthetic',contextId:work.id,returnContextId:'main',sourceSignalIds:[],status:'succeeded'});
  const report=await core.verifyReport(task,{outcome:'succeeded',summary:'Synthetic',checks:[{description:'bytes checked',passed:true}],deliveries:[{kind:'file',title:'Result',value:'result.txt'}],unresolved:[]});
  task=core.runtime.updateTask(task.id,{report});const route=`/tasks/${task.id}/deliveries/0?revision=${task.revision}`;
  assert.equal((await createApp(core).request(route)).status,401);const app=authenticatedApp(core);
  const response=await app.request(route);assert.equal(response.status,200);assert.equal(response.headers.get('x-content-sha256'),report.deliveries[0]!.sha256);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  assert.equal((await app.request(`/tasks/${task.id}/deliveries/0?revision=${task.revision+1}`)).status,409);
  fs.writeFileSync(path.join(root,'result.txt'),Buffer.alloc(bytes.length,0));assert.equal((await app.request(route)).status,409);
  const bad=core.runtime.updateTask(task.id,{report:{...report,deliveries:[{...report.deliveries[0]!,value:'../../outside.txt'}]}});assert.equal((await app.request(`/tasks/${task.id}/deliveries/0?revision=${bad.revision}`)).status,403);
 }finally{await core.close();await removeTemp(directory);}
});

test('private ancestors do not disable ordinary files inside the explicitly configured workspace',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-private-parent-'));const dataDir=path.join(directory,'.private','state');const core=await Core.open({dataDir,memoryEnabled:false});
 try{
  const context=core.createWorkContext({name:'fixture'});const root=core.capabilities.root(context.workspaceId).path;fs.writeFileSync(path.join(root,'ordinary.txt'),'safe fixture');fs.mkdirSync(path.join(root,'.private'));fs.writeFileSync(path.join(root,'.private','internal.txt'),'private fixture');
  assert.equal(core.capabilities.approvalCapability(context,'mastra_workspace_read_file',{path:'ordinary.txt'}),'read');
  assert.equal(core.capabilities.approvalCapability(context,'mastra_workspace_read_file',{path:'.private/internal.txt'}),null);
 }finally{await core.close();await removeTemp(directory);}
});
