import assert from 'node:assert/strict';import test from 'node:test';
import {encodeJsonContent,JsonContentDecoder,jsonContentResponse,decodeJsonContent} from '../src/json-content-stream.js';

test('bounded JSON content records preserve complete Unicode, nulls, arrays, shared values and safe object keys',async()=>{
 const shared={text:'中文🌸\u202e\r\x1b'.repeat(100000)},value={a:shared,b:shared,list:[null,true,false,5,undefined],date:new Date('2026-01-01T00:00:00.000Z'),['large-key'.repeat(20000)]:'complete key value',...JSON.parse('{"__proto__":{"polluted":true}}')};const response=jsonContentResponse(value);const actual=await decodeJsonContent(response.body!);assert.deepEqual(actual,JSON.parse(JSON.stringify(value)));assert.equal(({} as Record<string,unknown>).polluted,undefined);for(const line of encodeJsonContent(value))assert.ok(line.length<512*1024);
});
test('truncated, altered, duplicated and incomplete streams never yield a partial object',()=>{
 const lines=[...encodeJsonContent({original:'完整原文',list:[1,2]})];const parser=new JsonContentDecoder();for(const line of lines.slice(0,-1))parser.push(line);assert.throws(()=>parser.value(),/invalid_content_stream/);
 for(const change of ['text','duplicate','hash'] as const){const changed=[...lines];if(change==='text')changed[changed.findIndex(line=>line.includes('完整原文'))]=JSON.stringify({type:'text',value:'altered'});if(change==='duplicate')changed.splice(2,0,JSON.stringify({type:'key',value:'original'}));if(change==='hash')changed[changed.length-1]=JSON.stringify({type:'complete',records:lines.length-1,sha256:'0'.repeat(64)});const decoder=new JsonContentDecoder();assert.throws(()=>{for(const line of changed)decoder.push(line);decoder.value();},/invalid_content_stream/);}
 const cycle:{self?:unknown}={};cycle.self=cycle;assert.throws(()=>[...encodeJsonContent(cycle)],/response_content_not_serializable/);
});
