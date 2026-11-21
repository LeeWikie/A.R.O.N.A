import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,removeTemp,until} from './helpers.js';
import type {ProjectSkillDiagnostic,ProjectSkillMetadata} from '../src/tools/project-skills.js';

const write=(root:string,file:string,content:string)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
function stream(action?:{name:string;input:unknown},id='idle'){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:id,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

test('HTTP Skill sources, diagnostics, live edits and disablement survive reopening and preserve the actual source',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-skill-resource-lifecycle-')),prompts:string[]=[];
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));return stream();}});
  let core=await Core.open({dataDir:directory,model,memoryEnabled:false}),app=authenticatedApp(core);
  try{
    const root=path.join(directory,'workspace'),original='---\nname: flat-review\ndescription: Review provided material.\ndisable-model-invocation: true\n---\nSYNTHETIC_FLAT_V1';
    write(root,'vendor/review.md',original);write(root,'skills/broken/SKILL.md','---\ndescription: [broken\n---\nInvalid metadata.');write(root,'skills/notes.md','Ordinary project notes.');
    const added=await app.request('/contexts/main/skill-sources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:'vendor/review.md'})});assert.equal(added.status,200);
    const listing=await (await app.request('/contexts/main/skills')).json() as {skills:ProjectSkillMetadata[];diagnostics:ProjectSkillDiagnostic[]};
    assert.deepEqual(listing.skills.map(row=>row.name),['flat-review']);assert.equal(listing.skills[0]?.path,'vendor/review.md');assert.equal(listing.skills[0]?.disableModelInvocation,true);
    assert.deepEqual(listing.diagnostics,[{type:'warning',path:'skills/broken/SKILL.md',message:'Skill metadata could not be read.'}]);assert.doesNotMatch(JSON.stringify(listing),/@skill-catalog|Invalid metadata|Ordinary project notes/);
    const raw='/skill:flat-review   保留原文',invoked=await app.request('/contexts/main/skills/flat-review/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'保留原文',sourceText:raw})});assert.equal(invoked.status,202);
    const receipt=await invoked.json() as {id:string;runId:string};await until(()=>core.store.getRun(receipt.runId),run=>Boolean(run&&run.status!=='running'));assert.equal(core.store.getSignal(receipt.id)?.content,raw);assert.match(prompts.at(-1)!,/SYNTHETIC_FLAT_V1/);assert.equal(fs.readFileSync(path.join(root,'vendor/review.md'),'utf8'),original);
    write(root,'vendor/review.md',original.replace('SYNTHETIC_FLAT_V1','SYNTHETIC_FLAT_V2'));const updated=await (await app.request('/contexts/main/skills/flat-review')).json() as {instructions:string};assert.equal(updated.instructions,'SYNTHETIC_FLAT_V2');
    assert.equal((await app.request('/contexts/main/skills/flat-review',{method:'PATCH',headers:{'content-type':'application/json'},body:'{"enabled":false}'})).status,200);
    await core.close();core=await Core.open({dataDir:directory,model,memoryEnabled:false});app=authenticatedApp(core);
    const restored=await (await app.request('/contexts/main/skills')).json() as {skills:ProjectSkillMetadata[]};assert.equal(restored.skills[0]?.enabled,false);
    assert.equal((await app.request('/contexts/main/skills/flat-review/invoke',{method:'POST',headers:{'content-type':'application/json'},body:'{"content":"blocked"}'})).status,409);
    const before=prompts.length;assert.equal((await app.request('/contexts/main/skill-sources',{method:'DELETE',headers:{'content-type':'application/json'},body:'{"path":"vendor/review.md"}'})).status,200);assert.deepEqual((await (await app.request('/contexts/main/skills')).json() as {skills:unknown[]}).skills,[]);assert.equal(prompts.length,before);assert.ok(fs.existsSync(path.join(root,'vendor/review.md')));
  }finally{await core.close();await removeTemp(directory);}
});

