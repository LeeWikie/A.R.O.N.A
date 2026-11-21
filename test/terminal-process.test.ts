import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createWorkspaceTools} from '@mastra/core/workspace';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {TerminalSandbox} from '../src/tools/terminal-process.js';
import {terminalProcessSchema} from '../src/tools/process-tools.js';
import {writeProcessObservation} from '../src/tools/process-output.js';
import {sendTerminalFrame,terminalFrames} from '../src/tools/terminal-transport.js';
import {until,removeTemp} from './helpers.js';

const quote=(value:string)=>process.platform==='win32'?`"${value.replaceAll('"','\\"')}"`:`'${value.replaceAll("'","'\\''")}'`;
const command=(code:string)=>`${quote(process.execPath)} -e ${quote(code)}`;
async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-')),db=new DatabaseSync(':memory:'),runtime=new RuntimeStore(db),salt=randomUUID(),capabilities=new Capabilities(runtime,directory,undefined,salt);
  const record=runtime.createContext({id:'synthetic.worker',name:'Synthetic worker',role:'work'}),workspace=capabilities.workspace(record,()=>({write:true,execute:true,mcp:false}));
  const tools=await createWorkspaceTools(workspace),processTool=capabilities.terminalTools().terminal_process!;assert.ok(workspace.sandbox instanceof TerminalSandbox);
  t.after(async()=>{await capabilities.close();db.close();await removeTemp(directory);});
  const invoke=async(input:unknown)=>{const parsed=terminalProcessSchema.parse(input);return processTool.execute!(parsed,{workspace}) as Promise<Record<string,unknown>>;};
  return {directory,db,runtime,capabilities,record,workspace,sandbox:workspace.sandbox,tools,invoke,salt};
}

test('ordinary native commands automatically retain complete output with repeatable line and byte reads',async t=>{
  const f=await fixture(t);const result=String(await f.tools.mastra_workspace_execute_command.execute({command:command("for(let i=0;i<30000;i++)console.log('row_'+i+':'+'x'.repeat(80))"),description:'Generate synthetic long output',tail:0},{}));
  const id=/Full output: (process\.[0-9a-f-]+)/.exec(result)?.[1];assert.ok(id,'truncated native result carries a retrievable source reference');
  for(const offset of [1,15001,30000]){const first=await f.invoke({action:'log',id,offset,limit:1}),again=await f.invoke({action:'log',id,offset,limit:1});assert.equal(first.content,`row_${offset-1}:${'x'.repeat(80)}\n`);assert.deepEqual(again,first);}
  const bytes=await f.invoke({action:'log',id,encoding:'base64',byteOffset:0,maxBytes:100});assert.equal(Buffer.from(String(bytes.content),'base64').subarray(0,6).toString(),'row_0:');
  assert.equal(f.runtime.events(undefined,0,100).filter(row=>row.kind==='terminal_process_exit').length,1);
});

test('large stderr results expose the same complete archive as stdout',async t=>{
  const f=await fixture(t),result=String(await f.tools.mastra_workspace_execute_command.execute({command:command("for(let i=0;i<20000;i++)console.error('error_'+i+':'+'z'.repeat(80));process.exitCode=7;"),description:'Generate synthetic stderr output',tail:0},{}));
  const id=/Full output: (process\.[0-9a-f-]+)/.exec(result)?.[1];assert.ok(id);
  for(const offset of [1,10001,20000]){const page=await f.invoke({action:'log',id,stream:'stderr',offset,limit:1});assert.equal(page.content,`error_${offset-1}:${'z'.repeat(80)}\n`);assert.equal(page.exitCode,7);assert.equal(page.status,'failed');}
});

