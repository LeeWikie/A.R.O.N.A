import assert from 'node:assert/strict';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {Models} from '../src/models.js';
import {processInputImage} from '../src/input-images.js';
import {syntheticPng} from './fixtures/png.js';
import {hasNativeImage} from './fixtures/model-images.js';
import {finished} from './helpers.js';

const[directory,variant,plain]=process.argv.slice(2);
if(!directory||!variant||!process.send)throw Error('fixture_arguments');
const policy={supportsImages:variant!=='text',resizeOptions:{maxWidth:variant==='two'?2:8,maxHeight:variant==='two'?2:8}},originalPolicy=Models.prototype.imageReadOptions;
Models.prototype.imageReadOptions=function(id){return{...originalPolicy.call(this,id),...policy};};
const original=syntheticPng(32,16),normalized=await processInputImage(original,'image/png',policy);
let core:Core,calls=0,imageReads=0,omissions=0;
function objects(input:unknown):Record<string,unknown>[] {
 const rows:Record<string,unknown>[]=[],seen=new Set<object>();const visit=(value:unknown)=>{if(typeof value==='string'){try{visit(JSON.parse(value));}catch{}return;}if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);if(Array.isArray(value)){for(const item of value)visit(item);return;}rows.push(value as Record<string,unknown>);for(const item of Object.values(value))visit(item);};visit(input);return rows;
}
const model=new MastraLanguageModelV2Mock({doStream:async request=>{
 calls++;const text=JSON.stringify(request.prompt),reviewing=text.includes('REVIEW_RETAINED_IMAGE_GATE'),results=request.prompt.flatMap(row=>row.role==='tool'?row.content:[]),listed=results.some(part=>part.type==='tool-result'&&part.toolName==='list_attachments'),read=results.some(part=>part.type==='tool-result'&&part.toolName==='read_attachment'),answered=results.some(part=>part.type==='tool-result'&&part.toolName==='ask_user');let name:string|undefined,args:unknown;
 if(reviewing&&!answered){
  const source=core.store.db.prepare("SELECT id FROM signals WHERE status='accepted' AND json_extract(body,'$.contextId')='main' ORDER BY rowid DESC LIMIT 1").get();assert.ok(source);const signalIds=[String(source.id)];
  if(plain==='plain'){name='ask_user';args={question:'Continue this plain-text run?',options:[{label:'Continue'}]};}
  else if(!listed){name='list_attachments';args={signalIds};}
  else if(!read){const catalog=objects(request.prompt).find(row=>Array.isArray(row.attachments)&&row.attachments.some(value=>value&&typeof value==='object'&&'mediaType'in value&&value.mediaType==='image/png'));assert.ok(catalog);const image=(catalog.attachments as Array<Record<string,unknown>>).find(row=>row.mediaType==='image/png');assert.ok(image&&typeof image.id==='string'&&typeof image.sha256==='string');name='read_attachment';args={signalIds,id:image.id,expectedSha256:image.sha256};}
  else{
   imageReads++;if(normalized.ok)assert.ok(hasNativeImage(request.prompt,Buffer.from(normalized.data,'base64')),'the real next request includes the normalized native image');else{omissions++;assert.match(text,/selected model does not support images/);assert.equal(hasNativeImage(request.prompt,original),false);}
   name='ask_user';args={question:'Continue after viewing the retained image?',options:[{label:'Continue'}]};
  }
 }
 return{stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(name)controller.enqueue({type:'tool-call',toolCallId:`attachment-image-${name}`,toolName:name,input:JSON.stringify(args)});controller.enqueue({type:'finish',finishReason:name?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};
}});
core=await Core.open({dataDir:directory,model,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'http://127.0.0.1:9/v1',modelId:'synthetic-image-recovery',apiKey:'SYNTHETIC_ATTACHMENT_IMAGE_RECOVERY_KEY',authHeader:'bearer'}});
process.send({type:'ready'});
process.on('message',(message:unknown)=>{if(!message||typeof message!=='object'||!('type'in message))return;void(async()=>{
 if(message.type==='seed'){
  const asset=await core.assets.put(new Response(new Uint8Array(original)).body,'original.png'),first=await core.submitMessage({content:'ORIGINAL_COMPACTION_IMAGE',attachments:[asset.id]});assert.equal((await finished(core,first.runId!))!.status,'succeeded');const recent=await core.submitMessage({content:'KEEP_RECENT_IMAGE_CONTEXT'});assert.equal((await finished(core,recent.runId!))!.status,'succeeded');const record=core.sessionGraph.records('main').find(row=>row.source?.messageId===recent.nativeSignalId);assert.ok(record);const manager=core.sessionGraph.manager('main'),id=manager.appendCompaction('The original image has been summarized.',record.entry.id,1000),entry=manager.getEntry(id);assert.ok(entry);core.sessionGraph.append('main',[{entry}],core.sessionGraph.head('main')!.revision);await core.submitMessage({content:'REVIEW_RETAINED_IMAGE_GATE'});
 }
 if(message.type==='answer'){const question=core.interactions().find(row=>row.status==='pending');assert.ok(question);await core.answerInteraction(question.id,question.runId,'Continue');assert.equal((await finished(core,question.runId))!.status,'succeeded');}
 const question=core.interactions().find(row=>'question'in row.payload&&row.payload.question.includes(plain==='plain'?'plain-text':'retained image')),source=question?core.store.db.prepare('SELECT body FROM signals WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(question.runId):undefined;
 process.send?.({type:'state',calls,imageReads,omissions,question,run:question?core.store.getRun(question.runId):undefined,sourceBody:source?.body,seal:question?core.runtime.setting(`run-recovery:${question.runId}`,null):null,proofs:question?core.store.db.prepare('SELECT id,body FROM runtime_settings WHERE id LIKE ? ORDER BY id').all(`attachment-image-policy:${question.runId}:%`):[],events:core.runtime.events('main',0,1000).filter(row=>row.kind==='run_recovery_unavailable')});
})().catch(error=>process.send?.({type:'fixture-error',error:String(error)}));});
