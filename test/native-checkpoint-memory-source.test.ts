import assert from 'node:assert/strict';
import test from 'node:test';
import {suspendedNativeSystemFrames} from '../src/native-checkpoint-results.js';

function fixture(){
 const call={toolCallId:'original-call',toolName:'ask_user',args:{question:'Continue?'}},assistant={id:'original-assistant',role:'assistant',threadId:'main',resourceId:'local',content:{format:2,parts:[{type:'tool-invocation',toolInvocation:{state:'call',...call}}]}};
 const stream={status:'suspended',messageList:{memoryInfo:{threadId:'main',resourceId:'local'},messages:[assistant],systemMessages:[{role:'system',content:'ORIGINAL_SYSTEM_MEMORY'},{role:'system',content:'ORIGINAL_SYSTEM_MEMORY'}]}};
 const snapshot={status:'suspended',runId:'original-run',context:{'llm-execution':{output:{messageId:assistant.id}},toolCallStep:{status:'suspended',payload:[call],suspendPayload:{__workflow_meta:{foreachOutput:[{status:'suspended',suspendPayload:{...call,__streamState:stream}}]}}}}};
 return{snapshot,stream,assistant,call,address:{contextId:'main',runId:'original-run',gates:[{toolCallId:call.toolCallId,toolName:call.toolName}]}};
}

test('saved memory frames come only from the matched native suspended tool stream',()=>{const f=fixture(),original=JSON.stringify(f);assert.deepEqual(suspendedNativeSystemFrames(f.snapshot,f.address),['ORIGINAL_SYSTEM_MEMORY']);assert.equal(JSON.stringify(f),original);});
for(const mutation of['run','thread','resource','assistant','assistant-owner','call','args','gate','status','system-role','system-content','duplicate-call']as const)test(`saved memory frames reject changed ${mutation} provenance`,()=>{
 const f=fixture();switch(mutation){case'run':f.snapshot.runId='other-run';break;case'thread':f.stream.messageList.memoryInfo.threadId='other';break;case'resource':f.stream.messageList.memoryInfo.resourceId='other';break;case'assistant':f.assistant.id='other';break;case'assistant-owner':f.assistant.threadId='other';break;case'call':f.assistant.content.parts[0]!.toolInvocation.toolName='other';break;case'args':f.assistant.content.parts[0]!.toolInvocation.args={question:'Changed'};break;case'gate':f.address.gates[0]!.toolCallId='other';break;case'status':f.stream.status='success';break;case'system-role':f.stream.messageList.systemMessages[0]!.role='user';break;case'system-content':Reflect.set(f.stream.messageList.systemMessages[0]!,'content',{text:'ORIGINAL_SYSTEM_MEMORY'});break;case'duplicate-call':f.snapshot.context.toolCallStep.payload.push(f.call);break;}
 assert.equal(suspendedNativeSystemFrames(f.snapshot,f.address),undefined);
});
