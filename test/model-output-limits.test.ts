import assert from 'node:assert/strict';
import test from 'node:test';
import {createModel} from '../src/model.js';
import type {ModelConfig} from '../src/config.js';

for(const protocol of ['responses','chat-completions','messages'] as const)for(const streaming of [false,true])test(`${protocol} ${streaming?'stream':'generate'} sends the configured output ceiling and respects stricter caller limits`,async()=>{
 const previous=globalThis.fetch,requests:Array<Record<string,unknown>>=[];
 globalThis.fetch=async(input,init)=>{
  const request=new Request(input,init);assert.ok(request.url.startsWith('https://output-limit.invalid/'));const body=await request.json() as Record<string,unknown>;requests.push(body);
  const usage={input_tokens:1,output_tokens:1};
  const answer={type:'message',id:'msg_limit',role:'assistant',status:'completed',content:[{type:'output_text',text:'answer',annotations:[]}]};
  if(protocol==='responses'){
   const response={id:'resp_limit',model:'synthetic-model',status:'completed',output:[answer],usage:{...usage,total_tokens:2}};
   if(!body.stream)return Response.json(response);
   return sse([{type:'response.output_item.added',output_index:0,item:{...answer,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:answer.id,output_index:0,content_index:0,delta:'answer'},{type:'response.output_item.done',output_index:0,item:answer},{type:'response.completed',response}]);
  }
  if(protocol==='chat-completions'){
   const base={id:'chat_limit',created:1,model:'synthetic-model'};
   if(!body.stream)return Response.json({...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'answer'},finish_reason:'stop',logprobs:null}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
   return sse([{...base,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'answer'},finish_reason:null}]},{...base,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}]);
  }
  const message={id:'msg_limit',type:'message',role:'assistant',model:'synthetic-model',content:[{type:'text',text:'answer'}],stop_reason:'end_turn',stop_sequence:null,usage};
  if(!body.stream)return Response.json(message);
  return sse([{type:'message_start',message:{...message,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'answer'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}]);
 };
 try{
  const config:ModelConfig={protocol,baseURL:'https://output-limit.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-key',authHeader:'bearer',maxTokens:5000};const model=createModel(config);
  for(const [requested,expected]of [[undefined,5000],[1024,1024],[10000,5000]] as const){
   const options={prompt:[{role:'user' as const,content:[{type:'text' as const,text:'Synthetic request.'}]}],...(requested===undefined?{}:{maxOutputTokens:requested})},original=structuredClone(options);
   if(streaming){const response=await model.doStream(options);for await(const _ of response.stream){/* Drain the actual provider parser. */}}
   else{const response=await model.doGenerate(options);assert.equal(response.content.find(part=>part.type==='text')?.text,'answer');}
   const request=requests.at(-1)!;assert.equal(request[protocol==='responses'?'max_output_tokens':'max_tokens'],expected);assert.deepEqual(options,original);
  }
 }finally{globalThis.fetch=previous;}
});
function sse(frames:Record<string,unknown>[]){return new Response(frames.map(frame=>`event: ${typeof frame.type==='string'?frame.type:'message'}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});}

for(const streaming of [false,true])test(`Messages ${streaming?'stream':'generate'} shares the output reserve with native thinking and preserves caller options`,async()=>{
 const requests:Array<Record<string,unknown>>=[];
 const transport:typeof globalThis.fetch=async(input,init)=>{
  const request=new Request(input,init);const body=await request.json() as Record<string,unknown>;requests.push(body);
  const message={id:'msg_budget',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
  if(!body.stream)return Response.json(message);
  return sse([{type:'message_start',message:{...message,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'answer'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}]);
 };
 for(const fixture of [
  {maximum:8000,requested:8000,budget:6976,total:8000,actualBudget:6976},
  {maximum:5000,requested:undefined,budget:16000,total:5000,actualBudget:3976},
  {maximum:5000,requested:3000,budget:16000,total:3000,actualBudget:1976},
  {maximum:undefined,requested:8000,budget:16000,total:8000,actualBudget:6976},
  {maximum:5000,requested:undefined,budget:undefined,total:5000,actualBudget:1024},
  {maximum:2048,requested:undefined,budget:16000,total:2048,actualBudget:1024},
 ]){
  const model=createModel({protocol:'messages',baseURL:'https://output-limit.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-key',authHeader:'api-key',...(fixture.maximum===undefined?{}:{maxTokens:fixture.maximum})},transport);
  const options={prompt:[{role:'user' as const,content:[{type:'text' as const,text:'Synthetic request.'}]}],...(fixture.requested===undefined?{}:{maxOutputTokens:fixture.requested}),providerOptions:{anthropic:{thinking:{type:'enabled',...(fixture.budget===undefined?{}:{budgetTokens:fixture.budget})}}}};
  const before=structuredClone(options);
  if(streaming){const result=await model.doStream(options);for await(const _ of result.stream){}}
  else await model.doGenerate(options);
  const body=requests.at(-1)!;assert.equal(body.max_tokens,fixture.total);assert.equal((body.thinking as {budget_tokens:number}).budget_tokens,fixture.actualBudget);assert.deepEqual(options,before);
 }
 const count=requests.length,small=createModel({protocol:'messages',baseURL:'https://output-limit.invalid/v1',modelId:'synthetic-model',apiKey:'synthetic-only-key',authHeader:'api-key',maxTokens:2047},transport);
 const invoke=()=>small[streaming?'doStream':'doGenerate']({prompt:[],providerOptions:{anthropic:{thinking:{type:'enabled',budgetTokens:16000}}}});
 await assert.rejects(async()=>invoke(),/model_thinking_output_capacity/);assert.equal(requests.length,count);
});