test('raw non-UTF8 stdout and stderr retain their actual bytes, hashes and repeatable cold binary pages',async t=>{
  const f=await fixture(t),started=await f.invoke({action:'start',description:'Write synthetic binary stdout and stderr',command:command("process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i)));process.stderr.write(Buffer.from([0,255,254,128,10]));")}),id=String(started.id);
  await until(()=>f.sandbox.archive.observation(id),state=>state.status==='completed');
  for(const [stream,expected] of [['stdout',Buffer.from(Array.from({length:256},(_,i)=>i))],['stderr',Buffer.from([0,255,254,128,10])]] as const){
    const textRequest=await f.invoke({action:'log',id,stream});assert.equal(textRequest.encoding,'base64');assert.equal(textRequest.textUnavailable,'not-utf8');assert.deepEqual(Buffer.from(String(textRequest.content),'base64'),expected);
    for(const byteOffset of [0,3,expected.length-2]){const page=await f.invoke({action:'log',id,stream,encoding:'base64',byteOffset,maxBytes:2});assert.deepEqual(Buffer.from(String(page.content),'base64'),expected.subarray(byteOffset,byteOffset+2));}
    assert.equal(textRequest[`${stream}Sha256`],createHash('sha256').update(expected).digest('hex'));
  }
  const archivedFile=path.join(f.sandbox.archive.path(id),'stdout'),original=fs.readFileSync(archivedFile),altered=Buffer.from(original);altered[0]=1;fs.writeFileSync(archivedFile,altered);await assert.rejects(()=>f.invoke({action:'log',id}),/process_output_changed/);fs.writeFileSync(archivedFile,original);
  assert.match(String((await f.sandbox.processes.get(id))?.stdout),/Full output: process\..*encoding=base64/);
  await f.capabilities.close();const reopened=new Capabilities(f.runtime,f.directory,undefined,f.salt),workspace=reopened.workspace(f.record,()=>({write:false,execute:false,mcp:false}));
  try{assert.ok(workspace.sandbox instanceof TerminalSandbox);const page=workspace.sandbox.archive.read(id,{encoding:'base64'});assert.deepEqual(Buffer.from(page.content,'base64'),Buffer.from(Array.from({length:256},(_,i)=>i)));}
  finally{await reopened.close();}
});

test('a running partial UTF8 character stays pending and the completed text and bytes contain no replacement characters',async t=>{
  const f=await fixture(t),expected=Buffer.from('甲🙂乙\n'),started=await f.invoke({action:'start',description:'Split a synthetic Unicode character across process writes',interactive:true,command:command("const b=Buffer.from('甲🙂乙\\n');process.stdout.write(b.subarray(0,1));process.stdin.once('data',()=>{process.stdout.write(b.subarray(1));process.exit(0);});")}),id=String(started.id);
  await until(()=>f.sandbox.archive.observation(id),state=>state.stdoutBytes===1);const pending=await f.invoke({action:'log',id});assert.equal(pending.encoding,'text');assert.equal(pending.content,'');assert.equal(pending.status,'running');
  await f.invoke({action:'submit',id,data:'finish'});const completed=await until(()=>f.invoke({action:'log',id}),row=>row.status==='completed');assert.equal(completed.content,expected.toString());assert.equal(completed.stdoutEncoding,'utf8');assert.doesNotMatch(String(completed.content),/�/);
  const bytes=await f.invoke({action:'log',id,encoding:'base64'});assert.deepEqual(Buffer.from(String(bytes.content),'base64'),expected);
});

test('native completed process output remains readable across multiple native tool calls',async t=>{
  const f=await fixture(t),started=String(await f.tools.mastra_workspace_execute_command.execute({command:command("console.log('COMPLETE');"),description:'Run a synthetic background command',background:true},{}));
  const pid=/PID: (process\.[0-9a-f-]+)/.exec(started)?.[1];assert.ok(pid);await until(()=>f.sandbox.archive.observation(pid),state=>state.status==='completed');
  const first=await f.tools.mastra_workspace_get_process_output.execute({pid},{}),second=await f.tools.mastra_workspace_get_process_output.execute({pid},{});assert.equal(first,second);assert.match(String(first),/COMPLETE/);
});

