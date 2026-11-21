import {serve} from '@hono/node-server';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import {interactionAnswerCheckpoint} from '../src/interaction-outbox.js';

const directory=process.argv[2],mode=process.argv[3]??'',worker=mode.endsWith('write'),sameTurn=mode.startsWith('same-turn-');if(!directory||!process.send)throw Error('fixture_requires_private_directory_and_ipc');let calls=0;
const model=new MastraLanguageModelV2Mock({doStream:async request=>{
 const relevant=worker?request.tools?.some(tool=>tool.name==='task_report'):true;
 const toolName=worker?'mastra_workspace_write_file':'ask_user',completed=request.prompt.filter(message=>message.role==='tool').flatMap(message=>message.content).filter(part=>part.type==='tool-result'&&part.toolName===toolName).length;
 if(relevant)calls++;return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(relevant&&completed<2)for(const index of sameTurn?[0,1]:[completed])controller.enqueue({type:'tool-call',toolCallId:'persisted-repeated-id',toolName,input:JSON.stringify(worker?{path:index===0?'first.txt':'second.txt',content:index===0?'FIRST_PERSISTED_WRITE':'SECOND_PERSISTED_WRITE'}:{question:index===0?'First persisted question?':'Second persisted question?'})});controller.enqueue({type:'finish',finishReason:relevant&&completed<2?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};
}});
const core=await Core.open({dataDir:directory,model,memoryEnabled:false}),server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});
server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')process.send?.({type:'ready',port:address.port,token:core.controlToken});});
process.on('message',message=>{if(!message||typeof message!=='object'||!('type'in message)||message.type!=='inspect')return;void(async()=>{const native=await (worker?core.worker:core.agent).listSuspendedRuns({resourceId:'local'}),origin=worker?core.runtime.approvals()[0]:core.interactions()[0],workflow=origin?await (await core.memory.storage.getStore('workflows'))?.loadWorkflowSnapshot({workflowName:'executionWorkflow',runId:origin.runId}):undefined,firstCheckpoint=origin?interactionAnswerCheckpoint(workflow,{contextId:origin.contextId,runId:origin.runId,toolCallId:origin.toolCallId,toolName:origin.toolName}):undefined;process.send?.({type:'inspection',calls,native,firstCheckpoint,approvals:core.runtime.approvals(),interactions:core.interactions(),answers:core.interactionAnswers(),tasks:core.runtime.tasks(),sealed:native.runs.every(run=>run.runId&&Boolean(core.runtime.setting(`run-recovery:${run.runId}`,null)))});})().catch(error=>process.send?.({type:'fixture-error',error:String(error)}));});
let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close();if('closeAllConnections'in server)server.closeAllConnections();void core.close().finally(()=>process.disconnect?.());};process.once('SIGTERM',stop);process.once('SIGINT',stop);
