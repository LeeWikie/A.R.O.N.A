import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectResources } from '../src/tools/project-resources.js';
import { ProjectSkillCatalog } from '../src/tools/project-skills.js';

function write(root: string, relative: string, content: string) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function skill(root: string, relative: string, name: string, body: string, fields = '') { write(root, relative + '/SKILL.md', `---\nname: ${name}\ndescription: Synthetic ${name} skill.\n${fields}---\n${body}`); }

test('nested skills are discovered recursively and a root skill prevents scanning its bundled children', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-tree-'));
  const catalog = new ProjectSkillCatalog(new ProjectResources(root), () => []);
  try {
    skill(root, 'skills/nested/deep-child', 'deep-child', 'Deep instructions.');
    skill(root, 'skills/root-skill', 'root-skill', 'Root instructions.');
    skill(root, 'skills/root-skill/bundled/hidden-child', 'hidden-child', 'Bundled instructions.');
    assert.deepEqual((await catalog.list()).map(row => row.name), ['deep-child', 'root-skill']);
    assert.equal((await catalog.get('deep-child')).instructions, 'Deep instructions.');
    skill(root, 'skills/new-skill', 'new-skill', 'Created after first discovery.');
    assert.deepEqual((await catalog.list()).map(row => row.name), ['deep-child', 'new-skill', 'root-skill']);
    fs.rmSync(path.join(root, 'skills/nested'), { recursive: true });
    await assert.rejects(catalog.get('deep-child'), /skill_not_found/);
  } finally { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('plain markdown skill sources, root files and ignore rules share discovery, activation, resources and reload',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shittim-skills-markdown-'));
  const catalog=new ProjectSkillCatalog(new ProjectResources(root),()=>[],()=>['vendor/explicit.md']);
  try{
    write(root,'skills/flat.md','---\nname: flat-review\ndescription: Review a supplied file.\n---\nFlat instructions violet-marker.');
    write(root,'skills/notes.md','Ordinary notes without Skill metadata.');
    write(root,'skills/broken/SKILL.md','---\nname: broken\ndescription: [invalid\n---\nBroken source.');
    write(root,'skills/references/details.txt','Shared flat reference.');
    write(root,'vendor/explicit.md','---\nname: explicit-review\ndescription: Review explicitly supplied content.\n---\nExplicit instructions.');
    write(root,'skills/.gitignore','ignored/\n*.skip.md\n');
    skill(root,'skills/ignored','ignored','Ignored instructions.');
    write(root,'skills/hidden.skip.md','---\nname: ignored-file\ndescription: A hidden file.\n---\nIgnored file.');
    write(root,'skills/group/.fdignore','hidden/\n');skill(root,'skills/group/hidden','nested-ignored','Nested ignored.');skill(root,'skills/group/visible','visible','Visible.');
    assert.deepEqual((await catalog.list()).map(row=>row.name),['explicit-review','flat-review','visible']);
    assert.deepEqual(await catalog.diagnostics(),[{type:'warning',path:'skills/broken/SKILL.md',message:'Skill metadata could not be read.'}]);
    const flat=await catalog.get('flat-review');assert.equal(flat.path,'skills/flat.md');assert.equal(flat.instructions,'Flat instructions violet-marker.');
    assert.match((await catalog.activate('flat-review')).content,/Flat instructions/);
    const model=await catalog.modelView().getScoped!();assert.equal((await model.get('skills/flat.md'))?.name,'flat-review');assert.equal(await model.getReference('flat-review','references/details.txt'),'Shared flat reference.');
    const found=await model.search('violet-marker');assert.equal(found[0]?.skillPath,'skills/flat.md');assert.equal(found[0]?.skillName,'flat-review');
    write(root,'skills/flat.md','---\nname: flat-review\ndescription: Updated review.\n---\nChanged flat instructions.');assert.equal((await catalog.get('flat-review')).instructions,'Changed flat instructions.');
    fs.unlinkSync(path.join(root,'vendor/explicit.md'));await assert.rejects(catalog.get('explicit-review'),/skill_not_found/);
    assert.ok((await catalog.diagnostics()).some(row=>row.path==='vendor/explicit.md'&&row.message==='Skill source does not exist.'));
  }finally{await catalog.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('same-named project skills resolve consistently in management, model lists and native reads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-priority-'));
  const catalog = new ProjectSkillCatalog(new ProjectResources(root), () => []);
  try {
    skill(root, 'skills/calendar', 'calendar', 'Fallback instructions.');
    skill(root, '.agents/skills/calendar', 'calendar', 'Project instructions.');
    write(root, '.agents/skills/calendar/references/value.txt', 'Project reference.');
    assert.equal((await catalog.list()).length, 1);
    assert.match((await catalog.list())[0]!.warnings.join('\n'),/skills\/calendar.*shadowed/);
    const diagnostics=await catalog.diagnostics();assert.equal(diagnostics.length,1);assert.equal(diagnostics[0]?.type,'collision');assert.equal(diagnostics[0]?.path,'skills/calendar');assert.equal(diagnostics[0]?.winnerPath,'.agents/skills/calendar');
    assert.equal((await catalog.get('calendar')).instructions, 'Project instructions.');
    const model = await catalog.modelView().getScoped!();
    assert.equal((await model.list()).length, 1);
    assert.equal((await model.get('calendar'))?.instructions, 'Project instructions.');
    assert.equal(await model.getReference('calendar', 'references/value.txt'), 'Project reference.');
    assert.deepEqual(await model.search('Fallback'), []);
    assert.equal((await model.search('Project', { topK: 1 }))[0]?.skillPath, '.agents/skills/calendar');
    fs.rmSync(path.join(root, '.agents/skills/calendar'), { recursive: true });
    assert.equal((await catalog.get('calendar')).instructions, 'Fallback instructions.');
  } finally { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('frontmatter names remain usable when the containing directory has a different name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-name-'));
  const catalog = new ProjectSkillCatalog(new ProjectResources(root), () => []);
  try {
    skill(root, 'skills/package-directory', 'review-source', 'Review source instructions.');
    write(root, 'skills/package-directory/references/details.txt', 'Reference in the original directory.');
    const row = await catalog.get('review-source');
    assert.equal(row.path, 'skills/package-directory');
    assert.equal((await catalog.list())[0]?.path, 'skills/package-directory');
    const model = await catalog.modelView().getScoped!();
    assert.equal((await model.get('review-source'))?.path, 'skills/package-directory');
    assert.equal(await model.getReference('review-source', 'references/details.txt'), 'Reference in the original directory.');
    assert.ok(!(await catalog.activate('review-source')).content.includes('@skill-catalog'));
  } finally { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy names, missing names and long descriptions remain discoverable with warnings and original source content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-legacy-'));
  const catalog = new ProjectSkillCatalog(new ProjectResources(root), () => []);
  try {
    skill(root, 'skills/legacy-package', 'Review_Source', 'Legacy instructions contain searchable violet-marker.');
    skill(root, 'skills/long-package', 'a'.repeat(65), 'Long-name instructions.');
    write(root, 'skills/fallback-name/SKILL.md', `---\ndescription: ${'x'.repeat(1100)}\n---\nFallback instructions.`);
    const original = fs.readFileSync(path.join(root, 'skills/legacy-package/SKILL.md'));
    const rows = await catalog.list(); assert.equal(rows.length, 3);
    assert.equal(rows.find(row => row.name === 'Review_Source')?.warnings.length, 1);
    assert.equal(rows.find(row => row.name === 'fallback-name')?.description.length, 1100);
    assert.equal((await catalog.get('Review_Source')).name, 'Review_Source');
    assert.equal((await catalog.get('fallback-name')).instructions, 'Fallback instructions.');
    const model = await catalog.modelView().getScoped!();
    assert.equal((await model.get('Review_Source'))?.name, 'Review_Source');
    const asset = path.join(root, 'skills/legacy-package/assets/data.bin'); fs.mkdirSync(path.dirname(asset)); fs.writeFileSync(asset, Buffer.from([0xff, 0x00, 0x80]));
    assert.deepEqual(await model.getAsset('Review_Source', 'assets/data.bin'), Buffer.from([0xff, 0x00, 0x80]));
    const found = await model.search('violet-marker', { skillNames: ['Review_Source'] });
    assert.ok(found.length); assert.equal(found[0]?.skillName, 'Review_Source'); assert.equal(found[0]?.skillPath, 'skills/legacy-package');
    assert.match((await catalog.activate('Review_Source')).content, /Legacy instructions/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'skills/legacy-package/SKILL.md')), original);
    write(root, 'skills/manual-legacy/SKILL.md', '---\nname: Manual_Only\ndescription: Explicit usage only.\ndisable-model-invocation: true\n---\nManual instructions.');
    const refreshed = await catalog.modelView().getScoped!(); assert.equal(await refreshed.get('Manual_Only'), null);
    assert.match((await catalog.activate('Manual_Only')).content, /Manual instructions/);
  } finally { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual-only and disabled skills stay out of model discovery and cannot be read around the flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-controls-')); const disabled: string[] = [];
  const catalog = new ProjectSkillCatalog(new ProjectResources(root), () => disabled);
  try {
    skill(root, 'skills/manual', 'manual', 'Manual instructions.', 'disable-model-invocation: true\n');
    write(root, 'skills/manual/references/secret.txt', 'Manual reference.');
    skill(root, 'skills/normal', 'normal', 'Normal instructions.');
    skill(root, 'skills/internal', 'internal', 'Model-only instructions.', 'user-invocable: false\n');
    const rows = await catalog.list(); assert.equal(rows.length, 3); assert.equal(rows.find(row => row.name === 'manual')?.disableModelInvocation, true);
    const model = await catalog.modelView().getScoped!();
    assert.deepEqual((await model.list()).map(row => row.name).sort(), ['internal', 'normal']);
    assert.equal(await model.get('manual'), null); assert.equal(await model.get('skills/manual/SKILL.md'), null);
    assert.equal(await model.getReference('manual', 'references/secret.txt'), null);
    assert.match((await catalog.activate('manual')).content, /Manual instructions/);
    await assert.rejects(catalog.activate('internal'), /skill_not_user_invocable/);
    disabled.push('skills/normal');
    assert.equal(await model.get('normal'), null); assert.equal((await catalog.get('normal')).enabled, false);
    await assert.rejects(catalog.activate('normal'), /skill_disabled/);
    assert.deepEqual((await model.list()).map(row => row.name), ['internal']);
    disabled.pop(); assert.equal((await model.get('normal'))?.instructions, 'Normal instructions.');
  } finally { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('skill discovery and reference reads never follow aliases into private or outside directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-outside-'));
  const catalog = new ProjectSkillCatalog(new ProjectResources(root), () => []);
  try {
    skill(root, '.private/not-exposed', 'not-exposed', 'Private instructions.');
    skill(outside, 'external-skill', 'external-skill', 'Outside instructions.');
    fs.mkdirSync(path.join(root, 'skills'));
    fs.symlinkSync(path.join(root, '.private/not-exposed'), path.join(root, 'skills/private-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(outside, 'external-skill'), path.join(root, 'skills/outside-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(await catalog.list(), []);
  } finally { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('disabled and manual-only matches cannot consume the search result budget of usable skills', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shittim-skills-search-scope-'));
  const disabled = ['skills/a-disabled']; const catalog = new ProjectSkillCatalog(new ProjectResources(root), () => disabled);
  try {
    skill(root, 'skills/a-disabled', 'a-disabled', 'Searchable violet-marker.');
    skill(root, 'skills/b-manual', 'b-manual', 'Searchable violet-marker.', 'disable-model-invocation: true\n');
    skill(root, 'skills/z-available', 'z-available', 'Searchable violet-marker.');
    const model = await catalog.modelView().getScoped!();
    const results = await model.search('violet-marker', { topK: 1 });
    assert.equal(results.length, 1); assert.equal(results[0]?.skillName, 'z-available');
    assert.deepEqual(await model.search('violet-marker', { topK: 1, skillNames: ['a-disabled', 'b-manual'] }), []);
    assert.deepEqual(await model.search('violet-marker', { topK: 1, skillNames: ['missing'] }), []);
    disabled.length = 0;
    assert.equal((await model.search('violet-marker', { topK: 1, skillNames: ['a-disabled'] }))[0]?.skillName, 'a-disabled');
  } finally { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
