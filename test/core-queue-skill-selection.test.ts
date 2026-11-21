import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID}from'node:crypto';
import test from'node:test';
import{MastraLanguageModelV2Mock}from'@mastra/core/test-utils/llm-mock';
import{Core}from'../src/core.js';
import{finished,removeTemp,until}from'./helpers.js';
for(const selection of ['inherit','none','selected']as const)test(`an edited queue ${selection} Skill choice changes host activation without rewriting the original source or user command`,{timeout:20000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-skills-')),prompts:string[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));if(prompts.length===1)await gate;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}}),core=await Core.open({dataDir:directory,model,memoryEnabled:false});
 for(const name of ['original','replacement']){const folder=path.join(directory,'workspace','.agents','skills',name);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'SKILL.md'),`---\nname: ${name}\ndescription: Synthetic ${name} explicit selection.\ndisable-model-invocation: true\n---\nSYNTHETIC_${name.toUpperCase()}_SKILL_BODY`);}
 try{const active=await core.submitMessage({content:'SYNTHETIC_HELD_REQUEST'});await until(()=>prompts.length,count=>count===1);const raw='/skill original SYNTHETIC_UNMODIFIED_USER_TASK',source=await core.invokeSkill('main','original',{content:'SYNTHETIC_UNMODIFIED_USER_TASK',sourceText:raw,mode:'queue'},randomUUID()),draft=core.queueEditor().create('main',{},randomUUID()),entry=core.queueEditor().page('main',draft.id).entries[0]!;
   const original=core.runtime.setting(`skill-invocation:${source.id}`,null);assert.ok(JSON.stringify(original).includes('SYNTHETIC_ORIGINAL_SKILL_BODY'));fs.writeFileSync(path.join(directory,'workspace','.agents','skills','original','SKILL.md'),'---\nname: original\ndescription: Changed after enqueue.\n---\nSYNTHETIC_CHANGED_SKILL_BODY');
   const edited=core.queueEditor().mutate('main',draft.id,{expectedRevision:draft.revision,action:{kind:'skill',entryId:entry.id,selection:selection==='selected'?{kind:'selected',name:'replacement'}:{kind:selection}}},randomUUID());const body=core.queueEditor().page('main',draft.id).entries[0]!;assert.equal(body.content,raw);assert.deepEqual(body.sourceSignalIds,[source.id]);assert.equal(body.selectedSkillName,selection==='selected'?'replacement':undefined);assert.equal(body.clearSkills,selection==='none'?true:undefined);
   const accepted=await core.queueEditor().submit('main',draft.id,{expectedRevision:edited.revision,mode:'queue'},randomUUID());release();await finished(core,active.runId!);await until(()=>core.queueEditor().page('main',draft.id).draft.status,status=>status==='submitted');await finished(core,core.store.getSignal(accepted.submission!.entries[0]!.signalId)!.runId!);
   assert.equal(prompts.length,2);assert.equal(prompts[1]!.includes(raw),true);assert.equal(prompts[1]!.includes('SYNTHETIC_ORIGINAL_SKILL_BODY'),selection==='inherit');assert.equal(prompts[1]!.includes('SYNTHETIC_REPLACEMENT_SKILL_BODY'),selection==='selected');assert.equal(prompts[1]!.includes('SYNTHETIC_CHANGED_SKILL_BODY'),false);assert.deepEqual(core.runtime.setting(`skill-invocation:${source.id}`,null),original);assert.equal(core.store.getSignal(source.id)!.status,'cancelled');assert.equal(core.runtime.approvals().length,0);
 }finally{release();await core.close();await removeTemp(directory);}
});
