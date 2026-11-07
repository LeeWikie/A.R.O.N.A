import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Core} from '../src/core.js';
import {interruptForeground} from '../src/control.js';
import {scriptedModel,until,removeTemp} from './helpers.js';

test('foreground interruption validates exact run and does not terminate a successor',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-interrupt-'));let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const core=await Core.open({dataDir:dir,model:scriptedModel({gate}).model,memoryEnabled:false});
 try{
  const first=await core.submitSignal({version:2,source:'fixture',type:'user-message',content:'First fixture'});
  await until(()=>core.sessions.peek('main')?.getCurrentRunId(),id=>id===first.runId);
  await assert.rejects(interruptForeground(core,'main','stale-run'),/run_changed/);
  const cancelling=interruptForeground(core,'main',first.runId!);release();const result=await cancelling;
  assert.ok(['interrupted','failed'].includes(result.status));
  await assert.rejects(interruptForeground(core,'main',first.runId!),/run_changed/);
  const next=await core.submitSignal({version:2,source:'fixture',type:'user-message',content:'Next fixture'});assert.notEqual(next.runId,first.runId);
  await assert.rejects(interruptForeground(core,'main',first.runId!),/run_changed/);
 }finally{release();await core.close();await removeTemp(dir);}
});
