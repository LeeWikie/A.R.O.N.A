import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {Agent,MessageList,type MastraDBMessage} from '@mastra/core/agent';
import {createTool} from '@mastra/core/tools';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {z} from 'zod';

const commonJS=createRequire(import.meta.url)('@mastra/core/agent') as typeof import('@mastra/core/agent');
for(const [entry,NativeAgent,NativeMessageList]of [['esm',Agent,MessageList],['cjs',commonJS.Agent,commonJS.MessageList]] as const)test(`native ${entry} exposes the original assistant message for repeated provider tool IDs`,async()=>{
 let requests=0;let readMessages:(()=>readonly MastraDBMessage[])|undefined;const prompts:unknown[]=[];const calls:{messageId:string;value:string}[]=[];const failures:unknown[]=[];
 const model=new MastraLanguageModelV2Mock({doStream:async options=>{prompts.push(options.prompt);const turn=++requests;return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(turn<=2)controller.enqueue({type:'tool-call',toolCallId:'reused-provider-id',toolName:'record_value',input:JSON.stringify({value:`value-${turn}`})});controller.enqueue({type:'finish',finishReason:turn<=2?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};}});
 const agent=new NativeAgent({id:`native-message-${entry}`,name:'Synthetic tool identity',instructions:'Execute the supplied calls.',model,tools:{record_value:createTool({id:'record_value',description:'Return a synthetic value.',inputSchema:z.object({value:z.string()}).strict(),execute:async(input,context)=>{
  try{readMessages=context?.agent?.getMessages;assert.equal(context?.agent?.toolCallId,'reused-provider-id');const messageId=context?.agent?.messageId;assert.ok(messageId);calls.push({messageId,value:input.value});
  const message=context.agent.getMessages?.().find(row=>row.id===messageId);assert.ok(message);
  const matches=message.content.parts.filter(part=>part.type==='tool-invocation'&&part.toolInvocation.toolCallId==='reused-provider-id');const part=matches.find(part=>part.type==='tool-invocation'&&JSON.stringify(part.toolInvocation.args)===JSON.stringify(input));assert.ok(part?.type==='tool-invocation');assert.deepEqual(part.toolInvocation.args,input);
  return input;}catch(error){failures.push(error);throw error;}
 }})}});
 const output=await agent.stream('Execute both synthetic calls.',{maxSteps:4});await output.getFullOutput();
 assert.deepEqual(failures,[],JSON.stringify(calls));assert.equal(requests,3);assert.equal(calls.length,2);assert.notEqual(calls[0]!.messageId,calls[1]!.messageId);assert.deepEqual(calls.map(call=>call.value),['value-1','value-2']);
 const raw=structuredClone(readMessages!()),before=JSON.stringify(raw),completed=raw.flatMap(message=>message.content.parts.filter(part=>part.type==='tool-invocation'&&part.toolInvocation.state==='result'));
 assert.equal(completed.length,2);assert.deepEqual(completed.map(part=>part.type==='tool-invocation'?{args:part.toolInvocation.args,result:part.toolInvocation.result}:null),[{args:{value:'value-1'},result:{value:'value-1'}},{args:{value:'value-2'},result:{value:'value-2'}}]);
 const values=(prompt:unknown)=>{const messages=prompt as {role:string;content:unknown}[];return messages.flatMap(message=>message.role==='tool'&&Array.isArray(message.content)?message.content.map(part=>({id:part.toolCallId,name:part.toolName,input:part.input,output:part.output})):[]);};
 const expected=[{id:'reused-provider-id',name:'record_value',input:{value:'value-1'},output:{type:'text',value:'value-1'}},{id:'reused-provider-id',name:'record_value',input:{value:'value-2'},output:{type:'text',value:'value-2'}}];
 assert.deepEqual(values(prompts[2]),expected);
 const cold=new NativeMessageList({threadId:'native-message',resourceId:'local',filterIncompleteToolCalls:false});cold.add(structuredClone([...raw]),'memory');const state=cold.serialize(),reopened=new NativeMessageList({threadId:'native-message',resourceId:'local',filterIncompleteToolCalls:false});reopened.deserialize(JSON.parse(JSON.stringify(state)));assert.deepEqual(values(await reopened.get.all.aiV5.llmPrompt()),expected);assert.equal(JSON.stringify(raw),before);

});
