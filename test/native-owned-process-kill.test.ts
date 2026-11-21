import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import type {ProcessHandle} from '@mastra/core/workspace';
import {removeTemp,until} from './helpers.js';

for(const entry of ['esm','cjs'] as const)test(`native ${entry} owned-process termination uses its original child handle and refuses an exited child`,{timeout:20000},async()=>{
  const sdk:typeof import('@mastra/core/workspace')=entry==='esm'?await import('@mastra/core/workspace'):createRequire(import.meta.url)('@mastra/core/workspace');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-owned-child-')),sandbox=new sdk.LocalSandbox({workingDirectory:directory,timeout:0});let handle:ProcessHandle|undefined;
  try{
    let output='';const command=process.platform==='win32'?'set /p "ARONA_TEST_INPUT=READY"':`exec '${process.execPath.replaceAll("'","'\\''")}' -e 'process.stdout.write("READY");process.stdin.resume();process.stdin.on("end",()=>process.exit());setInterval(()=>{},1000)'`;
    handle=await sandbox.processes.spawn(command,{timeout:0,stdinMode:'pipe',onStdout:text=>output+=text});await until(()=>output,text=>text.includes('READY'));assert.equal(typeof handle.killOwnedProcess,'function');
    handle.kill=async()=>{throw Error('numeric_process_tree_fallback_forbidden');};assert.equal(await handle.killOwnedProcess!(),true);const result=await handle.wait();assert.notEqual(result.exitCode,0);assert.equal(await handle.killOwnedProcess!(),false);sandbox.processes.release(handle.pid);handle=undefined;
    const exited=await sandbox.processes.spawn(process.platform==='win32'?'echo NATURAL_EXIT':'printf NATURAL_EXIT',{timeout:0});const finished=await exited.wait();assert.equal(finished.exitCode,0);exited.kill=async()=>{throw Error('exited_pid_fallback_forbidden');};assert.equal(await exited.killOwnedProcess!(),false);sandbox.processes.release(exited.pid);
  }finally{if(handle){await handle.killOwnedProcess?.().catch(()=>{});await handle.closeStdin().catch(()=>{});await handle.wait().catch(()=>{});sandbox.processes.release(handle.pid);}await sandbox.destroy();await removeTemp(directory);}
});
