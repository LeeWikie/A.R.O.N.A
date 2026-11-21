import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createGrepTool} from '@earendil-works/pi-coding-agent';
import {createWorkspaceTools} from '@mastra/core/workspace';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {ProjectResources} from '../src/tools/project-resources.js';
import {AppError} from '../src/domain.js';

async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-project-grep-')),db=new DatabaseSync(':memory:'),runtime=new RuntimeStore(db),capabilities=new Capabilities(runtime,directory),record=runtime.createContext({id:'synthetic-search',name:'Search',role:'work'}),workspace=capabilities.workspace(record,()=>({write:false,execute:false,mcp:false})),tools=await createWorkspaceTools(workspace),root=path.join(directory,'workspace');t.after(async()=>{await capabilities.close();db.close();fs.rmSync(directory,{recursive:true,force:true});});
  const write=(file:string,text:string|Buffer)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};return {root,directory,write,search:(input:unknown,context={})=>tools.mastra_workspace_grep.execute(input,context),reference:createGrepTool(root)};
}
const text=(value:{content:Array<{type:string;text?:string}>})=>value.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');

test('the native tracked search matches the pinned grep engine across limits, trailing context, Unicode, literals and compact output',async t=>{
  const f=await fixture(t);
  for(const scene of[
    {body:'before\nneedle\nafter\n',input:{pattern:'needle',context:1}},
    {body:'before\nneedle\nneedle\nlast\n',input:{pattern:'needle',context:1,limit:1}},
    {body:'needle\nlast',input:{pattern:'needle',limit:1}},
    {body:'needle\nneedle\nlast',input:{pattern:'needle',limit:1}},
    {body:'λ 漢字\nnot Greek',input:{pattern:'\\p{Greek}+'}},
    {body:'a.b\naxb\nA.B',input:{pattern:'a.b',literal:true,ignoreCase:true}},
    {body:'needle '+ 'x'.repeat(1200),input:{pattern:'needle'}},
    {body:Array.from({length:130},()=>`needle ${'x'.repeat(499)}`).join('\n'),input:{pattern:'needle',limit:120}},
    {body:'needle\r\nlast\r\n',input:{pattern:'needle',context:1}},
    {body:'a'.repeat(30000)+'!',input:{pattern:'(a+)+$'}},
    {body:Buffer.concat([Buffer.from('needle\n\0'),Buffer.alloc(150000,120)]),input:{pattern:'needle'}},
    {body:'nothing matches',input:{pattern:'needle'}},
  ]){f.write('source.unlisted',scene.body);const input={path:'source.unlisted',...scene.input},expected=await f.reference.execute('reference',input),actual=await f.search(input);assert.equal(actual,text(expected),JSON.stringify(scene.input));}
  f.write('source.unlisted','needle\nneedle\nneedle');const legacy=String(await f.search({path:'source.unlisted',pattern:'needle',maxCount:1}));assert.equal(legacy,'source.unlisted:1: needle');
  await assert.rejects(f.search({pattern:'('}),/regex parse error|search_failed/);await assert.rejects(f.reference.execute('reference',{pattern:'('}),/regex parse error/);
});

test('discovery inherits native ignore and glob semantics without excluding ordinary file types or exposing protected sources',async t=>{
  const f=await fixture(t);f.write('.ignore','ignored.txt\ngroup/**/*.skip\n');f.write('ignored.txt','NEEDLE');f.write('notes.unlisted','NEEDLE ordinary');f.write('.ordinary','NEEDLE hidden');f.write('group/child/note.skip','NEEDLE ignored nested');f.write('group/child/good.txt','NEEDLE nested');f.write('group/.ignore','*.excluded\n');f.write('group/child/no.excluded','NEEDLE ignored deep');f.write('.env','NEEDLE PRIVATE_ENV');f.write('.private/source.txt','NEEDLE PRIVATE_SOURCE');fs.writeFileSync(path.join(f.directory,'outside.txt'),'NEEDLE PRIVATE_OUTSIDE');fs.symlinkSync(path.join(f.directory,'outside.txt'),path.join(f.root,'linked.txt'));fs.linkSync(path.join(f.directory,'outside.txt'),path.join(f.root,'hardlink.txt'));
  const output=String(await f.search({pattern:'NEEDLE'}));assert.match(output,/notes.unlisted/);assert.match(output,/\.ordinary/);assert.match(output,/group\/child\/good.txt/);assert.doesNotMatch(output,/PRIVATE|ignored|linked.txt|hardlink.txt|\.excluded/);
  assert.doesNotMatch(String(await f.search({pattern:'NEEDLE',includeHidden:false})),/\.ordinary/);const legacy=String(await f.search({pattern:'NEEDLE',path:'group/**/*.txt'}));assert.match(legacy,/good.txt/);assert.doesNotMatch(legacy,/notes.unlisted/);assert.equal(String(await f.search({pattern:'NEEDLE',path:'group',glob:'*.txt'})),'group/child/good.txt:1: NEEDLE nested');assert.equal(String(await f.search({pattern:'NEEDLE',path:'group',glob:'!*.txt'})),'No matches found');
});

test('search streams original checked descriptors and drains them on cancellation instead of using whole-file reads',async t=>{
  const f=await fixture(t),originalRead=ProjectResources.prototype.readBytes,originalChunks=ProjectResources.prototype.readChunks;f.write('source.txt','needle\n'.repeat(30000));let entered!:()=>void,release!:()=>void,closed=false;const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  ProjectResources.prototype.readBytes=function(value,...rest){if(value==='source.txt'&&this.root===fs.realpathSync(f.root))throw new Error('whole-file read must not run');return originalRead.call(this,value,...rest);};
  ProjectResources.prototype.readChunks=async function*(...args){try{for await(const bytes of originalChunks.apply(this,args)){if(this.root===fs.realpathSync(f.root)&&args[0]==='source.txt'){entered();await gate;}yield bytes;}}finally{closed=true;}};
  try{const controller=new AbortController();let returned=false;const run=f.search({path:'source.txt',pattern:'needle'},{abortSignal:controller.signal}).finally(()=>{returned=true;});const settled=assert.rejects(run,/abort/i);await ready;controller.abort();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(returned,false);assert.equal(closed,false);release();await settled;assert.equal(closed,true);fs.unlinkSync(path.join(f.root,'source.txt'));}
  finally{release();ProjectResources.prototype.readBytes=originalRead;ProjectResources.prototype.readChunks=originalChunks;}
});

test('native binary and max-count early exits drain the checked source, while source verification failures never become successful search',async t=>{
  const f=await fixture(t),original=ProjectResources.prototype.readChunks;f.write('binary.dat',Buffer.concat([Buffer.from('needle\n\0'),Buffer.alloc(4*1024*1024,120)]));f.write('limited.txt','needle\n'.repeat(700000));
  assert.equal(String(await f.search({path:'binary.dat',pattern:'needle'})),text(await f.reference.execute('binary-reference',{path:'binary.dat',pattern:'needle'})));assert.equal(String(await f.search({path:'limited.txt',pattern:'needle',maxCount:1})),'limited.txt:1: needle');
  let closed=false;ProjectResources.prototype.readChunks=async function*(...args){try{yield*original.apply(this,args);}finally{if(args[0]==='binary.dat'&&this.root===fs.realpathSync(f.root)){closed=true;throw new AppError('resource_changed',409);}}};
  try{await assert.rejects(f.search({path:'binary.dat',pattern:'needle'}),/resource_changed/);assert.equal(closed,true);fs.unlinkSync(path.join(f.root,'binary.dat'));}finally{ProjectResources.prototype.readChunks=original;}
});
