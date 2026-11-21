import {serve} from '@hono/node-server';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';
import type {MastraDBMessage} from '@mastra/core/agent/message-list';
import {Memory} from '@mastra/memory';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

const directory=process.argv[2]!,mode=process.argv[3]!,failure=process.argv[4]==='error';let core:Core,workerCalls=0;
const marker='SYNTHETIC_COMPLETED_TOOL_BODY';
function reply(action?:{name:string;input:unknown}){return {stream:new ReadableStream({start(controller){controller.enqueue({type:'stream-start',warnings:[]});if(action)controller.enqueue({type:'tool-call',toolCallId:action.name==='task_report'?'recovered-task-report':'completed-tool-checkpoint',toolName:action.name,input:JSON.stringify(action.input)});controller.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});controller.close();}})};}
const model=new MastraLanguageModelV2Mock({doStream:async request=>{
 if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();workerCalls++;
 const task=core.runtime.tasks().find(task=>['running','waiting'].includes(task.status))!;
 if(task.report)return reply();
 if(mode==='producer'&&workerCalls===1)return reply({name:failure?'mastra_workspace_read_file':'mastra_workspace_write_file',input:failure?{path:'missing.txt'}:{path:'completed.txt',content:marker+'\n'}});
 const prompt=JSON.stringify(request.prompt);process.send?.({type:mode==='producer'?'checkpoint':'resumed',prompt,workerCalls,runId:task.runIds.at(-1),taskId:task.id});
 if(mode==='producer')await new Promise<void>(()=>{});
 return reply({name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Verified the original completed native tool result.',checks:[{description:'The original completed call and result were preserved.',passed:request.prompt.some(message=>message.role==='tool')}],deliveries:[{kind:'text',title:'Original tool result',value:'The original tool result remains available.'}],unresolved:[]}}});
}});
if(mode==='memory-failure'){const save=Memory.prototype.saveMessages;Memory.prototype.saveMessages=function(input){if(input.messages.some(message=>message.id.startsWith('repair.')))throw Error('SYNTHETIC_REPAIR_MEMORY_UNAVAILABLE');return save.call(this,input);};}
if(mode==='publication-failure'){const db=new DatabaseSync(path.join(directory,'records.sqlite'));try{db.exec("CREATE TRIGGER synthetic_repair_publication_failure BEFORE INSERT ON session_graph_entries WHEN instr(COALESCE(NEW.source,''),'\"recoveryId\"')>0 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REPAIR_PUBLICATION_UNAVAILABLE'); END;");}finally{db.close();}}
core=await Core.open({dataDir:directory,model,memoryEnabled:false});
if(mode==='producer'){
 const save=core.memory.saveMessages.bind(core.memory);
 core.memory.saveMessages=input=>save({...input,messages:input.messages.map(message=>{if(!message.content.parts.some(part=>part.type==='tool-invocation'&&['result','output-error','output-denied'].includes(part.toolInvocation.state)))return message;const event=core.runtime.events(message.threadId,0,1000).find(event=>event.kind==='message_start'&&(event.data as {message:MastraDBMessage}).message.id===message.id);return event?{...(event.data as {message:MastraDBMessage}).message,createdAt:new Date(message.createdAt)}:message;})});
}
const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')process.send?.({type:'ready',port:address.port,token:core.controlToken});});
process.on('message',value=>{if(value&&typeof value==='object'&&'type'in value&&value.type==='inspect')void(async()=>{const contexts=core.runtime.contexts(),runIds=core.runtime.tasks().flatMap(task=>task.runIds);process.send?.({type:'inspection',workerCalls,tasks:core.runtime.tasks(),repairs:core.store.db.prepare("SELECT id,body FROM runtime_settings WHERE id LIKE 'session-tool-repair:%'").all(),events:core.runtime.events(undefined,0,1000),snapshots:runIds.map(runId=>({runId,value:core.runtime.getSnapshot(runId)})),prepared:await Promise.all(runIds.map(async runId=>{try{const source=await core.prepareMemorySource(runId);return {runId,source:{...source,contents:[...source.contents].map(([id,content])=>[id,{...content,body:new TextDecoder().decode(content.body)}]),canonicalRefs:[...source.canonicalRefs],attachmentRefs:[...source.attachmentRefs]}};}catch(error){return {runId,error:String(error)};}})),graphs:contexts.map(context=>({contextId:context.id,head:core.sessionGraph.head(context.id),records:core.sessionGraph.records(context.id),sources:core.sessionGraph.sources(context.id)})),native:await Promise.all(contexts.map(async context=>({contextId:context.id,messages:(await core.memory.recall({threadId:context.id,perPage:100,hideSignals:false})).messages})))});})();});
process.once('SIGTERM',()=>{server.close();if('closeAllConnections'in server)server.closeAllConnections();void core.close().finally(()=>process.exit(0));});
