import assert from 'node:assert/strict';
import test from 'node:test';
import {concealTrailingPrefix,secretSpans,trailingSecretPrefixStart} from '../src/public-text.js';

function referencePrefix(text:string,secrets:readonly string[]){
 let start=text.length;
 for(const secret of secrets)for(let size=1;size<secret.length&&size<=text.length;size++)if(text.endsWith(secret.slice(0,size)))start=Math.min(start,text.length-size);
 return start;
}
function referenceSpans(text:string,secrets:readonly string[]){
 const spans:Array<{start:number;end:number}>=[];
 for(const secret of secrets){if(!secret)continue;for(let start=text.indexOf(secret);start>=0;start=text.indexOf(secret,start+1))spans.push({start,end:start+secret.length});}
 const merged:Array<{start:number;end:number}>=[];
 for(const span of spans.sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&span.start<=last.end)last.end=Math.max(last.end,span.end);else merged.push({...span});}
 return merged;
}
test('credential matching preserves every overlap and proper suffix across deterministic UTF-16 cases',()=>{
 let seed=0x71cae903;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0,alphabet=['a','b','a',' ','中','\ud83d','\ude00','\n'];
 const text=(limit:number)=>Array.from({length:next()%limit},()=>alphabet[next()%alphabet.length]!).join('');
 for(let index=0;index<4000;index++){
  const secrets=Array.from({length:1+next()%5},()=>text(14)),value=index%2?text(80):text(30)+(secrets[0]??'').slice(0,next()%14);
  assert.equal(trailingSecretPrefixStart(value,secrets),referencePrefix(value,secrets),`suffix case ${index}`);
  assert.deepEqual(secretSpans(value,secrets),referenceSpans(value,secrets),`overlap case ${index}`);
 }
});
test('large repeated credentials merge overlapping spans and hide incomplete terminal values',()=>{
 const secret='a'.repeat(63999)+'Z',text='visible '+'a'.repeat(63999);
 assert.equal(trailingSecretPrefixStart(text,[secret]),8);
 assert.equal(concealTrailingPrefix(text,[secret]),'visible [hidden]');
 assert.deepEqual(secretSpans('a'.repeat(128000),['a'.repeat(64000)]),[{start:0,end:128000}]);
 for(let index=0;index<130;index++)trailingSecretPrefixStart('prefix-'+index,['prefix-'+index+'-secret']);
 assert.equal(trailingSecretPrefixStart(text,[secret]),8,'preprocessing eviction changes no credential boundary');
 const uncached='b'.repeat(70000)+'Z';assert.equal(trailingSecretPrefixStart('before '+'b'.repeat(70000),[uncached]),7);
});
