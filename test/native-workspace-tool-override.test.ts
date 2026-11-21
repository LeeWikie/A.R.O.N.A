import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {z} from 'zod';
import * as workspaceApi from '@mastra/core/workspace';
import {createTool} from '@mastra/core/tools';

const require=createRequire(import.meta.url),common=require('@mastra/core/workspace') as typeof workspaceApi;
for(const [entry,api] of [['esm',workspaceApi],['cjs',common]] as const)test(`native ${entry} host tool replacement retains read tracking, locks, hooks, approval and readonly omission`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-tool-override-'));fs.writeFileSync(path.join(directory,'source.txt'),'before');let readsRequired=true,calls=0,active=0,maximum=0,hooks=0;
  const filesystem=new api.LocalFilesystem({basePath:directory,contained:true}),workspace=new api.Workspace({filesystem,tools:{enabled:false,mastra_workspace_read_file:{enabled:true},mastra_workspace_edit_file:{enabled:true,requireApproval:true,requireReadBeforeWrite:()=>readsRequired,transformTool:original=>{const tool=createTool({id:original.id,description:'Write a synthetic checked file.',inputSchema:z.object({path:z.string(),content:z.string()}),execute:async(input,context)=>{
    const {filesystem}=api.requireFilesystem(context!);calls++;active++;maximum=Math.max(maximum,active);
    try{await new Promise(resolve=>setTimeout(resolve,10));await filesystem.writeFile(input.path,input.content,{overwrite:true,...(context&&'__expectedMtime'in context&&context.__expectedMtime instanceof Date?{expectedMtime:context.__expectedMtime}:{})});return 'changed';}finally{active--;}
  }});return tool;}},hooks:{beforeToolCall:()=>{hooks++;}}}});
  try{
    const tools=await api.createWorkspaceTools(workspace);assert.equal(tools.mastra_workspace_edit_file.requireApproval,true);
    await assert.rejects(()=>tools.mastra_workspace_edit_file.execute({path:'source.txt',content:'unread'},{}),/read|Read/);assert.equal(calls,0);assert.equal(fs.readFileSync(path.join(directory,'source.txt'),'utf8'),'before');
    await tools.mastra_workspace_read_file.execute({path:'source.txt'},{});await tools.mastra_workspace_edit_file.execute({path:'source.txt',content:'after'},{});assert.equal(calls,1);assert.equal(fs.readFileSync(path.join(directory,'source.txt'),'utf8'),'after');
    readsRequired=false;await Promise.all(['first','second'].map(content=>tools.mastra_workspace_edit_file.execute({path:'source.txt',content},{})));assert.equal(maximum,1);assert.equal(calls,3);assert.equal(fs.readFileSync(path.join(directory,'source.txt'),'utf8'),'second');assert.ok(hooks>=4);
  }finally{await workspace.destroy();fs.rmSync(directory,{recursive:true,force:true});}
  const readonlyDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-tool-readonly-'));let transformed=false;const readonly=new api.Workspace({filesystem:new api.LocalFilesystem({basePath:readonlyDirectory,contained:true,readOnly:true}),tools:{enabled:false,mastra_workspace_edit_file:{enabled:true,transformTool:tool=>{transformed=true;return tool;}}}});
  try{assert.equal((await api.createWorkspaceTools(readonly)).mastra_workspace_edit_file,undefined);assert.equal(transformed,false);}finally{await readonly.destroy();fs.rmSync(readonlyDirectory,{recursive:true,force:true});}
});

test('a host replacement cannot change a built-in authority identity before wrapper selection',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-tool-id-')),workspace=new workspaceApi.Workspace({filesystem:new workspaceApi.LocalFilesystem({basePath:directory,contained:true}),tools:{enabled:false,mastra_workspace_edit_file:{enabled:true,transformTool:()=>createTool({id:'another-tool',description:'Synthetic invalid authority identity.',inputSchema:z.object({}),execute:async()=>''})}}});
  try{await assert.rejects(()=>workspaceApi.createWorkspaceTools(workspace),/preserve the built-in tool id/);}finally{await workspace.destroy();fs.rmSync(directory,{recursive:true,force:true});}
});
