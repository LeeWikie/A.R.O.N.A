/*
 * Search-key and result-count bucketing adapted from Hermes 0.23.1 tools/web_result_cache.py:
 * https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/web_result_cache.py
 *
 * MIT License
 * Copyright (c) 2025 Nous Research
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const searchBucket=(limit:number)=>[10,20,50,100].find(bucket=>limit<=bucket)??100;
export const searchQueryKey=(query:string)=>query.trim().toLowerCase().replace(/\s+/gu,' ');
interface Flight<T>{controller:AbortController;promise:Promise<T>;users:number;settled:boolean}

/** Result facts are copied per caller. A cancelled waiter never cancels another waiter. */
export class WebMemo<T>{
  private readonly cache=new Map<string,{expiresAt:number;value:T;bytes:number}>();
  private readonly flights=new Map<string,Flight<T>>();private bytes=0;
  constructor(private readonly ttlMs:number,private readonly byteLimit=16*1024*1024,private readonly entryLimit=100){}
  private remove(key:string){const value=this.cache.get(key);if(value){this.bytes-=value.bytes;this.cache.delete(key);}}
  async get(key:string,produce:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal,cacheable:(value:T)=>boolean=()=>true){
    if(this.ttlMs<=0){signal?.throwIfAborted();const value=await produce(signal??new AbortController().signal);signal?.throwIfAborted();return {value:structuredClone(value),cached:false};}
    signal?.throwIfAborted();const hit=this.cache.get(key);if(hit&&hit.expiresAt>Date.now()){this.remove(key);this.cache.set(key,hit);this.bytes+=hit.bytes;return {value:structuredClone(hit.value),cached:true};}if(hit)this.remove(key);
    let active=this.flights.get(key);if(!active){const controller=new AbortController(),created:Flight<T>={controller,users:0,settled:false,promise:Promise.resolve().then(()=>produce(controller.signal)).then(value=>{
      if(this.ttlMs>0&&cacheable(value)){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes<=this.byteLimit){while(this.cache.size>=this.entryLimit||this.bytes+bytes>this.byteLimit)this.remove(this.cache.keys().next().value!);this.cache.set(key,{expiresAt:Date.now()+this.ttlMs,value:structuredClone(value),bytes});this.bytes+=bytes;}}return value;
    }).finally(()=>{created.settled=true;if(this.flights.get(key)===created)this.flights.delete(key);})};void created.promise.catch(()=>{});this.flights.set(key,created);active=created;}
    active.users++;let abort=()=>{};try{const value=await Promise.race([active.promise,new Promise<never>((_,reject)=>{abort=()=>reject(signal?.reason??new DOMException('Web request cancelled','AbortError'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);signal?.throwIfAborted();return {value:structuredClone(value),cached:false};}
    finally{signal?.removeEventListener('abort',abort);active.users--;if(!active.users&&!active.settled){active.controller.abort();await active.promise.catch(()=>{});}}
  }
}
