import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {until,removeTemp} from './helpers.js';

test('a preauthorized workspace patch uses the same write permission and validates every affected path',{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-workspace-patch-permission-'));let core!:Core,step=0;
  const patch='*** Begin Patch\n*** Update File: source.txt\n@@\n-before\n+after\n*** End Patch';
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    let action:{name:string;input:unknown}|undefined;
    if(request.tools?.some(tool=>tool.name==='task_report')){const task=core.runtime.tasks().find(row=>row.status==='running'||row.status==='waiting')!;if(!task.report){const actions=[{name:'mastra_workspace_read_file',input:{path:'source.txt'}},{name:'mastra_workspace_apply_patch',input:{patch}},{name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Applied the authorized patch.',checks:[{description:'Actual file bytes equal after.',passed:fs.readFileSync(path.join(directory,'workspace/source.txt'),'utf8')==='after\n'}],deliveries:[],unresolved:[]}}}];action=actions[step++];}}
    return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`patch-permission-${step}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};
  }});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    fs.writeFileSync(path.join(directory,'workspace/source.txt'),'before\n');const task=await core.submitTask({title:'Apply authorized patch',content:'Update the supplied source file.',grants:{write:true,execute:false,mcp:false}},'synthetic-patch-write');
    await until(()=>({task:core.runtime.task(task.id),pending:core.runtime.approvals().find(row=>row.status==='pending')}),row=>Boolean(row.pending)||!['pending','running','waiting'].includes(row.task.status));
    assert.equal(core.runtime.approvals().filter(row=>row.status==='pending').length,0,'A safe write-preauthorized patch must not require extra manual approval.');assert.equal(core.runtime.task(task.id).status,'succeeded');assert.equal(fs.readFileSync(path.join(directory,'workspace/source.txt'),'utf8'),'after\n');
    const context=core.runtime.context(task.contextId)!;for(const target of ['../outside.txt','.private/hidden.txt'])assert.equal(core.capabilities.approvalCapability(context,'mastra_workspace_apply_patch',{patch:`*** Begin Patch\n*** Add File: ${target}\n+unsafe\n*** End Patch`}),null);
    for(const operation of ['Delete File: source.txt','Update File: source.txt\n*** Move to: renamed.txt'])assert.equal(core.capabilities.approvalCapability(context,'mastra_workspace_apply_patch',{patch:`*** Begin Patch\n*** ${operation}\n*** End Patch`}),null,'Deletion and rename retain their explicit approval boundary.');
  }finally{await core.close();await removeTemp(directory);}
});
