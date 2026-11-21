import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {Core} from '../src/core.js';
import type {ModelConfig} from '../src/config.js';
import {MemoryRequestBudget} from '../src/memory/v1/request-budget.js';
import type {NativeMemoryV1Host} from '../src/memory/v1/runtime.js';
import type {ProcessLLMRequestArgs} from '@mastra/core/processors';
import {fauxAssistantMessage,fauxProvider,type TranscriptContext} from '@earendil-works/pi-ai';
import {getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {authenticatedApp,finished,removeTemp,until} from './helpers.js';

function responseFrames(output:Record<string,unknown>[],id:string){return new Response([...output.flatMap((item,output_index)=>{const text=Array.isArray(item.content)?item.content.find((part:unknown)=>part&&typeof part==='object'&&'type'in part&&part.type==='output_text')as{text?:unknown}|undefined:undefined;return[{type:'response.output_item.added',output_index,item:item.type==='function_call'?{...item,arguments:'',status:'in_progress'}:{...item,content:[],status:'in_progress'}},...(typeof text?.text==='string'?[{type:'response.output_text.delta',output_index,item_id:item.id,content_index:0,delta:text.text}]:[]),{type:'response.output_item.done',output_index,item}];}),{type:'response.completed',response:{id,model:'synthetic-model',status:'completed',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}].map(frame=>`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});}
for(const field of ['requestAuth','maxTokens','contextWindow']as const)test(`cold native continuation cannot silently change its original custom model ${field}`,{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-model-request-recovery-')),originalFetch=globalThis.fetch,requests:Array<{body:Record<string,unknown>;bearer:boolean;apiKey:boolean}>=[];
 const config:ModelConfig={protocol:'responses',baseURL:'https://model-request-contract.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-transport-key',authHeader:'bearer',requestAuth:'bearer',maxTokens:8000,contextWindow:200000};
 globalThis.fetch=async(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).hostname,'model-request-contract.invalid');requests.push({body:await request.json()as Record<string,unknown>,bearer:request.headers.has('authorization'),apiKey:request.headers.has('api-key')});return responseFrames(requests.length===1?[{type:'function_call',id:'fc_model_contract',call_id:'call_model_contract',name:'ask_user',arguments:JSON.stringify({question:'Continue the synthetic original run?',options:[{label:'Continue'}]}),status:'completed'}]:[{type:'message',id:'msg_model_contract',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic continuation.',annotations:[]}]}],'response-'+requests.length);};
 let core=await Core.open({dataDir:directory,modelConfig:config,memoryEnabled:false});
 try{
  const input=await core.submitMessage({content:'Keep this original custom model configuration.'}),question=await until(()=>core.interactions().find(row=>row.status==='pending'),Boolean);assert.ok(question);await until(()=>core.agent.listSuspendedRuns({threadId:'main',resourceId:'local'}),state=>state.total===1);await core.close();
  const changed={...config,...(field==='requestAuth'?{requestAuth:'api-key' as const}:field==='maxTokens'?{maxTokens:4000}:{contextWindow:100000})};core=await Core.open({dataDir:directory,modelConfig:changed,memoryEnabled:false});assert.equal(requests.length,1);
  await assert.rejects(core.answerInteraction(question.id,input.runId!,'Continue'),/interaction_not_active|run_recovery_configuration_changed/);assert.equal(requests.length,1,'the original run must not make a request under a new transport or output policy');assert.equal(core.store.getRun(input.runId!)?.status,'interrupted');
 }finally{await core.close();globalThis.fetch=originalFetch;await removeTemp(directory);}
});

test('model management probes honor the explicit authentication scheme accepted by profile configuration',{timeout:15000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-model-probe-contract-')),originalFetch=globalThis.fetch;let count=0;
 globalThis.fetch=async(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).hostname,'model-request-contract.invalid');assert.equal(request.headers.get('authorization'),null);assert.equal(request.headers.get('api-key'),'synthetic-only-probe-key');count++;return request.url.endsWith('/models')?Response.json({data:[{id:'synthetic-model'}]}):Response.json({id:'resp_probe_contract',model:'synthetic-model',status:'completed',output:[{type:'message',id:'msg_probe_contract',role:'assistant',content:[{type:'output_text',text:'OK',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});};
 const core=await Core.open({dataDir:directory,memoryEnabled:false});
 try{
  const app=authenticatedApp(core),draft={protocol:'responses',baseURL:'https://model-request-contract.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-probe-key',authHeader:'bearer',requestAuth:'api-key'};
  for(const route of ['/models/catalog','/models/test']){const response=await app.request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(draft)});assert.equal(response.status,200,JSON.stringify(await response.json()));}assert.equal(count,2);
 }finally{await core.close();globalThis.fetch=originalFetch;await removeTemp(directory);}
});

test('custom model memory reserves match the actual bounded auxiliary request and preserve original source evidence',{timeout:20000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-model-memory-reserve-')),originalFetch=globalThis.fetch,requests:Array<Record<string,unknown>>=[];
 const config:ModelConfig={protocol:'responses',baseURL:'https://model-request-contract.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-memory-key',authHeader:'bearer',requestAuth:'api-key',maxTokens:5000,contextWindow:200000};
 globalThis.fetch=async(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).hostname,'model-request-contract.invalid');assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.get('api-key'),config.apiKey);const body=await request.json()as Record<string,unknown>;requests.push(body);const output=[{type:'message',id:'msg_memory_contract_'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic source fact.',annotations:[]}]}];return body.stream?responseFrames(output,'resp_memory_'+requests.length):Response.json({id:'resp_memory_'+requests.length,model:'synthetic-model',status:'completed',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}});};
 let core=await Core.open({dataDir:directory,modelConfig:config,memoryContextMode:'v1',memoryEnabled:false});
 try{
  const source=await core.submitMessage({content:'Preserve this original source fact.'});assert.equal((await finished(core,source.runId!))?.status,'succeeded');const original=core.runtime.getSnapshot(source.runId!)!;
  const runtime=Reflect.get(core,'v1Runtime')as{host:NativeMemoryV1Host},selected=runtime.host.model(source.runId!);assert.equal(selected.contextWindow,config.contextWindow);assert.equal(selected.maxOutputTokens,config.maxTokens);
  const budget=new MemoryRequestBudget({contextWindow:selected.contextWindow,maxOutputTokens:selected.maxOutputTokens}),model=budget.wrap(core.models.resolve('default'));
  await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'Read the synthetic source fact.'}]}],providerOptions:selected.options});assert.equal(requests.at(-1)!.max_output_tokens,5000);assert.equal(budget.receipts()[0]!.outputReserve,requests.at(-1)!.max_output_tokens);assert.equal(budget.receipts()[0]!.contextWindowKnown,true);assert.deepEqual(core.runtime.getSnapshot(source.runId!),original,'auxiliary requests cannot rewrite the original prompt snapshot');
  await core.close();core=await Core.open({dataDir:directory,modelConfig:config,memoryContextMode:'v1',memoryEnabled:false});assert.deepEqual(core.runtime.getSnapshot(source.runId!),original);assert.equal(requests.length,2);const restored=(Reflect.get(core,'v1Runtime')as{host:NativeMemoryV1Host}).host.model(source.runId!);assert.equal(restored.contextWindow,config.contextWindow);assert.equal(restored.maxOutputTokens,config.maxTokens);
 }finally{await core.close();globalThis.fetch=originalFetch;await removeTemp(directory);}
});

test('an active native run summarizes with its frozen model and options after a profile is edited',{timeout:20000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-frozen-model-summary-')),originalFetch=globalThis.fetch,requests:Array<{host:string;maximum:unknown;bearer:boolean;key:boolean}>=[];
 const config:ModelConfig={protocol:'responses',baseURL:'https://model-request-contract.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-summary-key',authHeader:'bearer',requestAuth:'bearer',maxTokens:8000,contextWindow:200000};
 globalThis.fetch=async(input,init)=>{const request=new Request(input,init),body=await request.json()as Record<string,unknown>;requests.push({host:new URL(request.url).hostname,maximum:body.max_output_tokens,bearer:request.headers.has('authorization'),key:request.headers.has('api-key')});return responseFrames(requests.length===1?[{type:'function_call',id:'fc_summary_contract',call_id:'call_summary_contract',name:'ask_user',arguments:JSON.stringify({question:'Continue after retaining the frozen model?',options:[{label:'Continue'}]}),status:'completed'}]:[{type:'message',id:'msg_summary_contract',role:'assistant',status:'completed',content:[{type:'output_text',text:'A compact synthetic summary.',annotations:[]}]}],'response-summary-'+requests.length);};
 const core=await Core.open({dataDir:directory,modelConfig:config,memoryEnabled:false});
 try{
  await core.submitMessage({content:'Retain this original synthetic configuration.'});await until(()=>core.interactions().find(row=>row.status==='pending'),Boolean);await until(()=>core.agent.listSuspendedRuns({threadId:'main',resourceId:'local'}),state=>state.total===1);
  const {apiKey:_,...profile}=config;core.models.save({...profile,id:'default',name:'Edited profile',baseURL:'https://model-edited-contract.invalid/v1',requestAuth:'api-key',maxTokens:4000,apiKeyEnv:'SHITTIMCHEST_STARTUP_MODEL_KEY'});
  const view=(Reflect.get(core,'runViews')as Map<string,{forceCompaction?:boolean}>).get('main');assert.ok(view);view.forceCompaction=true;
  const prompt:ProcessLLMRequestArgs['prompt']=[{role:'system',content:'Synthetic context.'},...Array.from({length:8},(_,index)=>({role:index%2?'assistant' as const:'user' as const,content:[{type:'text' as const,text:`Source ${index}: `+'Retained synthetic material. '.repeat(300)}]}))];
  const summarize=Reflect.get(core,'automaticContextView')as(contextId:string,prompt:ProcessLLMRequestArgs['prompt'])=>Promise<ProcessLLMRequestArgs['prompt']>,result=await summarize.call(core,'main',prompt);assert.ok(JSON.stringify(result).length<JSON.stringify(prompt).length);assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0],'automatic compaction uses the same native frozen transport and total response reserve');
 }finally{await core.close();globalThis.fetch=originalFetch;await removeTemp(directory);}
});

test('custom profiles without new request-policy fields retain their exact legacy model signature',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-legacy-model-signature-')),config:ModelConfig={protocol:'responses',baseURL:'https://model-request-contract.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-signature-key',authHeader:'api-key'},core=await Core.open({dataDir:directory,modelConfig:config,memoryEnabled:false});
 try{const signature=Reflect.get(core,'modelSignature')as(profile:string)=>string;assert.equal(signature.call(core,'default'),createHash('sha256').update(JSON.stringify({protocol:config.protocol,baseURL:config.baseURL,modelId:config.modelId,authHeader:config.authHeader,credentialRef:'startup-config'})).digest('hex'));const {apiKey:_,...profile}=config;core.models.save({...profile,id:'legacy',name:'Legacy profile',apiKeyEnv:'SYNTHETIC_SIGNATURE_KEY'});assert.equal(signature.call(core,'legacy'),createHash('sha256').update(JSON.stringify({protocol:config.protocol,baseURL:config.baseURL,modelId:config.modelId,authHeader:config.authHeader,credentialRef:'SYNTHETIC_SIGNATURE_KEY'})).digest('hex'));}
 finally{await core.close();await removeTemp(directory);}
});

test('a native provider summary cannot recursively enter the active conversation capacity gate',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-summary-observer-')),core=await Core.open({dataDir:directory,memoryEnabled:false}),provider=fauxProvider({provider:'synthetic-summary-observer',models:[{id:'summary-model',contextWindow:24000,maxTokens:2000}]});let summaries=0;
 provider.setResponses(Array.from({length:10},()=>(context:TranscriptContext)=>{const summary=getCurrentTools(context.messages).length===0;if(summary)summaries++;return fauxAssistantMessage(summary?'Retain the original synthetic constraint.':'Synthetic complete.');}));core.providerRegistry.setProvider(provider.provider);core.models.save({id:'default',name:'Native summary model',providerId:provider.provider.id,modelId:'summary-model'});
 try{
  core.configure('runtime',{autoCompaction:{enabled:false,reserveTokens:1000,keepRecentTokens:500}});for(const content of Array.from({length:3},(_,index)=>`Original synthetic constraint ${index}. `+'old retained detail '.repeat(2800))){const input=await core.submitMessage({content});assert.equal((await finished(core,input.runId!))?.status,'succeeded');}
  core.configure('runtime',{autoCompaction:{enabled:true,reserveTokens:1000,keepRecentTokens:500}});const current=await core.submitMessage({content:'Continue the current exact input.'});assert.equal((await finished(core,current.runId!))?.status,'succeeded');assert.equal(summaries,1);assert.equal(provider.state.callCount,5,'one auxiliary summary and one primary request complete the same native run');const events=core.runtime.events('main',0,1000);assert.equal(events.filter(event=>event.kind==='compaction_state'&&(event.data as{state?:string}).state==='finished').length,1);const auxiliary=events.find(event=>event.kind==='model_auxiliary_start'&&event.runId===current.runId);assert.ok(auxiliary);const id=(auxiliary.data as{id:string}).id;for(const kind of['model_auxiliary_prompt','model_auxiliary_request','model_auxiliary_usage'])assert.ok(events.some(event=>event.kind===kind&&event.runId===current.runId&&(event.data as{id:string}).id===id),'the actual auxiliary request retains its own original run, prompt, native metadata and usage evidence');
 }finally{await core.close();await removeTemp(directory);}
});
