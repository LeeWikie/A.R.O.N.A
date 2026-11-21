import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {z} from 'zod';
import {Mastra} from '@mastra/core';
import {LibSQLStore} from '@mastra/libsql';
import {createStep,createWorkflow} from '@mastra/core/workflows';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {removeTemp} from './helpers.js';

for(const changed of ['native-workflow','model-request','tool-start','terminal-event','abort','anchor','raw-source'] as const)test(`prepared queue recovery refuses ${changed} evidence without changing the original admission identity`,{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-prepared-proof-'));
  const child=fork(fileURLToPath(new URL('./queue-editor-crash-fixture.ts',import.meta.url)),[directory,'prepared'],{stdio:['ignore','ignore','ignore','ipc']});let core:Core|undefined,calls=0;
  try{
    const [code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');
    const boundary=JSON.parse(fs.readFileSync(path.join(directory,'crash-boundary.json'),'utf8')) as {id:string};
    const db=new DatabaseSync(path.join(directory,'records.sqlite'));let runId:string,leaderId:string,original:{native_id:unknown;run_id:unknown;action:unknown};
    try{
      const draft=JSON.parse(String(db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(`queue-edit:${boundary.id}`)!.body)) as {submission:{leaderSignalId:string;runId:string}};
      leaderId=draft.submission.leaderSignalId;const leader=db.prepare('SELECT native_id,run_id,action,body FROM signals WHERE id=?').get(leaderId)!;runId=String(leader.run_id);assert.ok(runId&&runId!=='null');original={native_id:leader.native_id,run_id:leader.run_id,action:leader.action};
      if(['model-request','tool-start','terminal-event','abort'].includes(changed)){
        const kind=changed==='model-request'?'model_request':changed==='tool-start'?'tool_start':changed==='terminal-event'?'agent_end':'run_abort_requested';
        db.prepare('INSERT INTO runtime_events(context_id,run_id,kind,data,event_key,created_at) VALUES(?,?,?,?,?,?)').run('main',runId,kind,JSON.stringify({type:kind,reason:'complete'}),changed==='abort'?`run-abort:${runId}`:`synthetic-proof:${changed}`,new Date().toISOString());
      }else if(changed==='anchor'){
        const key=`session-run-anchor:${runId}`,value=JSON.parse(String(db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(key)!.body)) as {revision:number};value.revision++;db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(value),key);
      }else if(changed==='raw-source'){
        const input=JSON.parse(String(leader.body)) as {content:string};input.content='SYNTHETIC_CHANGED_AFTER_ADMISSION';db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(input),leaderId);
      }
    }finally{db.close();}
    if(changed==='native-workflow'){
      const storage=new LibSQLStore({id:'prepared-checkpoint-fixture',url:'file:'+path.join(directory,'history.sqlite').replaceAll('\\','/')});
      const schema=z.object({marker:z.literal('SYNTHETIC_NATIVE_CHECKPOINT')});
      const step=createStep({id:'native-persisted-gate',inputSchema:schema,outputSchema:schema,suspendSchema:schema,execute:async({inputData,suspend})=>{await suspend(inputData);return inputData;}});
      const workflow=createWorkflow({id:'synthetic-reservation-checkpoint',inputSchema:schema,outputSchema:schema}).then(step).commit();const mastra=new Mastra({storage,workflows:{'synthetic-reservation-checkpoint':workflow}});
      try{await storage.init();const run=await workflow.createRun({runId});const output=await run.start({inputData:{marker:'SYNTHETIC_NATIVE_CHECKPOINT'}});assert.equal(output.status,'suspended');assert.ok(await(await storage.getStore('workflows'))!.getWorkflowRunById({runId}));}finally{await mastra.shutdown();await storage.close();}
    }
    const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;throw Error('unproven_prepared_input_must_not_execute');}});
    core=await Core.open({dataDir:directory,model,memoryEnabled:false});await new Promise(resolve=>setTimeout(resolve,50));assert.equal(calls,0);
    const leader=core.store.getSignal(leaderId)!;assert.deepEqual({native_id:leader.nativeSignalId,run_id:leader.runId,action:leader.action},original);assert.notEqual(core.store.getRun(runId)?.status,'running');
    const document=core.queueEditor().page('main',boundary.id).draft;assert.equal(document.status,'blocked');assert.equal(document.errorCode,changed==='abort'?'queue_group_cancelled':'queue_group_interrupted');
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await core?.close();await removeTemp(directory);}
});
