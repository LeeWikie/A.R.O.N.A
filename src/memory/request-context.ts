import {createHash} from 'node:crypto';
import {Agent,type AgentExecutionOptions} from '@mastra/core/agent';
import type {ProcessLLMRequestArgs} from '@mastra/core/processors';
import {contentText,getCurrentSystemMessage,getSystemMessageText,type Usage} from '@earendil-works/pi-ai';
import {AppError} from '../domain.js';
import {completedCompactionSummary} from '../compaction.js';
import {estimatePromptTokens} from '../auto-context.js';
import {prepareNativeRequestCompaction,completeNativeRequestCompaction,projectNativeRequestCompaction,type NativeRequestCompactionCheckpoint} from '../native-request-compaction.js';
import type {SessionModelDescriptor} from '../providers/session-replay.js';
import {measureMemoryText,getMemoryTokenizerIdentity} from './v1/tokens.js';

type Prompt=ProcessLLMRequestArgs['prompt'];
type ProviderOptions=NonNullable<AgentExecutionOptions['providerOptions']>;
type AgentModel=ConstructorParameters<typeof Agent>[0]['model'];
export interface MemoryRequestContextPolicy {
 contextWindow:number|null;descriptor?:SessionModelDescriptor;reserveTokens?:number;keepRecentTokens?:number;
}
interface Options {
 policy:MemoryRequestContextPolicy;model:AgentModel;providerOptions:ProviderOptions;toolSchemas:unknown;signal?:AbortSignal;
 check():void;record(value:Record<string,unknown>):void;usage(value:unknown,part:string):void;
}

