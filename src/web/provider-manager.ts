/*! Selection and one-call rescue adapted from Hermes 0.23.1 tools/web_tools_rescue.py
 * and plugins/web/keyless_mcp.py. Copyright (c) 2025 Nous Research. MIT license in LICENSE.hermes.
 */
import {AppError} from '../domain.js';
import {WebBlockedError} from './network.js';
import {WebMemo,searchBucket,searchQueryKey} from './memo.js';
import {WebProviderRing,isKeylessProvider,type WebProviderRuntime,type ResolvedProvider,type WebProviderName} from './provider-config.js';
import type {WebProviderClient,ProviderDocument} from './provider-client.js';
import {WebProviderError,searchCanFailover,extractCanFailover,providerFailure,isOriginError,type WebSearchHit,type ProviderReceipt,type ProviderAttempt} from './provider-protocol.js';

export interface BackendAttempt {provider:WebProviderName;mode:'keyed'|'keyless';outcome:'succeeded'|'failed';error?:string;receipt?:ProviderReceipt;requests?:ProviderAttempt[]}
export type ProviderSearchOutcome={status:'ok';provider:WebProviderName;mode:'keyed'|'keyless';hits:WebSearchHit[];attempts:BackendAttempt[];rescuedFrom?:WebProviderName;backendError?:string;servedBy?:WebProviderName}|{status:'error';error:string;attempts:BackendAttempt[]}|{status:'not configured';reason:string;attempts:BackendAttempt[]};
export interface ProviderExtractOutcome {provider:WebProviderName;mode:'keyed'|'keyless';pages:ProviderDocument[];attempts:BackendAttempt[];rescuedFrom?:WebProviderName;backendError?:string;servedBy?:WebProviderName}
const message=(error:unknown)=>error instanceof Error?error.message:'Web provider failed';
const fatal=(error:unknown)=>error instanceof WebBlockedError||error instanceof AppError;
type ProviderClient=Pick<WebProviderClient,'search'|'extract'>;

