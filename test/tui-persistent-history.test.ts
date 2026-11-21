import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawn} from 'node:child_process';import{once}from'node:events';import{fileURLToPath}from'node:url';
import test from 'node:test';
import {TuiInputHistory}from'../src/tui/input-history.js';
const removeTemp=async(directory:string)=>{await fs.promises.rm(directory,{recursive:true,force:true});};

test('persistent input recall keeps full text and command/Shell entries with exact storage and context isolation',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-input-history-'));try{
  const first=new TuiInputHistory(directory,'authenticated-core'),text='中文😀\n'.repeat(18000);first.seed('store-a','main',[{id:'signal:original',text:'ordinary'}]);first.append('store-a','main','/unknown-command');first.append('store-a','main','!!printf synthetic');first.append('store-a','main',text,'signal:large');first.append('store-a','main','   ');
  const next=new TuiInputHistory(directory,'authenticated-core');next.seed('store-a','main',[{id:'signal:original',text:'ordinary'},{id:'signal:large',text}]);assert.deepEqual(next.list('store-a','main'),['ordinary','/unknown-command','!!printf synthetic',text]);assert.deepEqual(next.list('store-b','main'),[]);assert.deepEqual(next.list('store-a','chat.other'),[]);assert.deepEqual(new TuiInputHistory(directory,'another-core').list('store-a','main'),[]);
  for(let index=0;index<130;index++)next.append('store-a','main',`entry-${index}`);assert.deepEqual(next.list('store-a','main'),Array.from({length:100},(_,index)=>`entry-${index+30}`),'resident recall follows native Pi capacity and chronological append order');
  assert.equal(fs.statSync(path.join(directory,fs.readdirSync(directory).find(name=>name.endsWith('.sqlite'))!)).mode&0o777,0o600);
 }finally{await removeTemp(directory);}
});

test('independent client processes append history without replacing another process records',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-input-history-processes-'));try{
  const fixture=fileURLToPath(new URL('./tui-history-fixture.ts',import.meta.url));const children=['A','B'].map(prefix=>spawn(process.execPath,['--import','tsx',fixture,directory,prefix],{stdio:['ignore','ignore','pipe']}));
  await Promise.all(children.map(async child=>{const errors:Buffer[]=[];child.stderr!.on('data',data=>errors.push(data));const [code]=await once(child,'close');assert.equal(code,0,Buffer.concat(errors).toString());}));
  const rows=new TuiInputHistory(directory,'authenticated-core').list('store','main');assert.equal(rows.length,40);assert.equal(new Set(rows).size,40);for(const prefix of ['A','B'])assert.deepEqual(rows.filter(row=>row.startsWith(prefix)),Array.from({length:20},(_,index)=>`${prefix}-${index}`));
 }finally{await removeTemp(directory);}
});

test('history refuses redirected storage and retains pending input until the exact directory is writable again',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-input-history-private-'));try{
  const client=path.join(directory,'client'),outside=path.join(directory,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,client);const history=new TuiInputHistory(client,'core');assert.throws(()=>history.append('store','main','unsaved 中文'),/input_history_redirected/);assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(client);fs.mkdirSync(client);history.append('store','main','later');assert.deepEqual(new TuiInputHistory(client,'core').list('store','main'),['unsaved 中文','later']);
  const file=path.join(client,fs.readdirSync(client)[0]!);fs.linkSync(file,path.join(directory,'hardlink'));assert.throws(()=>new TuiInputHistory(client,'core').append('store','main','not disclosed'),/input_history_redirected/);fs.unlinkSync(path.join(directory,'hardlink'));assert.deepEqual(history.list('store','main'),['unsaved 中文','later']);
  const original=fs.readFileSync(file),target=path.join(directory,'history-target');fs.renameSync(file,target);fs.symlinkSync(target,file);assert.throws(()=>new TuiInputHistory(client,'core').append('store','main','not disclosed'),/input_history_redirected/);assert.deepEqual(fs.readFileSync(target),original,'a final symlink target is never opened as history storage');
 }finally{await removeTemp(directory);}
});