/** One native request view; the original job, message list and evidence keep their identities. */
export class MemoryRequestContext {
 private checkpoint?:NativeRequestCompactionCheckpoint;
 private force=false;
 private lastRequestHash='';
 private readonly overflowRetries=new Set<string>();
 private readonly schemaTokens:number;
 constructor(private readonly options:Options){this.schemaTokens=measureMemoryText(JSON.stringify(options.toolSchemas)).textTokens;}
 private measure(prompt:Prompt,withTools=true){
  let media=0;
  const normalized=prompt.map(message=>typeof message.content==='string'?message:{...message,content:message.content.map(part=>{
   if(part.type==='file'){media++;return{...part,data:'[retained typed file]'};}
   if(part.type==='tool-result'&&part.output.type==='content')return{...part,output:{...part.output,value:part.output.value.map(item=>{
    // Native V2 uses media; the V4 lane uses file after SDK envelope conversion.
    const typed=item as unknown as {type?:string;mediaType?:string};
    if(typed.type!=='media'&&typed.type!=='file')return item;
    media++;return{...item,data:'[retained typed file]'};
   })}};
   return part;
  })});
  return measureMemoryText(JSON.stringify(normalized)).textTokens+(withTools?this.schemaTokens:0)+media*4096;
 }
 async project(args:ProcessLLMRequestArgs,evidence:Prompt):Promise<Prompt>{
  this.options.check();const messages=args.messageList?.get.all.db()??[],original={prompt:args.prompt,messages};
  const current=this.checkpoint?projectNativeRequestCompaction(original,this.checkpoint):args.prompt,full=[...evidence,...current];
  this.lastRequestHash=createHash('sha256').update(JSON.stringify(full)).digest('hex');
  const window=this.options.policy.contextWindow,known=window!==null&&Number.isSafeInteger(window)&&window>0,reserve=this.options.policy.reserveTokens??Math.min(16384,known?Math.floor(window/2):16384),before=this.measure(full);
  this.options.record({state:'measured',estimatedInputTokens:before,contextWindow:known?window:null,reserveTokens:reserve,exactForProvider:false,tokenizer:getMemoryTokenizerIdentity()});
  if(!this.force&&(!known||before<=window-reserve))return full;
  if(!messages.length)throw new AppError('memory_compaction_source_unavailable',409);
  const keep=this.options.policy.keepRecentTokens??Math.max(1,Math.min(20000,known?Math.floor(window/4):20000,Math.floor(estimatePromptTokens(current)/4)));
  const plan=await prepareNativeRequestCompaction({...original,descriptor:this.options.policy.descriptor,keepRecentTokens:keep,reserveTokens:reserve,checkpoint:this.checkpoint});
  if(!plan)throw new AppError('memory_compaction_boundary_unavailable',409);
  this.options.check();this.options.record({state:'running',coveredMessages:plan.coveredMessages,prefixHash:plan.prefixHash});
  try{
   const completed=await completeNativeRequestCompaction(plan,async({context,kind})=>{
    this.options.check();const users=context.messages.filter(row=>row.role==='user'),system=getCurrentSystemMessage(context.messages);
    if(users.length!==1||context.messages.some(row=>row.role!=='user'&&row.role!=='system')||typeof users[0]!.content!=='string'&&users[0]!.content.some(part=>part.type!=='text'))throw new AppError('memory_compaction_context_invalid',409);
    const prompt=typeof users[0]!.content==='string'?users[0]!.content:contentText(users[0]!.content),instructions=system?getSystemMessageText(system):'';
    const input:Prompt=[{role:'system',content:instructions},{role:'user',content:[{type:'text',text:prompt}]}];
    if(known&&this.measure(input,false)>window-reserve)throw new AppError('memory_compaction_summary_capacity',409);
    const summarizer=new Agent({id:'memory-context-summary',name:'Memory context summary',model:this.options.model,instructions});
    const output=await summarizer.generate(prompt,{maxSteps:1,abortSignal:this.options.signal,providerOptions:this.options.providerOptions});
    const text=await completedCompactionSummary({text:Promise.resolve(output.text),finishReason:Promise.resolve(output.finishReason),toolCalls:Promise.resolve(output.toolCalls)},'memory_compaction_summary_empty',this.options.signal);
    this.options.check();this.options.usage(output.totalUsage,kind);
    const raw=output.totalUsage,cacheRead=raw.cachedInputTokens??0,cacheWrite=raw.cacheCreationInputTokens??0,inputTokens=Math.max(0,(raw.inputTokens??0)-cacheRead-cacheWrite),outputTokens=raw.outputTokens??0;
    const usage:Usage={input:inputTokens,output:outputTokens,cacheRead,cacheWrite,totalTokens:raw.totalTokens??inputTokens+outputTokens+cacheRead+cacheWrite,...(raw.reasoningTokens!==undefined?{reasoning:raw.reasoningTokens}:{}),cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    return{text,usage};
   },{signal:this.options.signal});
   this.options.check();const projected=[...evidence,...projectNativeRequestCompaction(original,completed.checkpoint)],after=this.measure(projected);
   if(after>=before)throw new AppError('memory_compaction_did_not_reduce_context',409);
   if(known&&after>window-reserve)throw new AppError('memory_compaction_context_capacity',409);
   this.checkpoint=completed.checkpoint;this.force=false;
   this.lastRequestHash=createHash('sha256').update(JSON.stringify(projected)).digest('hex');
   this.options.record({state:'finished',checkpoint:completed.checkpoint,estimatedInputTokens:after,usage:completed.usage});
   return projected;
  }catch(error){this.options.record({state:this.options.signal?.aborted?'cancelled':error instanceof AppError&&error.code==='memory_execution_interrupted'?'interrupted':'failed',code:error instanceof AppError?error.code:this.options.signal?.aborted?'memory_compaction_cancelled':'memory_compaction_failed'});throw error;}
 }
 recover(error:unknown,retryCount:number){
  if(retryCount>0||!this.lastRequestHash||this.overflowRetries.has(this.lastRequestHash)||this.options.signal?.aborted)return;
  let value=error,overflow=false;
  for(let depth=0;value&&depth<5;depth++){
   const row=value as {message?:unknown;code?:unknown;responseBody?:unknown;cause?:unknown};
   if([row.message,row.code,row.responseBody].some(item=>typeof item==='string'&&/(?:context[_ -](?:length|window)[_ -](?:exceeded|limit)|maximum context length|prompt is too long|too many (?:input )?tokens)/i.test(item)))overflow=true;
   value=row.cause;
  }
  if(!overflow)return;this.overflowRetries.add(this.lastRequestHash);this.force=true;this.options.record({state:'overflow-retry',requestHash:this.lastRequestHash});return{retry:true as const};
 }
}
