import assert from 'node:assert/strict';
import test from 'node:test';
import {Agent} from '@mastra/core/agent';
import {createTool} from '@mastra/core/tools';
import type {LanguageModelV4,LanguageModelV4CallOptions,LanguageModelV4StreamPart} from '@ai-sdk/provider';
import {z} from 'zod';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Core} from '../src/core.js';
import {finished,removeTemp} from './helpers.js';
import {createProvider,type Model} from '@earendil-works/pi-ai';
import {openAIResponsesApi} from '@earendil-works/pi-ai/api/openai-responses.lazy';

test('native V4 prompt retains a thrown local tool failure for the next model step',async()=>{
 const requests:LanguageModelV4CallOptions[]=[],failure='synthetic_tool_failure';
 const model:LanguageModelV4={specificationVersion:'v4',provider:'synthetic',modelId:'failure-replay',supportedUrls:{},doGenerate:async()=>{throw Error('stream required');},doStream:async options=>{
  requests.push(structuredClone({...options,abortSignal:undefined}));const first=requests.length===1;
  const parts:LanguageModelV4StreamPart[]=[{type:'stream-start',warnings:[]},...(first?[{type:'tool-call' as const,toolCallId:'call_failure',toolName:'fail',input:'{}'}]:[{type:'text-start' as const,id:'answer'},{type:'text-delta' as const,id:'answer',delta:'The tool failed.'},{type:'text-end' as const,id:'answer'}]),{type:'finish',finishReason:{unified:first?'tool-calls':'stop',raw:first?'tool_calls':'stop'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}}];
  return{stream:new ReadableStream({start(controller){for(const part of parts)controller.enqueue(part);controller.close();}})};
 }};
 const agent=new Agent({id:'failure-replay',name:'Synthetic failure replay',instructions:'Report the actual tool failure.',model,tools:{fail:createTool({id:'fail',description:'Fail without side effects.',inputSchema:z.object({}).strict(),execute:async()=>{throw Error(failure);}})}});
 const output=await agent.stream('Try the failing tool.',{maxSteps:3});await output.getFullOutput();assert.equal(requests.length,2);
 const result=requests[1]!.prompt.flatMap(message=>message.role==='tool'?message.content:[]).find(part=>part.type==='tool-result');assert.ok(result);assert.equal(result.toolCallId,'call_failure');assert.ok(result.output.type==='error-text'||result.output.type==='error-json');assert.equal(result.output.value,failure);
});

for(const viaPi of [false,true])test(`Core host tool failure remains a valid actual ${viaPi?'Pi':'startup'} Responses result on continuation and restart`,{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'arona-host-failure-replay-')),originalFetch=globalThis.fetch,id=randomUUID();
 const requests:Array<{input:Array<Record<string,unknown>>}>=[],prompts:LanguageModelV4CallOptions['prompt'][]=[];
 globalThis.fetch=async(input,init)=>{
  const request=new Request(input,init);assert.ok(request.url.startsWith('https://failure.invalid/'));requests.push(await request.json() as typeof requests[number]);
  const output=requests.length===1?[{type:'function_call' as const,status:'completed',id:'fc_host_failure',call_id:'call_host_failure',name:'task_get',arguments:JSON.stringify({id:randomUUID()})}]:[{type:'message' as const,id:'msg_failure_reply',role:'assistant',status:'completed',content:[{type:'output_text',text:'任务参数不正确，任务尚未开始。',annotations:[]}]}];
  const frames=[...output.flatMap((item,output_index)=>[{type:'response.output_item.added',output_index,item:item.type==='function_call'?{...item,status:'in_progress',arguments:''}:{...item,status:'in_progress',content:[]}},item.type==='function_call'?{type:'response.function_call_arguments.delta',output_index,item_id:item.id,delta:item.arguments}:{type:'response.output_text.delta',output_index,item_id:item.id,content_index:0,delta:item.content?.[0]?.text},{type:'response.output_item.done',output_index,item}]),{type:'response.completed',response:{id:'resp_failure',model:'synthetic-model',status:'completed',output,usage:{input_tokens:1,output_tokens:2,total_tokens:3}}}];
  return new Response(frames.map(frame=>`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 let core:Core|undefined;
 const open=async()=>{
  const app=await Core.open({dataDir:directory,memoryEnabled:false,modelConfig:{protocol:'responses',modelId:'synthetic-model',baseURL:'https://failure.invalid/v1',apiKey:'synthetic-only-key',authHeader:'bearer'}});
  if(viaPi){
   const model:Model<'openai-responses'>={id:'synthetic-model',name:'Synthetic model',api:'openai-responses',provider:'failure-fixture',baseUrl:'https://failure.invalid/v1',reasoning:false,input:['text'],contextWindow:64000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
   app.providerRegistry.setProvider(createProvider({id:model.provider,name:'Synthetic provider',baseUrl:model.baseUrl,models:[model],api:openAIResponsesApi(),auth:{apiKey:{name:'Synthetic key',resolve:async()=>({auth:{apiKey:'synthetic-only-key'},source:'fixture'})}}}));
   app.models.save({id:'default',name:'Synthetic model',providerId:model.provider,modelId:model.id});
  }
  const resolve=app.models.resolve.bind(app.models);app.models.resolve=(...args)=>{const model=resolve(...args);return{specificationVersion:'v4',provider:model.provider,modelId:model.modelId,supportedUrls:model.supportedUrls,doGenerate:options=>model.doGenerate(options),doStream:options=>{prompts.push(structuredClone(options.prompt));return model.doStream(options);}};};
  return app;
 };
 try{
  core=await open();const receipt=await core.submitMessage({id,content:'Inspect the missing synthetic task.'});assert.equal((await finished(core,receipt.runId!))?.status,'succeeded',JSON.stringify({errors:core.runtime.events(undefined,0,2000).filter(event=>event.kind==='model_error_observed').map(event=>(event.data as {error?:{message?:string}}).error?.message?.slice(0,300)),results:prompts.flatMap(prompt=>prompt.flatMap(message=>message.role==='tool'?message.content:[]))}));
  const assertOutput=()=>{const output=requests.at(-1)!.input.find(part=>part.type==='function_call_output'&&part.call_id==='call_host_failure');assert.ok(output);assert.equal(typeof output.output,'string');assert.ok(String(output.output).includes('task_not_found'));};
  assertOutput();assert.equal(core.runtime.tasks().length,0);
  await core.close();core=await open();const continued=await core.submitMessage({content:'Continue after the failed tool.'});assert.equal((await finished(core,continued.runId!))?.status,'succeeded');assertOutput();
 }finally{await core?.close();globalThis.fetch=originalFetch;await removeTemp(directory);}
});
