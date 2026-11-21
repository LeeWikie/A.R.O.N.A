import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import{randomBytes,randomUUID}from'node:crypto';import{fork}from'node:child_process';import{once}from'node:events';import{fileURLToPath}from'node:url';
import test from 'node:test';
import{QueueLocalEdits,type QueueLocalEdit}from'../src/tui/queue-local-edits.js';
import{removeTemp,until}from'./helpers.js';

function record():QueueLocalEdit{const entryId=randomUUID(),content=randomBytes(80000).toString('base64');return{storageId:'synthetic-storage',contextId:'main',draftId:randomUUID(),entryId,baseRevision:1,base:{id:entryId,content,attachments:[],sourceSignalIds:[randomUUID()],removed:false},content,attachments:[],updatedAt:new Date().toISOString()};}
function bytes(directory:string){return fs.readdirSync(directory).reduce((sum,name)=>sum+fs.statSync(path.join(directory,name)).size,0);}
const fixture=fileURLToPath(new URL('./queue-local-cache-process.ts',import.meta.url));

test('retiring superseded owned blobs preserves another owner, an explicit older review and an unresolved earlier operation',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-cache-bounds-'));try{
  const current=new QueueLocalEdits(directory,'synthetic-control'),other=new QueueLocalEdits(directory,'synthetic-control'),review=new QueueLocalEdits(directory,'synthetic-control'),input=record();let saved=current.save(input);const original=structuredClone(saved),foreign=other.save({...input,content:'OTHER_OWNER_'+input.content}),selected=review.adopt(original);
  for(let index=0;index<41;index++)saved=current.save({...saved,content:String(index).padStart(3,'0')+input.content,pending:{operationId:original.pending?.operationId??randomUUID(),baseRevision:1,content:original.content,attachments:[],localContext:'ORIGINAL_UNKNOWN_ACK_HOST'},updatedAt:new Date().toISOString()});
  assert.equal(current.acknowledge(input,input.entryId,original),false);assert.equal(current.current(input,input.entryId)?.content,saved.content);const reopened=new QueueLocalEdits(directory,'synthetic-control').list(input);assert.equal(reopened.length,3);assert.deepEqual(reopened.find(row=>row.localId===foreign.localId),foreign);assert.deepEqual(reopened.find(row=>row.localId===selected.localId),selected);assert.equal(reopened.find(row=>row.localId===saved.localId)?.pending?.content,original.content);assert.equal(reopened.find(row=>row.localId===saved.localId)?.pending?.localContext,'ORIGINAL_UNKNOWN_ACK_HOST');assert.ok(bytes(directory)<3*Buffer.byteLength(JSON.stringify(saved)),'only the three current independent manifests retain bytes, rather than each intermediate keystroke');
 }finally{await removeTemp(directory);}
});

test('a real second-process current-state reader retries a replaced manifest without losing or mixing the original selected review', {timeout:15000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-cache-reader-')),cacheDirectory=path.join(directory,'cache'),input=record(),cache=new QueueLocalEdits(cacheDirectory,'synthetic-control'),original=cache.save(input);fs.writeFileSync(path.join(directory,'input.json'),JSON.stringify(input));const child=fork(fixture,[directory,'reader'],{stdio:['ignore','ignore','pipe','ipc']});let diagnostics='';child.stderr!.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-4096);});
 try{await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error('reader exited before its manifest barrier: '+diagnostics);return fs.existsSync(path.join(directory,'manifest-read'));},Boolean);const oldReview=structuredClone(original),newest=cache.save({...original,content:'NEW_STATE_'+original.content,updatedAt:new Date().toISOString()});const exited=once(child,'exit'),result=Promise.race([once(child,'message'),exited.then(value=>{throw new Error('reader exited without a complete current state: '+JSON.stringify(value)+' '+diagnostics);})]);fs.writeFileSync(path.join(directory,'release-reader'),'release');const[loaded]=await result;assert.equal(loaded.type,'result');assert.deepEqual(loaded.value,newest);assert.deepEqual(await exited,[0,null]);assert.equal(oldReview.content,original.content,'an already selected exact version stays the selected version');const reviewer=new QueueLocalEdits(cacheDirectory,'synthetic-control'),adopted=reviewer.adopt(oldReview);assert.equal(adopted.content,original.content);assert.notEqual(adopted.localId,newest.localId);assert.equal(reviewer.list(input).find(row=>row.localId===newest.localId)?.content,newest.content);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await removeTemp(directory);}
});

for(const phase of['after-blob','after-manifest','during-retirement']as const)test(`actual ${phase} hard crash leaves the complete published local draft and operation recoverable`,{timeout:15000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-cache-crash-')),input=record();input.pending={operationId:randomUUID(),baseRevision:1,content:input.content,attachments:[],localContext:'UNKNOWN_OPERATION_ORIGINAL_MATERIAL'};fs.writeFileSync(path.join(directory,'input.json'),JSON.stringify(input));const child=fork(fixture,[directory,phase],{stdio:['ignore','ignore','ignore','ipc']});
 try{const[code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');const boundary=JSON.parse(fs.readFileSync(path.join(directory,'boundary.json'),'utf8'))as{original:QueueLocalEdit;latest:QueueLocalEdit},rows=new QueueLocalEdits(path.join(directory,'cache'),'synthetic-control').list(input);assert.equal(rows.length,1);assert.deepEqual(rows[0],phase==='after-blob'?boundary.original:boundary.latest);assert.deepEqual(rows[0]!.pending,input.pending);assert.equal(rows[0]!.base.content,input.base.content);assert.deepEqual(rows[0]!.base.sourceSignalIds,input.base.sourceSignalIds);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await removeTemp(directory);}
});

test('a final visible hardlink swap cannot turn an already opened local version into a foreign draft',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-queue-cache-final-link-')),input=record(),cache=new QueueLocalEdits(directory,'synthetic-control'),saved=cache.save(input),file=path.join(directory,fs.readdirSync(directory).find(name=>name.endsWith('.json'))!),preserved=file+'.original',foreign=path.join(directory,'foreign.txt'),read=fs.readFileSync.bind(fs);let injected=false;fs.writeFileSync(foreign,'FOREIGN_DATA_CANARY');
 try{
  fs.readFileSync=((...args:Parameters<typeof fs.readFileSync>)=>{const value=Reflect.apply(read,fs,args);if(!injected&&typeof args[0]==='number'&&Buffer.isBuffer(value)&&value.includes(Buffer.from('"format":"queue-editor-parts"'))){injected=true;fs.renameSync(file,preserved);fs.linkSync(foreign,file);}return value;})as typeof fs.readFileSync;
  assert.throws(()=>new QueueLocalEdits(directory,'synthetic-control').list(input),/queue_local_edit_redirected/);assert.equal(injected,true);assert.equal(read(foreign,'utf8'),'FOREIGN_DATA_CANARY');
 }finally{fs.readFileSync=read;if(injected){fs.unlinkSync(file);fs.renameSync(preserved,file);}assert.deepEqual(new QueueLocalEdits(directory,'synthetic-control').list(input)[0],saved);await removeTemp(directory);}
});
