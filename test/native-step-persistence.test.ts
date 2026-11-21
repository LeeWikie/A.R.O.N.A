import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {Agent} from '@mastra/core/agent';
import {createTool} from '@mastra/core/tools';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {LibSQLStore} from '@mastra/libsql';
import {Memory} from '@mastra/memory';
import {z} from 'zod';
import {bindMemoryResource} from '../src/run-recovery.js';
import {removeTemp} from './helpers.js';

const commonJS=createRequire(import.meta.url)('@mastra/core/agent') as typeof import('@mastra/core/agent');
for(const [entry,NativeAgent]of [['esm',Agent],['cjs',commonJS.Agent]] as const)test(`native ${entry} savePerStep reports a durable tool-result failure before another provider call`,{timeout:15000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-step-save-')),storage=new LibSQLStore({id:'native-step-persistence',url:'file:'+path.join(directory,'history.sqlite')}),memory=new Memory({storage,options:{lastMessages:false,generateTitle:false,semanticRecall:false,workingMemory:{enabled:false}}});bindMemoryResource(memory,'local');let calls=0,effects=0,rejected=0;
 const save=memory.saveMessages.bind(memory);memory.saveMessages=async input=>{if(input.messages.some(message=>message.content.parts.some(part=>part.type==='tool-invocation'&&part.toolInvocation.toolCallId==='native-completed-effect'&&part.toolInvocation.state==='result'))){rejected++;throw Error('SYNTHETIC_NATIVE_STEP_STORAGE_FAILED');}return save(input);};
 const model=new MastraLanguageModelV2Mock({doStream:async()=>{calls++;return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(calls===1)c.enqueue({type:'tool-call',toolCallId:'native-completed-effect',toolName:'record_effect',input:'{}'});c.enqueue({type:'finish',finishReason:calls===1?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}});
 const agent=new NativeAgent({id:`native-step-${entry}`,name:'Synthetic step persistence',instructions:'Run the synthetic tool once.',model,memory,tools:{record_effect:createTool({id:'record_effect',description:'Record one synthetic completed effect.',inputSchema:z.object({}).strict(),execute:async()=>{effects++;return {completed:true};}})}});
 try{await storage.init();const output=await agent.stream('Run the synthetic effect.',{memory:{thread:'native-step',resource:'local'},maxSteps:3,savePerStep:true});await assert.rejects(output.getFullOutput(),/SYNTHETIC_NATIVE_STEP_STORAGE_FAILED/);assert.ok(rejected>0);assert.equal(effects,1);assert.equal(calls,1);}
 finally{memory.saveMessages=save;await agent.getMastraInstance()?.shutdown();await storage.close();await removeTemp(directory);}
});
