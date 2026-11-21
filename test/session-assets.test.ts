import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import {sessionAssetPiEntries,extractSessionAssetPiEntries,verifyPortableShellAssetSecrets,type PortableSessionAsset} from '../src/session-assets.js';
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const user:SessionEntry={type:'message',id:'user',parentId:null,timestamp:'2026-11-12T00:00:00.000Z',message:{role:'user',content:'Synthetic original input.',timestamp:1}};
function asset(bytes:Buffer):PortableSessionAsset{return{id:randomUUID(),name:'source.bin',mediaType:'application/octet-stream',sha256:hash(bytes),data:bytes.toString('base64'),purpose:'client-shell-output',entryIds:[user.id]};}
test('Pi asset data envelopes preserve bounded binary parts and exact user-entry bindings, rejecting missing, substituted and duplicate data',()=>{
 const originals=[asset(Buffer.alloc(0)),asset(Buffer.from(Array.from({length:700003},(_,index)=>index%256)))],records=[user,...sessionAssetPiEntries(originals,user.id)];const restored=extractSessionAssetPiEntries(records);assert.deepEqual(restored.assets,originals);assert.deepEqual(restored.entries,[user]);
 assert.ok(records.every(row=>Buffer.byteLength(JSON.stringify(row))<360000));assert.throws(()=>extractSessionAssetPiEntries(records.slice(0,-1)),/invalid_session_asset/);assert.throws(()=>extractSessionAssetPiEntries([...records,records.at(-1)!]),/invalid_session_asset/);
 const wrong=structuredClone(records);const manifest=wrong.find(row=>row.type==='custom');assert.ok(manifest&&manifest.type==='custom');(manifest.data as {entryIds:string[]}).entryIds=['foreign-entry'];assert.throws(()=>extractSessionAssetPiEntries(wrong),/invalid_session_asset/);
 const changed=structuredClone(records);const part=changed.findLast(row=>row.type==='custom');assert.ok(part&&part.type==='custom');(part.data as {data:string}).data=Buffer.from('different').toString('base64');assert.throws(()=>extractSessionAssetPiEntries(changed),/invalid_session_asset/);
});
test('private backup scans each immutable Shell observation in declared stream order even when original chunks are shared',()=>{
 const first=asset(Buffer.from('prefix:TOP_SE')),oldTail=asset(Buffer.from('OLD')),newTail=asset(Buffer.from('CRET:end'));
 const manifest=(tail:PortableSessionAsset)=>{const all=Buffer.concat([Buffer.from(first.data,'base64'),Buffer.from(tail.data,'base64')]),body=[{format:'client-shell-output',version:1}, {stream:'stdout',bytes:all.length,sha256:hash(all),complete:true,parts:[first,tail].map((part,index)=>({id:part.id,stream:'stdout',index,bytes:Buffer.from(part.data,'base64').length,sha256:part.sha256}))},{stream:'stderr',bytes:0,sha256:hash(Buffer.alloc(0)),complete:true,parts:[]}].map(row=>JSON.stringify(row)).join('\n')+'\n';return asset(Buffer.from(body));};
 const prefix=manifest(oldTail),complete=manifest(newTail),rows=[prefix,first,oldTail,complete,newTail];assert.throws(()=>verifyPortableShellAssetSecrets(rows,['TOP_SECRET']),/session_backup_contains_secret/);assert.doesNotThrow(()=>verifyPortableShellAssetSecrets(rows,['not-in-this-data']));
 const missing=[prefix,first,oldTail,complete];assert.throws(()=>verifyPortableShellAssetSecrets(missing,[]),/invalid_session_asset/);
});
