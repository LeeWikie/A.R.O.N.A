import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {loadSkills,loadProjectContextFiles} from '@earendil-works/pi-coding-agent';
import {ProjectResources} from '../src/tools/project-resources.js';
import {ProjectSkillResources} from '../src/tools/skill-resources.js';
import {ProjectSkillCatalog} from '../src/tools/project-skills.js';
interface SkillObservation {name:string;path:string;description:string;manual:boolean;body:string}

// Behavioral source: Pi 1.5.1 skills.ts and resource-loader.ts. All materials below are synthetic.
test('the pinned resource loader and this catalog observe the same files, instructions, ignore changes and live Skill bodies',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-resource-reference-')),project=path.join(directory,'workspace'),agent=path.join(directory,'agent');let catalog:ProjectSkillCatalog|undefined;
  const write=(root:string,file:string,body:string)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);};
  const skill=(root:string,file:string,name:string,body:string,flags='')=>write(root,file,`---\nname: ${name}\ndescription: Synthetic ${name} behavior.\n${flags}---\n${body}`);
  const logical=(file:string)=>file.startsWith(path.join(agent,'skills')+path.sep)?'@user/'+path.relative(path.join(agent,'skills'),file).split(path.sep).join('/'):file.startsWith(agent+path.sep)?'@user/'+path.relative(agent,file).split(path.sep).join('/'):path.relative(project,file).split(path.sep).join('/');
  try{
    write(agent,'AGENTS.override.md','USER_RULE');write(project,'AGENTS.md','SHADOWED_RULE');write(project,'AGENTS.override.md','ROOT_RULE');write(project,'nested/CLAUDE.md','NESTED_RULE');
    skill(agent,'skills/user/SKILL.md','user-review','USER_BODY');skill(project,'skills/flat.md','flat-review','FLAT_V1');skill(project,'skills/nested/child/SKILL.md','child','CHILD_BODY');skill(project,'skills/owner/SKILL.md','owner','OWNER_BODY');skill(project,'skills/owner/bundled/child/SKILL.md','bundled','BUNDLED_BODY');skill(project,'skills/manual/SKILL.md','manual','MANUAL_BODY','disable-model-invocation: true\n');skill(project,'vendor/explicit.md','explicit','EXPLICIT_BODY');
    fs.mkdirSync(path.join(project,'.agents/skills'),{recursive:true});write(project,'skills/notes.md','Ordinary notes.');write(project,'skills/.gitignore','ignored/\n');skill(project,'skills/ignored/SKILL.md','ignored','IGNORED_BODY');
    const workspace=new ProjectResources(project),global=new ProjectResources(agent),resources=new ProjectSkillResources(workspace,new ProjectResources(path.join(agent,'skills')));catalog=new ProjectSkillCatalog(resources,()=>[],()=>['vendor/explicit.md']);
    for(const phase of ['initial','edited','ignore-removed']){
      if(phase==='edited')skill(project,'skills/flat.md','flat-review','FLAT_V2');
      if(phase==='ignore-removed')write(project,'skills/.gitignore','# no ignored sources\n');
      const reference=loadSkills({cwd:project,agentDir:agent,skillPaths:['.agents/skills','skills','vendor/explicit.md'],includeDefaults:true});
      assert.deepEqual(reference.diagnostics,[]);assert.deepEqual(await catalog.diagnostics(),[]);
      const expected=reference.skills.map(row=>({name:row.name,path:logical(row.filePath),description:row.description,manual:row.disableModelInvocation,body:fs.readFileSync(row.filePath,'utf8').split('\n---\n').slice(1).join('\n---\n').trim()})).sort((a,b)=>a.name.localeCompare(b.name));
      const actual:SkillObservation[]=await Promise.all((await catalog.list()).map(async row=>({name:row.name,path:resources.skillFile(row.path).split(path.sep).join('/'),description:row.description,manual:row.disableModelInvocation,body:(await catalog!.get(row.name)).instructions})));
      assert.deepEqual(actual,expected,phase);
      const nativeContext=loadProjectContextFiles({cwd:path.join(project,'nested'),agentDir:agent});for(const row of nativeContext)assert.ok(row.path.startsWith(project+path.sep)||row.path.startsWith(agent+path.sep),'An outside instruction cannot be silently filtered');
      assert.deepEqual([...global.instructionDocuments().map(row=>({...row,path:'@user/'+row.path})),...workspace.instructionDocuments('nested')],nativeContext.map(row=>({path:logical(row.path),content:row.content})),phase);
      const model=await catalog.modelView().getScoped!();assert.deepEqual((await model.list()).map(row=>row.name).sort(),reference.skills.filter(row=>!row.disableModelInvocation).map(row=>row.name).sort(),phase);
    }
  }finally{await catalog?.close();fs.rmSync(directory,{recursive:true,force:true});}
});
