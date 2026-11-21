import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {until,removeTemp} from './helpers.js';

for(const mode of ['foreground-pipe','background-pipe','background-pty'])test(`host SIGKILL ${mode.startsWith('foreground')?'interrupts foreground':'retains and reattaches background'} ${mode} with its exact cold output`,{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-crash-'));
  const child=fork(fileURLToPath(new URL('./terminal-process-crash-fixture.ts',import.meta.url)),[directory,mode],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  let output='',ready:{id:string}|undefined;
  child.stdout?.on('data',value=>output+=String(value));child.stderr?.on('data',value=>output+=String(value));
  child.on('message',value=>{if(value&&typeof value==='object'&&'type'in value&&value.type==='ready'&&'id'in value&&typeof value.id==='string')ready={id:value.id};});
  let capabilities:Capabilities|undefined,db:DatabaseSync|undefined;
  try{
    await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(`fixture_ended:${output}`);return ready;},Boolean);
    const stateFile=path.join(directory,'process-output',ready!.id,'state.json');
    await until(()=>JSON.parse(fs.readFileSync(stateFile,'utf8')) as {stdoutBytes:number},state=>state.stdoutBytes>20);
    const ended=once(child,'exit');child.kill('SIGKILL');await ended;
    const foreground=mode.startsWith('foreground');
    if(foreground)await until(()=>JSON.parse(fs.readFileSync(stateFile,'utf8')) as {status:string},state=>state.status==='interrupted');
    const root=path.join(directory,'workspace'),heartbeat=path.join(root,'heartbeat'),size=fs.statSync(heartbeat).size;
    await new Promise(resolve=>setTimeout(resolve,150));assert.equal(fs.statSync(heartbeat).size>size,!foreground,'background keeps its original process; foreground stops');
    db=new DatabaseSync(path.join(directory,'records.sqlite'));const runtime=new RuntimeStore(db);capabilities=new Capabilities(runtime,directory,()=>undefined,'synthetic-terminal-fixture-salt');
    const record=runtime.context('synthetic.worker')!,workspace=capabilities.workspace(record,()=>({write:false,execute:false,mcp:false}));
    const tool=capabilities.terminalTools().terminal_process!;
    const read=()=>tool.execute!({action:'log',id:ready!.id},{workspace}) as Promise<{status:string;content:string;reason?:string}>;
    if(!foreground){assert.equal((await read()).status,'running');const submitted=await tool.execute!({action:'submit',id:ready!.id,data:'finish'},{workspace}) as {status:string};assert.equal(submitted.status,'input-delivered');await until(read,row=>row.status==='completed');}
    const first=await read();assert.equal(first.status,foreground?'interrupted':'completed');assert.equal(first.reason,foreground?'disconnect':undefined);assert.match(first.content,/BEFORE_CRASH/);assert.deepEqual(await read(),first);assert.equal(fs.readFileSync(path.join(root,'executions'),'utf8'),'start\n','recovery does not replay the command');
    capabilities.reconcileTerminalProcesses();capabilities.reconcileTerminalProcesses();
    assert.equal(runtime.events(undefined,0,100).filter(row=>row.kind==='terminal_process_exit').length,1);
    assert.equal(runtime.pendingNotifications().filter(row=>row.id===`terminal:${ready!.id}`).length,foreground?0:1);
    await assert.rejects(()=>tool.execute!({action:'write',id:ready!.id,data:'do not restart'},{workspace}) as Promise<unknown>,/process_not_live/);
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}
    await capabilities?.close();db?.close();await removeTemp(directory);
  }
});

for(const mode of ['worker-loss-pipe','worker-loss-pty'])test(`the native supervisor stops its original ${mode} process when the process worker itself is killed`,{timeout:20000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-owner-loss-'));
  const child=fork(fileURLToPath(new URL('./terminal-process-crash-fixture.ts',import.meta.url)),[directory,mode],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  const messages:Array<Record<string,unknown>>=[];let output='';child.stdout?.on('data',data=>output+=String(data));child.stderr?.on('data',data=>output+=String(data));child.on('message',value=>{if(value&&typeof value==='object')messages.push(value as Record<string,unknown>);});
  try{
    const ready=await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(output);return messages.find(row=>row.type==='ready');},Boolean);
    const heartbeat=path.join(directory,'workspace','heartbeat');await until(()=>fs.existsSync(heartbeat),Boolean);
    child.send({type:'kill-worker'});await until(()=>messages.some(row=>row.type==='worker-killed'),Boolean);
    const stateFile=path.join(directory,'process-output',String(ready!.id),'state.json');
    const state=await until(()=>JSON.parse(fs.readFileSync(stateFile,'utf8')) as {status:string;reason?:string;exitCode?:number;stdoutSha256?:string},row=>row.status==='unknown',8000);
    assert.equal(state.reason,'worker-lost');assert.equal(state.exitCode,undefined,'losing the waiter does not invent a collected exit code');assert.match(state.stdoutSha256!,/^[a-f0-9]{64}$/);
    const bytes=fs.statSync(heartbeat).size;await new Promise(resolve=>setTimeout(resolve,150));assert.equal(fs.statSync(heartbeat).size,bytes,'the original native child stopped making file side effects');
    assert.equal(fs.readFileSync(path.join(directory,'workspace','executions'),'utf8'),'start\n');
    const db=new DatabaseSync(path.join(directory,'records.sqlite'));const runtime=new RuntimeStore(db),capabilities=new Capabilities(runtime,directory,()=>undefined,'synthetic-terminal-fixture-salt');
    try{const result=capabilities.readTerminalProcess('synthetic.worker',String(ready!.id));assert.equal(result.status,'unknown');assert.match(Buffer.from(result.content,'utf8').toString(),/BEFORE_CRASH/);}
    finally{await capabilities.close();db.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await removeTemp(directory);}
});
