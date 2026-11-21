import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';

const directory=process.argv[2]!,mode=process.argv[3]??'resume';let core:Core,started=false,step=0;
const quote=(value:string)=>process.platform==='win32'?`"${value.replaceAll('"','\\"')}"`:`'${value.replaceAll("'","'\\''")}'`;
const code=mode==='natural'?"const fs=require('fs');fs.appendFileSync('executions','start\\n');console.log('BEFORE_CRASH');setTimeout(()=>{console.log('NATURAL_TERMINAL_RESULT');process.exit(7);},1800);":"const fs=require('fs');fs.appendFileSync('executions','start\\n');console.log('BEFORE_CRASH');let data='';process.stdin.on('data',d=>{data+=d;if(data.includes('finish')){console.log('ORIGINAL_PROCESS_COMPLETED');process.exit(0);}});setInterval(()=>fs.appendFileSync('heartbeat','x'),25);";
const callScope=randomUUID();
function reply(action?:{name:string;input:unknown}){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolName:action.name,toolCallId:`synthetic-terminal-${callScope}-${++sequence}`,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}
let sequence=0;
const model=new MastraLanguageModelV2Mock({doStream:async request=>{
  const worker=request.tools?.some(tool=>tool.name==='task_report'),prompt=JSON.stringify(request.prompt);
  if(!worker){
    const text=request.prompt.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')).join('\n');
    const notification=/<external-event[^>]*signal_id="([^"]+)"[^>]*>\s*(\{[^<]*"kind":"terminal-process-result"[^<]*\})\s*<\/external-event>/.exec(text);
    if(!notification)return reply();
    const value=JSON.parse(notification[2]!) as {processId:string},read=request.prompt.filter(message=>message.role==='tool').some(message=>JSON.stringify(message.content).includes('read_terminal_result')&&JSON.stringify(message.content).includes(value.processId));
    if(!read)return reply({name:'read_terminal_result',input:{id:value.processId,signalIds:[notification[1]]}});
    const expected=mode==='natural'?'NATURAL_TERMINAL_RESULT':'ORIGINAL_PROCESS_COMPLETED';
    return reply({name:'emit_message',input:{signalIds:[notification[1]],text:prompt.includes(expected)?`Verified ${expected}; process status is separate from task completion.`:'Terminal output was not available.'}});
  }
  const task=core.runtime.tasks().find(task=>['running','waiting'].includes(task.status))!;
  if(mode==='checkpoint'){
    if(task.attempt===1){
      if(!started){started=true;return reply({name:'mastra_workspace_execute_command',input:{command:`${quote(process.execPath)} -e ${quote("const fs=require('fs');fs.appendFileSync('executions','start\\n');for(let i=0;i<1200;i++)console.log('CHECKPOINT_ROW_'+i+':'+'x'.repeat(80));")}`,description:'Produce a complete retained synthetic command result',tail:0}});}
      process.send?.({type:'terminal-checkpoint',taskId:task.id,runId:task.runIds.at(-1),toolCallId:`synthetic-terminal-${callScope}-1`,prompt:request.prompt});await new Promise<void>(()=>{});throw Error('unreachable');
    }
    const processId=/process\.[0-9a-f-]{36}/.exec(prompt)?.[0];process.send?.({type:'checkpoint-resume-model',step,processId,prompt:request.prompt});
    if(step++===0){if(!processId)throw Error('Resumed native history lost the completed command source');return reply({name:'terminal_process',input:{action:'log',id:processId,offset:300,limit:1}});}
    if(task.report)return reply();const verified=prompt.includes('CHECKPOINT_ROW_299:');return reply({name:'task_report',input:{id:task.id,report:{outcome:verified?'succeeded':'blocked',summary:'Read the original completed command from the recovered native history.',checks:[{description:'The original omitted middle was retrieved without executing the command again.',passed:verified}],deliveries:[],unresolved:verified?[]:['The completed output could not be read.']}}});
  }
  if(task.attempt===1){
    if(!started){started=true;return reply({name:'terminal_process',input:{action:'start',command:`${quote(process.execPath)} -e ${quote(code)}`,description:'Start a recoverable synthetic background process',interactive:true,notifyOnComplete:true}});}
    process.send?.({type:'process-started',taskId:task.id,runId:task.runIds.at(-1),processId:/process\.[0-9a-f-]{36}/.exec(prompt)?.[0]});
    await new Promise<void>(()=>{});throw Error('unreachable');
  }
  const processId=/process\.[0-9a-f-]{36}/.exec(prompt)?.[0];process.send?.({type:'resume-model',step,processId,prompt});
  if(mode==='resume-cancel'){
    const actions=[{name:'terminal_process',input:{action:'list'}},{name:'terminal_process',input:{action:'submit',id:processId,data:'continue'}},{name:'ask_user',input:{question:'Keep this synthetic process waiting until cancellation.'}}];return reply(actions[step++]);
  }
  const actions=[{name:'terminal_process',input:{action:'list'}},{name:'terminal_process',input:{action:'submit',id:processId,data:'finish'}},{name:'terminal_process',input:{action:'wait',id:processId,waitMs:5000}},
    {name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Continued the original process after a core restart.',checks:[{description:'The original process returned the completion marker.',passed:prompt.includes('ORIGINAL_PROCESS_COMPLETED')}],deliveries:[],unresolved:[]}}}];
  return reply(actions[step++]);
}});
core=await Core.open({dataDir:directory,model,memoryEnabled:false});
const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});
server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')process.send?.({type:'ready',port:address.port,token:core.controlToken});});
process.on('message',message=>{if(message&&typeof message==='object'&&'type'in message&&message.type==='inspect')process.send?.({type:'inspection',tasks:core.runtime.tasks(),notifications:core.runtime.pendingNotifications(),events:core.runtime.events(undefined,0,1000),outputs:core.store.listOutputs({contextId:'main',after:0,limit:1000}),processes:core.store.db.prepare("SELECT body FROM runtime_settings WHERE id LIKE 'terminal-process:%'").all().map(row=>{const binding=JSON.parse(String(row.body));let error:string|undefined;try{core.capabilities.terminalNotification(binding.id);}catch(caught){error=String(caught);}return {id:binding.id,contextId:binding.contextId,runId:binding.runId,attempt:binding.attempt,state:JSON.parse(fs.readFileSync(path.join(directory,'process-output',binding.id,'state.json'),'utf8')),error};})});});
process.once('SIGTERM',()=>{server.close();if('closeAllConnections'in server)server.closeAllConnections();void core.close().finally(()=>process.exit(0));});
