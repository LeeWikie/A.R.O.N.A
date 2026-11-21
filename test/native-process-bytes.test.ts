import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {LocalSandbox,type ProcessHandle} from '@mastra/core/workspace';

const require=createRequire(import.meta.url),common=require('@mastra/core/workspace') as typeof import('@mastra/core/workspace');
const quote=(value:string)=>process.platform==='win32'?`"${value.replaceAll('"','\\"')}"`:`'${value.replaceAll("'","'\\''")}'`;
for(const [entry,Constructor] of [['esm',LocalSandbox],['cjs',common.LocalSandbox]] as const)test(`native ${entry} byte observations preserve arbitrary stdout and stderr without changing original decoded callbacks`,{timeout:15000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-bytes-')),sandbox=new Constructor({workingDirectory:directory,timeout:0});let handle:ProcessHandle|undefined;const stdout:Buffer[]=[],stderr:Buffer[]=[];let visible='';
  try{
    const file=path.join(directory,'output.js');fs.writeFileSync(file,"process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i)));process.stderr.write(Buffer.from([0,255,254,128,10]));");
    handle=await sandbox.processes.spawn(`${quote(process.execPath)} ${quote(file)}`,{timeout:0,onStdoutBytes:bytes=>{stdout.push(Buffer.from(bytes));bytes.fill(0);},onStderrBytes:bytes=>{stderr.push(Buffer.from(bytes));bytes.fill(0);},onStdout:text=>{visible+=text;}});
    const result=await handle.wait(),original=Buffer.from(Array.from({length:256},(_,i)=>i));assert.equal(result.exitCode,0);assert.deepEqual(Buffer.concat(stdout),original);assert.deepEqual(Buffer.concat(stderr),Buffer.from([0,255,254,128,10]));assert.equal(visible,new TextDecoder('utf8').decode(original));assert.equal(result.stdout,visible);
  }finally{if(handle){if(handle.exitCode===undefined)await handle.killOwnedProcess?.();sandbox.processes.release(handle.pid);}await sandbox.destroy();fs.rmSync(directory,{recursive:true,force:true});}
});
