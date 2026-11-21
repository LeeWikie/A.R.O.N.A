import fs from 'node:fs';
import path from 'node:path';
import {acquireLock} from '../src/lock.js';
import {AppError} from '../src/domain.js';

const [directory,mode]=process.argv.slice(2);if(!directory||!mode)throw Error('fixture_arguments');
if(mode==='stale-reader'){
  const unlink=fs.unlinkSync,target=path.join(fs.realpathSync(directory),'core.lock');let paused=false;
  fs.unlinkSync=file=>{if(!paused&&path.resolve(String(file))===target){paused=true;process.send?.({stage:'before-unlink'});while(!fs.existsSync(path.join(directory,'release-stale-reader')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return unlink(file);};
}
try{
  const release=mode==='legacy'?(()=>{fs.writeFileSync(path.join(directory,'core.lock'),JSON.stringify({pid:process.pid,owner:'synthetic-legacy-owner'}),{flag:'wx',mode:0o600});return()=>fs.unlinkSync(path.join(directory,'core.lock'));})():acquireLock(directory);
  process.send?.({stage:'acquired',pid:process.pid});
  process.on('message',message=>{if(message==='release'){release();if(mode!=='legacy')release();process.disconnect?.();}else if(message==='remove-projection'){fs.unlinkSync(path.join(directory,'core.lock'));process.send?.({stage:'projection-removed'});}});
}catch(error){process.send?.({stage:'rejected',code:error instanceof AppError?error.code:'unexpected_lock_failure'});process.disconnect?.();}
