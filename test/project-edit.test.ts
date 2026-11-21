import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createEditTool} from '@earendil-works/pi-coding-agent';
import {createWorkspaceTools} from '@mastra/core/workspace';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {Store} from '../src/store.js';

async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-project-edit-')),root=path.join(directory,'project'),reference=path.join(directory,'reference'),state=path.join(directory,'state');for(const part of [root,reference,state])fs.mkdirSync(part);
  const store=new Store(path.join(state,'records.sqlite')),runtime=new RuntimeStore(store.db),capabilities=new Capabilities(runtime,state);capabilities.saveRoot({id:'project',name:'Project',path:root});const record=runtime.createContext({id:'work.edit',name:'Edit',role:'work',workspaceId:'project'}),workspace=capabilities.workspace(record,()=>({write:true,execute:false,mcp:false})),tools=await createWorkspaceTools(workspace);
  t.after(async()=>{await capabilities.close();store.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {root,reference,workspace,tools,read:()=>tools.mastra_workspace_read_file.execute({path:'source.txt'},{}),edit:(input:unknown,context={})=>tools.mastra_workspace_edit_file.execute(input,context)};
}

test('the complete pinned editor preserves bytes for batch original-snapshot edits, line endings and model formatting tolerance',async t=>{
  const f=await fixture(t),reference=createEditTool(f.reference);
  const cases=[
    {text:'\ufeffalpha\r\nbeta\r\ngamma\r\n',edits:[{oldText:'alpha\nbeta\n',newText:'updated\nbeta\n'}]},
    {text:'title = “hello”;  \nuntouched—line\n',edits:[{oldText:'title = "hello";\n',newText:'title = "updated";\n'}]},
    {text:'a=1;\r\nmiddle\r\nz=9;\n',edits:[{oldText:'a=1;',newText:'a=2;'},{oldText:'z=9;',newText:'z=10;'}]},
    {text:'abcd',edits:[{oldText:'ab',newText:'cd'},{oldText:'cd',newText:'ef'}]},
    {text:'before\n',edits:[{oldText:'before',newText:'$& ${literal} $1'}]},
  ];
  for(const [index,scenario] of cases.entries()){
    for(const root of [f.root,f.reference])fs.writeFileSync(path.join(root,'source.txt'),scenario.text);
    await f.read();const actual=await f.edit({path:'source.txt',edits:scenario.edits}),expected=await reference.execute(`reference-${index}`,{path:'source.txt',edits:scenario.edits});
    assert.deepEqual(fs.readFileSync(path.join(f.root,'source.txt')),fs.readFileSync(path.join(f.reference,'source.txt')));assert.deepEqual(actual,expected);
  }
});

test('legacy single edits, declared batch coercions and replace-all remain usable through native read tracking',async t=>{
  const f=await fixture(t);
  for(const fields of [{old_string:'before',new_string:'after'},{oldText:'before',newText:'after'},{edits:{oldText:'before',newText:'after'}},{edits:JSON.stringify([{oldText:'before',newText:'after'}])}]){
    fs.writeFileSync(path.join(f.root,'source.txt'),'before\n');await f.read();await f.edit({path:'source.txt',...fields});assert.equal(fs.readFileSync(path.join(f.root,'source.txt'),'utf8'),'after\n');
  }
  fs.writeFileSync(path.join(f.root,'source.txt'),'same\r\nkeep\nsame\r');await f.read();await f.edit({path:'source.txt',old_string:'same',new_string:'updated',replace_all:true});assert.equal(fs.readFileSync(path.join(f.root,'source.txt'),'utf8'),'updated\r\nkeep\nupdated\r');
  await f.read();await assert.rejects(()=>f.edit({path:'source.txt',old_string:'absent',new_string:'changed',replace_all:true}),/edit_text_not_found/);assert.equal(fs.readFileSync(path.join(f.root,'source.txt'),'utf8'),'updated\r\nkeep\nupdated\r');
});

test('ambiguous, overlapping, absent and binary edits fail without changing source bytes',async t=>{
  const f=await fixture(t);
  for(const scenario of [{text:'same same\n',edits:[{oldText:'same',newText:'changed'}]},{text:'abcdef\n',edits:[{oldText:'abcd',newText:'x'},{oldText:'cdef',newText:'y'}]},{text:'source\n',edits:[{oldText:'absent',newText:'changed'}]}]){
    fs.writeFileSync(path.join(f.root,'source.txt'),scenario.text);await f.read();await assert.rejects(()=>f.edit({path:'source.txt',edits:scenario.edits}));assert.equal(fs.readFileSync(path.join(f.root,'source.txt'),'utf8'),scenario.text);
  }
  const binary=Buffer.from([0xff,0x00,0x42]);fs.writeFileSync(path.join(f.root,'source.txt'),binary);await f.read();await assert.rejects(()=>f.edit({path:'source.txt',old_string:'B',new_string:'changed'}),/binary_file_requires_format_writer/);assert.deepEqual(fs.readFileSync(path.join(f.root,'source.txt')),binary);
});

test('cancelling an in-flight filesystem write retains the mutation lock until the real write settles',async t=>{
  const f=await fixture(t);fs.writeFileSync(path.join(f.root,'source.txt'),'before\n');await f.read();const filesystem=f.workspace.filesystem!,write=filesystem.writeFile.bind(filesystem),controller=new AbortController();let release!:()=>void,entered!:()=>void,writes=0;const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  filesystem.writeFile=async(...args)=>{writes++;entered();await gate;return write(...args);};
  const first=f.edit({path:'source.txt',old_string:'before',new_string:'after'},{abortSignal:controller.signal});const failed=assert.rejects(first,/aborted/i);await ready;controller.abort();
  const second=f.edit({path:'source.txt',old_string:'after',new_string:'last'});const reread=assert.rejects(second,/read|Read|modified|changed/);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(writes,1);assert.equal(fs.readFileSync(path.join(f.root,'source.txt'),'utf8'),'before\n');
  release();await Promise.all([failed,reread]);assert.equal(fs.readFileSync(path.join(f.root,'source.txt'),'utf8'),'after\n');filesystem.writeFile=write;await f.read();await f.edit({path:'source.txt',old_string:'after',new_string:'last'});assert.equal(fs.readFileSync(path.join(f.root,'source.txt'),'utf8'),'last\n');
});
