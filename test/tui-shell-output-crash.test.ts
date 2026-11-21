import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Assets } from '../src/assets.js';
import { ShellOutputCaptures } from '../src/tui/shell-output.js';
import { removeTemp } from './helpers.js';

test('SIGKILL after a raw stream commit preserves a truthful incomplete observation without replaying the client command', {skip:process.platform==='win32',timeout:15000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-shell-kill-')),bytes=Buffer.from([0,255,27,7,10,...Buffer.from('SYNTHETIC_SAVED_PREFIX')]);
  fs.writeFileSync(path.join(directory,'expected.bin'),bytes);fs.writeFileSync(path.join(directory,'producer.cjs'),"const fs=require('node:fs');fs.appendFileSync('executions','once\\n');fs.writeFileSync('producer.pid',String(process.pid));process.stdout.write(fs.readFileSync('expected.bin'));setInterval(()=>{},1000);");
  const child=spawn(process.execPath,['--import','tsx','test/tui-shell-output-crash-fixture.ts',directory],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc']});let output='';child.stderr?.on('data',value=>{output+=value;});let producerPid:number|undefined;
  try{
    const [message]=await once(child,'message',{signal:AbortSignal.timeout(8000)}) as [{captureId:string;commandPid:number}];producerPid=message.commandPid;const exit=once(child,'exit');child.kill('SIGKILL');await exit;process.kill(-producerPid,'SIGKILL');producerPid=undefined;
    const reopened=new ShellOutputCaptures(path.join(directory,'client'),'synthetic-control'),capture=reopened.list('store','context',true)[0]!;assert.equal(capture.id,message.captureId);assert.equal(capture.state,'incomplete');assert.equal(capture.exitCode,undefined);assert.equal(capture.streams.stdout.complete,false);assert.equal(capture.streams.stdout.bytes,bytes.length);
    const db=new DatabaseSync(':memory:'),assets=new Assets(db,path.join(directory,'core'));
    try{const result=await reopened.publish(capture.id,'store','context',async(body,name,metadata)=>assets.put(new Response(new Uint8Array(body)).body,name,undefined,metadata));const manifest=(await assets.read(result.manifest.id)).bytes.toString('utf8').trimEnd().split('\n').map(value=>JSON.parse(value));assert.equal(manifest[0].state,'incomplete');assert.equal('exitCode'in manifest[0],false);assert.equal(manifest[1].complete,false);assert.deepEqual((await assets.read(manifest[1].parts[0].id)).bytes,bytes);assert.equal(fs.readFileSync(path.join(directory,'executions'),'utf8'),'once\n');}finally{await assets.close();db.close();}
  }catch(error){throw new Error(`${error instanceof Error?error.message:'fixture failed'}\n${output}`);}finally{if(producerPid)try{process.kill(-producerPid,'SIGKILL');}catch{}if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await removeTemp(directory);}
});
