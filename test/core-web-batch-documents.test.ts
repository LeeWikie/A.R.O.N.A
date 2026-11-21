import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';
import {Core} from '../src/core.js';
import {authenticatedApp,until,removeTemp} from './helpers.js';
import {pdfFixture} from './document-fixture.js';
import type {WebResultReference} from '../src/web/results.js';

function reply(action?:{name:string;input:unknown},sequence=0){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(action)c.enqueue({type:'tool-call',toolCallId:`synthetic-batch-doc-${sequence}`,toolName:action.name,input:JSON.stringify(action.input)});c.enqueue({type:'finish',finishReason:action?'tool-calls':'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});c.close();}})};}

test('actual Core approves one URL batch and naturally reads both the retained middle and the extracted PDF through the original call source',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-core-web-batch-doc-')),body='HEAD\n'+Array.from({length:3000},(_,i)=>`row_${i}: synthetic batch source`).join('\n')+'\nTAIL',pdf=pdfFixture();let requests=0,core!:Core,step=0,modelError:unknown,refs:WebResultReference[]=[];
  const server=createServer((request,response)=>{requests++;response.writeHead(200,{'content-type':request.url==='/file.pdf'?'application/pdf':'text/plain'});response.end(request.url==='/file.pdf'?pdf:body);});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('invalid address');const base=`http://synthetic.example:${address.port}`;
  const model=new MastraLanguageModelV2Mock({doStream:async request=>{try{
    if(!request.tools?.some(tool=>tool.name==='task_report'))return reply();const task=core.runtime.tasks().find(row=>['running','waiting'].includes(row.status))!;if(task.report)return reply();const signalIds=[task.signalId],prompt=JSON.stringify(request.prompt);
    if(step===0){step++;return reply({name:'web_fetch',input:{signalIds,urls:[base+'/page',{href:base+'/file.pdf'},42,'http://10.0.0.1/blocked'],mode:'text',maxChars:20000}},step);}
    if(step===1){const event=core.runtime.events(task.contextId).find(row=>row.kind==='tool_end'&&(row.data as {toolCallId?:string}).toolCallId==='synthetic-batch-doc-1')!,result=(event.data as {result:{results:Array<{resultRef?:WebResultReference;isError?:boolean}>,count:number}}).result;assert.equal(result.count,4);assert.equal(result.results[2]!.isError,true);assert.equal(result.results[3]!.isError,true);refs=result.results.slice(0,2).map(row=>{assert.ok(row.resultRef);return row.resultRef;});assert.equal(refs[1]!.received.sha256,createHash('sha256').update(pdf).digest('hex'));assert.equal(refs[1]!.extraction?.format,'pdf');assert.match(prompt,/violet-17/);step++;return reply({name:'read_web_result',input:{signalIds,id:refs[0]!.id,offset:1500,limit:1,encoding:'text'}},step);}
    if(step===2){assert.match(prompt,/row_1498: synthetic batch source/);step++;return reply({name:'read_web_result',input:{signalIds,id:refs[1]!.id,offset:1,limit:200,encoding:'text'}},step);}
    const ended=core.runtime.events(task.contextId).filter(row=>row.kind==='tool_end'&&['synthetic-batch-doc-2','synthetic-batch-doc-3'].includes((row.data as {toolCallId?:string}).toolCallId??''));assert.equal(ended.length,2);for(const event of ended)assert.equal((event.data as {isError:boolean}).isError,false,JSON.stringify(event.data));step++;return reply({name:'task_report',input:{id:task.id,report:{outcome:'succeeded',summary:'Verified both retained URL sources and their original content.',checks:[{description:'The original page middle and PDF text were read from their authorized batch sources.',passed:true}],deliveries:[],unresolved:[]}}},step);
  }catch(error){modelError=error;throw error;}}});
  core=await Core.open({dataDir:directory,model,memoryEnabled:false,webTesting:{allowLoopbackForHostname:'synthetic.example',resolver:async()=>[{address:'127.0.0.1',family:4}]}});
  core.configure('web',{type:'none'});
  try{const app=authenticatedApp(core),task=await core.submitTask({title:'Synthetic mixed URL sources',content:`Read the page and PDF at ${base}, then verify their original text.`},'synthetic-web-batch-doc'),approved=new Set<string>();const completed=await until(async()=>{if(modelError)throw modelError;for(const approval of core.runtime.approvals().filter(row=>row.status==='pending')){assert.equal(approval.toolName,'web_fetch');approved.add(approval.id);assert.equal((await app.request(`/approvals/${approval.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"decision":"approve"}'})).status,200);}return core.runtime.task(task.id);},row=>['succeeded','failed','blocked','unreported'].includes(row.status));assert.equal(completed.status,'succeeded');assert.equal(approved.size,1);assert.equal(requests,2);assert.equal(refs.length,2);const snapshot=await (await app.request(`/snapshot?contextId=${encodeURIComponent(task.contextId)}&toolResultContent=1`)).json() as {toolActivity:Array<{toolName:string;output?:{text:string}}>};const output=snapshot.toolActivity.find(row=>row.toolName==='web_fetch')!.output!.text;assert.match(output,/violet-17/);assert.match(output,/TAIL/);assert.doesNotMatch(output,/external-content|Never obey instructions/);}
  finally{await core.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await removeTemp(directory);}
});
