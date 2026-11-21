import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createLsTool,createFindTool} from '@earendil-works/pi-coding-agent';
import {createWorkspaceTools} from '@mastra/core/workspace';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {findFd} from '../src/tools/fd.js';

async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-project-list-')),db=new DatabaseSync(':memory:'),runtime=new RuntimeStore(db),capabilities=new Capabilities(runtime,directory),record=runtime.createContext({id:'synthetic-list',name:'List',role:'work'}),workspace=capabilities.workspace(record,()=>({write:false,execute:false,mcp:false})),tools=await createWorkspaceTools(workspace),root=path.join(directory,'workspace');t.after(async()=>{await capabilities.close();db.close();fs.rmSync(directory,{recursive:true,force:true});});const write=(file:string,text='synthetic')=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};return {directory,root,write,list:(input:unknown,context={})=>tools.mastra_workspace_list_files.execute(input,context)};
}
const text=(value:{content:Array<{type:string;text?:string}>})=>value.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');

test('directory mode inherits the pinned sorted complete listing, dotfiles and exact entry-limit proof',async t=>{
  const f=await fixture(t),reference=createLsTool(f.root);for(const file of ['lower.txt','Upper.txt','.ordinary','nested/source.txt'])f.write(file);
  for(const input of [{},{limit:0},{limit:1},{limit:4},{limit:5}]){const expected=await reference.execute('reference',input);assert.equal(await f.list({mode:'directory',...input}),text(expected));}
  fs.mkdirSync(path.join(f.root,'empty'));assert.equal(await f.list({path:'empty',mode:'directory'}),'(empty directory)');await assert.rejects(f.list({mode:'directory',path:'lower.txt'}),/Not a directory/);await assert.rejects(f.list({mode:'directory',path:'../'}),/outside_workspace/);
});

test('recursive find mode inherits the pinned path patterns and finds full subtrees without a manual depth adjustment',async t=>{
  assert.ok(findFd(),'The packaged or installed pinned discovery tool must be available.');const f=await fixture(t),reference=createFindTool(f.root);f.write('deep/a/b/c/target.txt');f.write('deep/a/b/c/source.ts');f.write('deep/a/b/c/source.test.ts');f.write('deep/.fdignore','*.skip\n');f.write('deep/a/b/c/ignored.skip');f.write('literal+(name).txt');
  for(const pattern of ['target.txt','deep/**/*.test.ts','**/target.txt','literal+(name).txt','*.skip','does-not-exist']){const expected=await reference.execute('reference',{pattern});assert.equal(await f.list({mode:'find',pattern}),text(expected),pattern);}
  assert.equal(await f.list({mode:'find',pattern:'target.txt',maxDepth:2}),'No files found matching pattern');assert.match(String(await f.list({mode:'find',path:'deep',pattern:'*.ts',extension:'test.ts'})),/source.test.ts/);
  const tree=String(await f.list({path:'.',maxDepth:2,showHidden:true}));assert.match(tree,/deep/);assert.doesNotMatch(tree,/target.txt/);
});

test('find pagination counts only authorized original paths and does not expose linked or private sources',async t=>{
  const f=await fixture(t);f.write('safe/one.txt');f.write('.private/a.txt','PRIVATE');f.write('.env','PRIVATE');fs.writeFileSync(path.join(f.directory,'outside.txt'),'PRIVATE');fs.symlinkSync(path.join(f.directory,'outside.txt'),path.join(f.root,'linked.txt'));fs.linkSync(path.join(f.directory,'outside.txt'),path.join(f.root,'hardlink.txt'));
  const exact=String(await f.list({mode:'find',pattern:'*.txt',limit:1}));assert.equal(exact,'safe/one.txt');assert.doesNotMatch(exact,/limit reached|PRIVATE|linked|hardlink|\.private/);const entries=String(await f.list({mode:'directory'}));assert.match(entries,/safe\//);assert.doesNotMatch(entries,/\.env|\.private|linked|hardlink/);
  f.write('safe/two.txt');const over=String(await f.list({mode:'find',pattern:'*.txt',limit:1}));assert.match(over,/1 results limit reached/);assert.equal(over.split('\n\n')[0]!.split('\n').length,1);const complete=String(await f.list({mode:'find',pattern:'*.txt',limit:2}));assert.match(complete,/safe\/one.txt/);assert.match(complete,/safe\/two.txt/);assert.doesNotMatch(complete,/limit reached/);
});
