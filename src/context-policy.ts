import {createHash,randomUUID} from 'node:crypto';
import {estimateMessageTokens,estimateTextTokens} from '@earendil-works/pi-ai/utils/estimate';
import type {RuntimeStore} from './runtime-store.js';
import type {PiRequestObserver} from './providers/bridge.js';
import {AppError} from './domain.js';

export interface ContextCapacity {
  requestId:string;profileId:string;providerId:string;modelId:string;estimatedInputTokens:number;
  contextWindow:number|null;outputReserveTokens:number;safetyMarginTokens:number;availableInputTokens:number|null;
  contextWindowSource:'provider-metadata'|'unknown';outputReserveIsHardLimit:false;estimator:'pi-ai-1.5.0';
  basis:'heuristic'|'reported-prefix-plus-estimate';estimateIsExact:false;imageEstimateIsExact:false;
  lastReportedInputTokens?:number;lastReportedOutputTokens?:number;overBudget:boolean;
  policy:'warn'|'block';blockedBeforeProvider:boolean;updatedAt:string;
}
interface Basis {hashes:string[];toolsHash:string;inputTokens:number;provider:string;model:string}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Observes the exact normalized provider context; it never removes or rewrites history. */
export class ContextPolicy {
  constructor(private readonly store:RuntimeStore){}
  view(contextId:string){return this.store.setting<ContextCapacity|null>(`context-capacity:${contextId}`,null);}
  observer(contextId:string,profileId:string):PiRequestObserver {
    const policy=this.store.setting<'warn'|'block'>('context-overflow','warn');
    return ({context,model,options})=>{
      const hashes=context.messages.map(message=>digest({...message,timestamp:undefined}));const toolsHash=digest(context.tools??[]);
      const previous=this.store.setting<Basis|null>(`context-capacity-basis:${contextId}`,null);
      const matches=previous&&previous.provider===model.provider&&previous.model===model.id&&previous.toolsHash===toolsHash&&previous.hashes.length<=hashes.length&&previous.hashes.every((hash,i)=>hashes[i]===hash);
      const estimate=matches?previous.inputTokens+context.messages.slice(previous.hashes.length).reduce((sum,message)=>sum+estimateMessageTokens(message),0):context.messages.reduce((sum,message)=>sum+estimateMessageTokens(message),0)+estimateTextTokens(JSON.stringify(context.tools??[]));
      const window=Number.isFinite(model.contextWindow)&&model.contextWindow>0?model.contextWindow:null;
      const reserve=Math.min(options.maxTokens??model.maxTokens,window?Math.max(1,Math.floor(window/4)):model.maxTokens);const margin=4096;
      const available=window===null?null:Math.max(0,window-reserve-margin);const over=available!==null&&estimate>available;
      const value:ContextCapacity={requestId:randomUUID(),profileId,providerId:model.provider,modelId:model.id,estimatedInputTokens:estimate,contextWindow:window,outputReserveTokens:reserve,safetyMarginTokens:margin,availableInputTokens:available,contextWindowSource:window?'provider-metadata':'unknown',outputReserveIsHardLimit:false,estimator:'pi-ai-1.5.0',basis:matches?'reported-prefix-plus-estimate':'heuristic',estimateIsExact:false,imageEstimateIsExact:false,overBudget:over,policy,blockedBeforeProvider:over&&policy==='block',updatedAt:new Date().toISOString()};
      this.store.setSetting(`context-capacity:${contextId}`,value);this.store.event({contextId,kind:'capacity_state',data:value});
      if(value.blockedBeforeProvider)throw new AppError('context_capacity_exceeded',409);
      return usage=>{
        const input=usage.input+usage.cacheRead+usage.cacheWrite;
        if(input===0&&usage.output===0&&usage.totalTokens===0)return;
        if(input>0)this.store.setSetting(`context-capacity-basis:${contextId}`,{hashes,toolsHash,inputTokens:input,provider:model.provider,model:model.id} satisfies Basis);
        const current=this.view(contextId);if(current?.requestId!==value.requestId)return;
        const measured={...value,lastReportedInputTokens:input,lastReportedOutputTokens:usage.output,updatedAt:new Date().toISOString()};this.store.setSetting(`context-capacity:${contextId}`,measured);this.store.event({contextId,kind:'capacity_state',data:measured});
      };
    };
  }
}
