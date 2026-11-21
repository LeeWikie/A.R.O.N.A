import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { authenticatedApp, finished, removeTemp } from './helpers.js';

test('explicit standard skill invocation keeps exact user input separate from the selected Skill and is retry safe',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-explicit-skill-'));const prompts:string[]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async request=>{prompts.push(JSON.stringify(request.prompt));return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'t'});c.enqueue({type:'text-delta',id:'t',delta:'complete'});c.enqueue({type:'text-end',id:'t'});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
 const core=await Core.open({dataDir:directory,model,memoryEnabled:false});try{
  const skill=path.join(directory,'workspace','skills','manual-only');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: manual-only\ndescription: A manually selected skill.\ndisable-model-invocation: true\n---\nSYNTHETIC_EXPLICIT_SKILL_BODY');
  const raw='/skill:manual-only   保留原始空格与措辞';const receipt=await core.invokeSkill('main','manual-only',{content:'保留原始空格与措辞',sourceText:raw},'http:explicit-once');assert.equal((await finished(core,receipt.runId!))!.status,'succeeded');
  assert.equal(core.store.getSignal(receipt.id)!.content,raw);assert.ok(!core.store.getSignal(receipt.id)!.content.includes('SYNTHETIC_EXPLICIT_SKILL_BODY'));assert.match(prompts[0]!,/SYNTHETIC_EXPLICIT_SKILL_BODY/);
  const repeat=await core.invokeSkill('main','manual-only',{content:'保留原始空格与措辞',sourceText:raw},'http:explicit-once');assert.equal(repeat.id,receipt.id);assert.equal(prompts.length,1);
  await assert.rejects(core.invokeSkill('main','manual-only',{content:'different'},'http:explicit-once'),/operation_id_conflict/);
  const next=await core.submitMessage({content:'ordinary next message'});await finished(core,next.runId!);assert.doesNotMatch(JSON.stringify(JSON.parse(prompts.at(-1)!).filter((message:{role:string})=>message.role==='system')),/SYNTHETIC_EXPLICIT_SKILL_BODY/);
  await core.capabilities.setSkillEnabled(core.runtime.context('main')!,'manual-only',false);await assert.rejects(core.invokeSkill('main','manual-only',{content:'blocked'}),/skill_disabled/);
  const app=authenticatedApp(core);const response=await app.request('/contexts/main/skills/manual-only/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'blocked'})});assert.equal(response.status,409);
 }finally{await core.close();await removeTemp(directory);}
});
