import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeProcessObservation,terminalStatus,type ProcessObservation} from './process-output.js';

const watch=process.argv[2]==='--watch-worker',directory=process.argv[watch?3:2];
function observe(){if(directory){
  const before=fs.lstatSync(directory);if(!before.isDirectory()||before.isSymbolicLink())throw Error('process_storage_redirected');
  const stateFile=path.join(directory,'state.json'),stat=fs.lstatSync(stateFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('process_state_invalid');
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8')) as ProcessObservation;
  if(!terminalStatus(state.status)){
    const observed=(stream:'stdout'|'stderr')=>{const fd=fs.openSync(path.join(directory,stream),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw Error('process_output_changed');const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;for(;;){const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;bytes+=count;hash.update(buffer.subarray(0,count));}return {bytes,sha:hash.digest('hex')};}finally{fs.closeSync(fd);}};
    const stdout=observed('stdout'),stderr=observed('stderr');
    writeProcessObservation(directory,{status:'unknown',reason:'worker-lost',startedAt:state.startedAt,finishedAt:new Date().toISOString(),stdoutBytes:stdout.bytes,stderrBytes:stderr.bytes,stdoutSha256:stdout.sha,stderrSha256:stderr.sha,stdoutEncoding:state.stdoutEncoding,stderrEncoding:state.stderrEncoding});
  }
}}
if(watch){process.once('disconnect',observe);process.send?.({type:'ready'});}else observe();
