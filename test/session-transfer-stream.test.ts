import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {decodeSessionStream,encodeArchiveStream,encodePiStream} from '../src/session-transfer-codec.js';
import {logicalSessionInputSchema} from '../src/logical-session-input.js';
import {SESSION_TRANSFER_PART_BYTES} from '../src/session-transfer-store.js';
import type {SessionTransferJob,SessionArchive} from '../src/protocol.js';
import {removeTemp,until} from './helpers.js';

const timestamp='2026-01-01T00:00:00.000Z',sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const header={type:'session' as const,version:3,id:'synthetic-stream-session',timestamp,cwd:'/synthetic'};
const user=(id:string,parentId:string|null,content:string)=>({type:'message',id,parentId,timestamp,message:{role:'user',content,timestamp:Date.parse(timestamp)}});
async function* chunks(bytes:Uint8Array,size=7){for(let at=0;at<bytes.length;at+=size)yield bytes.subarray(at,at+size);}
async function collect(source:AsyncIterable<Uint8Array>){const output:Uint8Array[]=[];for await(const row of source)output.push(row);return Buffer.concat(output);}
function emptyModel(onCall?:()=>void){return new MastraLanguageModelV2Mock({doStream:async()=>{onCall?.();return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});}

function transport(core:Core){const app=createApp(core),headers={authorization:`Bearer ${core.controlToken}`,'X-ShittimChest-Storage-Id':core.storageId};return{
 async json<T>(route:string,body?:unknown,method=body===undefined?'GET':'POST',key?:string){const response=await app.request(route,{method,headers:{...headers,'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(response.ok,await response.clone().text());return await response.json() as T;},
 async upload(bytes:Uint8Array,key:string,id?:string){const {transfer}=await this.json<{transfer:SessionTransferJob}>('/session-transfers/import',{bytes:bytes.length,sha256:sha(bytes),options:id?{id}:{}},'POST',key);for(let index=0;index<transfer.partCount;index++){const part=bytes.subarray(index*transfer.partSize,Math.min(bytes.length,(index+1)*transfer.partSize));const response=await app.request(`/session-transfers/${transfer.id}/parts/${index}`,{method:'PUT',headers:{...headers,'X-Content-SHA256':sha(part)},body:new Uint8Array(part)});assert.equal(response.status,200,await response.clone().text());}return transfer;},
 async done(id:string){const value=await until(async()=>(await this.json<{transfer:SessionTransferJob}>(`/session-transfers/${id}`)).transfer,row=>['ready','completed','failed','cancelled'].includes(row.state),60000);assert.ok(['ready','completed'].includes(value.state),JSON.stringify(value));return value;},
 async download(job:SessionTransferJob){const bytes:Uint8Array[]=[];for(let index=0;index<job.partCount;index++){const response=await app.request(`/session-transfers/${job.id}/parts/${index}`,{headers});assert.equal(response.status,200);const part=new Uint8Array(await response.arrayBuffer());assert.equal(sha(part),response.headers.get('X-Content-SHA256'));assert.ok(part.length<=SESSION_TRANSFER_PART_BYTES);bytes.push(part);}const result=Buffer.concat(bytes);assert.equal(result.length,job.bytes);assert.equal(sha(result),job.sha256);return result;},
 app,headers,
};}

test('stream codec preserves UTF-8 boundaries, full native topology and sectional continuation without accepting malformed records',async()=>{
 const entries=[user('a',null,'中文\n🌸'),user('b','a','sibling one'),user('c','a','sibling two'),{type:'label',id:'label',parentId:'c',targetId:'b',label:'keep',timestamp}];const bytes=await collect(encodePiStream(header,entries));const parsed=await decodeSessionStream(chunks(Buffer.concat([Buffer.from('\uFEFF'),bytes]),1));assert.equal(parsed.format,'pi');if(parsed.format==='pi')assert.deepEqual(parsed.session.entries,entries);
 const archive:SessionArchive={format:'shittimchest-session',version:1,context:{id:'main',name:'Synthetic',purpose:'',modelProfile:'default',workspaceId:'default',createdAt:timestamp},messages:[{id:'visible-a',contextId:'main',role:'user',content:'中文\n🌸',createdAt:timestamp,runId:null,status:'committed',kind:'message'}],continuation:{messages:[{id:'raw-a',role:'user',createdAt:timestamp,content:{format:2,parts:[{type:'text',text:'中文\n🌸'}]}}],publicMessageMap:{'visible-a':'raw-a'},assets:[],graph:{header,leafId:'label',entries:entries.map(entry=>({entry:entry as never})),sources:[]}}};assert.deepEqual((await decodeSessionStream(chunks(await collect(encodeArchiveStream(archive)),1))),{format:'archive',archive});
 await assert.rejects(decodeSessionStream(chunks(Buffer.from([0xc3,0x28]))),/invalid_session_encoding/);await assert.rejects(decodeSessionStream(chunks(Buffer.from(JSON.stringify(header)+'\n'+JSON.stringify(user('dangling','absent','bad'))))),/invalid_pi_session_graph/);
 const duplicate=await collect(encodeArchiveStream(archive));await assert.rejects(decodeSessionStream(chunks(Buffer.concat([duplicate,Buffer.from(JSON.stringify({type:'public-native-map',publicId:'visible-a',nativeId:'raw-a'})+'\n')]))),/invalid_session_archive/);
});

test('logical provenance validation has no aggregate attachment cutoff while preserving hashes, lengths and distinct real sources',()=>{
 const attachments=Array.from({length:10001},()=>randomUUID()),content='complete logical original';const logical={id:'logical',kind:'queue-logical-input',contextId:'main',runId:randomUUID(),draftId:randomUUID(),revision:1,entryId:randomUUID(),signalIds:[randomUUID(),randomUUID()],nativeMessageIds:[randomUUID(),randomUUID()],originalNativeMessageIds:[randomUUID(),randomUUID()],content,contentHash:sha(content),attachments};assert.deepEqual(logicalSessionInputSchema.parse(logical).attachments,attachments);assert.equal(logicalSessionInputSchema.safeParse({...logical,originalNativeMessageIds:[logical.originalNativeMessageIds[0],logical.originalNativeMessageIds[0]]}).success,false);assert.equal(logicalSessionInputSchema.safeParse({...logical,content:'changed'}).success,false);
});

test('verified native session transport exceeds the legacy aggregate limit, resumes upload across Core restart and exports the complete graph', {timeout:120000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-large-session-transfer-'));let calls=0,core=await Core.open({dataDir:directory,model:emptyModel(()=>calls++),memoryEnabled:false});const first='FIRST_NATIVE_BEGIN'+'.'.repeat(17*1024*1024)+'FIRST_NATIVE_END',second='SECOND_NATIVE_BEGIN'+'.'.repeat(17*1024*1024)+'SECOND_NATIVE_END',bytes=await collect(encodePiStream(header,[user('a',null,first),user('b','a',second)]));let t=transport(core);
 try{
  const legacy=await t.app.request('/contexts/import-pi',{method:'POST',headers:{...t.headers,'content-type':'application/json'},body:JSON.stringify({jsonl:bytes.toString('utf8')})});assert.equal(legacy.status,413,'legacy request budget remains bounded');
  const {transfer}=await t.json<{transfer:SessionTransferJob}>('/session-transfers/import',{bytes:bytes.length,sha256:sha(bytes),options:{id:'chat.large-native'}},'POST','large-import');const firstPart=bytes.subarray(0,transfer.partSize);let response=await t.app.request(`/session-transfers/${transfer.id}/parts/0`,{method:'PUT',headers:{...t.headers,'X-Content-SHA256':sha(firstPart)},body:firstPart});assert.equal(response.status,200);await core.close();core=await Core.open({dataDir:directory,model:emptyModel(()=>calls++),memoryEnabled:false});t=transport(core);
  assert.equal((await t.json<{transfer:SessionTransferJob}>(`/session-transfers/${transfer.id}`)).transfer.receivedParts,1);const repeated=await t.upload(bytes,'large-import','chat.large-native');assert.equal(repeated.id,transfer.id);await t.json(`/session-transfers/${transfer.id}/commit`,{});const completed=await t.done(transfer.id);assert.equal(completed.state,'completed');assert.equal(completed.result!.id,'chat.large-native');assert.equal(calls,0,'imported history never executes');
  const records=core.sessionGraph.records(completed.result!.id);assert.deepEqual(records.map(row=>row.entry.type==='message'&&'content'in row.entry.message?row.entry.message.content:null),[first,second]);
  const exported=(await t.json<{transfer:SessionTransferJob}>('/session-transfers/export',{contextId:completed.result!.id,format:'pi'},'POST','large-export')).transfer,ready=await t.done(exported.id);assert.ok(ready.bytes>32*1024*1024);const raw=await t.download(ready),roundtrip=await decodeSessionStream(chunks(raw,256*1024));assert.equal(roundtrip.format,'pi');if(roundtrip.format==='pi')assert.deepEqual(roundtrip.session.entries,records.map(row=>row.entry));await t.json(`/session-transfers/${ready.id}/acknowledge`,{sha256:sha(raw)});assert.equal((await t.json<{transfer:SessionTransferJob}>(`/session-transfers/${ready.id}`)).transfer.state,'completed');
  assert.equal((await t.app.request(`/session-transfers/${ready.id}`,{headers:{authorization:`Bearer ${core.controlToken}`,'X-ShittimChest-Storage-Id':randomUUID()}})).status,409);
 }finally{await core.close();await removeTemp(directory);}
});
