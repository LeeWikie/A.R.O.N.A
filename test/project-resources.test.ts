import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectResources } from '../src/tools/project-resources.js';
import { Capabilities } from '../src/capabilities.js';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import {createWorkspaceTools} from '@mastra/core/workspace';

function directory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-project-resources-')); }
function write(root: string, file: string, content: string | Buffer) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }

test('project instructions are ordered, scoped to the selected path and reloaded after edits', () => {
  const root = directory();
  try {
    write(root, 'AGENTS.md', 'Root rule'); write(root, 'src/AGENTS.md', 'Source rule'); write(root, 'src/nested/entry.ts', 'fixture'); write(root, 'other/AGENTS.md', 'Other rule');
    const source = new ProjectResources(root);
    assert.equal(source.projectInstructions(), 'Project instructions (AGENTS.md):\nRoot rule');
    const nested = source.projectInstructions('src/nested/entry.ts');
    assert.ok(nested.indexOf('Root rule') < nested.indexOf('Source rule')); assert.ok(!nested.includes('Other rule'));
    write(root, 'src/AGENTS.md', 'Updated source rule'); assert.match(source.projectInstructions('src/nested'), /Updated source rule/);
    assert.match(source.projectInstructions('src/new-directory/new-file.ts'), /Updated source rule/);
    assert.throws(() => source.projectInstructions('../'), /resource_path_not_allowed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('instruction filename precedence applies independently at each scope and ignores directory-shaped candidates',()=>{
  const root=directory();
  try{
    write(root,'AGENTS.override.md','Root override');write(root,'AGENTS.md','Shadowed root');
    write(root,'nested/AGENTS.MD','Nested uppercase');write(root,'nested/CLAUDE.md','Shadowed nested');
    fs.mkdirSync(path.join(root,'nested/deep/AGENTS.override.md'),{recursive:true});write(root,'nested/deep/CLAUDE.MD','Deep fallback');
    const source=new ProjectResources(root),documents=source.instructionDocuments('nested/deep/new-file.ts');
    assert.deepEqual(documents,[{path:'AGENTS.override.md',content:'Root override'},{path:fs.existsSync(path.join(root,'nested/AGENTS.md'))?'nested/AGENTS.md':'nested/AGENTS.MD',content:'Nested uppercase'},{path:fs.existsSync(path.join(root,'nested/deep/CLAUDE.md'))?'nested/deep/CLAUDE.md':'nested/deep/CLAUDE.MD',content:'Deep fallback'}]);
    fs.unlinkSync(path.join(root,'AGENTS.override.md'));assert.equal(source.instructionDocuments()[0]?.content,'Shadowed root');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('project resources reject linked or sensitive files and invalid instruction text', async () => {
  const root = directory(), outside = directory();
  try {
    write(outside, 'secret.txt', 'outside-secret'); write(root, '.private/source.txt', 'private-source');
    write(root, 'safe.txt', 'safe'); fs.linkSync(path.join(root, 'safe.txt'), path.join(root, 'hard.txt'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(path.join(root, '.private'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const source = new ProjectResources(root);
    for (const file of ['link.txt', 'hard.txt', '.private/source.txt', 'alias/source.txt']) await assert.rejects(source.readFile(file), /resource_path_not_allowed/);
    assert.deepEqual(await source.readdir('.'), []);
    write(root, 'AGENTS.md', Buffer.from([0xff, 0xfe])); assert.throws(() => source.projectInstructions(), /resource_invalid_utf8/);
    write(root, 'AGENTS.md', Buffer.alloc(256 * 1024 + 1, 65)); assert.throws(() => source.projectInstructions(), /resource_too_large/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('workspace replacement invalidates an existing resource reader', () => {
  const root = directory(), moved = root + '-moved';
  try {
    write(root, 'AGENTS.md', 'Original'); const source = new ProjectResources(root);
    fs.renameSync(root, moved); fs.mkdirSync(root); write(root, 'AGENTS.md', 'Replacement');
    assert.throws(() => source.projectInstructions(), /workspace_changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(moved, { recursive: true, force: true }); }
});

test('deleting a newly discovered instruction file cannot make an unseen frozen scope executable',async()=>{
  const root=directory(),state=directory(),store=new Store(path.join(state,'records.sqlite')),runtime=new RuntimeStore(store.db),capabilities=new Capabilities(runtime,state);
  try{
    write(root,'nested/AGENTS.md','FROZEN_SCOPE_RULE');capabilities.saveRoot({id:'project',name:'Project',path:root});const record=runtime.createContext({id:'work.frozen-source',name:'Frozen source',role:'work',workspaceId:'project'}),workspace=capabilities.workspace(record,()=>({write:true,execute:false,mcp:false})),tools=await createWorkspaceTools(workspace),input={path:'nested/result.txt',content:'observed'};
    capabilities.beginProjectRun(record);assert.equal(capabilities.prepareProjectTool(record,'mastra_workspace_write_file',input),true);fs.unlinkSync(path.join(root,'nested/AGENTS.md'));
    const deferred=await tools.mastra_workspace_write_file.execute(input,{});assert.match(JSON.stringify(deferred),/project_instructions_available/);assert.equal(fs.existsSync(path.join(root,'nested/result.txt')),false);
    assert.match(capabilities.scopedProjectInstructions(record),/FROZEN_SCOPE_RULE/);await tools.mastra_workspace_write_file.execute(input,{});assert.equal(fs.readFileSync(path.join(root,'nested/result.txt'),'utf8'),'observed');
  }finally{await capabilities.close();store.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(state,{recursive:true,force:true});}
});

test('standard workspace skills use native discovery, references, hot reload and both configured directories', async () => {
  const root = directory(), state = directory(); const store = new Store(path.join(state, 'records.sqlite')); const runtime = new RuntimeStore(store.db); const capabilities = new Capabilities(runtime, state);
  try {
    write(root, 'skills/source-check/SKILL.md', '---\nname: source-check\ndescription: Check supplied source material.\n---\nRead the reference and report the marker.');
    write(root, 'skills/source-check/references/details.txt', 'SYNTHETIC_REFERENCE');
    write(root, 'skills/source-check/scripts/check.js', 'console.log("fixture")');
    write(root, 'skills/source-check/assets/fixture.bin', Buffer.from([1, 2, 3]));
    write(root, '.agents/skills/style-check/SKILL.md', '---\nname: style-check\ndescription: Check supplied text.\n---\nCheck the sentence.');
    capabilities.saveRoot({ id: 'project', name: 'Project', path: root });
    const record = runtime.createContext({ id: 'work.skills', name: 'Skills', role: 'work', workspaceId: 'project' });
    assert.deepEqual((await capabilities.listSkills(record)).map(skill => skill.name), ['source-check', 'style-check']);
    const skill = await capabilities.getSkill(record, 'source-check');
    assert.equal(skill.instructions, 'Read the reference and report the marker.'); assert.deepEqual(skill.references, ['details.txt']);
    assert.equal(await capabilities.skillResource(record, 'source-check', 'reference', 'details.txt'), 'SYNTHETIC_REFERENCE');
    assert.equal(await capabilities.skillResource(record, 'source-check', 'script', 'check.js'), 'console.log("fixture")');
    assert.deepEqual(await capabilities.skillResource(record, 'source-check', 'asset', 'fixture.bin'), Buffer.from([1, 2, 3]));
    write(root, 'skills/source-check/SKILL.md', '---\nname: source-check\ndescription: Updated check.\n---\nUpdated instructions.');
    assert.equal((await capabilities.getSkill(record, 'source-check')).instructions, 'Updated instructions.');
    await assert.rejects(capabilities.skillResource(record, 'source-check', 'reference', '../SKILL.md'), /invalid_skill_resource/);
    await assert.rejects(capabilities.getSkill(record, '../../secret'), /invalid_skill_name/);
    fs.unlinkSync(path.join(root, 'skills/source-check/references/details.txt'));
    fs.symlinkSync(path.join(root, '.private'), path.join(root, 'skills/source-check/references/details.txt'));
    await assert.rejects(capabilities.skillResource(record, 'source-check', 'reference', 'details.txt'), /resource_path_not_allowed/);
  } finally { await capabilities.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('explicit skill sources and enablement are shared by workspace and survive reopening without altering source files', async () => {
  const root = directory(), state = directory(); let store = new Store(path.join(state, 'records.sqlite')); let runtime = new RuntimeStore(store.db); let capabilities = new Capabilities(runtime, state);
  try {
    write(root, 'vendor/review/SKILL.md', '---\nname: review\ndescription: Review supplied material.\n---\nRead the supplied material.');
    write(root, '.private/hidden/SKILL.md', '---\nname: hidden\ndescription: Hidden material.\n---\nPrivate instructions.');
    capabilities.saveRoot({ id: 'project', name: 'Project', path: root });
    const first = runtime.createContext({ id: 'work.first', name: 'First', role: 'work', workspaceId: 'project' });
    const second = runtime.createContext({ id: 'work.second', name: 'Second', role: 'work', workspaceId: 'project' });
    assert.deepEqual(await capabilities.listSkills(first), []);
    assert.deepEqual((await capabilities.addSkillSource(first, 'vendor/review/SKILL.md')).map(skill => skill.name), ['review']);
    assert.deepEqual(capabilities.skillSources(second), ['vendor/review/SKILL.md']);
    assert.equal((await capabilities.getSkill(second, 'review')).instructions, 'Read the supplied material.');
    assert.match((await capabilities.activateSkill(first, 'review')).content, /Read the supplied material/);
    await capabilities.setSkillEnabled(first, 'review', false);
    await assert.rejects(capabilities.activateSkill(second, 'review'), /skill_disabled/);
    await assert.rejects(capabilities.addSkillSource(first, '.private/hidden'), /invalid_skill_source/);
    await capabilities.close(); store.close();
    store = new Store(path.join(state, 'records.sqlite')); runtime = new RuntimeStore(store.db); capabilities = new Capabilities(runtime, state);
    const restored = runtime.context('work.first')!;
    assert.equal((await capabilities.getSkill(restored, 'review') as { enabled?: boolean }).enabled, false);
    await capabilities.setSkillEnabled(restored, 'review', true);
    assert.match((await capabilities.activateSkill(restored, 'review')).content, /Read the supplied material/);
    await capabilities.removeSkillSource(restored, 'vendor/review/SKILL.md');
    assert.deepEqual(await capabilities.listSkills(restored), []);
    assert.equal(fs.existsSync(path.join(root, 'vendor/review/SKILL.md')), true);
  } finally { await capabilities.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});
