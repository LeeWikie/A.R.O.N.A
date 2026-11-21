import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {LocalSandbox,type ProcessHandle} from '@mastra/core/workspace';

test('native owned-process termination uses the held resource, leaves another process alone and never repeats after exit',{timeout:15000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-owned-')),sandbox=new LocalSandbox({workingDirectory:directory,timeout:0}),handles:ProcessHandle[]=[];
  const command=process.platform==='win32'?'set /p SYNTHETIC_BLOCK=':'read synthetic_block';
  try{
    const original=await sandbox.processes.spawn(command,{timeout:0,stdinMode:'pipe'}),other=await sandbox.processes.spawn(command,{timeout:0,stdinMode:'pipe'});handles.push(original,other);
    assert.equal(typeof original.killOwnedProcess,'function');assert.equal(typeof other.killOwnedProcess,'function');
    original.kill=async()=>{throw Error('unexpected_pid_tree_fallback');};
    assert.equal(await original.killOwnedProcess!(),true);const result=await original.wait();assert.equal(result.success,false);assert.equal(result.killed,true);
    assert.equal(other.exitCode,undefined);assert.equal(await original.killOwnedProcess!(),false);
    await other.sendStdin('finished\n');assert.equal((await other.wait()).exitCode,0);
    assert.equal(await other.killOwnedProcess!(),false);
  }finally{
    for(const handle of handles){if(handle.exitCode===undefined)await handle.killOwnedProcess?.();sandbox.processes.release(handle.pid);}
    await sandbox.destroy();fs.rmSync(directory,{recursive:true,force:true});
  }
});
