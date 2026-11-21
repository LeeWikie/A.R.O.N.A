import assert from 'node:assert/strict';
import {zstdDecompressSync} from 'node:zlib';
import type {Context, Model, Models} from '@earendil-works/pi-ai';
import {stream as codexStream} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';
import {createPiLanguageModel} from '../src/providers/bridge.js';

export const model:Model<'openai-codex-responses'>={id:'synthetic-occurrences',name:'Synthetic occurrences',api:'openai-codex-responses',provider:'openai-codex',baseUrl:'https://occurrences.invalid/backend-api',input:['text'],reasoning:true,contextWindow:64000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const token=`aaa.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64')}.bbb`;
export const opaque={type:'reasoning',id:'rs_occurrences',summary:[],encrypted_content:'SYNTHETIC-OPAQUE-REASONING'};
export const between={type:'message',id:'msg_between',role:'assistant',status:'completed',content:[{type:'output_text',text:'between original calls',annotations:[]}]};
const answer={type:'message',id:'msg_answer',role:'assistant',status:'completed',content:[{type:'output_text',text:'finished',annotations:[]}]};
type Item=Record<string,unknown>;
export function fixture(duplicate=false,sameArguments=false){
 const requests:Array<{input:Item[]}>=[],contexts:Context[]=[];
 const calls=[{type:'function_call',id:'fc_first',call_id:'call_first',name:'echo',arguments:JSON.stringify({value:'first'})},{type:'function_call',id:duplicate?'fc_first':'fc_second',call_id:duplicate?'call_first':'call_second',name:'echo',arguments:JSON.stringify({value:sameArguments?'first':'second'})}];
 const output=[opaque,calls[0]!,between,calls[1]!];
 const fetch:typeof globalThis.fetch=async(input,init)=>{
  const request=new Request(input,init);assert.ok(request.url.startsWith(model.baseUrl+'/'));
  let bytes=Buffer.from(await request.arrayBuffer());if(request.headers.get('content-encoding')==='zstd')bytes=zstdDecompressSync(bytes);requests.push(JSON.parse(bytes.toString('utf8')));
  const first=requests.length===1,items=first?output:[answer];
  // Parallel provider slots start in their original order, then finish in reverse.
  const frames=[...items.map((item,output_index)=>({type:'response.output_item.added',output_index,item:item.type==='function_call'?{...item,arguments:''}:item.type==='message'?{...item,content:[]}: {...item,encrypted_content:undefined}})),...items.map((item,output_index)=>({type:'response.output_item.done',output_index,item})).reverse(),{type:'response.completed',response:{id:'resp_occurrences_'+requests.length,status:'completed',model:model.id,output:items,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  return new Response(frames.map(frame=>`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const registry:Pick<Models,'streamSimple'>={streamSimple(target,context,options){contexts.push(structuredClone(context));return codexStream(target as Model<'openai-codex-responses'>,normalizeContext(context),{...options,apiKey:token,fetch,transport:'sse',maxRetries:0});}};
 return {lm:createPiLanguageModel(registry,model),registry,requests,contexts,calls,output};
}

