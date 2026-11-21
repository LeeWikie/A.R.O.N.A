import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Core} from '../src/core.js';
import {attachmentResultToModelOutput,isAttachmentImageView,normalizeAttachmentImage} from '../src/tools/attachment-images.js';
import {syntheticPng} from './fixtures/png.js';
import {removeTemp} from './helpers.js';

test('a default image read preserves the original descriptor while its native model view follows the selected image policy',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-attachment-image-view-')),core=await Core.open({dataDir:directory,memoryEnabled:false}),original=syntheticPng(32,16);
 try{const asset=await core.assets.put(new Response(new Uint8Array(original)).body,'original.png'),raw=await core.assets.readAttachment(asset.id);assert.ok(isAttachmentImageView(raw));assert.deepEqual(Buffer.from(raw.content,'base64'),original);const view=await normalizeAttachmentImage(raw,{resizeOptions:{maxWidth:8,maxHeight:8}}),bytes=Buffer.from(view.content,'base64');assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[8,4]);assert.deepEqual(view.source,raw.source);assert.equal(view.source.sha256,asset.sha256);assert.equal(view.source.bytes,original.length);assert.equal(view.byteLength,bytes.length);const output=attachmentResultToModelOutput(view);assert.ok(output&&output.value.some(part=>part.type==='media'&&part.data===view.content&&part.mediaType==='image/png'));assert.deepEqual((await core.assets.read(asset.id)).bytes,original);const page=await core.assets.readAttachment(asset.id,{encoding:'base64',byteOffset:1,maxBytes:7});assert.equal(page.representation,'base64');assert.deepEqual(Buffer.from(page.content,'base64'),original.subarray(1,8));await assert.rejects(core.assets.readAttachment(asset.id,{encoding:'text'}),/attachment_text_unavailable/);assert.equal(attachmentResultToModelOutput(page),undefined);
 }finally{await core.close();await removeTemp(directory);}
});

test('a text-only model receives an explicit image omission while exact original bytes remain available through explicit pages',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-attachment-image-omitted-')),core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{const original=syntheticPng(32,16),asset=await core.assets.put(new Response(new Uint8Array(original)).body,'original.png'),raw=await core.assets.readAttachment(asset.id);assert.ok(isAttachmentImageView(raw));const omitted=await normalizeAttachmentImage(raw,{supportsImages:false});assert.equal(omitted.imageOmitted,true);assert.equal(omitted.content,'');assert.equal(omitted.source.sha256,asset.sha256);assert.ok(omitted.hints.some(text=>text.includes('does not support images')));const output=attachmentResultToModelOutput(omitted);assert.ok(output);assert.ok(output.value.every(part=>part.type==='text'));const originalPage=await core.assets.readAttachment(asset.id,{encoding:'base64'});assert.deepEqual(Buffer.from(originalPage.content,'base64'),original);const controller=new AbortController(),reason=new Error('synthetic-image-read-cancel');controller.abort(reason);await assert.rejects(normalizeAttachmentImage(raw,{},controller.signal),error=>error===reason);
 }finally{await core.close();await removeTemp(directory);}
});
