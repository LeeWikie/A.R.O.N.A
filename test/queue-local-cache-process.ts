import fs from 'node:fs';
import path from 'node:path';
import {QueueLocalEdits,type QueueLocalEdit} from '../src/tui/queue-local-edits.js';

const[directory,mode]=process.argv.slice(2),input=JSON.parse(fs.readFileSync(path.join(directory!,'input.json'),'utf8'))as QueueLocalEdit,cacheDirectory=path.join(directory!,'cache'),cache=new QueueLocalEdits(cacheDirectory,'synthetic-control');
if(mode==='reader'){
 const read=fs.readFileSync.bind(fs);let paused=false;
 fs.readFileSync=((...args:Parameters<typeof fs.readFileSync>)=>{const value=Reflect.apply(read,fs,args);if(!paused&&typeof args[0]==='number'&&Buffer.isBuffer(value)&&value.includes(Buffer.from('"format":"queue-editor-parts"'))){paused=true;fs.writeFileSync(path.join(directory!,'manifest-read'),'ready');const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(path.join(directory!,'release-reader')))Atomics.wait(wait,0,0,10);}return value;})as typeof fs.readFileSync;
 const value=cache.list(input)[0];await new Promise<void>((resolve,reject)=>{if(!process.send)throw new Error('IPC fixture required');process.send({type:'result',value},error=>error?reject(error):resolve());});process.disconnect();
}else{
 const original=cache.save(input),latest={...original,content:'LATEST_PUBLISHED_'+original.content,updatedAt:new Date().toISOString()};
 const boundary=()=>{fs.writeFileSync(path.join(directory!,'boundary.json'),JSON.stringify({mode,original,latest}));process.kill(process.pid,'SIGKILL');};
 if(mode==='after-blob'){
  const open=fs.openSync.bind(fs),write=fs.writeFileSync.bind(fs),paths=new Map<number,string>();
  fs.openSync=((...args:Parameters<typeof fs.openSync>)=>{const fd=Reflect.apply(open,fs,args);paths.set(fd,String(args[0]));return fd;})as typeof fs.openSync;
  fs.writeFileSync=((...args:Parameters<typeof fs.writeFileSync>)=>{Reflect.apply(write,fs,args);if(typeof args[0]==='number'&&paths.get(args[0])?.includes('.blob-'))boundary();})as typeof fs.writeFileSync;
 }else if(mode==='after-manifest'){
  const rename=fs.renameSync.bind(fs);fs.renameSync=((...args:Parameters<typeof fs.renameSync>)=>{Reflect.apply(rename,fs,args);if(String(args[1]).startsWith(cacheDirectory)&&String(args[1]).endsWith('.json'))boundary();})as typeof fs.renameSync;
 }else if(mode==='during-retirement'){
  const unlink=fs.unlinkSync.bind(fs);fs.unlinkSync=((...args:Parameters<typeof fs.unlinkSync>)=>{Reflect.apply(unlink,fs,args);if(String(args[0]).includes('.blob-'))boundary();})as typeof fs.unlinkSync;
 }else throw new Error('unknown-fixture-mode');
 cache.save(latest);throw new Error('expected-hard-crash-boundary');
}
