import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentSignalContents} from '@mastra/core/agent';
import {processInputImage,processInputImages} from '../src/input-images.js';
import {syntheticPng} from './fixtures/png.js';

test('the input adapter preserves exact text, file metadata, duplicate image order and original bytes around native normalization',async()=>{
 const a=syntheticPng(32,16),b=syntheticPng(16,32,160),source:AgentSignalContents=[{type:'text',text:'ORIGINAL_USER_\u202e_\u0001'},{type:'file',data:a,mediaType:'image/png',filename:'original-a.png'},{type:'text',text:'ORIGINAL_HOST_MATERIAL'},{type:'file',data:b.toString('base64'),mediaType:'image/png',filename:'original-b.png'},{type:'file',data:a,mediaType:'image/png',filename:'original-a.png'}],original=JSON.stringify(source),policy={resizeOptions:{maxWidth:8,maxHeight:8}},result=await processInputImages(source,policy);assert.ok(Array.isArray(result));const images=result.filter(part=>part.type==='file');assert.equal(images.length,3);assert.deepEqual(images.map(part=>{assert.ok(part.data instanceof Uint8Array);const bytes=Buffer.from(part.data);return[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];}),[[8,4],[4,8],[8,4]]);assert.deepEqual(images.map(part=>part.filename),['original-a.png','original-b.png','original-a.png']);assert.equal(result[0]!.type,'text');assert.deepEqual(result[0],source[0]);assert.ok(result.some(part=>part.type==='text'&&part.text==='ORIGINAL_HOST_MATERIAL'));assert.equal(JSON.stringify(source),original);assert.deepEqual(policy,{resizeOptions:{maxWidth:8,maxHeight:8}});
});

test('unsupported and undecodable images are explicitly omitted from model input without losing their original data or other parts',async()=>{
 const original=syntheticPng(32,16),unsupported=await processInputImages([{type:'text',text:'ORIGINAL_REQUEST'},{type:'file',data:original,mediaType:'image/png'}],{supportsImages:false});assert.ok(Array.isArray(unsupported));assert.ok(unsupported.every(part=>part.type==='text'));assert.match(JSON.stringify(unsupported),/selected model does not support images/);assert.equal((await processInputImage(original,'image/png',{supportsImages:false})).ok,false);
 const invalid=await processInputImages([{type:'text',text:'ORIGINAL_REQUEST'},{type:'file',data:Buffer.from('not a valid image'),mediaType:'image/png'},{type:'text',text:'KEEP_AFTER_IMAGE'}]);assert.ok(Array.isArray(invalid));assert.equal(invalid.filter(part=>part.type==='file').length,0);assert.ok(invalid.some(part=>part.type==='text'&&part.text.includes('Image omitted')));assert.deepEqual(invalid.at(-1),{type:'text',text:'KEEP_AFTER_IMAGE'});
});

test('an explicit resize setting and abort preserve original bytes and await the native worker completion',async()=>{
 const original=syntheticPng(1200,9000),unchanged=await processInputImage(original,'image/png',{autoResizeImages:false,resizeOptions:{maxWidth:8,maxHeight:8}});assert.ok(unchanged.ok);assert.deepEqual(Buffer.from(unchanged.data,'base64'),original);const controller=new AbortController(),reason=new Error('synthetic image cancellation'),pending=processInputImage(original,'image/png',{resizeOptions:{maxWidth:8,maxHeight:8}},controller.signal);controller.abort(reason);await assert.rejects(pending,error=>error===reason);assert.deepEqual(original,syntheticPng(1200,9000));
});
