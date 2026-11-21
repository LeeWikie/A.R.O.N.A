import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,until,removeTemp} from './helpers.js';

function reply(action?:{name:string;input:unknown},sequence=0){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`project-edit-${sequence}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}
const report=(id:string)=>({name:'task_report',input:{id,report:{outcome:'succeeded',summary:'Edited and read back the actual source file.',checks:[{description:'The actual file contains both intended replacements.',passed:true}],deliveries:[{kind:'file',title:'Edited source',value:'nested/source.txt'}],unresolved:[]}}});

test('HTTP native batch editing applies one approved original-snapshot operation and replays its actual diff and file delivery',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-project-edit-'));let core!:Core,step=0,error:unknown;const expected='\ufeffstart=2;\r\nmid\r\nend=10;\n';
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    try{if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>row.status==='running'||row.status==='waiting')!;if(task.report)return reply();const prompt=JSON.stringify(request.prompt);let action;
      if(step===0)action={name:'mastra_workspace_read_file',input:{path:'nested/source.txt'}};
      else if(step===1){assert.match(prompt,/NESTED_EDIT_RULE/);action={name:'mastra_workspace_edit_file',input:{path:'nested/source.txt',edits:[{oldText:'start=1;\n',newText:'start=2;\n'},{oldText:'end=9;',newText:'end=10;'}]}};}
      else if(step===2){assert.equal(fs.readFileSync(path.join(directory,'workspace/nested/source.txt'),'utf8'),expected);action={name:'mastra_workspace_read_file',input:{path:'nested/source.txt'}};}
      else{assert.match(prompt,/start=2/);assert.match(prompt,/end=10/);action=report(task.id);}
      return reply(action,++step);
    }catch(caught){error=caught;throw caught;}
  }});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    const nested=path.join(directory,'workspace/nested');fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'AGENTS.md'),'NESTED_EDIT_RULE');fs.writeFileSync(path.join(nested,'source.txt'),'\ufeffstart=1;\r\nmid\r\nend=9;\n');const app=authenticatedApp(core),response=await app.request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Edit supplied source',content:'Read and update both counters in nested/source.txt and verify the delivered file.'})});assert.equal(response.status,202);const task=await response.json() as {id:string};const approved=new Set<string>();
    const result=await until(async()=>{if(error)throw error;for(const approval of core.runtime.approvals().filter(row=>row.status==='pending')){assert.equal(approval.toolName,'mastra_workspace_edit_file');approved.add(approval.id);assert.equal((await app.request(`/approvals/${approval.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"decision":"approve"}'})).status,200);}return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));
    assert.equal(result.status,'succeeded');assert.equal(approved.size,1);assert.equal(result.grants.write,false);assert.equal(result.toolGrants?.length??0,0);
    const snapshot=await (await app.request(`/snapshot?contextId=${encodeURIComponent(result.contextId)}&toolResultContent=1`)).json() as {toolActivity:Array<{toolName:string;state:string;output?:{text:string};diff?:{text:string}}>};const edit=snapshot.toolActivity.find(row=>row.toolName==='mastra_workspace_edit_file')!;assert.equal(edit.state,'finished');assert.match(edit.output!.text,/replaced 2 block/);assert.match(edit.diff!.text,/-start=1;[\s\S]*\+start=2;/);assert.match(edit.diff!.text,/-end=9;[\s\S]*\+end=10;/);
    const delivery=await app.request(`/tasks/${task.id}/deliveries/0?revision=${result.revision}`);assert.equal(delivery.status,200);assert.equal(Buffer.from(await delivery.arrayBuffer()).toString('utf8'),expected);
  }finally{await core.close();await removeTemp(directory);}
});

test('an ambiguous native edit is visibly failed and the agent can correct it without losing its original read or needing manual repair',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-project-edit-repair-'));let core!:Core,step=0,error:unknown;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    try{if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>row.status==='running'||row.status==='waiting')!;if(task.report)return reply();let action;
      if(step===0)action={name:'mastra_workspace_read_file',input:{path:'nested/source.txt'}};
      else if(step===1)action={name:'mastra_workspace_edit_file',input:{path:'nested/source.txt',old_string:'tag',new_string:'fixed'}};
      else if(step===2){assert.equal(fs.readFileSync(path.join(directory,'workspace/nested/source.txt'),'utf8'),'tag\nkeep\ntag\n');const end=core.runtime.events(task.contextId).find(event=>event.kind==='tool_end'&&(event.data as {toolCallId?:string}).toolCallId==='project-edit-2')!;assert.equal((end.data as {isError?:boolean}).isError,true);action={name:'mastra_workspace_edit_file',input:{path:'nested/source.txt',old_string:'tag\nkeep',new_string:'fixed\nkeep'}};}
      else{assert.equal(fs.readFileSync(path.join(directory,'workspace/nested/source.txt'),'utf8'),'fixed\nkeep\ntag\n');action=report(task.id);}
      return reply(action,++step);
    }catch(caught){error=caught;throw caught;}
  }});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    fs.mkdirSync(path.join(directory,'workspace/nested'));fs.writeFileSync(path.join(directory,'workspace/nested/source.txt'),'tag\nkeep\ntag\n');const task=await core.submitTask({title:'Correct an edit',content:'Edit the first tag and verify the result.',grants:{write:true,execute:false,mcp:false}},'synthetic-edit-repair');const result=await until(()=>{if(error)throw error;return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));assert.equal(result.status,'succeeded');assert.equal(core.runtime.approvals().filter(row=>row.status==='pending').length,0);
    const app=authenticatedApp(core),snapshot=await (await app.request(`/snapshot?contextId=${encodeURIComponent(task.contextId)}`)).json() as {toolActivity:Array<{toolName:string;state:string}>};assert.deepEqual(snapshot.toolActivity.filter(row=>row.toolName==='mastra_workspace_edit_file').map(row=>row.state),['failed','finished']);
  }finally{await core.close();await removeTemp(directory);}
});
