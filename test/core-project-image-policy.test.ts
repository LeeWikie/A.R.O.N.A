import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import test from 'node:test';
import {fauxAssistantMessage,fauxProvider,fauxToolCall,type TranscriptContext} from '@earendil-works/pi-ai';
import {getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {Core} from '../src/core.js';
import {until,removeTemp} from './helpers.js';

function syntheticPng(width:number,height:number){
  const chunk=(type:string,data:Buffer)=>{const name=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;const rows=Buffer.alloc((width*3+1)*height,80);for(let row=0;row<height;row++)rows[row*(width*3+1)]=0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

test('real image reads use the frozen native model policy through profile changes and use changed limits on the next run',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-image-policy-')),core=await Core.open({dataDir:directory,memoryEnabled:false}),provider=fauxProvider({provider:'synthetic-image-policy',models:[{id:'vision',input:['text','image'],inputLimits:{images:{resize:{maxWidth:8,maxHeight:8}}}},{id:'text',input:['text']}]});
  let error:unknown,changed=false;const stages=new Map<string,number>(),observed:Array<{model:string;width?:number;height?:number;text:string}>=[];
  const respond=async(context:TranscriptContext,_options:unknown,_state:unknown,model:{id:string})=>{
    try{
      if(!getCurrentTools(context.messages).some(tool=>tool.name==='task_report'))return fauxAssistantMessage('');const task=core.runtime.tasks().find(row=>['running','waiting'].includes(row.status))!;if(!task||task.report)return fauxAssistantMessage('');const stage=stages.get(task.id)??0;stages.set(task.id,stage+1);
      if(stage===0){if(!changed){changed=true;provider.getModel('vision')!.inputLimits!.images!.resize!.maxWidth=2;await core.switchModel(task.contextId,'images.text');}return fauxAssistantMessage(fauxToolCall('mastra_workspace_read_file',{path:'image.png'},{id:`image-read-${task.id}`}),{stopReason:'toolUse'});}
      const result=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='mastra_workspace_read_file');assert.ok(result&&result.role==='toolResult');const image=result.content.find(part=>part.type==='image'),text=result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
      if(image?.type==='image'){const bytes=Buffer.from(image.data,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');observed.push({model:model.id,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),text});}else observed.push({model:model.id,text});
      return fauxAssistantMessage(fauxToolCall('task_report',{id:task.id,report:{outcome:'succeeded',summary:'Read the synthetic image with the actual model policy.',checks:[{description:'The actual image read returned its model-sized result.',passed:true}],deliveries:[],unresolved:[]}},{id:`image-report-${task.id}`}),{stopReason:'toolUse'});
    }catch(caught){error=caught;throw caught;}
  };
  provider.setResponses(Array.from({length:30},()=>respond));core.providerRegistry.setProvider(provider.provider);core.models.save({id:'images.vision',name:'Vision',providerId:provider.provider.id,modelId:'vision'});core.models.save({id:'images.text',name:'Text',providerId:provider.provider.id,modelId:'text'});core.models.save({id:'default',name:'Default',providerId:provider.provider.id,modelId:'text'});
  try{
    fs.writeFileSync(path.join(directory,'workspace/image.png'),syntheticPng(32,16));
    for(const profile of ['images.vision','images.vision','images.text']){core.configure('runtime',{defaultWorkModel:profile});const task=await core.submitTask({title:'Read an image',content:'Read image.png with the current model.'},`synthetic-image-${profile}-${observed.length}`);const result=await until(()=>{if(error)throw error;return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));assert.equal(result.status,'succeeded',JSON.stringify({stages:[...stages],observed}));}
    assert.deepEqual(observed.slice(0,2).map(({model,width,height})=>({model,width,height})),[{model:'vision',width:8,height:4},{model:'vision',width:2,height:1}]);assert.equal(observed[2]!.model,'text');assert.match(observed[2]!.text,/does not support images/);assert.doesNotMatch(observed[0]!.text,/does not support images/);assert.equal(core.runtime.approvals().length,0);
  }finally{await core.close();await removeTemp(directory);}
});
