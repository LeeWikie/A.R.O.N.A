import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {WebResultStore,MAX_WEB_RESULT_CHARACTERS,type WebResultBinding,type WebResultDocument} from '../src/web/results.js';
import {cleanInlineImages,webPreview,binaryWebPayloadKind} from '../src/web/budget.js';

const key='synthetic-web-result-storage-key-not-a-credential';
const binding=():WebResultBinding=>({contextId:'work.synthetic',runId:randomUUID(),toolCallId:'synthetic-original-web-fetch',taskId:randomUUID(),attempt:1,workspaceId:'synthetic',sourceSignalIds:[randomUUID()],proof:createHash('sha256').update('synthetic accepted source proof').digest('hex')});
const document=(content:string,truncated=false):WebResultDocument=>({url:'https://synthetic.example/page',status:200,contentType:'text/plain',extractor:'raw',content,received:{bytes:Buffer.byteLength(content),wireBytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex'),truncated}});

test('retained extracted web text survives reopening with exact hashes and bounded original line and byte pages',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-web-results-')),file=path.join(directory,'records.sqlite');let db=new DatabaseSync(file);
  try{let store=new WebResultStore(db,key);const source=Array.from({length:6000},(_,index)=>`row_${index}: 甲🙂`).join('\n'),owner=binding(),reference=store.save(document(source),owner);db.close();db=new DatabaseSync(file);store=new WebResultStore(db,key);assert.deepEqual(store.describe(reference.id),{reference,binding:owner});const page=await store.read(reference.id,{offset:3000,limit:2});assert.match(page.content,/row_2999: 甲🙂\nrow_3000: 甲🙂/);assert.equal(page.nextOffset,3002);assert.equal(page.complete,false);const bytes=await store.read(reference.id,{encoding:'base64',byteOffset:0,maxBytes:31});assert.deepEqual(Buffer.from(bytes.content,'base64'),Buffer.from(source).subarray(0,31));assert.equal(bytes.nextByteOffset,31);assert.equal(reference.sha256,createHash('sha256').update(source).digest('hex'));
    db.prepare('UPDATE web_result_records SET content=? WHERE id=?').run(Buffer.from('changed'),reference.id);await assert.rejects(store.read(reference.id),/web_result_changed/);
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('retention and network limits remain explicit and cannot be mistaken for a complete source',async()=>{
  const db=new DatabaseSync(':memory:'),store=new WebResultStore(db,key);try{const reference=store.save(document('🙂'.repeat(MAX_WEB_RESULT_CHARACTERS+2),true),binding());assert.equal(reference.characters,MAX_WEB_RESULT_CHARACTERS);assert.equal(reference.originalCharacters,MAX_WEB_RESULT_CHARACTERS+2);assert.equal(reference.bytes,4*MAX_WEB_RESULT_CHARACTERS);assert.equal(reference.isTruncated,true);assert.deepEqual(reference.truncationReasons,['network-byte-limit','text-retention-limit']);assert.equal(reference.received.bytes,4*(MAX_WEB_RESULT_CHARACTERS+2));const long=await store.read(reference.id);assert.equal(long.complete,false);assert.equal(long.requiresByteRead,true);assert.equal(long.nextOffset,1);assert.doesNotMatch(long.content,/Use bash|sed -n/);const raw=await store.read(reference.id,{encoding:'base64',byteOffset:reference.bytes-8,maxBytes:8});assert.equal(Buffer.from(raw.content,'base64').toString(),'🙂🙂');assert.equal(raw.complete,false);assert.equal(raw.nextByteOffset,null);
    const row=db.prepare('SELECT body FROM web_result_records WHERE id=?').get(reference.id)!;const body=JSON.parse(String(row.body));body.binding.workspaceId='another';db.prepare('UPDATE web_result_records SET body=? WHERE id=?').run(JSON.stringify(body),reference.id);assert.throws(()=>store.describe(reference.id),/web_result_changed/);
  }finally{db.close();}
});

test('head and tail windows keep real Unicode and actionable partial-line continuation while removing inline image token payloads',()=>{
  const body='HEAD\n'+Array.from({length:3000},(_,index)=>`row_${index} 🙂`).join('\n')+'\nTAIL',preview=webPreview(body,5000);assert.equal(preview.truncated,true);assert.match(preview.text,/^HEAD/);assert.match(preview.text,/TAIL$/);assert.ok(preview.headCharacters+preview.tailCharacters<=5000);assert.ok(preview.middleStartLine!>1);assert.equal(preview.text.includes('\ufffd'),false);assert.equal(webPreview('🙂'.repeat(4000),2000).middleStartLine,1);
  assert.equal(cleanInlineImages('before ![a cat]( data:image/png;base64,'+'A'.repeat(5000)+') after'),'before [IMAGE: a cat] after');assert.equal(cleanInlineImages('data:image/gif;base64,ZZZ'),'[IMAGE]');assert.equal(cleanInlineImages('![safe](https://synthetic.example/image.png)'),'![safe](https://synthetic.example/image.png)');
  assert.equal(binaryWebPayloadKind(Buffer.from('SQLite format 3\0data')),'SQLite database');assert.equal(binaryWebPayloadKind(Buffer.from('PK\x03\x04data')),'ZIP archive');assert.equal(binaryWebPayloadKind(Buffer.from('BMW reviews are ordinary prose')),undefined);assert.equal(binaryWebPayloadKind(Buffer.from('MZ ordinary prose')),undefined);
});

test('history export carries exact retained text and source facts without old source grants or MACs',()=>{
  const db=new DatabaseSync(':memory:'),store=new WebResultStore(db,key);try{const content='HEAD\n甲🙂\nTAIL',reference=store.save(document(content),binding()),exported=store.exportRetained(reference.id);assert.deepEqual(Object.keys(exported).sort(),['bytes','reference']);assert.deepEqual(exported.bytes,Buffer.from(content));assert.deepEqual(exported.reference,reference);exported.bytes.fill(0);assert.deepEqual(store.exportRetained(reference.id).bytes,Buffer.from(content));const controller=new AbortController();controller.abort();assert.throws(()=>store.exportRetained(reference.id,controller.signal),{name:'AbortError'});db.prepare('UPDATE web_result_records SET content=? WHERE id=?').run(Buffer.from(content).fill(0),reference.id);assert.throws(()=>store.exportRetained(reference.id),/web_result_changed/);}finally{db.close();}
});
