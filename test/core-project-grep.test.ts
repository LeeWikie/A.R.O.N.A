import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {ProjectResources} from '../src/tools/project-resources.js';
import {authenticatedApp,until,removeTemp} from './helpers.js';

function reply(action?:{name:string;input:unknown},sequence=0){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`synthetic-grep-${sequence}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

test('an actual HTTP task searches arbitrary file names with Unicode and ignore rules, reads the real match and delivers one approved verified file',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-grep-'));let core!:Core,step=0,error:unknown;const expected='Verified: λ synthetic result\n';
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
    if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>['running','waiting'].includes(row.status))!;if(task.report)return reply();const prompt=JSON.stringify(request.prompt);assert.doesNotMatch(prompt,/PRIVATE_SYNTHETIC|IGNORED_SYNTHETIC/);let action;
    if(step===0)action={name:'mastra_workspace_grep',input:{pattern:'\\p{Greek}+'}};
    else if(step===1){assert.match(prompt,/notes.unlisted:1: λ synthetic result/);action={name:'mastra_workspace_read_file',input:{path:'notes.unlisted'}};}
    else if(step===2){assert.match(prompt,/λ synthetic result/);action={name:'mastra_workspace_write_file',input:{path:'result.txt',content:expected}};}
    else if(step===3)action={name:'mastra_workspace_read_file',input:{path:'result.txt'}};
    else{assert.equal(fs.readFileSync(path.join(directory,'workspace/result.txt'),'utf8'),expected);action={name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Found and verified the source using the native search tool.',checks:[{description:'The delivered file matches the actual search result and readback.',passed:true}],deliveries:[{kind:'file',title:'Verified result',value:'result.txt'}],unresolved:[]}}};}
    return reply(action,++step);
  }catch(caught){error=caught;throw caught;}}});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    const root=path.join(directory,'workspace');fs.writeFileSync(path.join(root,'notes.unlisted'),'λ synthetic result\n');fs.writeFileSync(path.join(root,'.ignore'),'ignored.txt\n');fs.writeFileSync(path.join(root,'ignored.txt'),'λ IGNORED_SYNTHETIC');fs.writeFileSync(path.join(root,'.env'),'λ PRIVATE_SYNTHETIC');const app=authenticatedApp(core),response=await app.request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Find and deliver',content:'Find the Greek text, read its source and deliver result.txt with the verified result.'})});assert.equal(response.status,202);const task=await response.json() as {id:string};const approvals=new Set<string>();
    const result=await until(async()=>{if(error)throw error;for(const pending of core.runtime.approvals().filter(row=>row.status==='pending')){assert.equal(pending.toolName,'mastra_workspace_write_file');approvals.add(pending.id);assert.equal((await app.request(`/approvals/${pending.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"decision":"approve"}'})).status,200);}return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));assert.equal(result.status,'succeeded');assert.equal(approvals.size,1);assert.equal(result.grants.write,false);
    const delivery=await app.request(`/tasks/${task.id}/deliveries/0?revision=${result.revision}`);assert.equal(delivery.status,200);assert.equal(createHash('sha256').update(Buffer.from(await delivery.arrayBuffer())).digest('hex'),createHash('sha256').update(expected).digest('hex'));
  }finally{await core.close();await removeTemp(directory);}
});

