import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {TerminalSandbox} from '../src/tools/terminal-process.js';
import {ChildProcess} from 'node:child_process';

const directory=process.argv[2]!,mode=process.argv[3]!,pty=mode.endsWith('pty'),foreground=mode.startsWith('foreground');
const db=new DatabaseSync(path.join(directory,'records.sqlite')),runtime=new RuntimeStore(db),capabilities=new Capabilities(runtime,directory,()=>undefined,'synthetic-terminal-fixture-salt');
const record=runtime.context('synthetic.worker')??runtime.createContext({id:'synthetic.worker',name:'Synthetic worker',role:'work'});
const workspace=capabilities.workspace(record,()=>({write:true,execute:true,mcp:false}));
if(!(workspace.sandbox instanceof TerminalSandbox))throw Error('terminal_unavailable');
const quote=(value:string)=>process.platform==='win32'?`"${value.replaceAll('"','\\"')}"`:`'${value.replaceAll("'","'\\''")}'`;
const code="const fs=require('fs');fs.appendFileSync('executions','start\\n');console.log('BEFORE_CRASH');let data='';process.stdin.on('data',d=>{data+=d;if(data.includes('finish'))process.exit(0);});"+(mode.startsWith('worker-loss')?"process.on('SIGHUP',()=>{});setTimeout(()=>process.exit(0),5000);setInterval(()=>fs.appendFileSync('heartbeat','x'),25);":"setInterval(()=>{fs.appendFileSync('heartbeat','x');console.log('TICK');},25);");
const command=`${quote(process.execPath)} -e ${quote(code)}`;
let id:string;
if(foreground){
  void workspace.sandbox.executeCommand!(command).catch(()=>{});
  for(;;){const row=workspace.sandbox.archive.list()[0];if(row){id=row.id;break;}await new Promise(resolve=>setTimeout(resolve,10));}
}else id=(await workspace.sandbox.processes.spawn(command,{interactive:true,pty,notify:true})).pid;
process.send?.({type:'ready',id});
process.on('message',message=>{if(message&&typeof message==='object'&&'type'in message&&message.type==='kill-worker')void(async()=>{const current=await workspace.sandbox!.processes!.get(id);if(current&&'child'in current&&current.child instanceof ChildProcess){const exited=new Promise(resolve=>current.child instanceof ChildProcess&&current.child.once('exit',resolve));current.child.kill('SIGKILL');await exited;process.send?.({type:'worker-killed'});}})();});
process.on('SIGTERM',()=>{void capabilities.close().then(()=>{db.close();process.disconnect?.();});});
