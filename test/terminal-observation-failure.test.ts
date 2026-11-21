import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {RuntimeStore} from '../src/runtime-store.js';
import {ProcessOutputArchive,writeProcessObservation} from '../src/tools/process-output.js';
import {TerminalSandbox} from '../src/tools/terminal-process.js';
import {terminalFrames,sendTerminalFrame,terminalProof,matchesTerminalProof} from '../src/tools/terminal-transport.js';

for(const fault of ['state','stdout'])test(`an authenticated worker exit with unreadable ${fault} settles its waiter without inventing business success`,{timeout:10000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-terminal-observation-failure-')),db=new DatabaseSync(':memory:'),store=new RuntimeStore(db),stat=fs.statSync(directory),archive=new ProcessOutputArchive(store,directory,()=>({contextId:'work.synthetic',taskId:null,runId:null,attempt:1,root:{id:'synthetic',path:directory,dev:stat.dev,ino:stat.ino},returnContextId:'main'}),'synthetic-key'),binding=archive.create({command:'must never be launched',cwd:directory,interactive:false,pty:false,notify:false,retainOnDisconnect:true}),connection=archive.connection(binding.id),sockets=new Set<net.Socket>();writeProcessObservation(archive.path(binding.id),{status:'running',stdoutBytes:0,stderrBytes:0});
  const sandbox=new TerminalSandbox({archive,workingDirectory:directory,executeAllowed:()=>false,check(){},observed(){}}),server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let hostNonce='';const nonce='b'.repeat(64);terminalFrames(socket,message=>{if(message.type==='hello'&&typeof message.nonce==='string'){hostNonce=message.nonce;sendTerminalFrame(socket,{type:'challenge',nonce,proof:terminalProof(connection.secret,'worker',hostNonce,nonce)});}else if(message.type==='authenticate'){assert.equal(matchesTerminalProof(message.proof,terminalProof(connection.secret,'host',hostNonce,nonce)),true);sendTerminalFrame(socket,{type:'attached'});sendTerminalFrame(socket,{type:'ready'});if(fault==='state')fs.writeFileSync(path.join(archive.path(binding.id),'state.json'),'invalid observation: private fragment');else{const body=Buffer.from('lost completed stdout');fs.writeFileSync(path.join(archive.path(binding.id),'stdout'),body);writeProcessObservation(archive.path(binding.id),{status:'completed',exitCode:0,stdoutBytes:body.length,stderrBytes:0,stdoutSha256:createHash('sha256').update(body).digest('hex'),stderrSha256:createHash('sha256').update('').digest('hex')});fs.unlinkSync(path.join(archive.path(binding.id),'stdout'));}sendTerminalFrame(socket,{type:'exit'});}});});
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();fs.rmSync(directory,{recursive:true,force:true});});server.listen(connection.endpoint);await once(server,'listening');const handle=await sandbox.processes.get(binding.id);assert.ok(handle);let timer:ReturnType<typeof setTimeout>|undefined;try{await assert.rejects(Promise.race([handle.wait(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('waiter_did_not_settle')),1000);})]),fault==='state'?/process_worker_lost|process_state_invalid/:/process_output_unavailable/);}finally{clearTimeout(timer);}assert.equal(handle.exitCode,fault==='state'?undefined:0);if(fault==='state')await assert.rejects(sandbox.destroy(),/terminal_cleanup_incomplete/);else await sandbox.destroy();
});