test('a source replaced during actual search is visibly failed and the same task can search the current source and finish without manual repair',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-grep-change-')),original=ProjectResources.prototype.readChunks;let core!:Core,step=0,error:unknown,replaced=false;
  ProjectResources.prototype.readChunks=async function*(...args){for await(const bytes of original.apply(this,args)){if(!replaced&&args[0]==='source.unlisted'&&this.root===fs.realpathSync(path.join(directory,'workspace'))){replaced=true;fs.writeFileSync(path.join(this.root,'replacement'),'needle current source\n');fs.renameSync(path.join(this.root,'replacement'),path.join(this.root,args[0]));}yield bytes;}};
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
    if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>['running','waiting'].includes(row.status))!;if(task.report)return reply();let action;
    if(step===0)action={name:'mastra_workspace_grep',input:{pattern:'needle',path:'source.unlisted'}};
    else if(step===1){const event=core.runtime.events(task.contextId).find(event=>event.kind==='tool_end'&&(event.data as {toolCallId?:string}).toolCallId==='synthetic-grep-1')!;assert.equal((event.data as {isError?:boolean}).isError,true);assert.match(JSON.stringify(request.prompt),/resource_changed/);action={name:'mastra_workspace_grep',input:{pattern:'needle',path:'source.unlisted'}};}
    else{assert.match(JSON.stringify(request.prompt),/source.unlisted:1: needle current source/);action={name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Retried the changed source and verified its current content.',checks:[{description:'The second search read the current source.',passed:true}],deliveries:[],unresolved:[]}}};}
    return reply(action,++step);
  }catch(caught){error=caught;throw caught;}}});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{fs.writeFileSync(path.join(directory,'workspace/source.unlisted'),'needle original source\n');const task=await core.submitTask({title:'Read a changing source',content:'Search source.unlisted and verify its current content.'},'synthetic-grep-change');const result=await until(()=>{if(error)throw error;return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));assert.equal(result.status,'succeeded');assert.equal(replaced,true);assert.equal(core.runtime.approvals().length,0);assert.deepEqual(core.runtime.events(task.contextId).filter(event=>event.kind==='tool_end'&&['synthetic-grep-1','synthetic-grep-2'].includes(String((event.data as {toolCallId?:string}).toolCallId))).map(event=>(event.data as {isError?:boolean}).isError),[true,false]);}
  finally{ProjectResources.prototype.readChunks=original;await core.close();await removeTemp(directory);}
});

test('a real task discovers a deep source with the complete find mode, sees the applicable instructions and verifies a native edit',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-find-'));let core!:Core,step=0,error:unknown;const target='deep/a/b/c/target.unlisted';
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
    if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>['running','waiting'].includes(row.status))!;if(task.report)return reply();let action;
    if(step===0)action={name:'mastra_workspace_list_files',input:{mode:'find',pattern:'target.unlisted'}};
    else if(step===1){assert.match(JSON.stringify(request.prompt),/deep\/a\/b\/c\/target.unlisted/);action={name:'mastra_workspace_read_file',input:{path:target}};}
    else if(step===2){assert.match(JSON.stringify(request.prompt),/SYNTHETIC_DEEP_RULE/);action={name:'mastra_workspace_edit_file',input:{path:target,oldText:'before',newText:'verified'}};}
    else if(step===3)action={name:'mastra_workspace_read_file',input:{path:target}};
    else{assert.equal(fs.readFileSync(path.join(directory,'workspace',target),'utf8'),'verified\n');action={name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Located and edited the deep source.',checks:[{description:'The edited source was read back and verified.',passed:true}],deliveries:[{kind:'file',title:'Verified source',value:target}],unresolved:[]}}};}
    return reply(action,++step);
  }catch(caught){error=caught;throw caught;}}});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{const absolute=path.join(directory,'workspace',target);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,'before\n');fs.writeFileSync(path.join(path.dirname(absolute),'AGENTS.md'),'SYNTHETIC_DEEP_RULE');const task=await core.submitTask({title:'Find and edit a deep source',content:'Find target.unlisted, update before to verified and verify the delivered file.',grants:{write:true,execute:false,mcp:false}},'synthetic-find-complete');const result=await until(()=>{if(error)throw error;return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));assert.equal(result.status,'succeeded');assert.equal(core.runtime.approvals().length,0);const app=authenticatedApp(core),delivery=await app.request(`/tasks/${task.id}/deliveries/0?revision=${result.revision}`);assert.equal(delivery.status,200);assert.equal(Buffer.from(await delivery.arrayBuffer()).toString('utf8'),'verified\n');}
  finally{await core.close();await removeTemp(directory);}
});
