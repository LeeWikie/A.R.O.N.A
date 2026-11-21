import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createReadTool} from '@earendil-works/pi-coding-agent';
import {createWorkspaceTools} from '@mastra/core/workspace';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {Store} from '../src/store.js';
import {ProjectResources} from '../src/tools/project-resources.js';
import {exactWorkspaceRead} from '../src/tools/exact-file-output.js';

async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-project-read-')),root=path.join(directory,'project'),reference=path.join(directory,'reference'),state=path.join(directory,'state');for(const part of [root,reference,state])fs.mkdirSync(part);
  const store=new Store(path.join(state,'records.sqlite')),runtime=new RuntimeStore(store.db),capabilities=new Capabilities(runtime,state);capabilities.saveRoot({id:'project',name:'Project',path:root});const record=runtime.createContext({id:'work.read',name:'Read',role:'work',workspaceId:'project'}),workspace=capabilities.workspace(record,()=>({write:false,execute:false,mcp:false})),tools=await createWorkspaceTools(workspace);
  t.after(async()=>{await capabilities.close();store.close();fs.rmSync(directory,{recursive:true,force:true});});return {root,reference,read:(input:unknown,context={})=>tools.mastra_workspace_read_file.execute(input,context),tools};
}

test('the pinned reader and native tracked adapter return the same text, ranges and actionable continuation across file endings',async t=>{
  const f=await fixture(t),reference=createReadTool(f.reference);
  for(const text of ['', 'first\nsecond\n','\ufeff甲\r\n🙂\n尾\r','x'.repeat(10)+'\nlast']){
    for(const root of [f.root,f.reference])fs.writeFileSync(path.join(root,'source.txt'),text);
    const full=String(await f.read({path:'source.txt'}));assert.equal(exactWorkspaceRead({path:'source.txt'},full)?.text,text);
    for(const range of [{},{offset:1,limit:1},{offset:1,limit:0},{offset:-1,limit:2},{offset:1.5,limit:1.5},{limit:-1}]){
      const expected=await reference.execute('reference',{path:'source.txt',...range}),actual=String(await f.read({path:'source.txt',showLineNumbers:false,...range}));assert.equal(actual.slice(actual.indexOf('\n')+1),expected.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'));
    }
  }
  const text=Array.from({length:3000},(_,index)=>`row_${index}`).join('\n');for(const root of [f.root,f.reference])fs.writeFileSync(path.join(root,'source.txt'),text);
  const expected=await reference.execute('reference',{path:'source.txt'}),actual=String(await f.read({path:'source.txt',showLineNumbers:false}));assert.equal(actual.slice(actual.indexOf('\n')+1),expected.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'));assert.match(actual,/offset=2001/);assert.equal(exactWorkspaceRead({path:'source.txt'},actual),undefined);
});

test('long lines and arbitrary binary files remain readable by bounded original byte pages without a shell fallback',async t=>{
  const f=await fixture(t),bytes=Buffer.alloc(120000,120);fs.writeFileSync(path.join(f.root,'source.txt'),bytes);const long=String(await f.read({path:'source.txt'}));assert.match(long,/byteOffset/);assert.doesNotMatch(long,/Use bash|sed -n/);assert.equal(exactWorkspaceRead({path:'source.txt'},long),undefined);
  for(const byteOffset of [0,60000,119999]){const page=String(await f.read({path:'source.txt',encoding:'base64',byteOffset,maxBytes:12}));assert.deepEqual(Buffer.from(page.split('\n')[1]!,'base64'),bytes.subarray(byteOffset,byteOffset+12));}
  const binary=Buffer.from(Array.from({length:256},(_,index)=>index));fs.writeFileSync(path.join(f.root,'source.txt'),binary);assert.match(String(await f.read({path:'source.txt'})),/not UTF-8/);const page=String(await f.read({path:'source.txt',encoding:'hex'}));assert.deepEqual(Buffer.from(page.split('\n')[1]!,'hex'),binary);
  fs.writeFileSync(path.join(f.root,'LICENSE'),'plain content without an extension');assert.match(String(await f.read({path:'LICENSE'})),/plain content without an extension/);
});

test('images keep the native media wire representation after the pinned image processing path',async t=>{
  const f=await fixture(t),image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');fs.writeFileSync(path.join(f.root,'image.png'),image);const output=await f.read({path:'image.png'}) as {__workspaceMedia:boolean;mediaType:string;data:string;text:string};assert.equal(output.__workspaceMedia,true);assert.equal(output.mediaType,'image/png');assert.ok(Buffer.from(output.data,'base64').length);assert.match(output.text,/image.png/);
  const model=await f.tools.mastra_workspace_read_file.toModelOutput?.(output);assert.ok(model&&typeof model==='object'&&'type'in model&&model.type==='content');
});

test('fenced streamed reads and byte pages reject changed sources, links and cancellation before resource completion',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arona-streamed-source-'));
  try{
    fs.writeFileSync(path.join(root,'source.txt'),Buffer.alloc(150000,120));const source=new ProjectResources(root),stream=source.readChunks('source.txt');const first=await stream.next();assert.equal(first.value!.length,65536);fs.appendFileSync(path.join(root,'source.txt'),'changed');await assert.rejects(async()=>{for await(const _ of stream){}},/resource_changed/);
    fs.linkSync(path.join(root,'source.txt'),path.join(root,'duplicate.txt'));await assert.rejects(source.readRange('source.txt',0,10),/resource_path_not_allowed/);fs.unlinkSync(path.join(root,'duplicate.txt'));
    const controller=new AbortController(),cancelled=source.readChunks('source.txt',controller.signal);await cancelled.next();controller.abort();await assert.rejects(cancelled.next(),/abort/i);fs.unlinkSync(path.join(root,'source.txt'));assert.equal(fs.readdirSync(root).length,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
