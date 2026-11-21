import fs from 'node:fs';
import path from 'node:path';
import net,{type Socket} from 'node:net';
import {setTimeout,clearTimeout} from 'node:timers';
import {createHash,randomBytes} from 'node:crypto';
import {LocalSandbox,type ProcessHandle,type CommandResult} from '@mastra/core/workspace';
import {PROCESS_OUTPUT_LIMIT,writeProcessObservation,type ProcessObservation} from './process-output.js';
import {sendTerminalFrame,terminalFrames,terminalProof,matchesTerminalProof} from './terminal-transport.js';
import {TerminalSupervisor} from './terminal-supervisor.js';

interface Start {type:'start';directory:string;command:string;cwd:string;timeout?:number;interactive:boolean;pty:boolean;cols:number;rows:number;endpoint:string;secret:string;retainOnDisconnect:boolean}
let handle:ProcessHandle|undefined,pty:import('@lydell/node-pty').IPty|undefined,local:LocalSandbox|undefined,start:Start|undefined,settled=false,reason:string|undefined,started=false,ready=false,controller:Socket|undefined,supervisor:TerminalSupervisor|undefined,group:number|undefined;
let observation:ProcessObservation={status:'starting',stdoutBytes:0,stderrBytes:0};
const hashes={stdout:createHash('sha256'),stderr:createHash('sha256')};
const validation={stdout:new TextDecoder('utf8',{fatal:true}),stderr:new TextDecoder('utf8',{fatal:true})},ptyDecoder=new TextDecoder('utf8');
const server=net.createServer();const sockets=new Set<Socket>();
let inputs=Promise.resolve();
let phase='starting';
let registeredGroup=false;
let ptyExit:Promise<{exitCode:number}>|undefined,ptyExitResult:{exitCode:number}|undefined;
function observedPtyExit():{exitCode:number}|undefined{return ptyExitResult;}
function send(value:unknown){if(controller)sendTerminalFrame(controller,value);}
function rawOutput(stream:'stdout'|'stderr',bytes:Uint8Array){
  if(settled||!start||reason==='output-limit')return;
  if(observation[`${stream}Bytes`]+bytes.length>PROCESS_OUTPUT_LIMIT){reason='output-limit';void kill();return;}
  if(observation[`${stream}Encoding`]!=='binary')try{validation[stream].decode(bytes,{stream:true});}catch{observation[`${stream}Encoding`]='binary';}
  fs.appendFileSync(path.join(start.directory,stream),bytes);hashes[stream].update(bytes);observation[`${stream}Bytes`]+=bytes.length;writeProcessObservation(start.directory,observation);
}
function textOutput(stream:'stdout'|'stderr',text:string){if(!settled&&reason!=='output-limit'&&text)send({type:'output',stream,text});}
async function finish(result:{exitCode?:number;success:boolean;timedOut?:boolean;killed?:boolean;unknown?:boolean}){
  if(settled||!start)return;
  if(pty)textOutput('stdout',ptyDecoder.decode());
  for(const stream of ['stdout','stderr'] as const)if(observation[`${stream}Encoding`]!=='binary')try{validation[stream].decode();observation[`${stream}Encoding`]='utf8';}catch{observation[`${stream}Encoding`]='binary';}
  settled=true;
  observation={...observation,status:result.unknown?'unknown':['disconnect','supervisor-lost','transport-failed'].includes(reason??'')?'interrupted':reason==='output-limit'||reason==='spawn-failed'?'failed':result.timedOut?'timed_out':reason?'cancelled':result.success?'completed':'failed',...(result.exitCode!==undefined?{exitCode:result.exitCode}:{}),finishedAt:new Date().toISOString(),stdoutSha256:hashes.stdout.digest('hex'),stderrSha256:hashes.stderr.digest('hex'),...(reason?{reason}:{})};
  writeProcessObservation(start.directory,observation);await inputs;send({type:'exit'});
  // The original waiter has supplied this observation. Releasing its tracking entry prevents
  // sandbox teardown from starting a second, PID-based termination after the waiter settled.
  if(handle)local?.processes.release(handle.pid);
  await local?.destroy();await supervisor?.close(group);for(const socket of sockets)socket.end();server.close();if(process.connected)process.disconnect();
}
async function kill(){
  if(process.platform==='win32'&&registeredGroup&&supervisor){await supervisor.terminate();return;}
  if(pty){try{if(process.platform!=='win32')process.kill(-pty.pid,'SIGKILL');else pty.kill();}catch{try{pty.kill();}catch{}}return;}
  if(process.platform==='win32'&&handle){if(!handle.killOwnedProcess)throw Error('process_owned_termination_unavailable');await handle.killOwnedProcess();return;}
  await handle?.kill();
}
async function execute(){
  if(started||!start)return;started=true;const input=start;
  observation={...observation,status:'running',startedAt:new Date().toISOString()};writeProcessObservation(input.directory,observation);
  phase='supervisor-open';supervisor=await TerminalSupervisor.open(input.directory,()=>{if(!settled){reason='supervisor-lost';void kill();}});
  if(!controller&&!input.retainOnDisconnect){reason='disconnect';await finish({exitCode:128,success:false,killed:true});return;}
  const env=Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string'&&!['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE'].includes(row[0])));
  if(input.pty){
    const {spawn}=await import('@lydell/node-pty');const windows=process.platform==='win32';
    const shell=windows?path.join(process.env.SystemRoot??'C:\\Windows','System32','cmd.exe'):'/bin/sh';
    phase='pty-spawn';pty=spawn(shell,windows?`/d /s /c "${input.command}"`:['-c',input.command],{cwd:input.cwd,env,name:'xterm-256color',encoding:null,cols:input.cols,rows:input.rows,...(windows?{useConptyDll:true}:{})});
    pty.onData((value:unknown)=>{const bytes=typeof value==='string'?Buffer.from(value):value instanceof Uint8Array?value:undefined;if(!bytes)throw Error('process_pty_output_invalid');rawOutput('stdout',bytes);textOutput('stdout',ptyDecoder.decode(bytes,{stream:true}));});let timeout:ReturnType<typeof setTimeout>|undefined;
    ptyExit=new Promise(resolve=>pty!.onExit(event=>{ptyExitResult=event;resolve(event);}));
    phase='pty-connecting';const connectedAt=performance.now();while(pty.pid<=1&&!ptyExitResult){if(performance.now()-connectedAt>10000)throw Error('process_pty_connection_timeout');await new Promise(resolve=>setTimeout(resolve,10));}
    if(ptyExitResult){await finish({exitCode:ptyExitResult.exitCode,success:ptyExitResult.exitCode===0});return;}
    phase='pty-register';group=pty.pid;
    try{await supervisor?.register(group);registeredGroup=true;}catch(error){const exited=observedPtyExit();if(!exited)throw error;await finish({exitCode:exited.exitCode,success:exited.exitCode===0});return;}
    if(input.timeout)timeout=setTimeout(()=>{reason='timeout';void kill();},input.timeout);
    void ptyExit.then(event=>{clearTimeout(timeout);return finish({exitCode:reason==='timeout'?124:event.exitCode,success:event.exitCode===0,timedOut:reason==='timeout',killed:Boolean(reason)});});
    phase='pty-running';ready=true;send({type:'ready'});if(!controller&&!input.retainOnDisconnect){reason='disconnect';await kill();}
  }else{
    local=new LocalSandbox({workingDirectory:input.cwd,env,timeout:0});
    phase='pipe-spawn';handle=await local.processes.spawn(input.command,{timeout:process.platform==='win32'?0:input.timeout,stdinMode:input.interactive?'pipe':'ignore',onStdoutBytes:bytes=>rawOutput('stdout',bytes),onStderrBytes:bytes=>rawOutput('stderr',bytes),onStdout:text=>textOutput('stdout',text),onStderr:text=>textOutput('stderr',text)});
    phase='pipe-register';group=Number(handle.pid);await supervisor?.register(group);registeredGroup=true;phase='pipe-running';
    let timeout:ReturnType<typeof setTimeout>|undefined;
    if(process.platform==='win32'&&input.timeout)timeout=setTimeout(()=>{reason='timeout';void kill();},input.timeout);
    ready=true;send({type:'ready'});if(!controller&&!input.retainOnDisconnect){reason='disconnect';await kill();}
    try{const result:CommandResult=await handle.wait();await finish(reason==='timeout'?{...result,exitCode:124,success:false,timedOut:true}:result);}finally{clearTimeout(timeout);}
  }
}
function disconnected(){if(!settled&&started&&!start?.retainOnDisconnect){reason='disconnect';void kill();}}
server.on('connection',socket=>{
  sockets.add(socket);let authenticated=false,hostNonce:string|undefined;const workerNonce=randomBytes(32).toString('hex'),timeout=setTimeout(()=>socket.destroy(),5000);
  socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timeout);sockets.delete(socket);if(controller===socket){controller=undefined;disconnected();}});
  terminalFrames(socket,message=>{
    if(!authenticated){
      if(!hostNonce){if(message.type!=='hello'||typeof message.nonce!=='string'||!/^[a-f0-9]{64}$/.test(message.nonce)||!start?.secret){socket.destroy();return;}hostNonce=message.nonce;sendTerminalFrame(socket,{type:'challenge',nonce:workerNonce,proof:terminalProof(start.secret,'worker',hostNonce,workerNonce)});return;}
      if(message.type!=='authenticate'||!matchesTerminalProof(message.proof,terminalProof(start!.secret,'host',hostNonce,workerNonce))){socket.destroy();return;}
      authenticated=true;clearTimeout(timeout);const previous=controller;controller=socket;previous?.destroy();
      send({type:'attached'});if(settled){send({type:'exit'});socket.end();}else if(ready)send({type:'ready'});else void execute().catch(async error=>{
        if(start)fs.writeFileSync(path.join(start.directory,'start-failure.json'),JSON.stringify({phase,group,error:error instanceof Error?error.message.slice(0,4096):'process_start_failed'}),{mode:0o600});
        reason='spawn-failed';textOutput('stderr','Process could not be started.\n');
        if(pty||handle){await kill().catch(()=>{});let timer:ReturnType<typeof setTimeout>|undefined;try{const result=await Promise.race([(ptyExit??handle!.wait()).catch(()=>undefined),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),5000);})]);await finish({exitCode:result?.exitCode,success:false,unknown:!result});}finally{clearTimeout(timer);}}
        else await finish({success:false});
      });
      return;
    }
    if(controller!==socket||message.type!=='input'||typeof message.requestId!=='string')return;
    const requestId=message.requestId;
    inputs=inputs.then(async()=>{
      try{
        if(settled||!ready)throw Error('process_already_ended');
        if(message.action==='kill'){reason='cancel';await kill();}
        else if(message.action==='resize'){if(!pty||!Number.isInteger(message.cols)||!Number.isInteger(message.rows))throw Error('process_not_pty');pty.resize(Number(message.cols),Number(message.rows));}
        else if(message.action==='close'){if(pty){if(process.platform==='win32')throw Error('process_pty_eof_unsupported');pty.write('\x04');}else await handle!.closeStdin();}
        else if(message.action==='write'||message.action==='submit'){
          if(typeof message.data!=='string'||message.data.length>65536)throw Error('invalid_input');
          const text=message.data+(message.action==='submit'?(pty?'\r':'\n'):'');if(pty)pty.write(text);else await handle!.sendStdin(text);
        }else throw Error('invalid_action');
        sendTerminalFrame(socket,{type:'reply',requestId,ok:true});
      }catch{sendTerminalFrame(socket,{type:'reply',requestId,ok:false});}
    });
  });
});
server.on('error',()=>{if(!started)process.exitCode=1;else{reason='transport-failed';void kill();}});
process.once('message',message=>{
  if(!message||typeof message!=='object'||!('type'in message)||message.type!=='start')return;
  start=message as Start;server.listen(start.endpoint,()=>{
    if(process.platform!=='win32')fs.chmodSync(start!.endpoint,0o600);
    process.send?.({type:'listening'});
    const timeout=setTimeout(()=>{if(!started){server.close();if(process.connected)process.disconnect();}},10000);timeout.unref();
  });
});
process.on('disconnect',()=>{if(!started){server.close();return;}disconnected();});