test('explicitly persisted processes survive normal release and caller abort, then reattach without being relaunched',async t=>{
  const f=await fixture(t),controller=new AbortController(),tool=f.capabilities.terminalTools().terminal_process!;
  const started=await tool.execute!({action:'start',command:command("const fs=require('fs');fs.appendFileSync('persistent-executions','start\\n');console.log('PERSIST_READY');process.stdin.on('data',d=>{if(String(d).includes('finish'))process.exit(0);});"),description:'Persist a synthetic background process',interactive:true,persistOnRelease:true},{workspace:f.workspace,abortSignal:controller.signal}) as {id:string};
  await until(()=>f.invoke({action:'poll',id:started.id}),row=>String(row.content).includes('PERSIST_READY'));controller.abort();await f.capabilities.close();
  const reopened=new Capabilities(f.runtime,f.directory,undefined,f.salt),workspace=reopened.workspace(f.record,()=>({write:false,execute:true,mcp:false})),resumed=reopened.terminalTools().terminal_process!;
  try{const before=await resumed.execute!({action:'log',id:started.id},{workspace}) as {status:string};assert.equal(before.status,'running');await resumed.execute!({action:'submit',id:started.id,data:'finish'},{workspace});await until(()=>resumed.execute!({action:'log',id:started.id},{workspace}) as Promise<{status:string}>,row=>row.status==='completed');assert.equal(fs.readFileSync(path.join(f.directory,'workspace','persistent-executions'),'utf8'),'start\n');}
  finally{await reopened.close();}
});

test('completed output and state reject altered bytes and extra filesystem links',async t=>{
  const f=await fixture(t),started=await f.invoke({action:'start',command:command("console.log('SEALED_OUTPUT')"),description:'Write a synthetic sealed result'}),id=String(started.id);
  await until(()=>f.invoke({action:'log',id}),row=>row.status==='completed');const directory=f.sandbox.archive.path(id),output=path.join(directory,'stdout'),original=fs.readFileSync(output);
  fs.writeFileSync(output,Buffer.from(original).fill(88));await assert.rejects(()=>f.invoke({action:'log',id}),/process_output_changed/);fs.writeFileSync(output,original);
  const duplicate=path.join(directory,'stdout-extra-link');fs.linkSync(output,duplicate);await assert.rejects(()=>f.invoke({action:'log',id}),/process_output_changed/);fs.unlinkSync(duplicate);
  const state=path.join(directory,'state.json'),stateLink=path.join(directory,'state-extra-link');fs.linkSync(state,stateLink);await assert.rejects(()=>f.invoke({action:'poll',id}),/process_state_invalid/);fs.unlinkSync(stateLink);
  assert.match(String((await f.invoke({action:'log',id})).content),/SEALED_OUTPUT/);
});

test('exit observation and notification commit together and reconciliation repairs an earlier event-only observation',async t=>{
  const f=await fixture(t);
  const create=()=>{const binding=f.sandbox.archive.create({command:'synthetic completed command',cwd:f.capabilities.root('default').path,interactive:false,pty:false,notify:true});writeProcessObservation(f.sandbox.archive.path(binding.id),{status:'completed',exitCode:0,stdoutBytes:0,stderrBytes:0,finishedAt:new Date().toISOString()});return binding;};
  const binding=create(),notify=f.runtime.notify.bind(f.runtime);
  f.runtime.notify=()=>{throw Error('synthetic notification storage failure');};
  assert.throws(()=>f.capabilities.reconcileTerminalProcesses(),/synthetic notification storage failure/);
  assert.equal(f.runtime.events(undefined,0,100).filter(row=>row.kind==='terminal_process_exit').length,0);
  assert.equal(f.runtime.pendingNotifications().length,0);
  assert.equal(f.db.prepare('SELECT 1 FROM runtime_operations WHERE id=?').get(`terminal-observed:${binding.id}`),undefined);
  f.runtime.notify=notify;f.capabilities.reconcileTerminalProcesses();f.capabilities.reconcileTerminalProcesses();
  assert.equal(f.runtime.events(undefined,0,100).filter(row=>row.kind==='terminal_process_exit').length,1);
  assert.equal(f.runtime.pendingNotifications().filter(row=>row.id===`terminal:${binding.id}`).length,1);
  const legacy=create();f.runtime.event({contextId:legacy.contextId,kind:'terminal_process_exit',data:{id:legacy.id,status:'completed',exitCode:0},key:`terminal-exit:${legacy.id}`});
  assert.equal(f.runtime.pendingNotifications().filter(row=>row.id===`terminal:${legacy.id}`).length,0);
  f.capabilities.reconcileTerminalProcesses();f.capabilities.reconcileTerminalProcesses();
  assert.equal(f.runtime.pendingNotifications().filter(row=>row.id===`terminal:${legacy.id}`).length,1);
  assert.equal(f.runtime.events(undefined,0,100).filter(row=>row.kind==='terminal_process_exit').length,2);
});

