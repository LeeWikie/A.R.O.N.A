import {createHash} from 'node:crypto';
import type {ToolExecutionContext} from '@mastra/core/tools';
import {AppError} from '../domain.js';
import type {WebHost} from './index.js';
import {validateWebTarget,WebBlockedError} from './network.js';
import {urlContainsCredential} from './url-credentials.js';
import {extract} from './extract.js';
import {cleanInlineImages} from './budget.js';
import {WebMemo} from './memo.js';
import {webProviderNetworkOptions,type WebProviderRuntime} from './provider-config.js';
import type {WebProviderManager,ProviderExtractOutcome} from './provider-manager.js';
import {MAX_WEB_RESULT_CHARACTERS,type WebResultDocument} from './results.js';

interface Limits {timeoutMs:number;maxBytes:number;maxCompressedBytes:number}
export type ProviderFetchResult={document:WebResultDocument;cached:boolean}|{url:string;isError:true;error:string};
export function completeWebDocument(document:WebResultDocument){
  if(document.status!==null&&(document.status<200||document.status>=300)||document.received.truncated||document.extraction&&!document.extraction.complete||document.provider&&(document.provider.error||document.provider.coverage!=='full'||document.provider.rescuedFrom))return false;
  let characters=0;for(const _character of document.content)if(++characters>MAX_WEB_RESULT_CHARACTERS)return false;return Boolean(document.content);
}

/** Reusable extraction facts carry no source grants; every result is archived by its current caller. */
export class ProviderFetch{
  private readonly cache=new Map<string,{document:WebResultDocument;expires:number;bytes:number}>();private bytes=0;
  private readonly flight=new WebMemo<ProviderExtractOutcome>(1);
  constructor(private readonly host:WebHost,private readonly limits:Limits,private readonly manager:WebProviderManager){}
  private remove(key:string){const item=this.cache.get(key);if(item){this.bytes-=item.bytes;this.cache.delete(key);}}
  private put(key:string,document:WebResultDocument,ttl:number){if(ttl<=0||!completeWebDocument(document))return;const bytes=Buffer.byteLength(JSON.stringify(document));if(bytes>16*1024*1024)return;this.remove(key);while(this.cache.size>=100||this.bytes+bytes>16*1024*1024)this.remove(this.cache.keys().next().value!);this.cache.set(key,{document:structuredClone(document),expires:Date.now()+ttl,bytes});this.bytes+=bytes;}
  private async target(url:string,signal?:AbortSignal){return validateWebTarget(url,{signal,testing:this.host.testing,secretValues:this.host.secretValues,timeoutMs:this.limits.timeoutMs});}
  async fetch(runtime:WebProviderRuntime,urls:readonly string[],mode:'text'|'markdown',signalIds:string[],context:ToolExecutionContext|undefined,signal?:AbortSignal):Promise<ProviderFetchResult[]>{
    for(const url of urls)if(urlContainsCredential(url,this.host.secretValues?.()??[]))throw new AppError('web_secret_url_blocked',403);
    const ttl=runtime.configuration.cacheEnabled?runtime.configuration.cacheTtlMinutes*60000:0,results:Array<ProviderFetchResult|undefined>=new Array(urls.length),misses:Array<{index:number;url:string;key:string}>=[];
    for(const [index,url]of urls.entries()){
      signal?.throwIfAborted();try{
        await this.target(url,signal);const key=createHash('sha256').update(JSON.stringify(['vendor-extract-v1',runtime.identity,runtime.extract.kind==='provider'?[runtime.extract.provider.name,runtime.extract.provider.mode]:runtime.extract.kind,url,mode,this.limits.maxBytes,this.limits.maxCompressedBytes])).digest('hex'),local=this.cache.get(key);if(local&&local.expires<=Date.now())this.remove(key);
        const hit=ttl>0?(await this.host.cache?.get(key,ttl,signalIds,context,signal)??this.cache.get(key)?.document):undefined;
        if(hit){await this.target(hit.url,signal);if(hit.provider)await validateWebTarget(hit.provider.apiResponse.url,{signal,testing:this.host.testing,secretValues:this.host.secretValues,timeoutMs:this.limits.timeoutMs,...webProviderNetworkOptions(runtime,hit.provider.name,hit.provider.mode,hit.provider.apiResponse.url)});results[index]={document:structuredClone(hit),cached:true};}else misses.push({index,url,key});
      }catch(error){signal?.throwIfAborted();if(error instanceof AppError)throw error;if(!(error instanceof WebBlockedError)&&!(error instanceof TypeError))throw error;results[index]={url,isError:true,error:error instanceof WebBlockedError?error.message:'Invalid HTTP(S) URL.'};}
    }
    if(misses.length){
      const requested=misses.map(row=>row.url),key=JSON.stringify([runtime.identity,requested,mode]),outcome=(await this.flight.get(key,effective=>this.manager.extract(runtime,requested,mode,effective),signal,()=>false)).value;
      for(const [position,miss]of misses.entries()){
        signal?.throwIfAborted();const page=outcome.pages.find(page=>page.sourceURL===miss.url||page.url===miss.url)??(outcome.pages.length===misses.length?outcome.pages[position]:undefined);
        if(!page){results[miss.index]={url:miss.url,isError:true,error:'The provider returned no result for this URL.'};continue;}
        if(!page.receipt){results[miss.index]={url:miss.url,isError:true,error:page.error??'The provider returned no verifiable response.'};continue;}
        try{await this.target(page.url,signal);}catch(error){signal?.throwIfAborted();if(error instanceof AppError)throw error;if(!(error instanceof WebBlockedError)&&!(error instanceof TypeError))throw error;results[miss.index]={url:miss.url,isError:true,error:error instanceof WebBlockedError?error.message:'The provider returned an invalid final URL.'};continue;}
        const content=cleanInlineImages(mode==='text'?extract(page.content,'text/markdown',page.url,'text').text:page.content),document:WebResultDocument={url:page.url,status:page.status,contentType:mode==='text'?'text/plain':'text/markdown',title:page.title.slice(0,256),extractor:`provider-${outcome.provider}`,content,received:{bytes:page.receipt.bytes,wireBytes:page.receipt.wireBytes,sha256:page.receipt.sha256,truncated:page.receipt.truncated,representation:'provider-api-response'},provider:{name:outcome.provider,mode:outcome.mode,coverage:page.coverage,requestedURL:miss.url,...(page.error?{error:page.error}:{}),...(outcome.rescuedFrom?{rescuedFrom:outcome.rescuedFrom}:{}),...(outcome.backendError?{backendError:outcome.backendError}:{}),...(outcome.servedBy?{servedBy:outcome.servedBy}:{}),apiResponse:page.receipt,attempts:outcome.attempts}};
        if(ttl>0&&completeWebDocument(document)){this.put(miss.key,document,ttl);await this.host.cache?.put(miss.key,document,signalIds,context,signal);}results[miss.index]={document,cached:false};
      }
    }
    return results.map(result=>{if(!result)throw new AppError('web_provider_result_missing',500);return result;});
  }
}
