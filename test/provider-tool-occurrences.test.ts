import assert from 'node:assert/strict';
import test from 'node:test';
import {Agent} from '@mastra/core/agent';
import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import {between,fixture,opaque} from './provider-tool-occurrence-fixture.js';

for(const duplicate of [false,true])for(const sameArguments of [false,true])test(`native Codex generate retains original block order and every ${duplicate?'repeated':'distinct'} tool ID, same arguments=${sameArguments}`,async()=>{
 const current=fixture(duplicate,sameArguments),result=await current.lm.doGenerate({prompt:[]});
 assert.deepEqual(result.content.map(part=>part.type),['reasoning','tool-call','text','tool-call']);
 const calls=result.content.filter(part=>part.type==='tool-call');
 assert.deepEqual(calls.map(part=>({id:part.toolCallId,name:part.toolName,input:part.input})),current.calls.map(item=>({id:item.call_id+'|'+item.id,name:item.name,input:item.arguments})));
 const reasoning=result.content[0]!;assert.equal(reasoning.type,'reasoning');if(reasoning.type==='reasoning'){assert.equal(reasoning.text,'');assert.equal(reasoning.providerMetadata?.pi?.thinkingSignature,JSON.stringify(opaque));}
});

for(const duplicate of [false,true])for(const sameArguments of [false,true])test(`native Codex -> bridge -> Agent replays original slot order, encrypted reasoning and both ${duplicate?'repeated':'distinct'} calls, same arguments=${sameArguments}`,{timeout:15000},async()=>{
 const current=fixture(duplicate,sameArguments),effects:Array<{id:string;value:string}>=[];
 const agent=new Agent({id:'codex-occurrences',name:'Synthetic occurrences',instructions:'Run both original calls in order.',model:current.lm,tools:{echo:createTool({id:'echo',description:'Record the original value.',inputSchema:z.object({value:z.string()}),execute:async(input,context)=>{effects.push({id:context!.agent!.toolCallId,value:input.value});return{seen:input.value};}})}});
 const result=await agent.stream('Run both calls.',{maxSteps:3,toolCallConcurrency:1});await result.getFullOutput();
 assert.deepEqual(effects.map(effect=>effect.value),sameArguments?['first','first']:['first','second']);assert.equal(new Set(effects.map(effect=>effect.id)).size,2);assert.equal(current.requests.length,2);
 const replay=current.requests[1]!.input.filter(item=>item.type==='reasoning'||item.type==='function_call'||item.type==='message'&&item.role==='assistant');
 assert.deepEqual(replay.map(item=>item.type),['reasoning','function_call','message','function_call']);assert.deepEqual(replay[0],opaque);assert.deepEqual(replay[2],between);
 const calls=replay.filter(item=>item.type==='function_call'),outputs=current.requests[1]!.input.filter(item=>item.type==='function_call_output');
 assert.deepEqual(calls.map(item=>({name:item.name,arguments:item.arguments})),current.calls.map(item=>({name:item.name,arguments:item.arguments})));
 assert.deepEqual(outputs.map(item=>item.call_id),calls.map(item=>item.call_id));assert.equal(new Set(calls.map(item=>item.call_id)).size,2);assert.ok(outputs.every(item=>typeof item.output==='string'&&JSON.parse(item.output).seen==='first'||typeof item.output==='string'&&JSON.parse(item.output).seen==='second'));
 assert.equal(JSON.stringify(effects).includes(opaque.encrypted_content),false);
});