test('an unauthenticated client cannot replace the live controller, inject stdin or kill the original process',async t=>{
  const f=await fixture(t),started=await f.invoke({action:'start',command:command("console.log('AUTH_READY');let input='';process.stdin.on('data',d=>{input+=d;if(input.includes('finish')){console.log('AUTHORIZED_FINISH');process.exit(0);}});"),description:'Keep a synthetic authenticated process alive',interactive:true});
  const id=String(started.id),connection=f.sandbox.archive.connection(id),socket=net.createConnection(connection.endpoint);socket.on('error',()=>{});
  await once(socket,'connect');const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));
  terminalFrames(socket,message=>{if(message.type==='challenge'){sendTerminalFrame(socket,{type:'authenticate',proof:'0'.repeat(64)});sendTerminalFrame(socket,{type:'input',requestId:'forged',action:'kill'});}});
  sendTerminalFrame(socket,{type:'hello',nonce:'a'.repeat(64)});await closed;
  assert.equal((await f.invoke({action:'poll',id})).status,'running');
  await f.invoke({action:'submit',id,data:'finish'});const ended=await until(()=>f.invoke({action:'log',id}),row=>row.status==='completed');assert.match(String(ended.content),/AUTHORIZED_FINISH/);
});

test('a substituted process endpoint cannot authenticate a new host or cause command replay',async t=>{
  const f=await fixture(t),binding=f.sandbox.archive.create({command:command("require('fs').writeFileSync('replayed','wrong')"),cwd:f.capabilities.root('default').path,interactive:true,pty:false,notify:false,retainOnDisconnect:true});
  writeProcessObservation(f.sandbox.archive.path(binding.id),{status:'running',stdoutBytes:0,stderrBytes:0});const connection=f.sandbox.archive.connection(binding.id),received:Array<Record<string,unknown>>=[];
  const server=net.createServer(socket=>{socket.on('error',()=>{});terminalFrames(socket,message=>{received.push(message);if(message.type==='hello')sendTerminalFrame(socket,{type:'challenge',nonce:'b'.repeat(64),proof:'0'.repeat(64)});});});
  server.listen(connection.endpoint);await once(server,'listening');
  try{await assert.rejects(()=>f.sandbox.processes.get(binding.id),/process_worker_lost/);assert.deepEqual(received.map(row=>row.type),['hello']);assert.equal(JSON.stringify(received).includes(connection.secret),false);assert.equal(fs.existsSync(path.join(f.directory,'workspace','replayed')),false);}
  finally{server.close();}
});

