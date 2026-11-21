import assert from'node:assert/strict';
import fs from'node:fs';
import os from'node:os';
import path from'node:path';
import test from'node:test';
import{DatabaseSync}from'node:sqlite';
import{Assets}from'../src/assets.js';
import{ShellOutputCaptures}from'../src/tui/shell-output.js';
import{removeTemp}from'./helpers.js';

test('sharing another live client observation does not consume later bytes or change the prior immutable publication',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-shell-observations-')),one=new ShellOutputCaptures(path.join(directory,'client'),'control'),two=new ShellOutputCaptures(path.join(directory,'client'),'control'),db=new DatabaseSync(':memory:'),assets=new Assets(db,path.join(directory,'core')),capture=one.start({storageId:'store',contextId:'context',command:'synthetic-producer',cwd:'/synthetic-client',shared:true}),prefix=Buffer.alloc(4*1024*1024+17,0x61),suffix=Buffer.from('SYNTHETIC_LATER_PRODUCER_BYTES');
 const upload=async(bytes:Uint8Array,name:string,metadata:{id:string;sha256:string;bytes:number;purpose:'client-shell-output'})=>assets.put(new Response(new Uint8Array(bytes)).body,name,undefined,metadata);
 try{one.append(capture.id,'stdout',prefix);const partial=await two.publish(capture.id,'store','context',upload),original=(await assets.read(partial.manifest.id)).bytes;two.markConsumed([capture.id],'store','context','first-input');assert.equal(two.list('store','context',true).length,0);one.append(capture.id,'stdout',suffix);one.finish(capture.id,{output:'synthetic preview',exitCode:0,cancelled:false});assert.equal(two.list('store','context',true).length,1,'later bytes belong to a new observation and cannot disappear with the earlier partial input');const complete=await two.publish(capture.id,'store','context',upload);assert.notEqual(complete.manifest.id,partial.manifest.id);assert.deepEqual((await assets.read(partial.manifest.id)).bytes,original);
  const first=original.toString('utf8').trimEnd().split('\n').map(row=>JSON.parse(row)),last=(await assets.read(complete.manifest.id)).bytes.toString('utf8').trimEnd().split('\n').map(row=>JSON.parse(row));assert.equal(first[0].state,'incomplete');assert.equal(first[1].complete,false);assert.equal(last[0].state,'finished');assert.equal(last[1].complete,true);assert.equal(last[1].parts[0].id,first[1].parts[0].id,'unchanged full chunks are reused across observations');const bytes:Buffer[]=[];for(const part of last[1].parts)bytes.push((await assets.read(part.id)).bytes);assert.deepEqual(Buffer.concat(bytes),Buffer.concat([prefix,suffix]));assert.equal(Number(db.prepare('SELECT count(*) n FROM asset_records').get()!.n),5);
 }finally{await assets.close();db.close();await removeTemp(directory);}
});
