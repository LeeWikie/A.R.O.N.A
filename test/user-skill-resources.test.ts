import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Store} from '../src/store.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {Capabilities} from '../src/capabilities.js';

const write=(root:string,file:string,body:string)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);};
const skill=(root:string,file:string,name:string,body:string)=>write(root,file,`---\nname: ${name}\ndescription: Synthetic ${name} behavior.\n---\n${body}`);

test('one checked user Skill source is shared across workspaces, wins collisions and keeps workspace controls and private resources scoped',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-user-skills-')),second=fs.mkdtempSync(path.join(os.tmpdir(),'arona-user-skills-workspace-'));let store=new Store(path.join(directory,'records.sqlite')),runtime=new RuntimeStore(store.db),capabilities=new Capabilities(runtime,directory);
  try{
    const root=path.join(directory,'workspace');skill(directory,'skills/review/SKILL.md','review','USER_REVIEW');write(directory,'skills/review/references/details.txt','USER_REFERENCE');write(directory,'AGENTS.md','USER_SCOPE_RULE');write(root,'AGENTS.override.md','PROJECT_SCOPE_RULE');
    skill(root,'skills/review/SKILL.md','review','SHADOWED_PROJECT_REVIEW');skill(second,'skills/local/SKILL.md','local','SECOND_LOCAL');skill(directory,'skills/.private/hidden/SKILL.md','hidden','PRIVATE_USER_BODY');write(directory,'credentials-hidden.txt','PRIVATE_CREDENTIAL');
    capabilities.saveRoot({id:'second',name:'Second',path:second});const first=runtime.createContext({id:'work.first',name:'First',role:'work'}),other=runtime.createContext({id:'work.second',name:'Second',role:'work',workspaceId:'second'});
    assert.deepEqual((await capabilities.listSkills(first)).map(row=>row.name),['review']);assert.deepEqual((await capabilities.listSkills(other)).map(row=>row.name),['local','review']);
    const selected=await capabilities.getSkill(first,'review');assert.equal(selected.path,'@user/review');assert.equal(selected.instructions,'USER_REVIEW');assert.equal(await capabilities.skillResource(other,'review','reference','details.txt'),'USER_REFERENCE');
    assert.match((await capabilities.skillDiagnostics(first))[0]?.message??'',/@user\/review/);assert.ok(capabilities.projectInstructions(first).indexOf('USER_SCOPE_RULE')<capabilities.projectInstructions(first).indexOf('PROJECT_SCOPE_RULE'));
    await capabilities.setSkillEnabled(first,'review',false);assert.equal((await capabilities.getSkill(first,'review') as {enabled?:boolean}).enabled,false);assert.equal((await capabilities.getSkill(other,'review') as {enabled?:boolean}).enabled,true);
    await assert.rejects(capabilities.addSkillSource(first,'@user/review'),/invalid_skill_source/);await assert.rejects(capabilities.skillResource(other,'review','reference','../../../credentials-hidden.txt'),/invalid_skill_resource/);
    const workspace=capabilities.workspace(other,()=>({write:false,execute:false,mcp:false})),model=await workspace.skills!.getScoped!();assert.equal((await model.get('review'))?.instructions,'USER_REVIEW');assert.equal(await model.getReference('review','references/details.txt'),'USER_REFERENCE');
    await capabilities.close();store.close();store=new Store(path.join(directory,'records.sqlite'));runtime=new RuntimeStore(store.db);capabilities=new Capabilities(runtime,directory);
    assert.equal((await capabilities.getSkill(runtime.context(first.id)!,'review') as {enabled?:boolean}).enabled,false);assert.equal((await capabilities.getSkill(runtime.context(other.id)!,'review') as {enabled?:boolean}).enabled,true);
    skill(directory,'skills/review/SKILL.md','review','USER_REVIEW_V2');assert.equal((await capabilities.getSkill(runtime.context(other.id)!,'review')).instructions,'USER_REVIEW_V2');
    write(directory,'skills/review/references/private-alias.txt','temporary');fs.unlinkSync(path.join(directory,'skills/review/references/private-alias.txt'));fs.symlinkSync(path.join(directory,'credentials-hidden.txt'),path.join(directory,'skills/review/references/private-alias.txt'));
    await assert.rejects(capabilities.skillResource(runtime.context(other.id)!,'review','reference','private-alias.txt'),/resource_path_not_allowed/);
  }finally{await capabilities.close();store.close();fs.rmSync(directory,{recursive:true,force:true});fs.rmSync(second,{recursive:true,force:true});}
});

test('replacing a user Skill root cannot silently redirect an already opened catalog',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-user-skill-replace-')),store=new Store(path.join(directory,'records.sqlite')),runtime=new RuntimeStore(store.db),capabilities=new Capabilities(runtime,directory);
  try{
    skill(directory,'skills/review/SKILL.md','review','ORIGINAL');const record=runtime.createContext({id:'work.user-root',name:'User root',role:'work'});assert.equal((await capabilities.getSkill(record,'review')).instructions,'ORIGINAL');
    fs.renameSync(path.join(directory,'skills'),path.join(directory,'skills-original'));skill(directory,'skills/review/SKILL.md','review','REPLACED');await assert.rejects(capabilities.getSkill(record,'review'),/workspace_changed/);
  }finally{await capabilities.close();store.close();fs.rmSync(directory,{recursive:true,force:true});}
});
