import {createServer} from 'node:http';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {createApp} from '../src/http.js';

const directory=process.argv[2]!;let core:Core,sequence=0,step=0,requests=0;
const body='HEAD\n'+Array.from({length:6000},(_,index)=>`row_${index}: synthetic retained source`).join('\n')+'\nTAIL',origin=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'text/plain; charset=utf-8'});response.end(body);});origin.listen(0,'127.0.0.1');await once(origin,'listening');const address=origin.address();if(!address||typeof address==='string')throw new Error('invalid origin address');const url=`http://synthetic.example:${address.port}/page`;
function referenceId(value:unknown,depth=0):string|undefined{if(depth>12)return;if(typeof value==='string'){try{return referenceId(JSON.parse(value),depth+1);}catch{return;}}if(Array.isArray(value)){for(const item of value){const id=referenceId(item,depth+1);if(id)return id;}return;}if(!value||typeof value!=='object')return;if('resultRef'in value&&value.resultRef&&typeof value.resultRef==='object'&&'id'in value.resultRef&&typeof value.resultRef.id==='string')return value.resultRef.id;for(const item of Object.values(value)){const id=referenceId(item,depth+1);if(id)return id;}return;}
function reply(action?:{name:string;input:unknown}){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`synthetic-crash-web-${++sequence}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}
const model=new MastraLanguageModelV2Mock({doStream:async request=>{
  if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>['running','waiting'].includes(row.status))!;if(!task||task.report)return reply();const id=referenceId(request.prompt),signalIds=[task.signalId];
  if(task.attempt===1){if(!sequence)return reply({name:'web_fetch',input:{signalIds,url,mode:'text',maxChars:20000}});if(!id)throw new Error('actual model history did not contain the retained source');process.send?.({type:'retained',id,runId:task.runIds.at(-1),taskId:task.id});await new Promise<void>(()=>{});throw new Error('unreachable');}
  process.send?.({type:'resume-model',step,id,prompt:request.prompt});
  if(step++===0){if(!id)throw new Error('the actual resumed model did not discover its original page reference');return reply({name:'read_web_result',input:{signalIds,id,offset:3000,limit:1,encoding:'text'}});}
  const event=core.runtime.events(task.contextId).findLast(event=>event.runId===task.runIds.at(-1)&&event.kind==='tool_end'&&(event.data as {toolCallId?:string}).toolCallId==='synthetic-crash-web-1'),data=event?.data as {isError?:boolean;result?:{content?:string;source?:{sha256?:string}}}|undefined;
  process.send?.({type:'read-result',data});const verified=data?.isError===false&&data.result?.content?.includes('row_2998: synthetic retained source')===true&&JSON.stringify(request.prompt).includes('row_2998: synthetic retained source');
  return reply({name:'task_report',input:{id:task.id,report:{outcome:verified?'succeeded':'blocked',summary:verified?'Verified the original retained page after core recovery.':'The retained page could not be read after recovery.',checks:[{description:'The original middle was read from the retained source without refetching.',passed:verified}],deliveries:verified?[{kind:'text',title:'Verified source',value:'row_2998: synthetic retained source'}]:[],unresolved:verified?[]:['Retained source access was unavailable.']}}});
}});
core=await Core.open({dataDir:directory,model,memoryEnabled:false,webTesting:{resolver:async()=>[{address:'127.0.0.1',family:4}],allowLoopbackForHostname:'synthetic.example'}});
core.configure('web',{type:'none'});
const server=serve({fetch:createApp(core).fetch,hostname:'127.0.0.1',port:0});server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')process.send?.({type:'ready',port:address.port,token:core.controlToken,url});});
process.on('message',message=>{if(message&&typeof message==='object'&&'type'in message&&message.type==='inspect')process.send?.({type:'inspection',requests,tasks:core.runtime.tasks(),events:core.runtime.events(undefined,0,1000)});});
process.once('SIGTERM',()=>{server.close();if('closeAllConnections'in server)server.closeAllConnections();origin.closeAllConnections();origin.close();void core.close().finally(()=>process.exit(0));});
