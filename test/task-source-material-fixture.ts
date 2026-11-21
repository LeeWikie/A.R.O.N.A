import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {splitQueueText} from '../src/queue-content.js';
import {until} from './helpers.js';

const [directory,mode]=process.argv.slice(2);if(!directory||!mode)throw Error('fixture_arguments_required');
const raw='SYNTHETIC_CRASH_SOURCE_START\n'+'甲'.repeat(63000)+'SYNTHETIC_CRASH_MIDDLE_A😀'+'乙'.repeat(63000)+'SYNTHETIC_CRASH_MIDDLE_B😀'+'丙'.repeat(24000)+'\nSYNTHETIC_CRASH_SOURCE_END',parts=splitQueueText(raw);
import {syntheticPng} from './fixtures/png.js';
import {hasNativeImage} from './fixtures/model-images.js';
const png=syntheticPng(1,1);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');let core!:Core,mainCalls=0,workerCalls=0,failure:unknown;
function reply(name?:string,input?:unknown){return{stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(name)c.enqueue({type:'tool-call',toolCallId:randomUUID(),toolName:name,input:JSON.stringify(input)});c.enqueue({type:'finish',finishReason:name?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}
const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return mode==='park'&&mainCalls++===0?reply('task_create',{task:{title:'Inspect original data after a restart',content:'Inspect all source text and files, ask once, then report.'}}):reply();
  workerCalls++;const text=request.prompt.map(message=>typeof message.content==='string'?message.content:message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')).join('\n');for(const part of parts)assert.equal(text.split(part).length-1,1);for(let index=0;index<8;index++)assert.equal(text.split(`SYNTHETIC_CRASH_ATTACHMENT_${index}`).length-1,1);assert.ok(hasNativeImage(request.prompt,png));
  if(mode==='park')return reply('ask_user',{question:'Continue after the restart?',options:[{label:'Continue'},{label:'Stop'}]});const task=core.runtime.tasks()[0]!;if(task.report)return reply();return reply('task_report',{id:task.id,report:{outcome:'succeeded',summary:'Verified all original source data after a restart.',checks:[{description:'Complete original text and all nine attachments.',passed:true}],deliveries:[],unresolved:[]}});
}catch(error){failure=error;throw error;}}});
core=await Core.open({dataDir:directory,model,memoryEnabled:false,modelConfig:{protocol:'responses',baseURL:'https://synthetic.invalid/v1',apiKey:'synthetic',authHeader:'bearer',modelId:'source-material',contextWindow:512000,maxTokens:1024}});
function inspection(){const task=core.runtime.tasks()[0];return{type:'inspection',workerCalls,task,interactions:core.interactions(),sourceBodies:task?.sourceSignalIds.map(id=>hash(String(core.store.db.prepare('SELECT body FROM signals WHERE id=?').get(id)!.body))),proof:task?Boolean(core.runtime.setting(`run-recovery:${task.runIds[0]}`,null)):false};}
process.on('message',async message=>{try{if(!message||typeof message!=='object'||!('type'in message))return;if(message.type==='inspect')process.send?.(inspection());else if(message.type==='answer'){const gate=core.interactions().find(item=>item.status==='pending')!;await core.answerInteraction(gate.id,gate.runId,'Continue');await until(()=>{if(failure)throw failure;return core.runtime.tasks()[0];},task=>task?.status==='succeeded');process.send?.({...inspection(),type:'complete'});}else if(message.type==='close'){await core.close();process.disconnect?.();}}catch(error){process.send?.({type:'error',message:String(error)});}});
if(mode==='park'){
  const attachments:string[]=[];for(let index=0;index<8;index++)attachments.push((await core.assets.put(new Response(`SYNTHETIC_CRASH_ATTACHMENT_${index}`).body,`source-${index}.txt`)).id);attachments.push((await core.assets.put(new Response(new Uint8Array(png)).body,'original.png')).id);
  const draft=core.queueEditor().create('main',{captureQueue:false,localCapture:true,current:{clientDraftId:randomUUID(),content:'placeholder',attachments:[]}},'create'),entry=core.queueEditor().page('main',draft.id).entries[0]!;
  const upload=core.queueEditor().beginEntryEdit('main',draft.id,{entryId:entry.id,expectedRevision:draft.revision,partCount:parts.length,characters:raw.length,hash:hash(raw),attachments},'parts');for(const[index,content]of parts.entries())core.queueEditor().writeEntryPart('main',draft.id,upload.id,index,{content});const committed=core.queueEditor().commitEntryEdit('main',draft.id,upload.id);await core.queueEditor().submit('main',draft.id,{expectedRevision:committed.revision},'submit');
  await until(()=>{if(failure)throw failure;return inspection();},value=>value.task?.status==='waiting'&&value.proof);
}
process.send?.({...inspection(),type:'ready'});