/** Provider retries and fact memoization do not own Agent runs, tasks, approvals or source authority. */
export class WebProviderManager{
  private readonly memos=new Map<string,WebMemo<ProviderSearchOutcome>>();
  constructor(private readonly client:ProviderClient,readonly ring=new WebProviderRing(),private readonly searchTtlMs?:number){}
  private keyless(runtime:WebProviderRuntime,name:WebProviderName):ResolvedProvider{return {name,mode:'keyless',key:'',endpoint:runtime.endpoints[name],explicit:false,selfHosted:false};}
  private pinned(runtime:WebProviderRuntime,provider:ResolvedProvider){return provider.explicit||runtime.configuration.providerTiers[provider.name]==='free'?provider.name:undefined;}
  private rescueAllowed(runtime:WebProviderRuntime,provider:ResolvedProvider){return runtime.configuration.keylessFallback&&runtime.configuration.keylessRescue&&!(isKeylessProvider(provider.name)&&provider.mode==='keyless');}
  private failed(provider:ResolvedProvider,error:unknown):BackendAttempt{return {provider:provider.name,mode:provider.mode,outcome:'failed',error:message(error),...(error instanceof WebProviderError&&error.receipt?{receipt:error.receipt}:{}),...(error instanceof WebProviderError&&error.attempts?{requests:error.attempts}:{})};}
  private async searchAttempt(provider:ResolvedProvider,query:string,count:number,attempts:BackendAttempt[],signal?:AbortSignal){try{const value=await this.client.search(provider,query,count,signal);attempts.push({provider:provider.name,mode:provider.mode,outcome:'succeeded',receipt:value.receipt});return {value};}catch(error){signal?.throwIfAborted();if(fatal(error))throw error;attempts.push(this.failed(provider,error));return {error:message(error)};}}
  private async searchRing(runtime:WebProviderRuntime,requested:ResolvedProvider,query:string,count:number,attempts:BackendAttempt[],signal?:AbortSignal){
    const order=this.ring.order(runtime,this.pinned(runtime,requested));let error='All anonymous web providers are pinned to paid tiers.',exhausted=false;
    for(const name of order){signal?.throwIfAborted();const provider=this.keyless(runtime,name),result=await this.searchAttempt(provider,query,count,attempts,signal);if(result.value)return {provider,result:result.value};error=result.error??'Web provider search failed';if(!searchCanFailover(error))break;exhausted=name===order.at(-1);}
    return {error:order.length?`${error}${exhausted?` (all anonymous providers unavailable: ${order.join(', ')})`:''}`:error};
  }
  private async runSearch(runtime:WebProviderRuntime,query:string,count:number,signal?:AbortSignal):Promise<ProviderSearchOutcome>{
    const route=runtime.search;if(route.kind!=='provider')return {status:'not configured',reason:route.kind==='disabled'?route.reason:'The selected backend cannot search.',attempts:[]};const requested=route.provider,attempts:BackendAttempt[]=[];
    if(requested.mode==='keyless'&&isKeylessProvider(requested.name)){const selected=await this.searchRing(runtime,requested,query,count,attempts,signal);if(selected.result&&selected.provider)return {status:'ok',provider:selected.provider.name,mode:'keyless',hits:selected.result.hits,attempts,...(selected.provider.name!==requested.name?{servedBy:selected.provider.name}:{})};return {status:'error',error:selected.error??'Web search failed',attempts};}
    const primary=await this.searchAttempt(requested,query,count,attempts,signal);if(primary.value)return {status:'ok',provider:requested.name,mode:requested.mode,hits:primary.value.hits,attempts};const original=primary.error??'Web search failed';
    if(this.rescueAllowed(runtime,requested)){const rescued=await this.searchRing(runtime,requested,query,count,attempts,signal);if(rescued.result&&rescued.provider)return {status:'ok',provider:rescued.provider.name,mode:'keyless',hits:rescued.result.hits,attempts,rescuedFrom:requested.name,backendError:original,...(rescued.provider.name!==requested.name?{servedBy:rescued.provider.name}:{})};return {status:'error',error:`${original} (anonymous rescue also failed: ${rescued.error??'unknown error'})`,attempts};}
    return {status:'error',error:original,attempts};
  }
  async search(runtime:WebProviderRuntime,query:string,count:number,signal?:AbortSignal):Promise<ProviderSearchOutcome&{cached:boolean}>{
    signal?.throwIfAborted();const ttl=this.searchTtlMs??(runtime.configuration.cacheEnabled?runtime.configuration.cacheTtlMinutes*60000:0);let memo=this.memos.get(runtime.identity);if(!memo){while(this.memos.size>=4)this.memos.delete(this.memos.keys().next().value!);memo=new WebMemo(ttl);this.memos.set(runtime.identity,memo);}const provider=runtime.search.kind==='provider'?runtime.search.provider.name:runtime.search.kind,key=JSON.stringify([provider,searchQueryKey(query),searchBucket(count)]),result=await memo.get(key,signal=>this.runSearch(runtime,query,searchBucket(count),signal),signal,value=>value.status==='ok'&&!value.rescuedFrom);const outcome=result.value;return {...outcome,...(outcome.status==='ok'?{hits:outcome.hits.slice(0,count)}:{}),cached:result.cached};
  }
  private async extractAttempt(provider:ResolvedProvider,urls:readonly string[],mode:'text'|'markdown',attempts:BackendAttempt[],signal?:AbortSignal){try{const pages=await this.client.extract(provider,urls,mode,signal);attempts.push({provider:provider.name,mode:provider.mode,outcome:pages.every(page=>Boolean(page.error))?'failed':'succeeded',...(pages.find(page=>page.receipt)?.receipt?{receipt:pages.find(page=>page.receipt)!.receipt}:{})});return pages;}catch(error){signal?.throwIfAborted();if(fatal(error))throw error;attempts.push(this.failed(provider,error));return urls.map(url=>({...providerFailure(url,message(error)),...(error instanceof WebProviderError&&error.receipt?{receipt:error.receipt}:{})}));}}
  private async extractRing(runtime:WebProviderRuntime,requested:ResolvedProvider,urls:readonly string[],mode:'text'|'markdown',attempts:BackendAttempt[],signal?:AbortSignal){const order=this.ring.order(runtime,this.pinned(runtime,requested));if(!order.length)return {provider:requested,pages:urls.map(url=>providerFailure(url,'All anonymous web providers are pinned to paid tiers.'))};let provider=requested,pages:ProviderDocument[]=[];for(const name of order){provider=this.keyless(runtime,name);pages=await this.extractAttempt(provider,urls,mode,attempts,signal);if(!extractCanFailover(pages))break;}return {provider,pages};}
  async extract(runtime:WebProviderRuntime,urls:readonly string[],mode:'text'|'markdown',signal?:AbortSignal):Promise<ProviderExtractOutcome>{
    signal?.throwIfAborted();const route=runtime.extract;if(route.kind!=='provider')throw new WebProviderError(route.kind==='disabled'?route.reason:'Direct HTTP extraction does not use a vendor.');const requested=route.provider,attempts:BackendAttempt[]=[];if(requested.name==='brave'||requested.name==='searxng')throw new WebProviderError(`${requested.name} is a search-only provider and cannot extract URLs.`);
    if(requested.mode==='keyless'&&isKeylessProvider(requested.name)){const value=await this.extractRing(runtime,requested,urls,mode,attempts,signal);return {provider:value.provider.name,mode:'keyless',pages:value.pages,attempts,...(value.provider.name!==requested.name?{servedBy:value.provider.name}:{})};}
    const pages=await this.extractAttempt(requested,urls,mode,attempts,signal),failed=pages.length>0&&pages.every(page=>Boolean(page.error))&&!pages.some(page=>isOriginError(page.error));if(failed&&this.rescueAllowed(runtime,requested)){const rescued=await this.extractRing(runtime,requested,urls,mode,attempts,signal);if(rescued.pages.some(page=>!page.error))return {provider:rescued.provider.name,mode:'keyless',pages:rescued.pages,attempts,rescuedFrom:requested.name,backendError:pages.find(page=>page.error)?.error,...(rescued.provider.name!==requested.name?{servedBy:rescued.provider.name}:{})};}
    return {provider:requested.name,mode:requested.mode,pages,attempts};
  }
}