test('a real HTTP task uses a flat Skill and reference through native tools, verifies its file delivery and needs only its original write approval',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-flat-skill-delivery-'));let core!:Core,sequence=0,error:unknown,readCall:string|undefined;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{
    try{
      if(!request.tools?.some(tool=>tool.name==='task_report'))return stream();
      const task=core.runtime.tasks().find(row=>row.status==='running'||row.status==='waiting')!;const prompt=JSON.stringify(request.prompt),root=path.join(directory,'workspace'),output='DELIVERED:violet-17\n';
      if(task.report)return stream();
      assert.match(prompt,/USER_SCOPE_RULE/);assert.match(prompt,/ROOT_SCOPE_RULE/);assert.match(prompt,/flat-review/);assert.doesNotMatch(prompt,/HIDDEN_SKILL_BODY|SHADOWED_PROJECT_SKILL/);
      let action:{name:string;input:unknown};
      if(!prompt.includes('SYNTHETIC_FLAT_LOADED'))action={name:'skill',input:{name:'flat-review'}};
      else if(!prompt.includes('REFERENCE_VALUE:violet-17'))action={name:'skill_read',input:{skillName:'flat-review',path:'references/details.txt'}};
      else if(!fs.existsSync(path.join(root,'result.txt')))action={name:'mastra_workspace_write_file',input:{path:'result.txt',content:output}};
      else{
        assert.equal(fs.readFileSync(path.join(root,'result.txt'),'utf8'),output);
        const verified=readCall&&core.runtime.events(task.contextId).some(event=>event.kind==='tool_end'&&(event.data as {toolCallId?:string}).toolCallId===readCall&&JSON.stringify((event.data as {result?:unknown}).result).includes('DELIVERED:violet-17'));
        if(!verified){readCall=`flat-journey-${sequence+1}`;action={name:'mastra_workspace_read_file',input:{path:'result.txt'}};}
        else action={name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Read the actual Skill reference and verified its delivery.',checks:[{description:'The actual native read returned the expected delivered file bytes.',passed:true}],deliveries:[{kind:'file',title:'Verified result',value:'result.txt'}],unresolved:[]}}};
      }
      return stream(action,`flat-journey-${++sequence}`);
    }catch(caught){error=caught;throw caught;}
  }});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false});
  try{
    const root=path.join(directory,'workspace');write(directory,'AGENTS.md','USER_SCOPE_RULE');write(root,'AGENTS.override.md','ROOT_SCOPE_RULE');write(directory,'skills/review.md','---\nname: flat-review\ndescription: Review provided material and write its verified result.\n---\nSYNTHETIC_FLAT_LOADED');write(root,'skills/review.md','---\nname: flat-review\ndescription: A shadowed project source.\n---\nSHADOWED_PROJECT_SKILL');write(directory,'skills/references/details.txt','REFERENCE_VALUE:violet-17');write(root,'skills/.ignore','hidden/\n');write(root,'skills/hidden/SKILL.md','---\nname: hidden\ndescription: Hidden source.\n---\nHIDDEN_SKILL_BODY');
    const app=authenticatedApp(core),submitted=await app.request('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Use a flat Skill',content:'Use flat-review and its supplied reference to create, read back and deliver result.txt.'})});assert.equal(submitted.status,202);const task=await submitted.json() as {id:string};const approved=new Set<string>();
    const result=await until(async()=>{if(error)throw error;for(const approval of core.runtime.approvals().filter(row=>row.status==='pending')){assert.equal(approval.toolName,'mastra_workspace_write_file');approved.add(approval.id);const response=await app.request(`/approvals/${approval.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"decision":"approve"}'});assert.equal(response.status,200);}return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status),20000);
    assert.equal(result.status,'succeeded',JSON.stringify({task:result,events:core.runtime.events(result.contextId).filter(event=>event.kind==='tool_end')}));assert.equal(approved.size,1);assert.equal(result.grants.write,false);assert.equal(result.report?.deliveries.length,1);
    const delivery=await app.request(`/tasks/${task.id}/deliveries/0?revision=${result.revision}`);assert.equal(delivery.status,200);const bytes=Buffer.from(await delivery.arrayBuffer());assert.equal(bytes.toString(),'DELIVERED:violet-17\n');assert.equal(delivery.headers.get('x-content-sha256'),createHash('sha256').update(bytes).digest('hex'));
    assert.equal(core.runtime.approvals().filter(row=>row.status==='pending').length,0);
  }finally{await core.close();await removeTemp(directory);}
});
