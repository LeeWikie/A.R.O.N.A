import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import type {TaskRecord} from '../src/runtime-store.js';
import {removeTemp,until} from './helpers.js';

async function launch(directory:string){
  const child=fork(fileURLToPath(new URL('./terminal-core-recovery-fixture.ts',import.meta.url)),[directory,'natural'],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  const messages:Array<Record<string,unknown>>=[];let output='';child.stdout?.on('data',data=>output+=String(data));child.stderr?.on('data',data=>output+=String(data));child.on('message',value=>{if(value&&typeof value==='object')messages.push(value as Record<string,unknown>);});
  const ready=await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(output||'fixture_exited');return messages.find(row=>row.type==='ready');},Boolean);
  return {child,messages,async request(route:string,body?:unknown){const response=await fetch(`http://127.0.0.1:${ready!.port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${ready!.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as Record<string,unknown>};}};
}
async function stop(child:ChildProcess,hard=false){if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,'exit');child.kill(hard?'SIGKILL':'SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await ended;}finally{clearTimeout(timer);}}

for(const change of ['native-content','native-scope','proof','source-body'] as const)test(`interrupted native input rejects changed ${change} without blocking management or replaying the process`,{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-input-proof-')),children:ChildProcess[]=[];
  try{
    const first=await launch(directory);children.push(first.child);const submitted=await first.request('/tasks',{title:'Synthetic input integrity',content:'Preserve the original task source.',grants:{write:false,execute:true,mcp:false}});assert.equal(submitted.status,202);
    const started=await until(()=>first.messages.find(row=>row.type==='process-started'),Boolean);await stop(first.child,true);
    const task=submitted.body as unknown as TaskRecord,db=new DatabaseSync(path.join(directory,'records.sqlite'));
    try{
      const event=db.prepare("SELECT seq,data FROM runtime_events WHERE run_id=? AND kind='message_start' ORDER BY seq LIMIT 1").get(String(started!.runId))!;
      const raw=JSON.parse(String(event.data)) as {message:{id:string;content:{parts:Array<{data:{contents:string}}>;metadata:{signal:{contents:string}}}}};
      const key=`session-native-input:${started!.runId}:${raw.message.id}`,proof=db.prepare('SELECT body FROM runtime_settings WHERE id=?').get(key);assert.ok(proof,'the actual native event has a sealed source proof');
      if(change==='native-content'){raw.message.content.parts[0]!.data.contents='ALTERED_NATIVE_CONTENT';raw.message.content.metadata.signal.contents='ALTERED_NATIVE_CONTENT';db.prepare('UPDATE runtime_events SET data=? WHERE seq=?').run(JSON.stringify(raw),Number(event.seq));}
      if(change==='native-scope')db.prepare('UPDATE runtime_events SET context_id=? WHERE seq=?').run('main',Number(event.seq));
      if(change==='proof'){const value=JSON.parse(String(proof.body));value.nativeHash='0'.repeat(64);db.prepare('UPDATE runtime_settings SET body=? WHERE id=?').run(JSON.stringify(value),key);}
      if(change==='source-body'){const source=db.prepare('SELECT body FROM signals WHERE id=?').get(task.signalId)!;const value=JSON.parse(String(source.body));value.content='ALTERED_ACCEPTED_SOURCE';db.prepare('UPDATE signals SET body=? WHERE id=?').run(JSON.stringify(value),task.signalId);}
    }finally{db.close();}
    const second=await launch(directory);children.push(second.child);assert.equal((await second.request('/health')).status,200);assert.equal((await second.request(`/contexts/${task.contextId}/tree`)).status,200);
    const inspect=new DatabaseSync(path.join(directory,'records.sqlite'),{readOnly:true});try{
      assert.equal(Number(inspect.prepare("SELECT count(*) AS n FROM session_graph_entries WHERE context_id=? AND json_extract(source,'$.runId')=?").get(task.contextId,String(started!.runId))!.n),0,'unverified event material cannot advance the selected graph');
      assert.equal(String(inspect.prepare('SELECT status FROM runs WHERE id=?').get(String(started!.runId))!.status),'interrupted');
    }finally{inspect.close();}
    assert.equal(fs.readFileSync(path.join(directory,'workspace','executions'),'utf8'),'start\n','the original command is never replayed');
  }finally{for(const child of children)await stop(child);await removeTemp(directory);}
});