for(const pty of [false,true])test(`interactive ${pty?'PTY':'pipe'} input, Enter and EOF use the original process`,{timeout:15000},async t=>{
  const f=await fixture(t),windowsPty=pty&&process.platform==='win32';const code="console.log('READY');let data='';process.stdin.on('data',d=>{data+=d;"+(windowsPty?"if(data.includes('finish-marker')){console.log('ANSWER:'+data);console.log('INPUT_BYTES:'+Buffer.from(data).toString('base64'));process.exit(0);}":'')+"});process.stdin.on('end',()=>console.log('ANSWER:'+data));";
  const started=await f.invoke({action:'start',command:command(code),description:'Read synthetic input',interactive:true,pty});const id=String(started.id);
  await until(()=>f.invoke({action:'poll',id}),row=>String(row.content).includes('READY'));
  await f.invoke({action:'write',id,data:'violet-'});await f.invoke({action:'submit',id,data:'17'});
  if(pty)await f.invoke({action:'resize',id,cols:91,rows:27});
  if(windowsPty){assert.deepEqual(started.input,{kind:'pty',eof:'unsupported'});await assert.rejects(()=>f.invoke({action:'close',id}),/process_pty_eof_unsupported/);assert.equal((await f.invoke({action:'poll',id})).status,'running');await f.invoke({action:'submit',id,data:'finish-marker'});}
  else await f.invoke({action:'close',id});
  const ended=await until(()=>f.invoke({action:'log',id}),row=>row.status==='completed');assert.match(String(ended.content),/ANSWER:violet-17/);assert.equal(ended.exitCode,0);
  if(windowsPty){const bytes=Buffer.from(/INPUT_BYTES:([A-Za-z0-9+/=]+)/.exec(String(ended.content))![1]!,'base64');assert.equal(bytes.includes(4),false);assert.equal(bytes.includes(26),false);assert.match(bytes.toString(),/violet-17\r?\nfinish-marker/);}
});

test('process exit, timeout, cancellation and readonly lookup preserve distinct results',async t=>{
  const f=await fixture(t);const failed=await f.invoke({action:'start',description:'Exit with a synthetic failure',command:command('process.exit(7)')});
  const failure=await until(()=>f.invoke({action:'log',id:failed.id}),row=>row.status==='failed');assert.equal(failure.exitCode,7);
  const timeout=await f.invoke({action:'start',description:'Wait for a bounded timeout',command:command('setTimeout(()=>{},10000)'),timeout:0.2});
  const timed=await until(()=>f.invoke({action:'log',id:timeout.id}),row=>row.status==='timed_out');assert.equal(timed.exitCode,124);
  const cancelled=await f.invoke({action:'start',description:'Start a cancellable process',command:command('setTimeout(()=>{},10000)')});await f.invoke({action:'kill',id:cancelled.id});
  assert.equal((await f.invoke({action:'log',id:cancelled.id})).status,'cancelled');
  for(const action of ['list','poll','log','wait'])assert.equal(f.capabilities.approvalCapability(f.record,'terminal_process',action==='list'?{action}:{action,id:cancelled.id}),'read');
  for(const action of ['write','submit','close','resize','kill','start']){const input=action==='start'?{action,command:'x',description:'x'}:action==='resize'?{action,id:cancelled.id,cols:80,rows:24}:['write','submit'].includes(action)?{action,id:cancelled.id,data:''}:{action,id:cancelled.id};assert.equal(f.capabilities.approvalCapability(f.record,'terminal_process',input),'execute');}
  assert.equal(f.capabilities.approvalCapability(f.record,'terminal_process',{action:'unknown',id:cancelled.id}),null);
});

test('process references cannot cross contexts or survive a replaced workspace as control authority',async t=>{
  const f=await fixture(t),started=await f.invoke({action:'start',description:'Read a scoped synthetic result',command:command("console.log('OWNED')")});
  await until(()=>f.invoke({action:'log',id:started.id}),row=>row.status==='completed');
  const other=f.runtime.createContext({id:'synthetic.other',name:'Other worker',role:'work'}),workspace=f.capabilities.workspace(other,()=>({write:true,execute:true,mcp:false}));
  await assert.rejects(f.capabilities.terminalTools().terminal_process!.execute!(terminalProcessSchema.parse({action:'log',id:started.id}),{workspace}),/process_not_authorized/);
  const replacement=path.join(f.directory,'replacement');fs.mkdirSync(replacement);await f.capabilities.updateRoot('default',{expectedPath:f.capabilities.root('default').path,path:replacement},async()=>{});
  await assert.rejects(f.invoke({action:'log',id:started.id}),/workspace_changed/);
});
