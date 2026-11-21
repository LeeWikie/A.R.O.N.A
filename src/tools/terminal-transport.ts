import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {Socket} from 'node:net';
import {AppError} from '../domain.js';

export function terminalEndpoint(directory:string,id:string):string {
  const scope=createHash('sha256').update(directory).digest('hex').slice(0,20);
  if(process.platform==='win32')return `\\\\.\\pipe\\arona-terminal-${scope}-${id.slice('process.'.length)}`;
  const root=path.join(fs.realpathSync('/tmp'),`arona-terminal-${scope}`);
  fs.mkdirSync(root,{mode:0o700,recursive:true});
  const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw new AppError('process_transport_redirected',409);
  return path.join(root,id.slice('process.'.length)+'.sock');
}

export function sendTerminalFrame(socket:Socket,value:unknown):void { if(!socket.destroyed)socket.write(JSON.stringify(value)+'\n'); }
export function terminalProof(secret:string,side:'host'|'worker',hostNonce:string,workerNonce:string):string{return createHmac('sha256',secret).update(JSON.stringify([side,hostNonce,workerNonce])).digest('hex');}
export function matchesTerminalProof(actual:unknown,expected:string):boolean{if(typeof actual!=='string'||!/^[a-f0-9]{64}$/.test(actual))return false;return timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
export function terminalFrames(socket:Socket,receive:(value:Record<string,unknown>)=>void):void {
  let pending='';socket.setEncoding('utf8');
  socket.on('data',chunk=>{
    pending+=chunk;
    if(Buffer.byteLength(pending)>512*1024){socket.destroy();return;}
    for(;;){const index=pending.indexOf('\n');if(index<0)break;const line=pending.slice(0,index);pending=pending.slice(index+1);
      try{const value:unknown=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_frame');receive(value as Record<string,unknown>);}catch{socket.destroy();return;}
    }
  });
}
